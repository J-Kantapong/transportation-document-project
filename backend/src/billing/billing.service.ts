import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { isMotorcycle } from '../document-submission/document-fee-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { computeInvoiceTotals, nextInvoiceNo, rateAmountExVat, round2, suggestRate, type BillingTerms, type RateRow } from './billing-calculator.js';

// พื้นที่ทำงานบัญชี: วางบิลในนามบริษัท - รถเข้าคิวเมื่อพนักงานบันทึกส่งงานแล้ว (Vehicle.deliveredDate) และยังไม่อยู่ในบิลที่ยังใช้อยู่
// (บิลที่ VOID ไม่นับ - รถกลับเข้าคิว) เลขที่บิลพิมพ์เอง เพราะช่วงแรกยังรันเลขร่วมกับ Google Sheet ของงานประเภทอื่น

const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;
const VEHICLE_KINDS = ['CAR', 'MOTO', 'ANY'];

const bad = (error: string) => new BadRequestException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));

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

type CustomerTermsRow = { billingVat: boolean; billingWhtRate: unknown; billingWhtSpecialRate: unknown; billingWhtSpecialUntil: Date | null };

function toTerms(c: CustomerTermsRow): BillingTerms {
  return { vat: c.billingVat, whtRate: Number(c.billingWhtRate), whtSpecialRate: num(c.billingWhtSpecialRate), whtSpecialUntil: iso(c.billingWhtSpecialUntil) };
}

type RateDbRow = { id: string; label: string; vehicleKind: string; ccMin: unknown; ccMax: unknown; amount: unknown; vatInclusive: boolean; sortOrder: number };

function toRate(r: RateDbRow): RateRow {
  return { id: r.id, label: r.label, vehicleKind: r.vehicleKind, ccMin: num(r.ccMin), ccMax: num(r.ccMax), amount: Number(r.amount), vatInclusive: r.vatInclusive, sortOrder: r.sortOrder };
}

