import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import type { UploadedReceiptFile } from '../receipts/receipts.service.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { detectAttachmentType } from '../yamaha-relocation/yamaha-relocation.service.js';
import { accountOn } from './billing-account.js';
import { computeInvoiceTotals, effectiveWhtRate, round2 } from './billing-calculator.js';
import { SELLER_PROFILE, type SellerSnapshot } from './seller-profile.js';
import { parseItems, toPeriods, toTerms } from './billing.service.js';
import { daysBetween, formatTaxInvoiceNo, missingBuyerFields, taxInvoiceAmounts, WHT_METHODS, type WhtMethod } from './tax-invoice-calc.js';

// ใบกำกับภาษี/ใบเสร็จรับเงิน (TV) + หนังสือรับรองหัก ณ ที่จ่าย (50 ทวิ) - ผู้ใช้ 2026-09-28
// - ออกตอนรับเงิน เฉพาะบิลบัญชีบริษัทที่มี VAT, บิล 1 ใบ = ใบกำกับที่ใช้อยู่ 1 ใบ, ระบบให้เลขเอง TV{ปี}-{3 หลัก}
// - วันที่ใบกำกับ = วันที่รับเงิน และต้องไม่ก่อนใบล่าสุดของปีนั้น (เลขเรียงตามวันที่)
// - ออกแล้วแก้ไม่ได้: ยกเลิก (เหตุผลบังคับ เลขเดิมเก็บไว้ บิลกลับเป็นรอรับเงิน) แล้วออกใบใหม่ที่อ้างใบเดิม
// - ลูกค้าทำต้นฉบับหาย = ใบแทน (เลขเดิม บันทึกวันที่และเหตุผล)
// - 50 ทวิ ใบเดียวครอบคลุมหลายใบกำกับได้ (บางลูกค้าส่งรวม) · ได้ใบเป็นกระดาษ -> แนบรูป/PDF · e-WHT -> เลขอ้างอิง
// - ใบกำกับกำหนดเอง (ผู้ใช้ 2026-10-05): งานนอกระบบที่ไม่มีใบวางบิล (invoiceId null) พิมพ์บรรทัดเอง ออกตอนรับเงินเหมือนกัน
//   เลขชุดเดียวกับใบที่ออกจากบิล · ยกเลิกแล้วออกใหม่แทนได้ (replacesId) · ไม่มีบิลให้ย้อนสถานะ
// สิทธิ์: ADMIN + ACCOUNTANT (/api/billing) ยกเว้นตั้งเลขเริ่ม = ADMIN (access-policy.ts)

const bad = (error: string) => new BadRequestException({ error });
const conflict = (error: string) => new ConflictException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

// ค้างส่ง 50 ทวิ เกินกี่วันถึงขึ้นสีเตือน (ผู้ใช้ 2026-09-28: 1 เดือน)
export const WHT_OVERDUE_DAYS = 30;

