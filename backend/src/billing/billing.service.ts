import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit, type AuditChanges } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import {
  computeDocumentFees,
  isMotorcycle,
  requestsPlateNumber,
  type DocumentFeeRuleSet,
  type NewPlateOption,
  type PlateNumberOption,
} from '../document-submission/document-fee-calculator.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ACCOUNT_LABEL, accountOn, isBillingAccount, type AccountPeriod } from './billing-account.js';
import { computeInvoiceTotals, nextInvoiceNo, rateAmountExVat, RATE_KINDS, round2, serviceFeeFromRate, suggestAddOns, suggestRate, type BillingTerms, type RateRow } from './billing-calculator.js';

// พื้นที่ทำงานบัญชี: วางบิลในนามบริษัท - รถเข้าคิวเมื่อพนักงานบันทึกส่งงานแล้ว (Vehicle.deliveredDate) และยังไม่อยู่ในบิลที่ยังใช้อยู่
// (บิลที่ VOID ไม่นับ - รถกลับเข้าคิว) เลขที่บิลพิมพ์เอง เพราะช่วงแรกยังรันเลขร่วมกับ Google Sheet ของงานประเภทอื่น
// รถที่ "ปิดงาน - วางบิลนอกระบบ" (Vehicle.billingClosedAt, ผู้ใช้ 2026-09-27) ไม่อยู่ในคิวและลงบิลในระบบไม่ได้จนกว่า ADMIN เปิดกลับ

const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;
const VEHICLE_KINDS = ['CAR', 'MOTO', 'ANY'];

// รายการบิลส่งประวัติ (รับเงินแล้ว / ยกเลิก) ทีละ 200 ใบ - บิลรอรับเงินส่งครบทุกใบเสมอ
const INVOICE_HISTORY_PAGE = 200;
// รายการรถที่ปิดงาน (วางบิลนอกระบบ) ใหม่สุดทีละ 100 คัน
const CLOSED_PAGE = 100;

const bad = (error: string) => new BadRequestException({ error });
const conflict = (error: string) => new ConflictException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const nameOf = (u: { name: string; displayName: string | null } | null) => (u ? u.displayName || u.name : null);
const plateOf = (v: { plateCategory: string | null; plateNumber: string | null }) => (v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : '');

type Extra = { label: string; amount: number };
type LineAmounts = { receiptAmount: number; serviceFee: number; serviceLabel: string | null; deduction: number; deductionNote: string | null };
const LINE_FIELDS = ['receiptAmount', 'serviceFee', 'serviceLabel', 'deduction', 'deductionNote'] as const;

// ข้อมูลรถที่บิลเก็บไว้ (snapshot) - ใช้ทั้งตอนออกบิลและตอน "ใช้ข้อมูลรถล่าสุด" ในหน้าแก้บิล (ผู้ใช้ 2026-09-27, F53a)
type LineSnapshot = { chassis: string; brandName: string; body: string | null; plateText: string; receiptNo: string | null; deliveredDate: Date | null };
const SNAPSHOT_FIELDS = ['chassis', 'brandName', 'body', 'plateText', 'receiptNo', 'deliveredDate'] as const;
type SnapshotSource = {
  chassis: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  deliveredDate: Date | null;
  brand: { name: string };
  documentSubmissions: Array<{ receiptNo: string | null }>; // การยื่นครั้งล่าสุด (QUEUE_VEHICLE_INCLUDE)
};
const lineSnapshotOf = (v: SnapshotSource): LineSnapshot => ({
  chassis: v.chassis,
  brandName: v.brand.name,
  body: v.body,
  plateText: plateOf(v),
  receiptNo: v.documentSubmissions[0]?.receiptNo ?? null,
  deliveredDate: v.deliveredDate,
});
const TOTAL_FIELDS = ['vatRate', 'whtRate', 'feeTotal', 'serviceTotal', 'vatAmount', 'whtAmount', 'netTotal'] as const;

// เลขที่บิลเดียวกันจาก 2 หน้าจอพร้อมกัน ผ่านการตรวจล่วงหน้าทั้งคู่ -> unique index ของ invoiceNo กันไว้อีกชั้น (Prisma P2002)
export function isInvoiceNoConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return false;
  // ชื่อคอลัมน์อยู่ใน meta.target หรือใน meta.driverAdapterError (แล้วแต่ adapter) - ไม่รู้คอลัมน์ = ถือว่าเป็นของ invoiceNo (unique เดียวของบิล)
  const meta = (err as { meta?: unknown }).meta;
  return meta === undefined || JSON.stringify(meta).includes('invoiceNo');
}

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

function parsePercent(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) throw bad(`${label}ต้องอยู่ระหว่าง 0 ถึง 100`);
  return round2(raw);
}

function optionalText(raw: unknown, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw bad(`${label}ต้องเป็นข้อความ`);
  return raw.trim() || null;
}

// ยอดรายคันของบิล (ใช้ทั้งออกบิลและแก้บิล) - serviceFee = ค่าดำเนินการหลังหัก deduction แล้ว / ไม่มียอดหัก = ไม่เก็บเหตุผลที่หัก
function parseLineAmounts(l: Record<string, unknown>): LineAmounts {
  const deduction = l.deduction === undefined || l.deduction === null ? 0 : parseMoney(l.deduction, 'ยอดหัก');
  return {
    receiptAmount: parseMoney(l.receiptAmount, 'ค่าใบเสร็จ'),
    serviceFee: parseMoney(l.serviceFee, 'ค่าดำเนินการ'),
    serviceLabel: optionalText(l.serviceLabel, 'หมายเหตุรายการ'),
    deduction,
    deductionNote: deduction > 0 ? optionalText(l.deductionNote, 'เหตุผลที่หัก') : null,
  };
}

function parseExtras(raw: unknown): Extra[] {
  return (Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []).map((e) => {
    const label = optionalText(e?.label, 'ชื่อค่าใช้จ่ายอื่นๆ');
    if (!label) throw bad('ค่าใช้จ่ายอื่นๆ ต้องมีชื่อรายการ');
    return { label, amount: parseMoney(e.amount, `จำนวนเงินของ "${label}"`) };
  });
}

const extrasOf = (raw: unknown): Extra[] =>
  (Array.isArray(raw) ? (raw as Array<{ label?: unknown; amount?: unknown }>) : []).map((e) => ({ label: String(e.label ?? ''), amount: Number(e.amount ?? 0) }));

const lineAmountsOf = (l: { receiptAmount: unknown; serviceFee: unknown; serviceLabel: string | null; deduction: unknown; deductionNote: string | null }): LineAmounts => ({
  receiptAmount: Number(l.receiptAmount),
  serviceFee: Number(l.serviceFee),
  serviceLabel: l.serviceLabel,
  deduction: Number(l.deduction),
  deductionNote: l.deductionNote,
});

type CustomerTermsRow = { billingVat: boolean; billingWhtRate: unknown; billingWhtSpecialRate: unknown; billingWhtSpecialUntil: Date | null };

function toTerms(c: CustomerTermsRow): BillingTerms {
  return { vat: c.billingVat, whtRate: Number(c.billingWhtRate), whtSpecialRate: num(c.billingWhtSpecialRate), whtSpecialUntil: iso(c.billingWhtSpecialUntil) };
}

type RateDbRow = {
  id: string;
  label: string;
  vehicleKind: string;
  ccMin: unknown;
  ccMax: unknown;
  chassisPrefix: string | null;
  amount: unknown;
  vatInclusive: boolean;
  includesReceipt: boolean;
  kind: string;
  sortOrder: number;
};

const toPeriods = (rows: Array<{ account: string; effectiveFrom: Date }>): AccountPeriod[] =>
  rows.map((p) => ({ account: p.account, effectiveFrom: iso(p.effectiveFrom)! }));

// บิลบัญชีบุคคลไม่มี VAT เสมอ (ผู้ใช้ 2026-09-27) ไม่ว่าเงื่อนไข VAT ของลูกค้าจะตั้งไว้อย่างไร - หัก ณ ที่จ่ายยังตามลูกค้า (SPI หัก, YMAC ไม่หัก)
const termsFor = (account: string, terms: BillingTerms): BillingTerms => (account === 'PERSONAL' ? { ...terms, vat: false } : terms);

