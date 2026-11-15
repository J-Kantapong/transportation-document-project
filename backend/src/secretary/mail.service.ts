import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { pushLine, type LineMessage } from './line-client.js';
import { buildYamahaNoticeMessage, type NoticeInvoice } from './mail-message.js';
import { isYamahaNotice, MailFormatError, parseYamahaNotice, type MailMessage, type YamahaNotice } from './yamaha-mail.js';
import {
  buildYamahaDoMessage,
  buildYamahaPoMessage,
  isYamahaDoMail,
  isYamahaPoMail,
  parseYamahaDoMail,
  parseYamahaPoMail,
  type PoStatus,
  type WaitingQuotation,
} from './yamaha-po-mail.js';

export const MAX_MAILS_PER_CALL = 20;
const MAX_BODY_CHARS = 20_000;
const MAX_REMEMBERED = 500;

// sent = ส่งการ์ดเข้าไลน์แล้ว · nothing-to-do = อ่านได้แต่ไม่มีอะไรต้องแจ้ง · duplicate = เคยรับเมลนี้แล้ว
// ignored = ไม่ใช่เมลของยามาฮ่าที่รู้จัก (แจ้งโอน / PO / DO) · unreadable = เป็นเมลแจ้งโอนแต่อ่านรูปแบบไม่ออก (แจ้งเจ้าของในไลน์ให้เปิดเมลเอง)
export type MailStatus = 'sent' | 'nothing-to-do' | 'duplicate' | 'ignored' | 'unreadable';
export interface MailResult {
  id: string;
  status: MailStatus;
}

// รับเมลที่สคริปต์ใน Gmail ส่งเข้ามา (ผู้ใช้ 2026-11-16 "ให้ bot อ่านเมลยามาฮ่าเอง") แล้วส่งการ์ดเข้าไลน์เจ้าของ
// ไม่ออกใบกำกับเอง: การ์ดมีปุ่ม แล้วต้องกดยืนยันอีกครั้งเหมือนไฟล์ statement (statement.service.ts)
@Injectable()
export class MailService {
  constructor(private readonly prisma: PrismaService) {}

  // กันส่งการ์ดซ้ำเมื่อสคริปต์ retry - จำในหน่วยความจำ (รีสตาร์ท = ลืม) ตัวกันหลักคือป้ายที่สคริปต์ติดให้เมลที่ส่งสำเร็จแล้ว
  private readonly seen = new Set<string>();

  async handleMails(raw: unknown): Promise<MailResult[]> {
    const results: MailResult[] = [];
    for (const mail of normalizeMails(raw)) {
      if (this.seen.has(mail.id)) {
        results.push({ id: mail.id, status: 'duplicate' });
        continue;
      }
      const status = await this.handleOne(mail);
      if (status !== 'ignored') this.remember(mail.id);
      results.push({ id: mail.id, status });
    }
    return results;
  }

  private remember(id: string): void {
    if (this.seen.size >= MAX_REMEMBERED) this.seen.delete(this.seen.values().next().value as string);
    this.seen.add(id);
  }

  private baseUrl(): string | undefined {
    const origin = process.env.FRONTEND_ORIGIN?.trim();
    return origin && /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : undefined;
  }

  // เมล PO / DO จากระบบจัดซื้อของยามาฮ่า (ผู้ใช้ 2026-11-16): แจ้งเตือนอย่างเดียว ไม่บันทึกอะไรจากเมล
  private async handlePurchasing(mail: MailMessage): Promise<MailStatus | null> {
    const isPo = isYamahaPoMail(mail);
    if (!isPo && !isYamahaDoMail(mail)) return null;
    try {
      if (isPo) {
        const poNumbers = parseYamahaPoMail(mail);
        const statuses = await this.loadPoStatuses(poNumbers);
        const waiting = statuses.some((p) => p.state === 'new') ? await this.loadWaitingQuotations() : [];
        const message = buildYamahaPoMessage(statuses, waiting, this.baseUrl());
        if (!message) return 'nothing-to-do';
        await pushLine([message]);
      } else {
        await pushLine([buildYamahaDoMessage(parseYamahaDoMail(mail))]);
      }
      return 'sent';
    } catch (error) {
      if (!(error instanceof MailFormatError)) throw error;
      await pushLine([{ type: 'text', text: `มีเมล ${isPo ? 'PO' : 'DO'} จากยามาฮ่าที่อ่านไม่ออก (${error.message}) - เปิดเมลดูเอง: ${mail.subject.slice(0, 120)}` }]);
      return 'unreadable';
    }
  }

  async loadPoStatuses(poNumbers: string[]): Promise<PoStatus[]> {
    const match = poNumbers.map((po) => ({ poNumber: { contains: po, mode: 'insensitive' as const } }));
    const [invoices, quotations] = await Promise.all([
      this.prisma.invoice.findMany({ where: { OR: match, status: { not: 'VOID' } }, select: { invoiceNo: true, poNumber: true, quotationNo: true } }),
      this.prisma.quotation.findMany({ where: { OR: match, status: 'APPROVED' }, select: { quotationNo: true, poNumber: true } }),
    ]);
    const has = (value: string | null, po: string) => (value ?? '').toUpperCase().includes(po);
    return poNumbers.map((poNumber): PoStatus => {
      const invoice = invoices.find((i) => has(i.poNumber, poNumber));
      const quotation = quotations.find((q) => has(q.poNumber, poNumber));
      if (invoice) return { poNumber, state: 'billed', invoiceNo: invoice.invoiceNo, quotationNo: invoice.quotationNo ?? quotation?.quotationNo ?? null };
      if (quotation) return { poNumber, state: 'approved', invoiceNo: null, quotationNo: quotation.quotationNo };
      return { poNumber, state: 'new', invoiceNo: null, quotationNo: null };
    });
  }