const QUEUE_VEHICLE_INCLUDE = {
  brand: { select: { name: true } },
  // การยื่นครั้งล่าสุด = ใบเสร็จที่ใช้วางบิล (รถที่ส่งงานแล้วต้องเคยได้รับใบเสร็จ)
  documentSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { status: true, receiptNo: true, receiptAmount: true, billFeeTotal: true, taxAmount: true, plateNumberOption: true },
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

@Injectable()
export class BillingService {
  constructor(private readonly prisma: PrismaService) {}

  // คิวรอวางบิล จัดกลุ่มตามลูกค้า พร้อมเงื่อนไขวางบิล ตารางราคา และค่าดำเนินการที่ระบบเสนอให้รายคัน
  async queue() {
    const [customers, lastInvoice] = await Promise.all([
      this.prisma.customer.findMany({
        where: { vehicles: { some: { deliveredDate: { not: null }, invoiceLines: { none: NOT_VOID } } } },
        orderBy: { name: 'asc' },
        include: {
          serviceFeeRates: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
          vehicles: {
            where: { deliveredDate: { not: null }, invoiceLines: { none: NOT_VOID } },
            orderBy: [{ deliveredDate: 'asc' }, { plateCategory: 'asc' }, { plateNumber: 'asc' }],
            include: QUEUE_VEHICLE_INCLUDE,
          },
        },
      }),
      this.prisma.invoice.findFirst({ orderBy: { createdAt: 'desc' }, select: { invoiceNo: true } }),
    ]);

    return {
      suggestedInvoiceNo: nextInvoiceNo(lastInvoice?.invoiceNo ?? null),
      customers: customers.map((c) => {
        const rates = c.serviceFeeRates.map(toRate);
        return {
          id: c.id,
          name: c.name,
          company: c.company,
          branch: c.branch,
          address: c.address,
          taxId: c.taxId,
          terms: toTerms(c),
          rates,
          vehicles: c.vehicles.map((v) => {
            const sub = v.documentSubmissions[0];
            const isMoto = isMotorcycle(v.body);
            const cc = num(v.cc);
            const rate = suggestRate(rates, { isMoto, cc });
            // ยอดบนใบเสร็จจริงมาก่อน ถ้าพนักงานไม่ได้กรอกไว้ใช้ยอด Bill ที่ระบบคำนวณ (ค่าธรรมเนียม + ภาษี) แทนและบอกให้บัญชีตรวจ
            const receiptAmount = num(sub?.receiptAmount);
            const estimate = sub && sub.taxAmount !== null ? round2(Number(sub.billFeeTotal) + Number(sub.taxAmount)) : null;
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
              recipient: v.deliveryRecipient,
              plateDelivered: v.plateDeliveredDate !== null,
              receiptNo: sub?.receiptNo ?? null,
              receiptAmount: receiptAmount ?? estimate,
              receiptAmountSource: receiptAmount !== null ? 'RECEIPT' : estimate !== null ? 'BILL_ESTIMATE' : 'NONE',
              requestedPlateNumber: !!sub && sub.plateNumberOption !== 'NONE', // ขอใช้เลขทะเบียน - เผื่อเคสลูกค้าชำระค่าขอใช้เลขเอง
              suggestedRateId: rate?.id ?? null,
              suggestedServiceFee: rate ? rateAmountExVat(rate) : null,
            };
          }),
        };
      }),
    };
  }

  async updateTerms(customerId: string, dto: { vat?: unknown; whtRate?: unknown; whtSpecialRate?: unknown; whtSpecialUntil?: unknown }) {
    if (typeof dto?.vat !== 'boolean') throw bad('ต้องระบุว่ามี VAT หรือไม่');
    const whtRate = parsePercent(dto.whtRate, 'อัตราหัก ณ ที่จ่าย');
    const hasSpecial = dto.whtSpecialRate !== null && dto.whtSpecialRate !== undefined;
    const whtSpecialRate = hasSpecial ? parsePercent(dto.whtSpecialRate, 'อัตราหัก ณ ที่จ่ายพิเศษ') : null;
    if (hasSpecial && !dto.whtSpecialUntil) throw bad('อัตราพิเศษต้องระบุวันสุดท้ายที่ใช้');
    const whtSpecialUntil = hasSpecial ? parseIsoDate(dto.whtSpecialUntil, 'วันสุดท้ายของอัตราพิเศษ') : null;

    const exists = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
    if (!exists) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const updated = await this.prisma.customer.update({
      where: { id: customerId },
      data: { billingVat: dto.vat, billingWhtRate: whtRate, billingWhtSpecialRate: whtSpecialRate, billingWhtSpecialUntil: whtSpecialUntil },
    });
    return toTerms(updated);
  }

  // บันทึกตารางค่าดำเนินการของลูกค้าทั้งชุด (แทนที่ของเดิม) - ลำดับในรายการ = ลำดับที่ใช้จับคู่
  async replaceRates(customerId: string, dto: { rates?: unknown }) {
    if (!Array.isArray(dto?.rates)) throw bad('rates ต้องเป็นรายการ');
    const rows = (dto.rates as Array<Record<string, unknown>>).map((r, i) => {
      const label = optionalText(r?.label, 'ชื่อรายการ');
      if (!label) throw bad(`แถวที่ ${i + 1}: ต้องใส่ชื่อรายการ`);
      const vehicleKind = typeof r.vehicleKind === 'string' && VEHICLE_KINDS.includes(r.vehicleKind) ? r.vehicleKind : null;
      if (!vehicleKind) throw bad(`แถวที่ ${i + 1}: ชนิดรถต้องเป็น CAR, MOTO หรือ ANY`);
      const ccMin = r.ccMin === null || r.ccMin === undefined ? null : parseMoney(r.ccMin, `แถวที่ ${i + 1}: CC ตั้งแต่`);
      const ccMax = r.ccMax === null || r.ccMax === undefined ? null : parseMoney(r.ccMax, `แถวที่ ${i + 1}: CC น้อยกว่า`);
      if (ccMin !== null && ccMax !== null && ccMin >= ccMax) throw bad(`แถวที่ ${i + 1}: ช่วง CC ไม่ถูกต้อง`);
      return { customerId, label, vehicleKind, ccMin, ccMax, amount: parseMoney(r.amount, `แถวที่ ${i + 1}: ราคา`), vatInclusive: r.vatInclusive === true, sortOrder: i };
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
      return {
        vehicleId: l.vehicleId,
        receiptAmount: parseMoney(l.receiptAmount, 'ค่าใบเสร็จ'),
        serviceFee: parseMoney(l.serviceFee, 'ค่าดำเนินการ'),
        serviceLabel: optionalText(l.serviceLabel, 'หมายเหตุรายการ'),
        deduction: l.deduction === undefined || l.deduction === null ? 0 : parseMoney(l.deduction, 'ยอดหัก'),
        deductionNote: optionalText(l.deductionNote, 'เหตุผลที่หัก'),
      };
    });
    if (new Set(lineInputs.map((l) => l.vehicleId)).size !== lineInputs.length) throw bad('มีรถซ้ำในบิล');

    const extras = (Array.isArray(dto.extras) ? (dto.extras as Array<Record<string, unknown>>) : []).map((e) => {
      const label = optionalText(e?.label, 'ชื่อค่าใช้จ่ายอื่นๆ');
      if (!label) throw bad('ค่าใช้จ่ายอื่นๆ ต้องมีชื่อรายการ');
      return { label, amount: parseMoney(e.amount, `จำนวนเงินของ "${label}"`) };
    });

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    if (await this.prisma.invoice.findUnique({ where: { invoiceNo }, select: { id: true } })) throw bad(`เลขที่บิล ${invoiceNo} ถูกใช้ไปแล้ว`);

    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: lineInputs.map((l) => l.vehicleId) } },
      include: { ...QUEUE_VEHICLE_INCLUDE, invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } } },
    });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const lines = lineInputs.map((l) => {
      const v = byId.get(l.vehicleId);
      if (!v) throw bad('ไม่พบข้อมูลรถบางคันในบิล');
      if (v.customerId !== customer.id) throw bad(`รถ ${v.chassis} ไม่ใช่ของลูกค้ารายนี้`);
      if (!v.deliveredDate) throw bad(`รถ ${v.chassis} ยังไม่ได้บันทึกส่งงาน`);
      if (v.invoiceLines.length > 0) throw bad(`รถ ${v.chassis} อยู่ในบิล ${v.invoiceLines[0].invoice.invoiceNo} แล้ว`);
      return {
        ...l,
        chassis: v.chassis,
        brandName: v.brand.name,
        body: v.body,
        plateText: v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : '',
        receiptNo: v.documentSubmissions[0]?.receiptNo ?? null,
        deliveredDate: v.deliveredDate,
      };
    });

    const issueIso = issueDate.toISOString().slice(0, 10);
    const totals = computeInvoiceTotals({ lines, extras, terms: toTerms(customer), issueDate: issueIso });

    const invoice = await this.prisma.invoice.create({
      data: {
        invoiceNo,
        issueDate,
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
        lines: { create: lines },
      },
      include: { lines: true },
    });
    return this.mapInvoice(invoice);
  }

  async listInvoices() {
    const invoices = await this.prisma.invoice.findMany({ orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }], take: 200, include: { lines: true } });
    return invoices.map((i) => this.mapInvoice(i));
  }

  async markPaid(id: string, dto: { paidDate?: unknown; taxInvoiceNo?: unknown }) {
    const paidDate = parseIsoDate(dto?.paidDate, 'วันที่รับเงิน');
    const taxInvoiceNo = optionalText(dto.taxInvoiceNo, 'เลขที่ใบกำกับภาษี');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    if (invoice.status !== 'ISSUED') throw bad('บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน');
    const updated = await this.prisma.invoice.update({ where: { id }, data: { status: 'PAID', paidDate, taxInvoiceNo }, include: { lines: true } });
    return this.mapInvoice(updated);
  }

  // ยกเลิกบิล - รถทุกคันในบิลกลับเข้าคิวรอวางบิล ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน
  async voidInvoice(id: string, dto: { reason?: unknown }) {
    const voidReason = optionalText(dto?.reason, 'เหตุผล');
    if (!voidReason) throw bad('ต้องใส่เหตุผลที่ยกเลิกบิล');
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { status: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    if (invoice.status !== 'ISSUED') throw bad('ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน');
    const updated = await this.prisma.invoice.update({ where: { id }, data: { status: 'VOID', voidReason }, include: { lines: true } });
    return this.mapInvoice(updated);
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
  }) {
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