const feeRows = (rows: Array<{ key: string; amount: unknown }>) => rows.map((r) => ({ key: r.key, amount: r.amount === null ? null : Number(r.amount) }));

// ยอด Bill ที่ควรเป็นจากข้อมูลรถ "ล่าสุด" + ตัวเลือกตอนยื่น (ผู้ใช้ 2026-09-28): แก้จังหวัดหลังยื่นแล้ว ยอดที่ใช้เทียบใบเสร็จตามไปด้วย
// คำนวณแบบเดียวกับตอนยื่น (computeDocumentFees) + ภาษีที่ยื่นไว้ - คำนวณไม่ได้ (ไม่มีภาษี / ไม่มีตารางอัตรา) = null ให้ใช้ยอดตอนยื่นแทน
function currentBillEstimate(
  vehicle: { body: string | null; registrationProvince: string | null; ownerProvince: string | null },
  sub: {
    taxAmount: unknown;
    plateNumberOption: string;
    includePlateFee: boolean;
    newPlateOption: string | null;
    relocateAddon: boolean;
    stopUseRelocateOut: boolean;
    urgent: boolean;
  } | undefined,
  rules: DocumentFeeRuleSet | null,
): number | null {
  if (!sub || !rules || sub.taxAmount === null) return null;
  try {
    const fee = computeDocumentFees(
      vehicle,
      {
        plateNumberOption: sub.plateNumberOption as PlateNumberOption,
        includePlateFee: sub.includePlateFee,
        newPlateOption: sub.newPlateOption as NewPlateOption | null,
        relocateAddon: sub.relocateAddon,
        stopUseRelocateOut: sub.stopUseRelocateOut,
        urgent: sub.urgent,
      },
      rules,
    );
    return round2(fee.billTotal + Number(sub.taxAmount));
  } catch {
    return null;
  }
}

function toRate(r: RateDbRow): RateRow {
  return {
    id: r.id,
    label: r.label,
    vehicleKind: r.vehicleKind,
    ccMin: num(r.ccMin),
    ccMax: num(r.ccMax),
    chassisPrefix: r.chassisPrefix,
    amount: Number(r.amount),
    vatInclusive: r.vatInclusive,
    includesReceipt: r.includesReceipt,
    kind: r.kind,
    sortOrder: r.sortOrder,
  };
}

const QUEUE_VEHICLE_INCLUDE = {
  brand: { select: { name: true } },
  // การยื่นครั้งล่าสุด = ใบเสร็จที่ใช้วางบิล (รถที่ส่งงานแล้วต้องเคยได้รับใบเสร็จ)
  documentSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: {
      status: true,
      receiptNo: true,
      receiptAmount: true,
      billFeeTotal: true,
      taxAmount: true,
      plateNumberOption: true,
      urgent: true,
      // ตัวเลือกตอนยื่น - ใช้คำนวณยอด Bill ใหม่จากข้อมูลรถล่าสุด (เทียบกับใบเสร็จ)
      includePlateFee: true,
      newPlateOption: true,
      relocateAddon: true,
      stopUseRelocateOut: true,
      // รูปใบเสร็จของการยื่นล่าสุด - หน้าวางบิลแสดงให้เทียบยอด (ผู้ใช้ 2026-09-28)
      receipts: { orderBy: { createdAt: 'desc' as const }, select: { id: true } },
    },
  },
} as const;

export interface CreateInvoiceDto {
  customerId?: unknown;
  invoiceNo?: unknown;
  issueDate?: unknown;
  jobLabel?: unknown;
  lines?: unknown;
  extras?: unknown;
}

