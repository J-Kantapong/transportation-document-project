import { HttpException, Injectable } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { TaxInvoiceService } from '../billing/tax-invoice.service.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { matchStatement, parseKbizCsv, StatementFormatError, type StatementInvoice } from './bank-statement.js';
import { fetchLineContent, type LineMessage } from './line-client.js';
import { buildInvoiceLinkMessages, buildTaxInvoiceLinkMessages, documentDownloadUrl, invoiceDownloadUrl, type InvoiceLinkCommand } from './invoice-link.js';
import { createPrintToken, PRINT_LINK_DAYS } from './print-link.js';
import { buildConfirmMessage, buildDownloadLinkMessage, buildIssuedMessage, buildStatementMessages, dmy, postbackData, type StatementPostback } from './statement-message.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const LOOKBACK_MONTHS = 12;
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const iso = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const textOf = (text: string): LineMessage => ({ type: 'text', text });

// ข้อความ error ของระบบ (HttpException ที่มี { error }) เป็นภาษาที่ผู้ใช้อ่านได้อยู่แล้ว - อย่างอื่นตอบกลางๆ
function errorText(error: unknown): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'object' && body && typeof (body as { error?: unknown }).error === 'string') return (body as { error: string }).error;
    if (typeof body === 'string') return body;
  }
  console.error('เลขาทำรายการ statement ไม่สำเร็จ:', error instanceof Error ? error.message : error);
  return 'ทำรายการไม่สำเร็จ ลองใหม่อีกครั้ง';
}

