import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { assertVehicleInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { accountOn } from '../billing/billing-account.js';
import { round2 } from '../billing/billing-calculator.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';

// บันทึกการจ่ายของลูกค้า + ตารางล้อ (ผู้ใช้ 2026-09-27): SPI กำหนดเองว่าจ่ายคันไหนเท่าไร ราคายังตกลงกันอยู่
// จึงเก็บตามที่ลูกค้าจ่ายมาจริง (ยอดโอน + รายคันตามเลขตัวถัง) แล้วเทียบกับรถที่ส่งงานแล้ว - ไม่ผูกกับใบวางบิล
// สิทธิ์ ADMIN / ACCOUNTANT / STAFF_CAR (access-policy.ts) - STAFF_CAR จับคู่/เห็นตารางล้อเฉพาะรถยนต์ (vehicle-scope.ts)

const PAYMENT_PAGE = 50;
const VEHICLE_LIMIT = 1000;
const MAX_LINES = 2000;

const bad = (error: string) => new BadRequestException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const nameOf = (u: { name: string; displayName: string | null } | null) => (u ? u.displayName || u.name : null);
const plateOf = (v: { plateCategory: string | null; plateNumber: string | null }) => (v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : '');

// เลขตัวถังที่ลูกค้าแจ้งมักมีช่องว่าง/ขีด/ตัวเล็ก (คัดลอกจาก Excel) - เทียบแบบตัวใหญ่ไม่มีช่องว่างและขีด
export const normalizeChassis = (raw: string) => raw.toUpperCase().replace(/[\s-]/g, '');

function parseIsoDate(raw: unknown, label: string): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

function parseMoney(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 99_999_999) throw bad(`${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 ขึ้นไป`);
  return round2(raw);
}

function optionalText(raw: unknown, label: string, max = 500): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw bad(`${label}ต้องเป็นข้อความ`);
  const text = raw.trim();
  if (text.length > max) throw bad(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return text || null;
}

export interface CreatePaymentDto {
  customerId?: unknown;
  paidDate?: unknown;
  amount?: unknown;
  whtAmount?: unknown;
  reference?: unknown;
  note?: unknown;
  lines?: unknown; // [{ chassis, amount, note? }]
}

const PAYMENT_INCLUDE = {
  createdBy: { select: { name: true, displayName: true } },
  cancelledBy: { select: { name: true, displayName: true } },
  lines: {
    orderBy: { sortOrder: 'asc' as const },
    include: { vehicle: { select: { plateCategory: true, plateNumber: true, brand: { select: { name: true } } } } },
  },
} as const;

type PaymentRow = {
  id: string;
  customerId: string;
  account: string;
  paidDate: Date;
  amount: unknown;
  whtAmount: unknown;
  reference: string | null;
  note: string | null;
  createdAt: Date;
  cancelledAt: Date | null;
  cancelReason: string | null;
  createdBy: { name: string; displayName: string | null } | null;
  cancelledBy: { name: string; displayName: string | null } | null;
  lines: Array<{
    id: string;
    vehicleId: string | null;
    chassis: string;
    amount: unknown;
    note: string | null;
    vehicle: { plateCategory: string | null; plateNumber: string | null; brand: { name: string } } | null;
  }>;
};

function mapPayment(p: PaymentRow) {
  const lines = p.lines.map((l) => ({
    id: l.id,
    vehicleId: l.vehicleId,
    chassis: l.chassis,
    amount: Number(l.amount),
    note: l.note,
    plateText: l.vehicle ? plateOf(l.vehicle) : '',
    brandName: l.vehicle?.brand.name ?? null,
  }));
  return {
    id: p.id,
    customerId: p.customerId,
    account: p.account,
    paidDate: iso(p.paidDate),
    amount: Number(p.amount),
    whtAmount: Number(p.whtAmount),
    reference: p.reference,
    note: p.note,
    createdBy: nameOf(p.createdBy),
    createdAt: p.createdAt.toISOString(),
    cancelledAt: p.cancelledAt?.toISOString() ?? null,
    cancelReason: p.cancelReason,
    cancelledBy: nameOf(p.cancelledBy),
    linesTotal: round2(lines.reduce((s, l) => s + l.amount, 0)),
    lines,
  };
}

@Injectable()
export class CustomerPaymentsService {
  constructor(private readonly prisma: PrismaService) {}