// แก้บิลที่ยังไม่รับเงิน (ผู้ใช้ 2026-09-27) - ช่องที่ไม่ส่งมา = ไม่แก้
export interface UpdateInvoiceDto {
  issueDate?: unknown;
  jobLabel?: unknown;
  extras?: unknown; // ส่งมา = แทนที่ทั้งชุด
  lines?: unknown; // [{ id (InvoiceLine.id), receiptAmount, serviceFee, serviceLabel, deduction, deductionNote }] เฉพาะคันที่แก้
  removeLineIds?: unknown; // คันที่เอาออกจากบิล - รถกลับเข้าคิวรอวางบิล
  // คันที่ให้ดึงข้อมูลรถล่าสุดลงบิล (ทะเบียน เลขที่ใบเสร็จ ยี่ห้อ ประเภทรถ เลขตัวถัง วันที่ส่งงาน) - เช่น แก้ทะเบียนที่ AI อ่านผิดหลังออกบิล
  refreshLineIds?: unknown;
  applyCurrentTerms?: unknown; // true = คิด VAT / หัก ณ ที่จ่ายใหม่ตามเงื่อนไขปัจจุบันของลูกค้า ณ วันออกบิล
  expectedUpdatedAt?: unknown; // updatedAt ของบิลตอนเปิดหน้าแก้ - ไม่ตรง = มีคนแก้/เปลี่ยนสถานะไปก่อน (409)
  remark?: unknown;
}

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // คิวรอวางบิล จัดกลุ่มตามลูกค้า พร้อมเงื่อนไขวางบิล ตารางราคา และค่าดำเนินการที่ระบบเสนอให้รายคัน
  // รถที่ถูกลบ (deletedAt) และรถที่ปิดงาน - วางบิลนอกระบบ (billingClosedAt) ไม่อยู่ในคิว
  async queue() {
    const waiting = { deletedAt: null, billingClosedAt: null, deliveredDate: { not: null }, invoiceLines: { none: NOT_VOID } };
    const [customers, lastInvoice, lastPersonal] = await Promise.all([
      this.prisma.customer.findMany({
        where: { vehicles: { some: waiting } },
        orderBy: { name: 'asc' },
        include: {
          serviceFeeRates: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
          accountPeriods: { select: { account: true, effectiveFrom: true } },
          vehicles: {
            where: waiting,
            orderBy: [{ deliveredDate: 'asc' }, { plateCategory: 'asc' }, { plateNumber: 'asc' }],
            include: QUEUE_VEHICLE_INCLUDE,
          },
        },
      }),
      this.prisma.invoice.findFirst({ where: { account: 'COMPANY' }, orderBy: { createdAt: 'desc' }, select: { invoiceNo: true } }),
      this.prisma.invoice.findFirst({ where: { account: 'PERSONAL' }, orderBy: { createdAt: 'desc' }, select: { invoiceNo: true } }),
    ]);

    const today = bangkokToday();
    const feeRules = await this.loadFeeRules();
    return {
      // เลขบิลรันแยกตามบัญชี - บัญชีบุคคลยังไม่เคยออก = ว่าง ให้พิมพ์เลขแรกเอง
      suggestedInvoiceNo: nextInvoiceNo(lastInvoice?.invoiceNo ?? null),
      suggestedPersonalInvoiceNo: nextInvoiceNo(lastPersonal?.invoiceNo ?? null),
      // เลขล่าสุดที่ออกในระบบ (แสดงใต้ช่องเลขที่ให้เทียบก่อนกรอก - ผู้ใช้ 2026-09-28)
      lastInvoiceNo: lastInvoice?.invoiceNo ?? null,
      lastPersonalInvoiceNo: lastPersonal?.invoiceNo ?? null,
      customers: customers.map((c) => {
        const rates = c.serviceFeeRates.map(toRate);
        const periods = toPeriods(c.accountPeriods ?? []);
        return {
          id: c.id,
          name: c.name,
          company: c.company,
          branch: c.branch,
          address: c.address,
          taxId: c.taxId,
          account: accountOn(periods, today),
          terms: toTerms(c),
          rates,
          vehicles: c.vehicles.map((v) => {
            const sub = v.documentSubmissions[0];
            const isMoto = isMotorcycle(v.body);
            const cc = num(v.cc);
            const rate = suggestRate(rates, { isMoto, cc, chassis: v.chassis });
            // ยอดบนใบเสร็จจริงมาก่อน ถ้าพนักงานไม่ได้กรอกไว้ใช้ยอด Bill ที่ระบบคำนวณ (ค่าธรรมเนียม + ภาษี) แทนและบอกให้บัญชีตรวจ
            const receiptAmount = num(sub?.receiptAmount);
            const estimate = sub && sub.taxAmount !== null ? round2(Number(sub.billFeeTotal) + Number(sub.taxAmount)) : null;
            const requestedPlateNumber = requestsPlateNumber(sub?.plateNumberOption);
            const urgent = sub?.urgent ?? false;
            // ขอใช้ = จดจังหวัดอื่น (จังหวัดที่จดทะเบียน ≠ จังหวัดเจ้าของรถ) เงื่อนไขเดียวกับค่าธรรมเนียมอื่นๆ 20 ตอนยื่น (document-fee-calculator)
            const otherProvince = !!v.registrationProvince && !!v.ownerProvince && v.registrationProvince !== v.ownerProvince;
            const addOns = suggestAddOns(rates, { isMoto, otherProvince, urgent, requestedPlateNumber });
            const base = rate ? serviceFeeFromRate(rate, receiptAmount ?? estimate) : null;
            return {
              id: v.id,
              chassis: v.chassis,
              brandName: v.brand.name,
              body: v.body,
              isMoto,
              cc,
              plateCategory: v.plateCategory,
              plateNumber: v.plateNumber,
              deliveredDate: iso(v.deliveredDate),
              // บัญชีของงานคันนี้ = บัญชีของลูกค้า ณ วันส่งงาน (ย้ายบัญชีแล้วงานที่ส่งก่อนวันย้ายยังอยู่บัญชีเดิม)
              account: accountOn(periods, iso(v.deliveredDate)!),
              recipient: v.deliveryRecipient,
              plateDelivered: v.plateDeliveredDate !== null,
              receiptNo: sub?.receiptNo ?? null,
              receiptAmount: receiptAmount ?? estimate,
              receiptAmountSource: receiptAmount !== null ? 'RECEIPT' : estimate !== null ? 'BILL_ESTIMATE' : 'NONE',
              // ยอด Bill ที่ระบบคำนวณตอนยื่นจากข้อมูลรถ (ค่าธรรมเนียม + ภาษี) - หน้าวางบิลเทียบกับยอดใบเสร็จจริง ไม่ตรง = เตือน
              // (ผู้ใช้ 2026-09-28: พบรถ 2 คันที่ใบเสร็จเป็นขอใช้แต่จังหวัดในข้อมูลรถบอกไม่ใช่ ค่าบริการเลยผิดคันละ 100)
              receiptEstimate: currentBillEstimate(v, sub, feeRules) ?? estimate,
              receiptImageIds: sub?.receipts?.map((r) => r.id) ?? [],
              // ขอใช้เลขทะเบียน - เผื่อเคสลูกค้าชำระค่าขอใช้เลขเอง; SWAP_* (มีคนทำสลับเลขมาให้) ไม่ใช่การขอใช้เลข (ผู้ใช้ 2026-09-27)
              requestedPlateNumber,
              urgent,
              otherProvince,
              // จับคู่ราคาอัตโนมัติจากข้อมูลรถ (ผู้ใช้ 2026-09-28): ราคาหลักตามชนิดรถ/CC + ค่าเพิ่มขอใช้ (จดจังหวัดอื่น) / ด่วนตามการยื่นล่าสุด
              // หน้าจอเปลี่ยนแถวราคา / ติ๊กค่าเพิ่มเองได้ แล้วคิดค่าดำเนินการใหม่ฝั่งหน้าจอ (บิลเก็บเป็นยอด ไม่ผูกกับแถวราคา)
              suggestedRateId: rate?.id ?? null,
              suggestedAddOnIds: addOns.map((a) => a.id),
              suggestedServiceFee: base === null ? null : round2(base + addOns.reduce((s, a) => s + rateAmountExVat(a), 0)),
            };
          }),
        };
      }),
    };
  }

  // เงื่อนไขวางบิลปัจจุบันของลูกค้า - หน้าแก้บิลใช้เทียบกับอัตราที่บิลออกไป (ลูกค้าที่ไม่มีรถในคิวไม่อยู่ใน queue())
  async getTerms(customerId: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    return toTerms(customer);
  }

  // เงื่อนไขวางบิลเป็นข้อมูลลูกค้า -> ต้องมีเหตุผลและเก็บค่าก่อน/หลังลง AuditLog เหมือนหน้าแก้ไขลูกค้า (ผู้ใช้ 2026-09-27, F25)
  // ประวัติแสดงรวมกับการแก้ข้อมูลลูกค้าในหน้าลูกค้า (entity Customer) · บิลที่ออกไปแล้วไม่เปลี่ยน
  async updateTerms(customerId: string, dto: { vat?: unknown; whtRate?: unknown; whtSpecialRate?: unknown; whtSpecialUntil?: unknown; remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้เงื่อนไขวางบิล');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    if (typeof dto?.vat !== 'boolean') throw bad('ต้องระบุว่ามี VAT หรือไม่');
    const whtRate = parsePercent(dto.whtRate, 'อัตราหัก ณ ที่จ่าย');
    const hasSpecial = dto.whtSpecialRate !== null && dto.whtSpecialRate !== undefined;
    const whtSpecialRate = hasSpecial ? parsePercent(dto.whtSpecialRate, 'อัตราหัก ณ ที่จ่ายพิเศษ') : null;
    if (hasSpecial && !dto.whtSpecialUntil) throw bad('อัตราพิเศษต้องระบุวันสุดท้ายที่ใช้');
    const whtSpecialUntil = hasSpecial ? parseIsoDate(dto.whtSpecialUntil, 'วันสุดท้ายของอัตราพิเศษ') : null;
    const data = { billingVat: dto.vat, billingWhtRate: whtRate, billingWhtSpecialRate: whtSpecialRate, billingWhtSpecialUntil: whtSpecialUntil };

    return this.prisma.$transaction(async (tx) => {
      // ล็อกแถวก่อนอ่านค่าเดิม เหมือน CustomersService.update: แก้พร้อมกัน 2 หน้าจอ ประวัติต้องมีค่า "ก่อนแก้" ที่ถูกต้อง
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      const current = await tx.customer.findUnique({ where: { id: customerId } });
      if (!current) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
      const changes = diffChanges(current, data);
      if (!Object.keys(changes).length) throw bad('เงื่อนไขวางบิลเหมือนเดิม - ไม่มีอะไรต้องแก้');
      const updated = await tx.customer.update({ where: { id: customerId }, data });
      await writeAudit(tx, { entity: 'Customer', entityId: customerId, action: 'update-terms', remark, changes });
      return toTerms(updated);
    });
  }

  // ---------- บัญชีรับเงินของลูกค้า (ผู้ใช้ 2026-09-26/27) ----------
  // ประวัติบัญชีเรียงวันเริ่มใช้ + บัญชีที่ใช้วันนี้
  async accountPeriods(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: {
        accountPeriods: { orderBy: { effectiveFrom: 'asc' }, include: { createdBy: { select: { name: true, displayName: true } } } },
      },
    });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const rows = customer.accountPeriods;
    return {
      current: accountOn(toPeriods(rows), bangkokToday()),
      periods: rows.map((p) => ({
        id: p.id,
        account: p.account,
        effectiveFrom: iso(p.effectiveFrom),
        remark: p.remark,
        createdBy: nameOf(p.createdBy),
        createdAt: p.createdAt.toISOString(),
      })),
    };
  }

  // ตั้ง/ย้ายบัญชีตั้งแต่วันที่ effectiveFrom (เหตุผลบังคับ + AuditLog ของลูกค้า) - วันเดียวกับแถวเดิม = แก้แถวนั้น
  // งานก่อนวันนั้นยังอยู่บัญชีเดิม · บัญชีที่ใช้อยู่แล้ว ณ วันนั้นตั้งซ้ำไม่ได้
  async setAccount(customerId: string, dto: { account?: unknown; effectiveFrom?: unknown; remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ตั้ง/ย้ายบัญชี');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    if (!isBillingAccount(dto.account)) throw bad('บัญชีต้องเป็น COMPANY หรือ PERSONAL');
    const account = dto.account;
    const effectiveFrom = parseIsoDate(dto.effectiveFrom, 'วันที่เริ่มใช้');
    const fromIso = iso(effectiveFrom)!;

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, accountPeriods: true } });
      if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
      const sameDay = customer.accountPeriods.find((p) => iso(p.effectiveFrom) === fromIso);
      const others = toPeriods(customer.accountPeriods.filter((p) => p !== sameDay));
      // บัญชีที่มีผลก่อนวันนี้ (ไม่นับแถววันเดียวกัน) - ตั้งบัญชีเดิมซ้ำ = ไม่มีอะไรเปลี่ยน
      const before = accountOn(others, fromIso);
      if (sameDay?.account === account || (!sameDay && before === account)) {
        throw bad(`ตั้งแต่ ${dmy(fromIso)} ลูกค้ารายนี้ใช้${ACCOUNT_LABEL[account]}อยู่แล้ว`);
      }
      const createdById = currentUser()?.id ?? null;
      if (sameDay) {
        await tx.customerAccountPeriod.update({ where: { id: sameDay.id }, data: { account, remark, createdById } });
      } else {
        await tx.customerAccountPeriod.create({ data: { customerId, account, effectiveFrom, remark, createdById } });
      }
      await writeAudit(tx, {
        entity: 'Customer',
        entityId: customerId,
        action: 'set-account',
        remark,
        changes: { [`บัญชีรับเงิน ตั้งแต่ ${fromIso}`]: { from: sameDay?.account ?? before, to: account } },
      });
    });
    return this.accountPeriods(customerId);
  }

  // บันทึกตารางค่าดำเนินการของลูกค้าทั้งชุด (แทนที่ของเดิม) - ลำดับในรายการ = ลำดับที่ใช้จับคู่
  async replaceRates(customerId: string, dto: { rates?: unknown }) {
    if (!Array.isArray(dto?.rates)) throw bad('rates ต้องเป็นรายการ');
    const rows = (dto.rates as Array<Record<string, unknown>>).map((r, i) => {
      const label = optionalText(r?.label, 'ชื่อรายการ');
      if (!label) throw bad(`แถวที่ ${i + 1}: ต้องใส่ชื่อรายการ`);
      const kind = r.kind === undefined || r.kind === null ? 'BASE' : (RATE_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as string) : null;
      if (!kind) throw bad(`แถวที่ ${i + 1}: ประเภทราคาต้องเป็น BASE, OTHER_PROVINCE, URGENT หรือ PLATE_REQUEST`);
      const vehicleKind = typeof r.vehicleKind === 'string' && VEHICLE_KINDS.includes(r.vehicleKind) ? r.vehicleKind : null;
      if (!vehicleKind) throw bad(`แถวที่ ${i + 1}: ชนิดรถต้องเป็น CAR, MOTO หรือ ANY`);
      const ccMin = r.ccMin === null || r.ccMin === undefined ? null : parseMoney(r.ccMin, `แถวที่ ${i + 1}: CC ตั้งแต่`);
      const ccMax = r.ccMax === null || r.ccMax === undefined ? null : parseMoney(r.ccMax, `แถวที่ ${i + 1}: CC น้อยกว่า`);
      if (ccMin !== null && ccMax !== null && ccMin >= ccMax) throw bad(`แถวที่ ${i + 1}: ช่วง CC ไม่ถูกต้อง`);
      // ราคาแยกตามเลขตัวถังขึ้นต้น (ผู้ใช้ 2026-09-28, MC Superbike) - เว้นว่างได้ ไม่จำกัดชนิด/ความยาว
      const chassisPrefix = optionalText(r.chassisPrefix, `แถวที่ ${i + 1}: เลขตัวถังขึ้นต้น`);
      return {
        customerId,
        label,
        vehicleKind,
        ccMin,
        ccMax,
        chassisPrefix,
        amount: parseMoney(r.amount, `แถวที่ ${i + 1}: ราคา`),
        vatInclusive: r.vatInclusive === true,
        includesReceipt: r.includesReceipt === true,
        kind,
        sortOrder: i,
      };
    });

    const exists = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!exists) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    await this.prisma.$transaction([this.prisma.serviceFeeRate.deleteMany({ where: { customerId } }), this.prisma.serviceFeeRate.createMany({ data: rows })]);
    const saved = await this.prisma.serviceFeeRate.findMany({ where: { customerId }, orderBy: { sortOrder: 'asc' } });
    return saved.map(toRate);
  }

  async createInvoice(dto: CreateInvoiceDto) {
    const invoiceNo = optionalText(dto?.invoiceNo, 'เลขที่บิล');
    if (!invoiceNo) throw bad('ต้องใส่เลขที่บิล');
    const issueDate = parseIsoDate(dto.issueDate, 'วันที่ออกบิล');
    const jobLabel = optionalText(dto.jobLabel, 'ชื่องาน');
    if (!jobLabel) throw bad('ต้องใส่ชื่องานที่จะแสดงบนบิล');
    if (typeof dto.customerId !== 'string') throw bad('ต้องระบุลูกค้า');
    if (!Array.isArray(dto.lines) || dto.lines.length === 0) throw bad('ต้องเลือกรถอย่างน้อย 1 คัน');

    const lineInputs = (dto.lines as Array<Record<string, unknown>>).map((l) => {
      if (typeof l?.vehicleId !== 'string') throw bad('รายการรถไม่ถูกต้อง');
      return { vehicleId: l.vehicleId, ...parseLineAmounts(l) };
    });
    if (new Set(lineInputs.map((l) => l.vehicleId)).size !== lineInputs.length) throw bad('มีรถซ้ำในบิล');

    const extras = parseExtras(dto.extras);

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, include: { accountPeriods: { select: { account: true, effectiveFrom: true } } } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const periods = toPeriods(customer.accountPeriods ?? []);
    if (await this.prisma.invoice.findUnique({ where: { invoiceNo }, select: { id: true } })) throw bad(`เลขที่บิล ${invoiceNo} ถูกใช้ไปแล้ว`);

    // ออกบิลพร้อมกัน 2 หน้าจอด้วยรถคันเดียวกัน (พบ 2026-09-27): ล็อกแถวรถในบิลก่อน แล้วค่อยอ่าน/ตรวจรถใน transaction เดียวกัน
    // อีกคำขอต้องรอจนบิลนี้บันทึกเสร็จ แล้วจะเห็นว่ารถอยู่ในบิลแล้ว - กันรถคันเดียวอยู่ใน 2 บิลที่ยังใช้อยู่ (ล็อกเรียงตาม id กัน deadlock)
    const vehicleIds = lineInputs.map((l) => l.vehicleId);
    let invoice;
    try {
      invoice = await this.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ANY(${vehicleIds}::text[]) ORDER BY "id" FOR UPDATE`;
          const vehicles = await tx.vehicle.findMany({
            where: { id: { in: vehicleIds } },
            include: { ...QUEUE_VEHICLE_INCLUDE, invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } } },
          });
          const byId = new Map(vehicles.map((v) => [v.id, v]));
          const lines = lineInputs.map((l) => {
            const v = byId.get(l.vehicleId);
            if (!v) throw bad('ไม่พบข้อมูลรถบางคันในบิล');
            if (v.customerId !== customer.id) throw bad(`รถ ${v.chassis} ไม่ใช่ของลูกค้ารายนี้`);
            if (!v.deliveredDate) throw bad(`รถ ${v.chassis} ยังไม่ได้บันทึกส่งงาน`);
            if (v.invoiceLines.length > 0) throw bad(`รถ ${v.chassis} อยู่ในบิล ${v.invoiceLines[0].invoice.invoiceNo} แล้ว`);
            // ปิดงาน - วางบิลนอกระบบแล้ว (ผู้ใช้ 2026-09-27): ลงบิลซ้ำในระบบไม่ได้ ต้องให้ ADMIN เปิดกลับก่อน
            if (v.billingClosedAt) throw bad(`รถ ${v.chassis} ปิดงาน (วางบิลนอกระบบ) ไปแล้ว`);
            return { ...l, ...lineSnapshotOf(v), deliveredDate: v.deliveredDate };
          });

          // บัญชีของบิล = บัญชีของลูกค้า ณ วันส่งงานของรถ - บิลเดียวต้องอยู่บัญชีเดียว (ช่วงย้ายบัญชีต้องแยกบิล)
          const accounts = new Set(lines.map((l) => accountOn(periods, iso(l.deliveredDate)!)));
          if (accounts.size > 1) throw bad('รถในบิลนี้ส่งงานคนละช่วงบัญชี (บริษัท/บุคคล) - แยกออกเป็นบิลละบัญชี');
          const account = [...accounts][0];
          const issueIso = issueDate.toISOString().slice(0, 10);
          const totals = computeInvoiceTotals({ lines, extras, terms: termsFor(account, toTerms(customer)), issueDate: issueIso });

          return tx.invoice.create({
            data: {
              invoiceNo,
              issueDate,
              account,
              customerId: customer.id,
              customerSnapshot: { name: customer.company || customer.name, branch: customer.branch, address: customer.address, taxId: customer.taxId },
              jobLabel,
              extras,
              vatRate: totals.vatRate,
              whtRate: totals.whtRate,
              feeTotal: totals.feeTotal,
              serviceTotal: totals.serviceTotal,
              vatAmount: totals.vatAmount,
              whtAmount: totals.whtAmount,
              netTotal: totals.netTotal,
              // createMany = คำสั่งเดียว บิลหลายสิบคันไม่ชน timeout ของ transaction
              lines: { createMany: { data: lines } },
            },
            include: { lines: true },
          });
        },
        { timeout: 20_000 },
      );
    } catch (err) {
      if (isInvoiceNoConflict(err)) throw bad(`เลขที่บิล ${invoiceNo} ถูกใช้ไปแล้ว`);
      throw err;
    }
    return this.mapInvoice(invoice);
  }

  // บิลรอรับเงินทุกใบ + ประวัติ (รับเงินแล้ว / ยกเลิก) ใหม่สุดทีละ 200 ใบ (พบ 2026-09-27: เดิมจำกัด 200 ใบรวมทุกสถานะ
  // บิลค้างรับเงินเก่าหลุดจากหน้าจอ กดรับเงิน/ยกเลิกไม่ได้ และยอดรอรับเงินต่ำกว่าหน้าภาพรวม)
  // offset = ข้ามประวัติไปกี่ใบ สำหรับปุ่ม "โหลดเพิ่ม" (ส่งกลับเฉพาะประวัติ), limit = ขนาดหน้าประวัติ สูงสุด 1,000
  // ใช้ตอนโหลดใหม่หลังรับเงิน/ยกเลิกให้ได้เท่าที่เปิดดูอยู่ - outstanding = บิล ISSUED ทั้งหมด ตรงกับหน้าภาพรวม
  async listInvoices(params: { offset?: string; limit?: string } = {}) {
    const pageSize = Math.min(1000, Math.max(1, Number.parseInt(params.limit ?? String(INVOICE_HISTORY_PAGE), 10) || INVOICE_HISTORY_PAGE));
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);
    const orderBy = [{ issueDate: 'desc' as const }, { createdAt: 'desc' as const }];
    // อ่านทั้ง 3 ใน snapshot เดียวกัน (พบ 2026-09-27): อ่านแยกกันแล้วมีคนกดรับเงิน/ยกเลิกบิลระหว่างนั้น บิลใบเดียวมา 2 แถว
    // (รอรับเงิน + ประวัติ) และยอดรอรับเงินไม่ตรงกับรายการ - อ่านอย่างเดียวใน RepeatableRead ไม่มี serialization error
    const { issued, history, outstanding, audits } = await this.prisma.$transaction(
      async (tx) => {
        const issued = offset === 0 ? await tx.invoice.findMany({ where: { status: 'ISSUED' }, orderBy, include: { lines: true } }) : [];
        const history = await tx.invoice.findMany({
          where: { status: { not: 'ISSUED' } },
          orderBy,
          skip: offset,
          take: pageSize + 1, // เกินมา 1 ใบ = ยังมีหน้าถัดไป
          include: { lines: true },
        });
        const outstanding = await tx.invoice.aggregate({ where: { status: 'ISSUED' }, _count: { _all: true }, _sum: { netTotal: true } });
        // จำนวนประวัติแก้/ยกเลิก/ย้อนรับเงินของแต่ละใบ (AuditLog) - หน้าจอแสดงปุ่ม "ประวัติ" เฉพาะใบที่มี
        const ids = [...issued, ...history].map((i) => i.id);
        const audits = ids.length
          ? await tx.auditLog.groupBy({ by: ['entityId'], where: { entity: 'Invoice', entityId: { in: ids } }, _count: { _all: true } })
          : [];
        return { issued, history, outstanding, audits };
      },
      { isolationLevel: 'RepeatableRead', timeout: 20_000 }, // บิลรอรับเงินหลายร้อยใบพร้อมรายการรถ เกิน 5 วินาทีตั้งต้นได้
    );
    const historyCount = new Map(audits.map((a) => [a.entityId, a._count._all]));
    // กันไว้อีกชั้น: บิลที่มาทั้ง 2 ชุดใช้แถวประวัติ (สถานะใหม่กว่า) ไม่ให้แถวรอรับเงินเก่ายังมีปุ่มรับเงิน/ยกเลิก
    const page = history.slice(0, pageSize);
    const historyIds = new Set(page.map((i) => i.id));
    const invoices = [...issued.filter((i) => !historyIds.has(i.id)), ...page].sort(
      (a, b) => b.issueDate.getTime() - a.issueDate.getTime() || b.createdAt.getTime() - a.createdAt.getTime(),
    );
    return {
      invoices: invoices.map((i) => this.mapInvoice(i, historyCount.get(i.id) ?? 0)),
      hasMore: history.length > pageSize,
      outstanding: { count: outstanding._count._all, total: round2(Number(outstanding._sum.netTotal ?? 0)) },
    };
  }

  // บันทึกรับเงิน: วันที่รับเงินต้องไม่ก่อนวันออกบิลและไม่เกินวันนี้ตามเวลาไทย (พบ 2026-09-27: วันที่ผิดทำให้เงินเข้า/วันเก็บเงิน
  // ของลูกค้าในหน้าภาพรวมเพี้ยน และบิลที่รับเงินแล้วยังแก้ไม่ได้) เปลี่ยนสถานะแบบมีเงื่อนไข ISSUED -> PAID
  // กันกดรับเงินกับยกเลิกบิลใบเดียวกันพร้อมกันจาก 2 หน้าจอ (ใครบันทึกก่อนได้ อีกคนได้ข้อความว่าบิลเปลี่ยนสถานะแล้ว)
  // สถานะไม่ตรงกับที่ต้องการ = หน้าจอเก่า (อีกหน้าจอเปลี่ยนไปก่อน) ตอบ 409 ให้หน้ารายการบิลโหลดใหม่ - ใช้เหมือนกันทั้ง
  // รับเงิน / ยกเลิกบิล / ยกเลิกการรับเงิน / แก้บิล (พบ 2026-09-27: เดิมตอบ 400 หน้าจอไม่โหลดใหม่ บิลค้างสถานะเก่าพร้อมปุ่มเดิม)
  async markPaid(id: string, dto: { paidDate?: unknown; taxInvoiceNo?: unknown }) {
    const paidDate = parseIsoDate(dto?.paidDate, 'วันที่รับเงิน');
    const taxInvoiceNo = optionalText(dto.taxInvoiceNo, 'เลขที่ใบกำกับภาษี');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true, issueDate: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    if (invoice.status !== 'ISSUED') throw conflict('บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน');
    const paidIso = paidDate.toISOString().slice(0, 10);
    const issuedIso = invoice.issueDate.toISOString().slice(0, 10);
    if (paidIso < issuedIso) throw bad(`วันที่รับเงินต้องไม่ก่อนวันที่ออกบิล (${dmy(issuedIso)})`);
    if (paidIso > bangkokToday()) throw bad('วันที่รับเงินต้องไม่เกินวันนี้');
    const { count } = await this.prisma.invoice.updateMany({ where: { id, status: 'ISSUED' }, data: { status: 'PAID', paidDate, taxInvoiceNo } });
    if (count === 0) throw conflict('บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน');
    return this.mapInvoice(await this.invoiceWithLines(id));
  }

  // ยกเลิกบิล - รถทุกคันในบิลกลับเข้าคิวรอวางบิล ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน (เปลี่ยนสถานะแบบมีเงื่อนไขเหมือน markPaid)
  // บันทึกประวัติ (AuditLog) ว่าใครยกเลิก - ช่อง voidReason บนบิลเก็บแค่เหตุผล (ผู้ใช้ 2026-09-27: ทุกการยกเลิกต้องมีประวัติ)
  async voidInvoice(id: string, dto: { reason?: unknown }) {
    const voidReason = optionalText(dto?.reason, 'เหตุผล');
    if (!voidReason) throw bad('ต้องใส่เหตุผลที่ยกเลิกบิล');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    if (invoice.status !== 'ISSUED') throw conflict('ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน');
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.invoice.updateMany({ where: { id, status: 'ISSUED' }, data: { status: 'VOID', voidReason } });
      if (count === 0) throw conflict('ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน');
      await writeAudit(tx, { entity: 'Invoice', entityId: id, action: 'void', remark: voidReason, changes: { status: { from: 'ISSUED', to: 'VOID' } } });
    });
    return this.mapInvoice(await this.invoiceWithLines(id));
  }

  // ยกเลิกการรับเงิน (ผู้ใช้ 2026-09-27): ADMIN / ACCOUNTANT (access-policy.ts) ย้อนบิลที่รับเงินแล้วกลับเป็นรอรับเงิน พร้อมเหตุผล
  // ใช้กับกดรับเงินผิดใบ / วันที่รับเงินผิด / เลข TV ผิด - ล้างวันที่รับเงินและเลข TV (ค่าเดิมเก็บในประวัติ) แล้วบันทึกรับเงินใหม่
  // หรือแก้/ยกเลิกบิลต่อได้ตามปกติ · เปลี่ยนสถานะแบบมีเงื่อนไข PAID เหมือน markPaid กันกดพร้อมกัน 2 หน้าจอ
  async unpayInvoice(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิกการรับเงิน');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true, paidDate: true, taxInvoiceNo: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    if (invoice.status !== 'PAID') throw conflict('ยกเลิกการรับเงินได้เฉพาะบิลที่รับเงินแล้ว');
    await this.prisma.$transaction(async (tx) => {
      // เงื่อนไขรวมวันที่/เลข TV ที่อ่านมา: ประวัติต้องตรงกับค่าที่ถูกล้างจริง
      const { count } = await tx.invoice.updateMany({
        where: { id, status: 'PAID', paidDate: invoice.paidDate, taxInvoiceNo: invoice.taxInvoiceNo },
        data: { status: 'ISSUED', paidDate: null, taxInvoiceNo: null },
      });
      if (count === 0) throw conflict('บิลนี้เปลี่ยนสถานะไปแล้ว กรุณาโหลดรายการใหม่');
      await writeAudit(tx, {
        entity: 'Invoice',
        entityId: id,
        action: 'unpay',
        remark,
        changes: {
          status: { from: 'PAID', to: 'ISSUED' },
          paidDate: { from: invoice.paidDate, to: null },
          taxInvoiceNo: { from: invoice.taxInvoiceNo, to: null },
        },
      });
    });
    return this.mapInvoice(await this.invoiceWithLines(id));
  }

  // แก้บิลที่ยังไม่รับเงินโดยใช้เลขที่เดิม (ผู้ใช้ 2026-09-27 เลือกแบบนี้แทนยกเลิกแล้วออกเลขใหม่ ซึ่งทำให้เลข IV กระโดด)
  // แก้ได้: วันที่ออกบิล ชื่องาน ค่าใช้จ่ายอื่นๆ ยอดรายคัน (ค่าใบเสร็จ/ค่าดำเนินการ/ข้อความต่อท้าย/ยอดหัก) เอารถออกจากบิล
  // (รถกลับเข้าคิวรอวางบิล ต้องเหลืออย่างน้อย 1 คัน) และดึงข้อมูลรถล่าสุดลงบิลรายคัน (refreshLineIds: ทะเบียน / เลขที่ใบเสร็จ
  // ที่แก้หลังออกบิล พิมพ์ตามจริงได้โดยไม่ต้องยกเลิกบิล) - เพิ่มรถเข้าบิลเดิมไม่ได้ ออกบิลใหม่แทน
  // ยอดคำนวณใหม่ฝั่ง server ด้วยอัตรา VAT / หัก ณ ที่จ่ายเดิมของบิล เว้นแต่ applyCurrentTerms = ใช้เงื่อนไขปัจจุบันของลูกค้า ณ วันออกบิล
  // ข้อมูลลูกค้าบนบิล (customerSnapshot) และเลขที่บิลไม่เปลี่ยน · เหตุผลบังคับ + ค่าก่อน/หลังลง AuditLog
  // ล็อกแถวบิลก่อนอ่าน กันแก้พร้อมรับเงิน/ยกเลิก/แก้จากอีกหน้าจอ - หน้าจอเก่า (updatedAt ไม่ตรง / สถานะเปลี่ยน) ตอบ 409
  async updateInvoice(id: string, dto: UpdateInvoiceDto) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้ไขบิล');
    const issueDate = dto.issueDate === undefined ? undefined : parseIsoDate(dto.issueDate, 'วันที่ออกบิล');
    let jobLabel: string | undefined;
    if (dto.jobLabel !== undefined) {
      jobLabel = optionalText(dto.jobLabel, 'ชื่องาน') ?? undefined;
      if (!jobLabel) throw bad('ต้องใส่ชื่องานที่จะแสดงบนบิล');
    }
    const extras = dto.extras === undefined ? undefined : parseExtras(dto.extras);
    if (dto.lines !== undefined && !Array.isArray(dto.lines)) throw bad('lines ต้องเป็นรายการ');
    const updates = new Map<string, LineAmounts>();
    for (const l of (dto.lines ?? []) as Array<Record<string, unknown>>) {
      if (typeof l?.id !== 'string') throw bad('รายการรถไม่ถูกต้อง');
      if (updates.has(l.id)) throw bad('มีรถซ้ำในรายการที่แก้');
      updates.set(l.id, parseLineAmounts(l));
    }
    if (dto.removeLineIds !== undefined && (!Array.isArray(dto.removeLineIds) || dto.removeLineIds.some((x) => typeof x !== 'string'))) {
      throw bad('removeLineIds ต้องเป็นรายการ id');
    }
    const removeIds = new Set((dto.removeLineIds ?? []) as string[]);
    if ([...removeIds].some((rid) => updates.has(rid))) throw bad('รถคันเดียวกันแก้ยอดและเอาออกจากบิลพร้อมกันไม่ได้');
    if (dto.refreshLineIds !== undefined && (!Array.isArray(dto.refreshLineIds) || dto.refreshLineIds.some((x) => typeof x !== 'string'))) {
      throw bad('refreshLineIds ต้องเป็นรายการ id');
    }
    const refreshIds = new Set((dto.refreshLineIds ?? []) as string[]);
    if ([...refreshIds].some((rid) => removeIds.has(rid))) throw bad('รถคันเดียวกันดึงข้อมูลล่าสุดและเอาออกจากบิลพร้อมกันไม่ได้');
    const applyCurrentTerms = dto.applyCurrentTerms === true;
    const expectedUpdatedAt = typeof dto.expectedUpdatedAt === 'string' ? dto.expectedUpdatedAt : null;

    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${id} FOR UPDATE`;
        const invoice = await tx.invoice.findUnique({ where: { id }, include: { lines: true } });
        if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
        // เทียบ updatedAt ก่อนสถานะ และสถานะไม่ใช่รอรับเงินก็ตอบ 409 (พบ 2026-09-27: เดิมตอบ 400 หน้ารายการบิลไม่โหลดใหม่
        // บิลที่อีกคนเพิ่งรับเงินยังแสดงรอรับเงินพร้อมปุ่มแก้ไข)
        if (expectedUpdatedAt && invoice.updatedAt.toISOString() !== expectedUpdatedAt) {
          throw conflict('บิลนี้ถูกแก้ไขหรือเปลี่ยนสถานะไปแล้ว กรุณาเปิดหน้าแก้ใหม่');
        }
        if (invoice.status !== 'ISSUED') throw conflict('แก้ไขได้เฉพาะบิลที่ยังไม่รับเงิน');
        const byId = new Map(invoice.lines.map((l) => [l.id, l]));
        if ([...updates.keys(), ...removeIds, ...refreshIds].some((lid) => !byId.has(lid))) throw bad('รถบางคันไม่อยู่ในบิลนี้แล้ว กรุณาเปิดหน้าแก้ใหม่');
        const kept = invoice.lines.filter((l) => !removeIds.has(l.id));
        if (kept.length === 0) throw bad('บิลต้องเหลือรถอย่างน้อย 1 คัน - ถ้าจะเอาออกทั้งหมดให้ยกเลิกบิล');

        // ข้อมูลรถปัจจุบันของคันที่ขอดึงล่าสุด - อ่านใต้ล็อกบิล ค่าที่เขียนลงบิลกับค่าในประวัติจึงตรงกัน
        const refreshVehicleIds = kept.filter((l) => refreshIds.has(l.id)).map((l) => l.vehicleId);
        const live = new Map(
          refreshVehicleIds.length
            ? (await tx.vehicle.findMany({ where: { id: { in: refreshVehicleIds } }, include: QUEUE_VEHICLE_INCLUDE })).map((v) => [v.id, v])
            : [],
        );

        const lineLabel = (l: { plateText: string; chassis: string }) => `รถ ${l.plateText || l.chassis}`;
        const changes: AuditChanges = diffChanges(invoice, { issueDate, jobLabel, extras });
        const lineWrites = new Map<string, Partial<LineAmounts> & Partial<Omit<LineSnapshot, 'deliveredDate'>> & { deliveredDate?: Date }>();
        const nextLines = kept.map((l) => {
          const before = lineAmountsOf(l);
          const after = updates.get(l.id);
          if (after) {
            const diff = diffChanges(before, after, LINE_FIELDS);
            if (Object.keys(diff).length) {
              for (const [field, change] of Object.entries(diff)) changes[`${lineLabel(l)} · ${field}`] = change;
              lineWrites.set(l.id, { ...after });
            }
          }
          if (refreshIds.has(l.id)) {
            const v = live.get(l.vehicleId);
            if (!v) throw bad(`ไม่พบข้อมูลรถ ${l.chassis}`);
            const snap = lineSnapshotOf(v);
            // รถที่วางบิลแล้วยกเลิกการส่งเล่มไม่ได้ (delivery.service) - ถ้าไม่มีวันที่ส่งงานก็เก็บวันที่เดิมของบิลไว้
            const fresh = { ...snap, deliveredDate: snap.deliveredDate ?? l.deliveredDate };
            const diff = diffChanges(l, fresh, SNAPSHOT_FIELDS);
            if (Object.keys(diff).length) {
              for (const [field, change] of Object.entries(diff)) changes[`${lineLabel(l)} · ${field}`] = change;
              lineWrites.set(l.id, { ...lineWrites.get(l.id), ...fresh });
            }
          }
          return after ?? before;
        });
        for (const l of invoice.lines.filter((x) => removeIds.has(x.id))) {
          changes[`${lineLabel(l)} · เอาออกจากบิล`] = { from: { chassis: l.chassis, ...lineAmountsOf(l) }, to: null };
        }

        const nextIssue = issueDate ?? invoice.issueDate;
        const nextIssueIso = nextIssue.toISOString().slice(0, 10);
        let terms: BillingTerms = { vat: Number(invoice.vatRate) > 0, whtRate: Number(invoice.whtRate), whtSpecialRate: null, whtSpecialUntil: null };
        if (applyCurrentTerms) {
          const customer = await tx.customer.findUnique({ where: { id: invoice.customerId } });
          if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
          terms = termsFor(invoice.account, toTerms(customer));
        }
        const nextExtras = extras ?? extrasOf(invoice.extras);
        const totals = computeInvoiceTotals({ lines: nextLines, extras: nextExtras, terms, issueDate: nextIssueIso });
        Object.assign(changes, diffChanges(invoice, totals, TOTAL_FIELDS));
        if (Object.keys(changes).length === 0) {
          throw bad(refreshIds.size ? 'ไม่มีข้อมูลที่เปลี่ยน - ข้อมูลรถในบิลตรงกับข้อมูลล่าสุดอยู่แล้ว' : 'ไม่มีข้อมูลที่เปลี่ยน');
        }

        for (const [lineId, data] of lineWrites) await tx.invoiceLine.update({ where: { id: lineId }, data });
        if (removeIds.size) await tx.invoiceLine.deleteMany({ where: { invoiceId: id, id: { in: [...removeIds] } } });
        await tx.invoice.update({
          where: { id },
          data: {
            issueDate: nextIssue,
            jobLabel: jobLabel ?? invoice.jobLabel,
            extras: nextExtras,
            vatRate: totals.vatRate,
            whtRate: totals.whtRate,
            feeTotal: totals.feeTotal,
            serviceTotal: totals.serviceTotal,
            vatAmount: totals.vatAmount,
            whtAmount: totals.whtAmount,
            netTotal: totals.netTotal,
          },
        });
        await writeAudit(tx, { entity: 'Invoice', entityId: id, action: 'update', remark, changes });
      },
      { timeout: 20_000 },
    );
    return this.mapInvoice(await this.invoiceWithLines(id));
  }

  // ประวัติแก้ไข / ยกเลิก / ย้อนรับเงินของบิล ใหม่สุดก่อน
  async invoiceHistory(id: string) {
    const entries = await this.prisma.auditLog.findMany({
      where: { entity: 'Invoice', entityId: id },
      orderBy: { createdAt: 'desc' },
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    return entries.map((e) => ({ id: e.id, action: e.action, remark: e.remark, changes: e.changes, editedBy: nameOf(e.editedBy), createdAt: e.createdAt.toISOString() }));
  }

  // ข้อมูลรถปัจจุบันของแต่ละคันในบิล (ผู้ใช้ 2026-09-27, F53a) - หน้าแก้บิลเทียบกับข้อมูลที่บิลเก็บไว้ แล้วให้ติ๊ก
  // "ใช้ข้อมูลล่าสุด" เฉพาะคันที่ต่าง (เช่น ทะเบียน / เลขที่ใบเสร็จที่แก้หลังออกบิล) · ค่าที่ลงบิลจริงอ่านใหม่ตอนบันทึก (updateInvoice)
  // receiptAmount = ยอดบนใบเสร็จที่พนักงานกรอกไว้ในการยื่นล่าสุด (ไม่มี = null) ใช้แสดงเป็นคำแนะนำเท่านั้น ยอดในบิลยังแก้เอง
  async invoiceLiveLines(id: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { lines: { select: { id: true, vehicleId: true } } } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    const vehicles = await this.prisma.vehicle.findMany({ where: { id: { in: invoice.lines.map((l) => l.vehicleId) } }, include: QUEUE_VEHICLE_INCLUDE });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    return invoice.lines.flatMap((l) => {
      const v = byId.get(l.vehicleId);
      if (!v) return [];
      const snap = lineSnapshotOf(v);
      return [{ id: l.id, ...snap, deliveredDate: iso(snap.deliveredDate), receiptAmount: num(v.documentSubmissions[0]?.receiptAmount) }];
    });
  }

  // ---------- ปิดงาน - วางบิลนอกระบบ (ผู้ใช้ 2026-09-27) ----------
  // รถที่ส่งงานแล้วแต่วางบิลที่อื่น (บัญชีส่วนตัว / Google Sheet / เหมาจ่าย): ADMIN / ACCOUNTANT ปิดพร้อมหมายเหตุ
  // -> ออกจากคิวรอวางบิล ยอดส่งงานแล้วยังไม่วางบิลในภาพรวม และสถานะรอ "วางบิล" ในหน้าค้นหารถ
  // เปิดกลับได้เฉพาะ ADMIN พร้อมเหตุผล (access-policy.ts) · ทุกครั้งบันทึกลง VehicleEditLog เหมือนการแก้ข้อมูลรถอื่นๆ
  async closeVehicleBilling(vehicleId: string, dto: { note?: unknown }) {
    const note = requireRemark(dto?.note, 'กรุณาระบุหมายเหตุการปิดงาน เช่น วางบิลที่ไหน เลขที่อะไร');
    await this.prisma.$transaction(async (tx) => {
      // ล็อกแถวรถเหมือนตอนออกบิล - ปิดงานพร้อมกับออกบิลคันเดียวกันจากอีกหน้าจอ อย่างใดอย่างหนึ่งต้องรอแล้วเห็นอีกฝั่ง
      await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
      const v = await tx.vehicle.findUnique({
        where: { id: vehicleId },
        select: {
          chassis: true,
          deletedAt: true,
          deliveredDate: true,
          billingClosedAt: true,
          invoiceLines: { where: NOT_VOID, take: 1, select: { invoice: { select: { invoiceNo: true } } } },
        },
      });
      if (!v || v.deletedAt) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
      if (!v.deliveredDate) throw bad(`รถ ${v.chassis} ยังไม่ได้บันทึกส่งงาน`);
      if (v.invoiceLines.length > 0) throw bad(`รถ ${v.chassis} อยู่ในบิล ${v.invoiceLines[0].invoice.invoiceNo} แล้ว`);
      if (v.billingClosedAt) throw bad(`รถ ${v.chassis} ปิดงานไปแล้ว`);
      const closedAt = new Date();
      const { count } = await tx.vehicle.updateMany({
        where: { id: vehicleId, billingClosedAt: null },
        data: { billingClosedAt: closedAt, billingClosedNote: note, billingClosedById: currentUser()?.id ?? null },
      });
      if (count !== 1) throw conflict(`รถ ${v.chassis} เพิ่งถูกปิดงาน กรุณาโหลดรายการใหม่`);
      await this.editLog(tx, vehicleId, `ปิดงาน - วางบิลนอกระบบ: ${note}`, {
        billingClosed: { from: null, to: 'ปิดงาน - วางบิลนอกระบบ' },
        billingClosedNote: { from: null, to: note },
      });
    });
    const [row] = await this.closedRows({ id: vehicleId });
    return row;
  }

  async reopenVehicleBilling(vehicleId: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่เปิดงานกลับ');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
      const v = await tx.vehicle.findUnique({ where: { id: vehicleId }, select: { chassis: true, deletedAt: true, billingClosedAt: true, billingClosedNote: true } });
      if (!v || v.deletedAt) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
      if (!v.billingClosedAt) throw bad(`รถ ${v.chassis} ไม่ได้ปิดงานไว้`);
      const { count } = await tx.vehicle.updateMany({
        where: { id: vehicleId, billingClosedAt: v.billingClosedAt },
        data: { billingClosedAt: null, billingClosedNote: null, billingClosedById: null },
      });
      if (count !== 1) throw conflict(`รถ ${v.chassis} ถูกเปิดงานกลับไปแล้ว กรุณาโหลดรายการใหม่`);
      await this.editLog(tx, vehicleId, `เปิดงานกลับ (ยกเลิกปิดงาน - วางบิลนอกระบบ): ${remark}`, {
        billingClosed: { from: 'ปิดงาน - วางบิลนอกระบบ', to: null },
        billingClosedNote: { from: v.billingClosedNote, to: null },
      });
    });
    return { id: vehicleId, reopened: true };
  }

  // รถที่ปิดงานไว้ ใหม่สุดก่อนทีละ 100 คัน
  async listClosedVehicles(params: { offset?: string } = {}) {
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);
    const rows = await this.closedRows({}, offset, CLOSED_PAGE + 1);
    return { vehicles: rows.slice(0, CLOSED_PAGE), hasMore: rows.length > CLOSED_PAGE };
  }

  private async closedRows(where: { id?: string }, skip = 0, take?: number) {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { ...where, deletedAt: null, billingClosedAt: { not: null } },
      orderBy: [{ billingClosedAt: 'desc' }, { id: 'desc' }],
      skip,
      take,
      select: {
        id: true,
        chassis: true,
        body: true,
        plateCategory: true,
        plateNumber: true,
        deliveredDate: true,
        billingClosedAt: true,
        billingClosedNote: true,
        brand: { select: { name: true } },
        customer: { select: { id: true, name: true, company: true } },
        billingClosedBy: { select: { name: true, displayName: true } },
      },
    });
    return vehicles.map((v) => ({
      id: v.id,
      chassis: v.chassis,
      brandName: v.brand.name,
      body: v.body,
      plateText: plateOf(v),
      customerId: v.customer.id,
      customerName: v.customer.company || v.customer.name,
      deliveredDate: iso(v.deliveredDate),
      closedAt: v.billingClosedAt!.toISOString(),
      note: v.billingClosedNote,
      closedBy: nameOf(v.billingClosedBy),
    }));
  }

  // ตารางอัตราค่าธรรมเนียมขั้นยื่นเอกสาร (ชุดเดียวกับ DocumentSubmissionService.loadRuleSet) - โหลดไม่ได้ = null (ใช้ยอดตอนยื่น)
  private async loadFeeRules(): Promise<DocumentFeeRuleSet | null> {
    try {
      const [carBill, carNoBill, motoBill, motoNoBill] = await Promise.all([
        this.prisma.feeCarBillParam.findMany(),
        this.prisma.feeCarNoBillParam.findMany(),
        this.prisma.feeMotorcycleBillParam.findMany(),
        this.prisma.feeMotorcycleNoBillParam.findMany(),
      ]);
      return { carBill: feeRows(carBill), carNoBill: feeRows(carNoBill), motoBill: feeRows(motoBill), motoNoBill: feeRows(motoNoBill) };
    } catch {
      return null;
    }
  }

  private editLog(tx:Pick<Prisma.TransactionClient, 'vehicleEditLog'>, vehicleId: string, remark: string, changes: Record<string, unknown>) {
    return tx.vehicleEditLog.create({ data: { vehicleId, remark, changes: JSON.stringify(changes), editedById: currentUser()?.id ?? null } });
  }

  private async invoiceWithLines(id: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, include: { lines: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    return invoice;
  }

  private mapInvoice(i: {
    id: string;
    invoiceNo: string;
    issueDate: Date;
    customerId: string;
    customerSnapshot: unknown;
    jobLabel: string;
    extras: unknown;
    vatRate: unknown;
    whtRate: unknown;
    feeTotal: unknown;
    serviceTotal: unknown;
    vatAmount: unknown;
    whtAmount: unknown;
    netTotal: unknown;
    status: string;
    paidDate: Date | null;
    taxInvoiceNo: string | null;
    voidReason: string | null;
    account?: string;
    updatedAt?: Date;
    lines: Array<{
      id: string;
      vehicleId: string;
      chassis: string;
      brandName: string;
      body: string | null;
      plateText: string;
      receiptNo: string | null;
      deliveredDate: Date;
      receiptAmount: unknown;
      serviceFee: unknown;
      serviceLabel: string | null;
      deduction: unknown;
      deductionNote: string | null;
    }>;
  }, historyCount?: number) {
    return {
      id: i.id,
      invoiceNo: i.invoiceNo,
      issueDate: iso(i.issueDate),
      customerId: i.customerId,
      customer: i.customerSnapshot as { name: string; branch: string | null; address: string | null; taxId: string | null },
      jobLabel: i.jobLabel,
      extras: i.extras as Array<{ label: string; amount: number }>,
      vatRate: Number(i.vatRate),
      whtRate: Number(i.whtRate),
      feeTotal: Number(i.feeTotal),
      serviceTotal: Number(i.serviceTotal),
      vatAmount: Number(i.vatAmount),
      whtAmount: Number(i.whtAmount),
      netTotal: Number(i.netTotal),
      status: i.status,
      paidDate: iso(i.paidDate),
      taxInvoiceNo: i.taxInvoiceNo,
      voidReason: i.voidReason,
      account: i.account,
      // หน้าแก้บิลส่งกลับมาเทียบ (expectedUpdatedAt) - รับเงิน/ยกเลิก/แก้ ทำให้ค่านี้เปลี่ยน
      updatedAt: i.updatedAt?.toISOString() ?? null,
      // จำนวนประวัติใน AuditLog - ส่งเฉพาะรายการบิล (listInvoices) หน้าจอโหลดรายการใหม่หลังทุกการกระทำอยู่แล้ว
      ...(historyCount === undefined ? {} : { historyCount }),
      lines: i.lines.map((l) => ({
        id: l.id,
        vehicleId: l.vehicleId,
        chassis: l.chassis,
        brandName: l.brandName,
        body: l.body,
        plateText: l.plateText,
        receiptNo: l.receiptNo,
        deliveredDate: iso(l.deliveredDate),
        receiptAmount: Number(l.receiptAmount),
        serviceFee: Number(l.serviceFee),
        serviceLabel: l.serviceLabel,
        deduction: Number(l.deduction),
        deductionNote: l.deductionNote,
      })),
    };
  }
}