function parseIsoDate(raw: unknown, label: string): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD`);
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== raw) throw bad(`${label}ไม่ถูกต้อง`);
  return d;
}

function parseMoney(raw: unknown, label: string): number {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 99_999_999) throw bad(`${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 ขึ้นไป`);
  return round2(n);
}

const optionalText = (raw: unknown, max = 200): string | null => {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (t.length > max) throw bad(`ข้อความยาวเกิน ${max} ตัวอักษร`);
  return t || null;
};

function parseWht(dto: { whtAmount?: unknown; whtMethod?: unknown }): { whtAmount: number; whtMethod: WhtMethod } {
  const whtAmount = parseMoney(dto.whtAmount ?? 0, 'ภาษีหัก ณ ที่จ่าย');
  const whtMethod = (whtAmount > 0 ? dto.whtMethod : 'NONE') as WhtMethod;
  if (!WHT_METHODS.includes(whtMethod) || (whtAmount > 0 && whtMethod === 'NONE')) throw bad('ลูกค้าหัก ณ ที่จ่าย ต้องเลือกว่าเป็น 50 ทวิ กระดาษ หรือ e-WHT');
  return { whtAmount, whtMethod };
}

type CustomerSnapshot = { name: string; branch: string | null; address: string | null; taxId: string | null; email?: string | null };

const TV_INCLUDE = {
  invoice: { select: { invoiceNo: true, issueDate: true, jobLabel: true, extras: true, lines: true, items: true, whtRate: true, vatRate: true } },
  whtCertificate: { select: { id: true, method: true, certificateNo: true, certificateDate: true, amount: true, storageKey: true, cancelledAt: true } },
  replaces: { select: { taxInvoiceNo: true } },
  replacedBy: { select: { taxInvoiceNo: true } },
  items: true,
} as const;

type TvRow = Prisma.TaxInvoiceGetPayload<{ include: typeof TV_INCLUDE }>;

@Injectable()
export class TaxInvoiceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // ---------- เลขใบกำกับ ----------

  // เปิดใช้แล้วหรือยัง + เลขล่าสุดแต่ละปี + จำนวนใบในระบบของปีนั้น
  async series() {
    const [rows, counts] = await Promise.all([
      this.prisma.taxInvoiceSeries.findMany({ orderBy: { year: 'desc' } }),
      this.prisma.taxInvoice.groupBy({ by: ['year'], _count: { _all: true } }),
    ]);
    const countOf = new Map(counts.map((c) => [c.year, c._count._all]));
    return {
      enabled: rows.length > 0,
      series: rows.map((r) => ({
        year: r.year,
        lastNumber: r.lastNumber,
        nextNo: formatTaxInvoiceNo(r.year, r.lastNumber + 1),
        issuedInSystem: countOf.get(r.year) ?? 0,
      })),
    };
  }

  // ADMIN ตั้งเลขล่าสุดที่ใช้ไปแล้ว (ต่อจาก Google Sheet) = เปิดใช้ใบกำกับในระบบ · ตั้งได้เฉพาะปีที่ยังไม่มีใบในระบบ
  async setSeries(dto: { year?: unknown; lastNumber?: unknown; remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผล/ที่มาของเลขเริ่ม');
    const year = dto.year;
    if (typeof year !== 'number' || !Number.isInteger(year) || year < 2020 || year > 2100) throw bad('ปีต้องเป็น ค.ศ. เช่น 2026');
    const lastNumber = dto.lastNumber;
    if (typeof lastNumber !== 'number' || !Number.isInteger(lastNumber) || lastNumber < 0 || lastNumber > 99_999) throw bad('เลขล่าสุดต้องเป็นจำนวนเต็มตั้งแต่ 0');
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT INTO "TaxInvoiceSeries" ("year", "lastNumber", "updatedAt") VALUES (${year}, 0, NOW()) ON CONFLICT DO NOTHING`;
      const [row] = await tx.$queryRaw<Array<{ lastNumber: number }>>`SELECT "lastNumber" FROM "TaxInvoiceSeries" WHERE "year" = ${year} FOR UPDATE`;
      if ((await tx.taxInvoice.count({ where: { year } })) > 0) throw bad(`ปี ${year} ออกใบกำกับในระบบไปแล้ว - แก้เลขเริ่มไม่ได้`);
      await tx.taxInvoiceSeries.update({ where: { year }, data: { lastNumber } });
      await writeAudit(tx, {
        entity: 'TaxInvoiceSeries',
        entityId: String(year),
        action: 'set-last-number',
        remark,
        changes: { lastNumber: { from: row?.lastNumber ?? null, to: lastNumber } },
      });
    });
    return this.series();
  }

  // ---------- ออก / ยกเลิก / ใบแทน ----------

  // ข้อมูลสำหรับหน้าต่าง "รับเงิน + ออกใบกำกับ": ลูกค้าปัจจุบัน, สิ่งที่ขาด, เลขถัดไป, ใบเดิมที่ยกเลิกไว้
  async issuePreview(invoiceId: string) {
    const invoice = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { customer: true } });
    if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
    const buyer = this.buyerOf(invoice.customer);
    const [seriesRows, replaces] = await Promise.all([
      this.prisma.taxInvoiceSeries.findMany(),
      this.replaceableOf(this.prisma, invoiceId),
    ]);
    const year = Number(bangkokToday().slice(0, 4));
    const current = seriesRows.find((s) => s.year === year);
    const last = await this.prisma.taxInvoice.findFirst({ where: { year, status: 'ISSUED' }, orderBy: { number: 'desc' }, select: { taxInvoiceNo: true, issueDate: true } });
    return {
      enabled: seriesRows.length > 0,
      buyer,
      missing: missingBuyerFields(buyer, false),
      missingIfNotRegistered: missingBuyerFields(buyer, true),
      nextNo: seriesRows.length ? formatTaxInvoiceNo(year, (current?.lastNumber ?? 0) + 1) : null,
      lastIssued: last ? { taxInvoiceNo: last.taxInvoiceNo, issueDate: iso(last.issueDate) } : null,
      replaces: replaces ? { id: replaces.id, taxInvoiceNo: replaces.taxInvoiceNo, cancelReason: replaces.cancelReason, whtCertificateId: replaces.whtCertificateId } : null,
      defaultWhtMethod: invoice.customer.billingWhtMethod === 'EWHT' ? 'EWHT' : 'PAPER',
    };
  }

  async issue(
    invoiceId: string,
    dto: { paidDate?: unknown; whtAmount?: unknown; whtMethod?: unknown; buyerNotVatRegistered?: unknown; expectedUpdatedAt?: unknown },
  ) {
    const paidDate = parseIsoDate(dto?.paidDate, 'วันที่รับเงิน');
    const paidIso = iso(paidDate)!;
    if (paidIso > bangkokToday()) throw bad('วันที่รับเงินต้องไม่เกินวันนี้');
    const { whtAmount, whtMethod } = parseWht(dto);
    const buyerNotVatRegistered = dto.buyerNotVatRegistered === true;
    const expectedUpdatedAt = typeof dto.expectedUpdatedAt === 'string' ? dto.expectedUpdatedAt : null;
    const year = Number(paidIso.slice(0, 4));

    const id = await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${invoiceId} FOR UPDATE`;
        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId }, include: { customer: true } });
        if (!invoice) throw new NotFoundException({ error: 'ไม่พบบิล' });
        if (expectedUpdatedAt && invoice.updatedAt.toISOString() !== expectedUpdatedAt) throw conflict('บิลนี้ถูกแก้หรือเปลี่ยนสถานะไปแล้ว กรุณาโหลดรายการใหม่');
        if (invoice.status !== 'ISSUED') throw conflict('ออกใบกำกับได้เฉพาะบิลที่รอรับเงิน');
        if (invoice.account !== 'COMPANY') throw bad('บิลบัญชีบุคคลไม่มีใบกำกับภาษี - ใช้ "รับเงินแล้ว"');
        if (Number(invoice.vatRate) <= 0) throw bad('บิลนี้ไม่มี VAT - ใช้ "รับเงินแล้ว"');
        const issueIso = iso(invoice.issueDate)!;
        if (paidIso < issueIso) throw bad(`วันที่รับเงินต้องไม่ก่อนวันที่ออกบิล (${dmy(issueIso)})`);

        const buyer = this.buyerOf(invoice.customer);
        const missing = missingBuyerFields(buyer, buyerNotVatRegistered);
        if (missing.length) throw bad(`ข้อมูลลูกค้ายังไม่ครบ: ${missing.join(', ')} - แก้ข้อมูลลูกค้าก่อน`);

        const fee = Number(invoice.feeTotal);
        const service = Number(invoice.serviceTotal);
        const goods = Number(invoice.goodsTotal);
        const vat = Number(invoice.vatAmount);
        const amounts = taxInvoiceAmounts({ feeTotal: fee, serviceTotal: service, goodsTotal: goods, vatAmount: vat }, whtAmount);
        if (whtAmount > round2(service + goods)) throw bad('ภาษีหัก ณ ที่จ่ายมากกว่ามูลค่าค่าบริการ - ตรวจยอดอีกครั้ง');

        const { number, taxInvoiceNo } = await this.takeNumber(tx, year, paidIso);

        // ออกแทนใบที่ยกเลิกไปของบิลเดียวกัน - 50 ทวิ ที่แนบไว้กับใบเดิมย้ายมาใบใหม่ (หักภาษีจากการจ่ายเดิม)
        const replaces = await this.replaceableOf(tx, invoiceId);
        const carriedCert = replaces?.whtCertificateId && whtAmount > 0 ? replaces.whtCertificateId : null;
        const created = await tx.taxInvoice.create({
          data: {
            taxInvoiceNo,
            year,
            number,
            invoiceId,
            customerId: invoice.customerId,
            issueDate: paidDate,
            customerSnapshot: buyer,
            sellerSnapshot: SELLER_PROFILE,
            buyerNotVatRegistered,
            vatRate: invoice.vatRate,
            feeTotal: fee,
            serviceTotal: service,
            goodsTotal: goods,
            vatAmount: vat,
            grandTotal: amounts.grandTotal,
            whtAmount: amounts.whtAmount,
            receivedAmount: amounts.receivedAmount,
            whtMethod,
            whtCertificateId: carriedCert,
            replacesId: replaces?.id ?? null,
            createdById: currentUser()?.id ?? null,
          },
        });
        if (carriedCert) await tx.taxInvoice.update({ where: { id: replaces!.id }, data: { whtCertificateId: null } });
        await tx.invoice.update({ where: { id: invoiceId }, data: { status: 'PAID', paidDate, taxInvoiceNo } });
        return created.id;
      },
      { timeout: 20_000 },
    );
    return this.get(id);
  }

  // ---------- ใบกำกับกำหนดเอง (งานนอกระบบ ไม่มีใบวางบิล) ----------

  // ข้อมูลสำหรับหน้า "ออกใบกำกับกำหนดเอง": ผู้ซื้อ ณ ตอนนี้ ข้อมูลที่ขาด เลขถัดไป บัญชีของลูกค้า ณ วันที่ และอัตราหัก ณ ที่จ่ายตั้งต้น
  async customPreview(customerId: string, date?: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, include: { accountPeriods: { select: { account: true, effectiveFrom: true } } } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const dateIso = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : bangkokToday();
    const year = Number(dateIso.slice(0, 4));
    const buyer = this.buyerOf(customer);
    const [seriesRows, last] = await Promise.all([
      this.prisma.taxInvoiceSeries.findMany(),
      this.prisma.taxInvoice.findFirst({ where: { year, status: 'ISSUED' }, orderBy: { number: 'desc' }, select: { taxInvoiceNo: true, issueDate: true } }),
    ]);
    const current = seriesRows.find((s) => s.year === year);
    return {
      enabled: seriesRows.length > 0,
      buyer,
      missing: missingBuyerFields(buyer, false),
      missingIfNotRegistered: missingBuyerFields(buyer, true),
      nextNo: seriesRows.length ? formatTaxInvoiceNo(year, (current?.lastNumber ?? 0) + 1) : null,
      lastIssued: last ? { taxInvoiceNo: last.taxInvoiceNo, issueDate: iso(last.issueDate) } : null,
      replaces: null,
      account: accountOn(toPeriods(customer.accountPeriods ?? []), dateIso),
      whtRate: effectiveWhtRate(toTerms(customer), dateIso),
      defaultWhtMethod: customer.billingWhtMethod === 'EWHT' ? 'EWHT' : 'PAPER',
    };
  }

  // ออกใบกำกับกำหนดเอง { customerId, issueDate (= วันที่รับเงิน), items, whtAmount, whtMethod, buyerNotVatRegistered?, replacesId? }
  // VAT 7% เสมอ (ใบกำกับภาษี) · ค่าธรรมเนียมราชการไม่มี VAT · ลูกค้าบัญชีบุคคล ณ วันนั้นออกไม่ได้เหมือนบิล
  async issueCustom(dto: Record<string, unknown>) {
    const paidDate = parseIsoDate(dto?.issueDate, 'วันที่รับเงิน');
    const paidIso = iso(paidDate)!;
    if (paidIso > bangkokToday()) throw bad('วันที่รับเงินต้องไม่เกินวันนี้');
    if (typeof dto.customerId !== 'string' || !dto.customerId) throw bad('ต้องระบุลูกค้า');
    const items = parseItems(dto.items);
    if (items.length === 0) throw bad('ต้องมีอย่างน้อย 1 บรรทัด');
    const { whtAmount, whtMethod } = parseWht(dto);
    const buyerNotVatRegistered = dto.buyerNotVatRegistered === true;
    const replacesId = typeof dto.replacesId === 'string' && dto.replacesId ? dto.replacesId : null;
    const year = Number(paidIso.slice(0, 4));

    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, include: { accountPeriods: { select: { account: true, effectiveFrom: true } } } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    if (accountOn(toPeriods(customer.accountPeriods ?? []), paidIso) !== 'COMPANY') throw bad('ลูกค้ารายนี้ใช้บัญชีบุคคล ณ วันที่นี้ ไม่มีใบกำกับภาษี');
    const buyer = this.buyerOf(customer);
    const missing = missingBuyerFields(buyer, buyerNotVatRegistered);
    if (missing.length) throw bad(`ข้อมูลลูกค้ายังไม่ครบ: ${missing.join(', ')} - แก้ข้อมูลลูกค้าก่อน`);

    const totals = computeInvoiceTotals({ lines: [], extras: [], items, terms: { vat: true, whtRate: 0, whtSpecialRate: null, whtSpecialUntil: null }, issueDate: paidIso });
    if (whtAmount > round2(totals.serviceTotal + totals.goodsTotal)) throw bad('ภาษีหัก ณ ที่จ่ายมากกว่ามูลค่าค่าบริการ - ตรวจยอดอีกครั้ง');
    const amounts = taxInvoiceAmounts({ feeTotal: totals.feeTotal, serviceTotal: totals.serviceTotal, goodsTotal: totals.goodsTotal, vatAmount: totals.vatAmount }, whtAmount);

    const id = await this.prisma.$transaction(
      async (tx) => {
        // ออกแทนใบกำกับกำหนดเองที่ยกเลิกไปแล้ว (เช่น ชื่อผู้ซื้อผิด) - 50 ทวิ ที่แนบไว้ย้ายมาใบใหม่ถ้าเป็นลูกค้าคนเดิม
        let replaces: { id: string; whtCertificateId: string | null; customerId: string } | null = null;
        if (replacesId) {
          await tx.$queryRaw`SELECT "id" FROM "TaxInvoice" WHERE "id" = ${replacesId} FOR UPDATE`;
          const old = await tx.taxInvoice.findUnique({
            where: { id: replacesId },
            select: { id: true, status: true, invoiceId: true, customerId: true, whtCertificateId: true, replacedBy: { select: { id: true } } },
          });
          if (!old) throw new NotFoundException({ error: 'ไม่พบใบกำกับที่จะออกแทน' });
          if (old.status !== 'CANCELLED' || old.invoiceId !== null) throw conflict('ออกแทนได้เฉพาะใบกำกับกำหนดเองที่ยกเลิกแล้ว');
          if (old.replacedBy) throw conflict('ใบนี้มีใบใหม่ออกแทนไปแล้ว');
          replaces = old;
        }
        const { number, taxInvoiceNo } = await this.takeNumber(tx, year, paidIso);
        const carriedCert = replaces?.whtCertificateId && whtAmount > 0 && replaces.customerId === customer.id ? replaces.whtCertificateId : null;
        const created = await tx.taxInvoice.create({
          data: {
            taxInvoiceNo,
            year,
            number,
            invoiceId: null,
            customerId: customer.id,
            issueDate: paidDate,
            customerSnapshot: buyer,
            sellerSnapshot: SELLER_PROFILE,
            buyerNotVatRegistered,
            vatRate: totals.vatRate,
            feeTotal: totals.feeTotal,
            serviceTotal: totals.serviceTotal,
            goodsTotal: totals.goodsTotal,
            vatAmount: totals.vatAmount,
            grandTotal: amounts.grandTotal,
            whtAmount: amounts.whtAmount,
            receivedAmount: amounts.receivedAmount,
            whtMethod,
            whtCertificateId: carriedCert,
            replacesId: replaces?.id ?? null,
            createdById: currentUser()?.id ?? null,
            items: { createMany: { data: items.map((it) => ({ kind: it.kind, description: it.description, quantity: it.quantity, unitPrice: it.unitPrice, amount: it.amount, sortOrder: it.sortOrder })) } },
          },
        });
        if (carriedCert) await tx.taxInvoice.update({ where: { id: replaces!.id }, data: { whtCertificateId: null } });
        return created.id;
      },
      { timeout: 20_000 },
    );
    return this.get(id);
  }

  // ยกเลิกใบกำกับ (แทน "ยกเลิกการรับเงิน" ของบิลที่มีใบกำกับในระบบ): เลขเดิมเก็บเป็น "ยกเลิก" ไม่ใช้ซ้ำ บิลกลับเป็นรอรับเงิน
  async cancel(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิกใบกำกับ');
    await this.prisma.$transaction(async (tx) => {
      const tv = await tx.taxInvoice.findUnique({ where: { id }, select: { id: true, invoiceId: true } });
      if (!tv) throw new NotFoundException({ error: 'ไม่พบใบกำกับ' });
      // ใบกำกับกำหนดเองไม่มีบิลให้ล็อกหรือย้อนสถานะ - ล็อกแถวใบกำกับเองแทน แล้วบันทึกประวัติที่ใบกำกับ
      if (tv.invoiceId) await tx.$queryRaw`SELECT "id" FROM "Invoice" WHERE "id" = ${tv.invoiceId} FOR UPDATE`;
      else await tx.$queryRaw`SELECT "id" FROM "TaxInvoice" WHERE "id" = ${id} FOR UPDATE`;
      const current = await tx.taxInvoice.findUnique({ where: { id } });
      if (!current || current.status !== 'ISSUED') throw conflict('ใบกำกับนี้ถูกยกเลิกไปแล้ว กรุณาโหลดรายการใหม่');
      const invoice = tv.invoiceId ? await tx.invoice.findUnique({ where: { id: tv.invoiceId }, select: { status: true, paidDate: true } }) : null;
      await tx.taxInvoice.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null },
      });
      if (tv.invoiceId && invoice?.status === 'PAID') {
        await tx.invoice.update({ where: { id: tv.invoiceId }, data: { status: 'ISSUED', paidDate: null, taxInvoiceNo: null } });
      }
      await writeAudit(
        tx,
        tv.invoiceId
          ? {
              entity: 'Invoice',
              entityId: tv.invoiceId,
              action: 'cancel-tax-invoice',
              remark,
              changes: {
                status: { from: invoice?.status ?? null, to: 'ISSUED' },
                paidDate: { from: invoice?.paidDate ?? null, to: null },
                taxInvoiceNo: { from: current.taxInvoiceNo, to: null },
              },
            }
          : { entity: 'TaxInvoice', entityId: id, action: 'cancel', remark, changes: { status: { from: 'ISSUED', to: 'CANCELLED' }, taxInvoiceNo: { from: current.taxInvoiceNo, to: null } } },
      );
    });
    return this.get(id);
  }

  // ใบแทน (ลูกค้าทำต้นฉบับหาย): เลขเดิม ไม่ใช่ใบใหม่ - บันทึกวันที่และเหตุผล แล้วหน้าจอพิมพ์เป็น "ใบแทน"
  async replacement(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ออกใบแทน');
    await this.prisma.$transaction(async (tx) => {
      const tv = await tx.taxInvoice.findUnique({ where: { id }, select: { status: true, invoiceId: true, taxInvoiceNo: true, replacementIssuedAt: true } });
      if (!tv) throw new NotFoundException({ error: 'ไม่พบใบกำกับ' });
      if (tv.status !== 'ISSUED') throw conflict('ใบกำกับที่ยกเลิกแล้วออกใบแทนไม่ได้');
      const now = new Date();
      await tx.taxInvoice.update({ where: { id }, data: { replacementIssuedAt: now, replacementReason: remark } });
      await writeAudit(tx, {
        entity: tv.invoiceId ? 'Invoice' : 'TaxInvoice',
        entityId: tv.invoiceId ?? id,
        action: 'tax-invoice-replacement',
        remark,
        changes: { [`ใบแทน ${tv.taxInvoiceNo}`]: { from: tv.replacementIssuedAt, to: now } },
      });
    });
    return this.get(id);
  }

  async get(id: string) {
    const tv = await this.prisma.taxInvoice.findUnique({ where: { id }, include: TV_INCLUDE });
    if (!tv) throw new NotFoundException({ error: 'ไม่พบใบกำกับ' });
    return this.map(tv);
  }

  // รายการใบกำกับของเดือน (รวมใบที่ยกเลิก) เรียงตามเลข - ใช้ทั้งหน้ารายการและรายงานภาษีขาย
  async list(params: { month?: string }) {
    const month = params.month ?? bangkokToday().slice(0, 7);
    if (!/^\d{4}-\d{2}$/.test(month)) throw bad('เดือนต้องเป็น YYYY-MM');
    const from = new Date(`${month}-01T00:00:00.000Z`);
    const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
    const rows = await this.prisma.taxInvoice.findMany({
      where: { issueDate: { gte: from, lt: to } },
      orderBy: [{ year: 'asc' }, { number: 'asc' }],
      include: TV_INCLUDE,
    });
    return { month, taxInvoices: rows.map((r) => this.map(r)) };
  }

  // ---------- 50 ทวิ ----------

  // ใบกำกับที่ลูกค้าหัก ณ ที่จ่ายแต่ยังไม่มีหลักฐาน (รวมทุกลูกค้า เก่าสุดก่อน) - หน้าติดตามจัดกลุ่มตามลูกค้าเอง
  async whtPending() {
    const today = bangkokToday();
    const rows = await this.prisma.taxInvoice.findMany({
      where: { status: 'ISSUED', whtAmount: { gt: 0 }, whtCertificateId: null },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      select: {
        id: true,
        taxInvoiceNo: true,
        issueDate: true,
        customerId: true,
        customerSnapshot: true,
        whtAmount: true,
        whtMethod: true,
        whtRemindedAt: true,
        receivedAmount: true,
        invoice: { select: { invoiceNo: true } },
      },
    });
    return {
      overdueDays: WHT_OVERDUE_DAYS,
      pending: rows.map((r) => {
        const date = iso(r.issueDate)!;
        return {
          id: r.id,
          taxInvoiceNo: r.taxInvoiceNo,
          invoiceNo: r.invoice?.invoiceNo ?? null,
          issueDate: date,
          customerId: r.customerId,
          customerName: (r.customerSnapshot as CustomerSnapshot).name,
          whtAmount: Number(r.whtAmount),
          whtMethod: r.whtMethod,
          remindedAt: r.whtRemindedAt?.toISOString() ?? null,
          daysWaiting: daysBetween(date, today),
        };
      }),
    };
  }

  // บันทึกว่าทวง 50 ทวิ แล้ว (ปุ่ม "คัดลอกข้อความทวง")
  async remind(dto: { taxInvoiceIds?: unknown }) {
    const ids = dto?.taxInvoiceIds;
    if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) throw bad('ต้องเลือกใบกำกับอย่างน้อย 1 ใบ');
    const { count } = await this.prisma.taxInvoice.updateMany({ where: { id: { in: ids as string[] } }, data: { whtRemindedAt: new Date() } });
    return { updated: count };
  }

  async listCertificates(params: { customerId?: string }) {
    const rows = await this.prisma.whtCertificate.findMany({
      where: { ...(params.customerId ? { customerId: params.customerId } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { customer: { select: { name: true, company: true } }, taxInvoices: { select: { id: true, taxInvoiceNo: true, whtAmount: true } } },
    });
    return {
      certificates: rows.map((c) => ({
        id: c.id,
        customerId: c.customerId,
        customerName: c.customer.company || c.customer.name,
        method: c.method,
        certificateNo: c.certificateNo,
        certificateDate: iso(c.certificateDate),
        amount: Number(c.amount),
        note: c.note,
        hasFile: !!c.storageKey,
        originalName: c.originalName,
        createdAt: c.createdAt.toISOString(),
        cancelledAt: c.cancelledAt?.toISOString() ?? null,
        cancelReason: c.cancelReason,
        taxInvoices: c.taxInvoices.map((t) => ({ id: t.id, taxInvoiceNo: t.taxInvoiceNo, whtAmount: Number(t.whtAmount) })),
        taxInvoiceWhtTotal: round2(c.taxInvoices.reduce((s, t) => s + Number(t.whtAmount), 0)),
      })),
    };
  }

  // แนบ 50 ทวิ ให้ใบกำกับ 1 ใบหรือหลายใบของลูกค้าเดียวกัน (multipart: ไฟล์ file + ช่องข้อความ)
  // กระดาษต้องมีไฟล์ · e-WHT ต้องมีเลขอ้างอิง (ไฟล์ไม่บังคับ) · ยอดไม่ตรงกับยอดหักของใบกำกับ = หน้าจอเตือนก่อนส่ง (ไม่บล็อก)
  async createCertificate(
    dto: { method?: unknown; certificateNo?: unknown; certificateDate?: unknown; amount?: unknown; note?: unknown; taxInvoiceIds?: unknown },
    file: UploadedReceiptFile | undefined,
  ) {
    const method = dto?.method;
    if (method !== 'PAPER' && method !== 'EWHT') throw bad('ประเภทต้องเป็น 50 ทวิ กระดาษ หรือ e-WHT');
    const certificateNo = optionalText(dto.certificateNo, 100);
    if (method === 'EWHT' && !certificateNo) throw bad('e-WHT ต้องใส่เลขอ้างอิง');
    const certificateDate = typeof dto.certificateDate === 'string' && dto.certificateDate ? parseIsoDate(dto.certificateDate, 'วันที่ในหนังสือรับรอง') : null;
    const amount = parseMoney(dto.amount, 'ยอดภาษีตามหนังสือรับรอง');
    if (amount <= 0) throw bad('ยอดภาษีตามหนังสือรับรองต้องมากกว่า 0');
    const note = optionalText(dto.note, 500);
    const rawIds = typeof dto.taxInvoiceIds === 'string' ? dto.taxInvoiceIds.split(',') : dto.taxInvoiceIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) throw bad('ต้องเลือกใบกำกับที่หนังสือรับรองนี้ครอบคลุม');
    const ids = [...new Set((rawIds as unknown[]).map((x) => String(x).trim()).filter(Boolean))];
    if (method === 'PAPER' && !file) throw bad('50 ทวิ กระดาษต้องแนบรูปหรือ PDF');

    let upload: { storageKey: string; mimeType: string; sizeBytes: number; originalName: string | null; contentHash: string; buffer: Buffer } | null = null;
    if (file) {
      const type = detectAttachmentType(file.buffer);
      if (!type) throw bad('ไฟล์ต้องเป็นรูป JPEG/PNG/WebP หรือ PDF');
      const contentHash = contentHashOf(file.buffer);
      if (await this.prisma.whtCertificate.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload('ไฟล์ 50 ทวิ นี้อัพโหลดไปแล้ว');
      const now = new Date();
      const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      upload = {
        storageKey: `wht-certificates/${ym}/${randomUUID()}.${type.ext}`,
        mimeType: type.mimeType,
        sizeBytes: file.size,
        originalName: file.originalname || null,
        contentHash,
        buffer: file.buffer,
      };
    }

    if (upload) await this.storage.put(upload.storageKey, upload.buffer, upload.mimeType);
    try {
      const id = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "TaxInvoice" WHERE "id" = ANY(${ids}::text[]) ORDER BY "id" FOR UPDATE`;
        const tvs = await tx.taxInvoice.findMany({ where: { id: { in: ids } }, select: { id: true, taxInvoiceNo: true, customerId: true, status: true, whtAmount: true, whtCertificateId: true } });
        if (tvs.length !== ids.length) throw bad('ไม่พบใบกำกับบางใบ กรุณาโหลดรายการใหม่');
        if (new Set(tvs.map((t) => t.customerId)).size > 1) throw bad('หนังสือรับรองใบเดียวต้องเป็นของลูกค้ารายเดียว');
        for (const t of tvs) {
          if (t.status !== 'ISSUED') throw conflict(`${t.taxInvoiceNo} ถูกยกเลิกไปแล้ว`);
          if (Number(t.whtAmount) <= 0) throw bad(`${t.taxInvoiceNo} ลูกค้าไม่ได้หัก ณ ที่จ่าย`);
          if (t.whtCertificateId) throw conflict(`${t.taxInvoiceNo} แนบ 50 ทวิ ไปแล้ว`);
        }
        const cert = await tx.whtCertificate.create({
          data: {
            customerId: tvs[0].customerId,
            method,
            certificateNo,
            certificateDate,
            amount,
            note,
            storageKey: upload?.storageKey ?? null,
            mimeType: upload?.mimeType ?? null,
            sizeBytes: upload?.sizeBytes ?? null,
            originalName: upload?.originalName ?? null,
            contentHash: upload?.contentHash ?? null,
            createdById: currentUser()?.id ?? null,
          },
        });
        await tx.taxInvoice.updateMany({ where: { id: { in: ids } }, data: { whtCertificateId: cert.id, whtMethod: method } });
        return cert.id;
      });
      return { id };
    } catch (err) {
      if (upload) await this.storage.delete(upload.storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload('ไฟล์ 50 ทวิ นี้อัพโหลดไปแล้ว');
      throw err;
    }
  }

  // ยกเลิก 50 ทวิ ที่แนบผิด: ใบกำกับกลับเป็นรอ 50 ทวิ, ล้าง contentHash ให้แนบไฟล์เดิมใหม่ได้ (ตัวไฟล์ยังเก็บไว้)
  async cancelCertificate(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิก');
    await this.prisma.$transaction(async (tx) => {
      const cert = await tx.whtCertificate.findUnique({ where: { id }, include: { taxInvoices: { select: { taxInvoiceNo: true } } } });
      if (!cert) throw new NotFoundException({ error: 'ไม่พบหนังสือรับรอง' });
      if (cert.cancelledAt) throw conflict('หนังสือรับรองนี้ถูกยกเลิกไปแล้ว');
      await tx.taxInvoice.updateMany({ where: { whtCertificateId: id }, data: { whtCertificateId: null } });
      await tx.whtCertificate.update({
        where: { id },
        data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null, contentHash: null },
      });
      await writeAudit(tx, {
        entity: 'WhtCertificate',
        entityId: id,
        action: 'cancel',
        remark,
        changes: { taxInvoices: { from: cert.taxInvoices.map((t) => t.taxInvoiceNo), to: [] }, amount: { from: cert.amount, to: null } },
      });
    });
    return { ok: true };
  }

  async certificateFile(id: string): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
    const cert = await this.prisma.whtCertificate.findUnique({ where: { id }, select: { storageKey: true, mimeType: true, certificateNo: true } });
    if (!cert?.storageKey) throw new NotFoundException({ error: 'ไม่มีไฟล์แนบ' });
    const ext = cert.storageKey.slice(cert.storageKey.lastIndexOf('.') + 1);
    return { data: await this.storage.get(cert.storageKey), mimeType: cert.mimeType ?? 'application/octet-stream', fileName: `50ทวิ-${cert.certificateNo ?? id}.${ext}` };
  }

  // ---------- ภายใน ----------

  // เลขถัดไปของปี - ล็อกแถวปีนั้น ออกพร้อมกัน 2 หน้าจอได้เลขต่อกันไม่ซ้ำไม่ข้าม (ใช้ทั้งใบจากบิลและใบกำหนดเอง เลขชุดเดียวกัน)
  private async takeNumber(tx: Prisma.TransactionClient, year: number, paidIso: string) {
    if ((await tx.taxInvoiceSeries.count()) === 0) throw bad('ยังไม่ได้เปิดใช้ใบกำกับในระบบ - ADMIN ต้องตั้งเลขเริ่มก่อน');
    await tx.$executeRaw`INSERT INTO "TaxInvoiceSeries" ("year", "lastNumber", "updatedAt") VALUES (${year}, 0, NOW()) ON CONFLICT DO NOTHING`;
    const [series] = await tx.$queryRaw<Array<{ lastNumber: number }>>`SELECT "lastNumber" FROM "TaxInvoiceSeries" WHERE "year" = ${year} FOR UPDATE`;
    const last = await tx.taxInvoice.findFirst({ where: { year, status: 'ISSUED' }, orderBy: { number: 'desc' }, select: { taxInvoiceNo: true, issueDate: true } });
    // เทียบวันที่กับใบที่ "ยังใช้อยู่" เท่านั้น (ผู้ใช้ 2026-10-06): ใบที่ยกเลิกแล้วใช้ไม่ได้ วันที่ของมันไม่ควรกันการออกใบใหม่ที่ลงวันที่ก่อนหน้า
    if (last && iso(last.issueDate)! > paidIso) {
      throw bad(`วันที่ต้องไม่ก่อนใบกำกับล่าสุด ${last.taxInvoiceNo} (${dmy(iso(last.issueDate)!)}) - เลขใบกำกับต้องเรียงตามวันที่`);
    }
    const number = series.lastNumber + 1;
    const taxInvoiceNo = formatTaxInvoiceNo(year, number);
    await tx.taxInvoiceSeries.update({ where: { year }, data: { lastNumber: number } });
    return { number, taxInvoiceNo };
  }

  private buyerOf(c: { name: string; company: string | null; branch: string | null; address: string | null; taxId: string | null; email?: string | null }): CustomerSnapshot {
    return { name: c.company || c.name, branch: c.branch, address: c.address, taxId: c.taxId ? c.taxId.replace(/\D/g, '') || c.taxId : null, email: c.email?.trim() || null };
  }

  // ใบที่ยกเลิกล่าสุดของบิลนี้ซึ่งยังไม่มีใบใหม่ออกแทน
  private replaceableOf(db: Pick<Prisma.TransactionClient, 'taxInvoice'>, invoiceId: string) {
    return db.taxInvoice.findFirst({
      where: { invoiceId, status: 'CANCELLED', replacedBy: null },
      orderBy: { cancelledAt: 'desc' },
      select: { id: true, taxInvoiceNo: true, cancelReason: true, whtCertificateId: true },
    });
  }

  private map(t: TvRow) {
    const cert = t.whtCertificate && !t.whtCertificate.cancelledAt ? t.whtCertificate : null;
    return {
      id: t.id,
      taxInvoiceNo: t.taxInvoiceNo,
      invoiceId: t.invoiceId,
      // null = ใบกำกับกำหนดเอง (งานนอกระบบ ไม่มีใบวางบิล)
      invoiceNo: t.invoice?.invoiceNo ?? null,
      invoiceIssueDate: t.invoice ? iso(t.invoice.issueDate) : null,
      customerId: t.customerId,
      customer: t.customerSnapshot as CustomerSnapshot,
      // ผู้ขาย ณ วันออกใบ - ใบที่ออกก่อนมีคอลัมน์นี้เป็น null (หน้าจอใช้ข้อมูลบริษัทปัจจุบันแทน)
      seller: (t.sellerSnapshot as SellerSnapshot | null) ?? null,
      buyerNotVatRegistered: t.buyerNotVatRegistered,
      issueDate: iso(t.issueDate),
      createdAt: t.createdAt.toISOString(),
      vatRate: Number(t.vatRate),
      feeTotal: Number(t.feeTotal),
      serviceTotal: Number(t.serviceTotal),
      goodsTotal: Number(t.goodsTotal),
      vatAmount: Number(t.vatAmount),
      grandTotal: Number(t.grandTotal),
      whtAmount: Number(t.whtAmount),
      receivedAmount: Number(t.receivedAmount),
      whtMethod: t.whtMethod,
      whtCertificate: cert
        ? { id: cert.id, method: cert.method, certificateNo: cert.certificateNo, certificateDate: iso(cert.certificateDate), amount: Number(cert.amount), hasFile: !!cert.storageKey }
        : null,
      whtRemindedAt: t.whtRemindedAt?.toISOString() ?? null,
      replacesNo: t.replaces?.taxInvoiceNo ?? null,
      replacedByNo: t.replacedBy?.taxInvoiceNo ?? null,
      replacementIssuedAt: t.replacementIssuedAt?.toISOString() ?? null,
      replacementReason: t.replacementReason,
      status: t.status,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      cancelReason: t.cancelReason,
      // บรรทัดบนหน้าใบ = บรรทัดหน้าใบวางบิลเดิม (หน้าจอคำนวณด้วย invoiceFaceLines ชุดเดียวกัน) · ใบกำหนดเองใช้บรรทัดของใบเอง
      jobLabel: t.invoice?.jobLabel ?? '',
      extras: t.invoice ? (t.invoice.extras as Array<{ label: string; amount: number }>) : [],
      whtRate: t.invoice ? Number(t.invoice.whtRate) : Number(t.serviceTotal) > 0 ? round2((Number(t.whtAmount) / Number(t.serviceTotal)) * 100) : 0,
      lines: (t.invoice?.lines ?? []).map((l) => ({
        receiptAmount: Number(l.receiptAmount),
        serviceFee: Number(l.serviceFee),
        serviceLabel: l.serviceLabel,
        chassis: l.chassis,
        plateText: l.plateText,
        brandName: l.brandName,
        body: l.body,
        deduction: Number(l.deduction),
        swapReceiptAmount: l.swapReceiptAmount === null ? null : Number(l.swapReceiptAmount),
      })),
      items: [...(t.invoice?.items ?? t.items)]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((it) => ({ id: it.id, kind: it.kind, description: it.description, quantity: it.quantity, unitPrice: Number(it.unitPrice), amount: Number(it.amount), cost: null })),
      lineCount: t.invoice?.lines.length ?? 0,
    };
  }
}