  // การจ่ายของลูกค้า ใหม่สุดก่อนทีละ 50 ครั้ง (รวมที่ยกเลิกแล้ว - หน้าจอแสดงขีดฆ่า)
  async list(params: { customerId?: string; offset?: string }) {
    if (!params.customerId) throw bad('ต้องระบุลูกค้า');
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);
    const rows = await this.prisma.customerPayment.findMany({
      where: { customerId: params.customerId },
      orderBy: [{ paidDate: 'desc' }, { createdAt: 'desc' }],
      skip: offset,
      take: PAYMENT_PAGE + 1,
      include: PAYMENT_INCLUDE,
    });
    return { payments: rows.slice(0, PAYMENT_PAGE).map(mapPayment), hasMore: rows.length > PAYMENT_PAGE };
  }

  // ตารางล้อ: รถของลูกค้าที่ส่งงานในช่วงวันที่ (deliveredDate) พร้อมยอดที่ลูกค้าจ่ายมาแล้วรายคัน (ไม่นับการจ่ายที่ยกเลิก)
  // status: unpaid = ยังไม่มีการจ่าย, paid = มีแล้ว, ไม่ระบุ = ทั้งหมด
  async vehicles(params: { customerId?: string; from?: string; to?: string; status?: string }) {
    if (!params.customerId) throw bad('ต้องระบุลูกค้า');
    const deliveredDate: { gte?: Date; lte?: Date; not: null } = { not: null };
    if (params.from) deliveredDate.gte = parseIsoDate(params.from, 'วันที่เริ่ม');
    if (params.to) deliveredDate.lte = parseIsoDate(params.to, 'วันที่สิ้นสุด');
    const activeLine = { payment: { cancelledAt: null } };
    const paidFilter =
      params.status === 'unpaid' ? { paymentLines: { none: activeLine } } : params.status === 'paid' ? { paymentLines: { some: activeLine } } : {};
    const rows = await this.prisma.vehicle.findMany({
      where: { customerId: params.customerId, deletedAt: null, deliveredDate, ...paidFilter, ...vehicleTypeWhere() },
      orderBy: [{ deliveredDate: 'asc' }, { plateCategory: 'asc' }, { plateNumber: 'asc' }],
      take: VEHICLE_LIMIT + 1,
      select: {
        id: true,
        chassis: true,
        body: true,
        plateCategory: true,
        plateNumber: true,
        deliveredDate: true,
        billingClosedAt: true,
        brand: { select: { name: true } },
        documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { receiptNo: true, receiptAmount: true } },
        invoiceLines: { where: { invoice: { status: { not: 'VOID' } } }, take: 1, select: { invoice: { select: { invoiceNo: true } } } },
        paymentLines: { where: activeLine, select: { amount: true, payment: { select: { paidDate: true } } } },
      },
    });
    const vehicles = rows.slice(0, VEHICLE_LIMIT).map((v) => {
      const paid = v.paymentLines.map((l) => ({ amount: Number(l.amount), date: iso(l.payment.paidDate)! }));
      const sub = v.documentSubmissions[0];
      return {
        id: v.id,
        chassis: v.chassis,
        brandName: v.brand.name,
        body: v.body,
        plateText: plateOf(v),
        deliveredDate: iso(v.deliveredDate),
        receiptNo: sub?.receiptNo ?? null,
        receiptAmount: sub?.receiptAmount === null || sub?.receiptAmount === undefined ? null : Number(sub.receiptAmount),
        invoiceNo: v.invoiceLines[0]?.invoice.invoiceNo ?? null,
        billingClosed: v.billingClosedAt !== null,
        paidTotal: round2(paid.reduce((s, p) => s + p.amount, 0)),
        paymentCount: paid.length,
        lastPaidDate: paid.reduce<string | null>((max, p) => (!max || p.date > max ? p.date : max), null),
      };
    });
    return { vehicles, truncated: rows.length > VEHICLE_LIMIT };
  }

  // จับคู่เลขตัวถังที่ลูกค้าแจ้งกับรถของลูกค้า (ก่อนบันทึก) - ไม่เจอ = null, ยอดที่จ่ายมาแล้วของคันนั้นไว้เตือนจ่ายซ้ำ
  async match(dto: { customerId?: unknown; chassis?: unknown }) {
    if (typeof dto?.customerId !== 'string') throw bad('ต้องระบุลูกค้า');
    if (!Array.isArray(dto.chassis) || dto.chassis.some((c) => typeof c !== 'string')) throw bad('chassis ต้องเป็นรายการเลขตัวถัง');
    if (dto.chassis.length > MAX_LINES) throw bad(`ครั้งละไม่เกิน ${MAX_LINES} คัน`);
    const found = await this.findVehicles(dto.customerId, dto.chassis as string[]);
    return {
      rows: (dto.chassis as string[]).map((raw) => {
        const v = found.get(normalizeChassis(raw));
        return {
          chassis: raw,
          vehicle: v
            ? {
                id: v.id,
                chassis: v.chassis,
                plateText: plateOf(v),
                brandName: v.brand.name,
                deliveredDate: iso(v.deliveredDate),
                paidTotal: round2(v.paymentLines.reduce((s, l) => s + Number(l.amount), 0)),
              }
            : null,
        };
      }),
    };
  }

  async create(dto: CreatePaymentDto) {
    if (typeof dto?.customerId !== 'string') throw bad('ต้องระบุลูกค้า');
    const paidDate = parseIsoDate(dto.paidDate, 'วันที่เงินเข้า');
    const paidIso = iso(paidDate)!;
    if (paidIso > bangkokToday()) throw bad('วันที่เงินเข้าต้องไม่เกินวันนี้');
    const amount = parseMoney(dto.amount, 'ยอดที่โอนเข้า');
    if (amount <= 0) throw bad('ยอดที่โอนเข้าต้องมากกว่า 0');
    const whtAmount = dto.whtAmount === undefined || dto.whtAmount === null ? 0 : parseMoney(dto.whtAmount, 'หัก ณ ที่จ่าย');
    const reference = optionalText(dto.reference, 'เลขที่อ้างอิง', 100);
    const note = optionalText(dto.note, 'หมายเหตุ');
    if (dto.lines !== undefined && !Array.isArray(dto.lines)) throw bad('lines ต้องเป็นรายการ');
    const rawLines = (dto.lines ?? []) as Array<Record<string, unknown>>;
    if (rawLines.length > MAX_LINES) throw bad(`ครั้งละไม่เกิน ${MAX_LINES} คัน`);
    const seen = new Set<string>();
    const lineInputs = rawLines.map((l, i) => {
      const chassis = optionalText(l?.chassis, `แถวที่ ${i + 1}: เลขตัวถัง`, 50);
      if (!chassis) throw bad(`แถวที่ ${i + 1}: ต้องใส่เลขตัวถัง`);
      const key = normalizeChassis(chassis);
      if (seen.has(key)) throw bad(`เลขตัวถัง ${chassis} ซ้ำในการจ่ายครั้งนี้`);
      seen.add(key);
      return { chassis, amount: parseMoney(l.amount, `แถวที่ ${i + 1}: ยอด`), note: optionalText(l.note, `แถวที่ ${i + 1}: หมายเหตุ`) };
    });

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, select: { id: true, accountPeriods: { select: { account: true, effectiveFrom: true } } } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const account = accountOn(customer.accountPeriods.map((p) => ({ account: p.account, effectiveFrom: iso(p.effectiveFrom)! })), paidIso);

    // จับคู่ฝั่ง server เสมอ (ไม่เชื่อ vehicleId จากหน้าจอ) - รถนอกขอบเขตของผู้ใช้ (STAFF_CAR กับจักรยานยนต์) บันทึกไม่ได้
    const found = await this.findVehicles(customer.id, lineInputs.map((l) => l.chassis), false);
    const lines = lineInputs.map((l, i) => {
      const v = found.get(normalizeChassis(l.chassis));
      if (v) assertVehicleInScope(v.body);
      return { ...l, vehicleId: v?.id ?? null, sortOrder: i };
    });

    const created = await this.prisma.customerPayment.create({
      data: {
        customerId: customer.id,
        account,
        paidDate,
        amount,
        whtAmount,
        reference,
        note,
        createdById: currentUser()?.id ?? null,
        lines: { createMany: { data: lines } },
      },
      include: PAYMENT_INCLUDE,
    });
    return mapPayment(created);
  }

  // ยกเลิกการจ่ายที่บันทึกผิด (ไม่ลบ) - เหตุผลบังคับ + AuditLog, ยอดรายคันหลุดจากตารางล้อ
  async cancel(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิก');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    await this.prisma.$transaction(async (tx) => {
      const payment = await tx.customerPayment.findUnique({ where: { id }, select: { cancelledAt: true, amount: true, paidDate: true } });
      if (!payment) throw new NotFoundException({ error: 'ไม่พบรายการจ่าย' });
      const { count } = await tx.customerPayment.updateMany({
        where: { id, cancelledAt: null },
        data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null },
      });
      if (count === 0) throw new ConflictException({ error: 'รายการนี้ถูกยกเลิกไปแล้ว กรุณาโหลดใหม่' });
      await writeAudit(tx, {
        entity: 'CustomerPayment',
        entityId: id,
        action: 'cancel',
        remark,
        changes: { status: { from: 'ACTIVE', to: 'CANCELLED' }, amount: payment.amount, paidDate: payment.paidDate },
      });
    });
    const row = await this.prisma.customerPayment.findUnique({ where: { id }, include: PAYMENT_INCLUDE });
    return mapPayment(row!);
  }

  // รถของลูกค้าที่เลขตัวถังตรง (key = เลขตัวถังแบบ normalize) - scoped = กรองตามขอบเขตการอ่านของผู้ใช้
  private async findVehicles(customerId: string, chassisList: string[], scoped = true) {
    const keys = [...new Set(chassisList.map(normalizeChassis).filter(Boolean))];
    if (!keys.length) return new Map<string, never>();
    const rows = await this.prisma.vehicle.findMany({
      where: { customerId, deletedAt: null, chassis: { in: keys, mode: 'insensitive' }, ...(scoped ? vehicleTypeWhere() : {}) },
      select: {
        id: true,
        chassis: true,
        body: true,
        plateCategory: true,
        plateNumber: true,
        deliveredDate: true,
        brand: { select: { name: true } },
        paymentLines: { where: { payment: { cancelledAt: null } }, select: { amount: true } },
      },
    });
    return new Map(rows.map((v) => [normalizeChassis(v.chassis), v]));
  }
}