// จับคู่ยอดเงินเข้าจากไฟล์ K BIZ กับใบวางบิล แล้วให้เจ้าของกดออกใบกำกับ/บันทึกรับเงินจากไลน์ (ผู้ใช้ 2026-11-16)
// ทำงานนอก request ของผู้ใช้ (webhook) - ผู้เรียกต้องตรวจแล้วว่าเป็นเจ้าของระบบ · ไม่ออกใบกำกับเองโดยไม่มีการกดยืนยัน
@Injectable()
export class StatementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxInvoices: TaxInvoiceService,
    private readonly billing: BillingService,
  ) {}

  async loadInvoices(): Promise<StatementInvoice[]> {
    const since = new Date(`${bangkokToday()}T00:00:00.000Z`);
    since.setUTCMonth(since.getUTCMonth() - LOOKBACK_MONTHS);
    const rows = await this.prisma.invoice.findMany({
      where: { status: { in: ['ISSUED', 'PAID'] }, issueDate: { gte: since } },
      select: {
        id: true,
        invoiceNo: true,
        customerId: true,
        issueDate: true,
        status: true,
        paidDate: true,
        account: true,
        vatRate: true,
        serviceTotal: true,
        whtAmount: true,
        netTotal: true,
        taxInvoiceNo: true,
        customer: { select: { name: true, company: true } },
        taxInvoices: { where: { status: 'ISSUED' }, select: { taxInvoiceNo: true } },
      },
      orderBy: { issueDate: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      invoiceNo: r.invoiceNo,
      customerId: r.customerId,
      customerName: r.customer.company || r.customer.name,
      issueDate: iso(r.issueDate)!,
      status: r.status as 'ISSUED' | 'PAID',
      paidDate: iso(r.paidDate),
      account: r.account === 'PERSONAL' ? 'PERSONAL' : 'COMPANY',
      hasVat: Number(r.vatRate) > 0,
      serviceTotal: Number(r.serviceTotal),
      whtAmount: Number(r.whtAmount),
      netTotal: Number(r.netTotal),
      taxInvoiceNo: r.taxInvoices[0]?.taxInvoiceNo ?? r.taxInvoiceNo ?? null,
    }));
  }

  // ไฟล์ที่ส่งเข้าแชต: โหลดจาก LINE -> อ่าน -> จับคู่ -> การ์ด
  async handleFile(messageId: string, fileName: string): Promise<LineMessage[]> {
    if (!/\.csv$/i.test(fileName)) return [textOf('รับเฉพาะไฟล์ .csv ที่โหลดจาก K BIZ (รายการเดินบัญชี)')];
    try {
      const file = await fetchLineContent(messageId);
      if (file.length > MAX_FILE_BYTES) return [textOf('ไฟล์ใหญ่เกิน 2 MB - เลือกช่วงวันที่ให้สั้นลงแล้วส่งใหม่')];
      return this.answerStatement(file.toString('utf8'));
    } catch (error) {
      return [textOf(errorText(error))];
    }
  }

  async answerStatement(csv: string): Promise<LineMessage[]> {
    let deposits;
    try {
      deposits = parseKbizCsv(csv);
    } catch (error) {
      if (error instanceof StatementFormatError) return [textOf(error.message)];
      throw error;
    }
    return buildStatementMessages(matchStatement(deposits, await this.loadInvoices()));
  }

  async handlePostback(p: StatementPostback): Promise<LineMessage[]> {
    try {
      if (p.action === 'tv' || p.action === 'tvb') return [await this.confirmTaxInvoice(p)];
      if (p.action === 'tvgo' || p.action === 'tvbgo') return await this.issueTaxInvoice(p);
      if (p.action === 'pay') return [await this.confirmPaid(p)];
      return [await this.markPaid(p)];
    } catch (error) {
      return [textOf(errorText(error))];
    }
  }

  private async invoiceOf(id: string) {
    const invoice = await this.prisma.invoice.findUnique({
      where: { id },
      select: { invoiceNo: true, status: true, netTotal: true, whtAmount: true, customer: { select: { name: true, company: true, billingWhtMethod: true } } },
    });
    if (!invoice) return null;
    return { ...invoice, customerName: invoice.customer.company || invoice.customer.name, whtMethod: invoice.customer.billingWhtMethod === 'EWHT' ? ('EWHT' as const) : ('PAPER' as const) };
  }

  private async confirmTaxInvoice(p: StatementPostback): Promise<LineMessage> {
    const invoice = await this.invoiceOf(p.invoiceId);
    if (!invoice) return textOf('ไม่พบบิลนี้แล้ว ส่งไฟล์ statement ใหม่อีกครั้ง');
    if (invoice.status !== 'ISSUED') return textOf(`${invoice.invoiceNo} บันทึกรับเงินไปแล้ว`);
    const preview = await this.taxInvoices.issuePreview(p.invoiceId);
    const warnings: string[] = [];
    if (!preview.enabled) warnings.push('ยังไม่ได้เปิดใช้ใบกำกับภาษีในระบบ');
    if (preview.missing.length) warnings.push(`ข้อมูลลูกค้ายังไม่ครบ: ${preview.missing.join(', ')} - แก้ข้อมูลลูกค้าก่อน`);
    const last = preview.lastIssued;
    if (last?.issueDate && last.issueDate > p.date) {
      warnings.push(
        last.issueDate.slice(0, 7) === p.date.slice(0, 7)
          ? `ลงวันที่ย้อนก่อน ${last.taxInvoiceNo} (${dmy(last.issueDate)}) - เลขจะไม่เรียงตามวันที่ในเดือนนี้`
          : `มีใบกำกับ ${last.taxInvoiceNo} ลงวันที่ ${dmy(last.issueDate)} แล้ว ระบบไม่ให้ย้อนข้ามเดือน`,
      );
    }
    // ออกก่อนรับเงิน (เมลแจ้งโอนของยามาฮ่า): เฉพาะลูกค้าที่ตั้งไว้ วันที่ = วันที่ลูกค้าจะโอน บิลยังรอรับเงิน
    const before = p.action === 'tvb';
    if (before && !preview.beforePaymentAllowed) warnings.push('ลูกค้ารายนี้ยังไม่ได้ตั้ง "ออกใบกำกับก่อนรับเงิน" ในเงื่อนไขลูกค้า');
    if (before && p.date > bangkokToday()) warnings.push('ลงวันที่ล่วงหน้า - ใบกำกับใบอื่นที่ออกหลังจากนี้ต้องลงวันที่นี้ขึ้นไป');
    const blocked = !preview.enabled || preview.missing.length > 0 || (before && !preview.beforePaymentAllowed);
    return buildConfirmMessage({
      title: `ยืนยันออกใบกำกับ ${invoice.invoiceNo}${before ? ' (ก่อนรับเงิน)' : ''}`,
      lines: [
        invoice.customerName,
        `เลขที่จะได้: ${preview.nextNo ?? '-'}`,
        before ? `วันที่ใบกำกับ (วันที่ลูกค้าจะโอน): ${dmy(p.date)}` : `วันที่ใบกำกับ (วันที่รับเงิน): ${dmy(p.date)}`,
        p.whtAmount > 0 ? `หัก ณ ที่จ่าย ${money(p.whtAmount)} (${invoice.whtMethod === 'EWHT' ? 'e-WHT' : '50 ทวิ กระดาษ'})` : 'ไม่หัก ณ ที่จ่าย',
        'ออกแล้วแก้ไม่ได้ ต้องยกเลิกแล้วออกใหม่',
      ],
      warnings,
      confirm: blocked ? null : { label: 'ยืนยันออกใบกำกับ', data: postbackData({ ...p, action: before ? 'tvbgo' : 'tvgo' }) },
    });
  }

  private async issueTaxInvoice(p: StatementPostback): Promise<LineMessage[]> {
    const invoice = await this.invoiceOf(p.invoiceId);
    if (!invoice) return [textOf('ไม่พบบิลนี้แล้ว')];
    const before = p.action === 'tvbgo';
    const tv = await this.taxInvoices.issue(p.invoiceId, {
      paidDate: p.date,
      whtAmount: p.whtAmount,
      whtMethod: p.whtAmount > 0 ? invoice.whtMethod : 'NONE',
      backdateConfirmed: true, // ผู้ใช้เห็นคำเตือนย้อนวันที่ในการ์ดยืนยันแล้ว
      beforePayment: before,
    });
    const printUrl = this.printUrl(tv.id);
    const card = buildIssuedMessage({ taxInvoiceNo: tv.taxInvoiceNo, invoiceNo: invoice.invoiceNo, customerName: invoice.customerName, date: p.date, printUrl, beforePayment: before });
    // ข้อความที่สอง = ลิงก์ดาวน์โหลด PDF แบบข้อความธรรมดา ส่งต่อให้พนักงานได้ทันที
    return printUrl ? [card, buildDownloadLinkMessage({ taxInvoiceNo: tv.taxInvoiceNo, customerName: invoice.customerName, printUrl })] : [card];
  }

  private async confirmPaid(p: StatementPostback): Promise<LineMessage> {
    const invoice = await this.invoiceOf(p.invoiceId);
    if (!invoice) return textOf('ไม่พบบิลนี้แล้ว ส่งไฟล์ statement ใหม่อีกครั้ง');
    if (invoice.status !== 'ISSUED') return textOf(`${invoice.invoiceNo} บันทึกรับเงินไปแล้ว`);
    return buildConfirmMessage({
      title: `ยืนยันบันทึกรับเงิน ${invoice.invoiceNo}`,
      lines: [invoice.customerName, `ยอดบิล ${money(Number(invoice.netTotal))}`, `วันที่รับเงิน: ${dmy(p.date)}`, 'ไม่ออกใบกำกับใหม่ (บิลนี้มีใบกำกับแล้ว หรือเป็นบัญชีส่วนตัว)'],
      warnings: [],
      confirm: { label: 'ยืนยันรับเงิน', data: postbackData({ ...p, action: 'paygo' }) },
    });
  }

  private async markPaid(p: StatementPostback): Promise<LineMessage> {
    const invoice = await this.billing.markPaid(p.invoiceId, { paidDate: p.date });
    return textOf(`บันทึกรับเงิน ${invoice.invoiceNo} วันที่ ${dmy(p.date)} แล้ว`);
  }

  // ลิงก์เปิดใบกำกับแบบไม่ต้องล็อกอิน - ต้องมีทั้ง FRONTEND_ORIGIN และ AUTH_SECRET ไม่ครบ = ไม่มีลิงก์
  printUrl(taxInvoiceId: string): string | undefined {
    const origin = process.env.FRONTEND_ORIGIN?.trim();
    const secret = process.env.AUTH_SECRET?.trim();
    if (!origin || !/^https?:\/\//i.test(origin) || !secret) return undefined;
    return `${origin.replace(/\/+$/, '')}/tv?token=${encodeURIComponent(createPrintToken(taxInvoiceId, secret))}`;
  }

  // ลิงก์ดาวน์โหลดใบวางบิล (ผู้ใช้ 2026-11-16): "บิลล่าสุด" = ใบที่ออกล่าสุด ไม่นับใบที่ยกเลิก · "บิล IV…" = ตามเลข (ใบที่ยกเลิกแล้วก็เปิดได้ มีลายน้ำ)
  // อ่านอย่างเดียว ไม่แก้ข้อมูล · ลิงก์แสดงราคาในบิล จึงส่งให้เฉพาะเจ้าของ (handleEvents ตอบเฉพาะเจ้าของ) และหมดอายุใน 7 วัน
  async invoiceLinks(command: InvoiceLinkCommand): Promise<LineMessage[]> {
    const origin = process.env.FRONTEND_ORIGIN?.trim();
    const secret = process.env.AUTH_SECRET?.trim();
    if (!origin || !/^https?:\/\//i.test(origin) || !secret) return [textOf('ยังสร้างลิงก์ไม่ได้: ระบบยังไม่ได้ตั้งค่า FRONTEND_ORIGIN / AUTH_SECRET')];
    const base = origin.replace(/\/+$/, '');
    if (command.doc === 'tv') return this.taxInvoiceLinks(command, base, secret);
    const select = { id: true, invoiceNo: true, issueDate: true, netTotal: true, status: true, customer: { select: { name: true, company: true } } } as const;
    const found =
      command.kind === 'numbers'
        ? await this.prisma.invoice.findMany({ where: { invoiceNo: { in: command.numbers } }, select })
        : await this.prisma.invoice.findMany({
            where: { status: { not: 'VOID' }, ...(command.kind === 'customer' ? { customerId: command.customerId } : {}) },
            orderBy: [{ createdAt: 'desc' }, { invoiceNo: 'desc' }],
            take: command.count,
            select,
          });
    const ordered = command.kind === 'numbers' ? command.numbers.flatMap((no) => found.filter((i) => i.invoiceNo === no)) : found;
    const missing = command.kind === 'numbers' ? command.numbers.filter((no) => !found.some((i) => i.invoiceNo === no)) : [];
    return buildInvoiceLinkMessages(
      ordered.map((i) => ({
        invoiceNo: i.invoiceNo,
        customerName: i.customer.company || i.customer.name,
        issueDate: i.issueDate.toISOString().slice(0, 10),
        netTotal: Number(i.netTotal),
        status: i.status,
        url: invoiceDownloadUrl(base, createPrintToken(i.id, secret, Date.now(), PRINT_LINK_DAYS, 'iv')),
      })),
      missing,
    );
  }

  // ลิงก์ดาวน์โหลดใบกำกับภาษี + สรุปยอด (ผู้ใช้ 2026-11-16 "สรุปยอดมาด้วยพร้อมระบุหัก ณ ที่จ่าย vat เท่าไหร่"): "ใบกำกับล่าสุด" = ใบที่ออกล่าสุด
  // ไม่นับใบที่ยกเลิก · "ใบกำกับ TV…" = ตามเลข (ใบที่ยกเลิกแล้วก็เปิดได้ มีลายน้ำ) · ยอดอ่านจากใบกำกับตรงๆ ไม่คำนวณใหม่ · อ่านอย่างเดียว
  private async taxInvoiceLinks(command: InvoiceLinkCommand, base: string, secret: string): Promise<LineMessage[]> {
    const select = {
      id: true,
      taxInvoiceNo: true,
      issueDate: true,
      beforePayment: true,
      customerSnapshot: true,
      vatRate: true,
      feeTotal: true,
      serviceTotal: true,
      goodsTotal: true,
      vatAmount: true,
      grandTotal: true,
      whtAmount: true,
      receivedAmount: true,
      status: true,
      invoice: { select: { invoiceNo: true } },
      customer: { select: { name: true, company: true } },
    } as const;
    const found =
      command.kind === 'numbers'
        ? await this.prisma.taxInvoice.findMany({ where: { taxInvoiceNo: { in: command.numbers } }, select })
        : await this.prisma.taxInvoice.findMany({
            where: { status: 'ISSUED', ...(command.kind === 'customer' ? { customerId: command.customerId } : {}) },
            orderBy: [{ createdAt: 'desc' }, { taxInvoiceNo: 'desc' }],
            take: command.count,
            select,
          });
    const ordered = command.kind === 'numbers' ? command.numbers.flatMap((no) => found.filter((t) => t.taxInvoiceNo === no)) : found;
    const missing = command.kind === 'numbers' ? command.numbers.filter((no) => !found.some((t) => t.taxInvoiceNo === no)) : [];
    return buildTaxInvoiceLinkMessages(
      ordered.map((t) => {
        // ชื่อบนใบกำกับ = ชื่อ ณ วันออกใบ (customerSnapshot) ไม่ใช่ชื่อปัจจุบันของลูกค้า
        const snapshotName = (t.customerSnapshot as { name?: unknown } | null)?.name;
        return {
          taxInvoiceNo: t.taxInvoiceNo,
          invoiceNo: t.invoice?.invoiceNo ?? null,
          customerName: typeof snapshotName === 'string' && snapshotName.trim() ? snapshotName.trim() : t.customer.company || t.customer.name,
          issueDate: t.issueDate.toISOString().slice(0, 10),
          vatRate: Number(t.vatRate),
          feeTotal: Number(t.feeTotal),
          serviceTotal: Number(t.serviceTotal),
          goodsTotal: Number(t.goodsTotal),
          vatAmount: Number(t.vatAmount),
          grandTotal: Number(t.grandTotal),
          whtAmount: Number(t.whtAmount),
          receivedAmount: Number(t.receivedAmount),
          beforePayment: t.beforePayment,
          status: t.status,
          url: documentDownloadUrl(base, 'tv', createPrintToken(t.id, secret)),
        };
      }),
      missing,
    );
  }
}