  // ใบเสนอราคาที่ออกแล้วและยังรออนุมัติ ของงานยามาฮ่าหรือลูกค้าที่ต้องมีใบเสนอราคาก่อนวางบิล
  async loadWaitingQuotations(): Promise<WaitingQuotation[]> {
    const rows = await this.prisma.quotation.findMany({
      where: { status: 'ISSUED', quotationNo: { not: null }, OR: [{ yamahaMonth: { not: null } }, { customer: { billingRequiresQuotation: true } }] },
      orderBy: { issueDate: 'asc' },
      take: 20,
      select: { quotationNo: true, title: true, netTotal: true },
    });
    return rows.map((r) => ({ quotationNo: r.quotationNo ?? '', title: r.title, netTotal: Number(r.netTotal) }));
  }

  private async handleOne(mail: MailMessage): Promise<MailStatus> {
    const purchasing = await this.handlePurchasing(mail);
    if (purchasing) return purchasing;
    if (!isYamahaNotice(mail)) return 'ignored';
    let notice: YamahaNotice;
    try {
      notice = parseYamahaNotice(mail);
    } catch (error) {
      if (!(error instanceof MailFormatError)) throw error;
      await pushLine([{ type: 'text', text: `มีเมลแจ้งโอนจากยามาฮ่าที่อ่านไม่ออก (${error.message}) - เปิดเมลดูเอง: ${mail.subject.slice(0, 120)}` }]);
      return 'unreadable';
    }
    const message: LineMessage | null = buildYamahaNoticeMessage(notice, await this.loadInvoices(notice.invoiceNos));
    if (!message) return 'nothing-to-do';
    await pushLine([message]);
    return 'sent';
  }

  async loadInvoices(invoiceNos: string[]): Promise<NoticeInvoice[]> {
    const rows = await this.prisma.invoice.findMany({
      where: { invoiceNo: { in: invoiceNos } },
      select: {
        id: true,
        invoiceNo: true,
        status: true,
        account: true,
        vatRate: true,
        netTotal: true,
        whtAmount: true,
        taxInvoiceNo: true,
        customer: { select: { name: true, company: true, billingTaxInvoiceBeforePayment: true } },
        taxInvoices: { where: { status: 'ISSUED' }, select: { taxInvoiceNo: true } },
      },
    });
    return invoiceNos.map((invoiceNo): NoticeInvoice => {
      // เลขบิลซ้ำได้เมื่อใบเดิมถูกยกเลิกแล้วออกใหม่ - เลือกใบที่ยังใช้อยู่ก่อน
      const row = rows.find((r) => r.invoiceNo === invoiceNo && r.status !== 'VOID') ?? rows.find((r) => r.invoiceNo === invoiceNo);
      if (!row) return { invoiceNo, id: null, state: 'not-found', customerName: '', netTotal: 0, whtAmount: 0, taxInvoiceNo: null, beforePaymentAllowed: false };
      const taxInvoiceNo = row.taxInvoices[0]?.taxInvoiceNo ?? null;
      const canIssue = row.account === 'COMPANY' && Number(row.vatRate) > 0;
      const state: NoticeInvoice['state'] = row.status === 'PAID' ? 'paid' : row.status !== 'ISSUED' ? 'unusable' : taxInvoiceNo ? 'has-tv' : canIssue ? 'open' : 'unusable';
      return {
        invoiceNo,
        id: row.id,
        state,
        customerName: row.customer.company || row.customer.name,
        netTotal: Number(row.netTotal),
        whtAmount: Number(row.whtAmount),
        taxInvoiceNo: taxInvoiceNo ?? row.taxInvoiceNo ?? null,
        beforePaymentAllowed: row.customer.billingTaxInvoiceBeforePayment ?? false,
      };
    });
  }
}

// รับเฉพาะ { messages: [{ id, from, subject, body }] } - ตัดจำนวนและความยาว กันคำขอใหญ่ผิดปกติ
export function normalizeMails(raw: unknown): MailMessage[] {
  const list = (raw as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(list)) return [];
  const out: MailMessage[] = [];
  for (const item of list.slice(0, MAX_MAILS_PER_CALL)) {
    const m = item as Partial<Record<keyof MailMessage, unknown>> | null;
    if (!m || typeof m.id !== 'string' || !m.id || typeof m.from !== 'string' || typeof m.subject !== 'string' || typeof m.body !== 'string') continue;
    out.push({ id: m.id.slice(0, 200), from: m.from.slice(0, 300), subject: m.subject.slice(0, 500), body: m.body.slice(0, MAX_BODY_CHARS) });
  }
  return out;
}
