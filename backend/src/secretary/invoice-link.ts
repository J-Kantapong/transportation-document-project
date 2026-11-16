// คำสั่งขอลิงก์ดาวน์โหลดใบวางบิลในไลน์ (ผู้ใช้ 2026-11-16 "ลองส่งใบวางบิลที่ออกล่าสุดสองอันมาหน่อยทางไลน์")
//   "บิลล่าสุด" / "ใบวางบิลล่าสุด 3"  = ใบที่ออกล่าสุด (ไม่ใส่จำนวน = 2 ใบ สูงสุด 5 ใบ)
//   "บิล IV2026-155" / "IV2026-155 IV2026-156" = ตามเลขบิล (สูงสุด 5 ใบ)
// ตอบเป็นข้อความธรรมดาใบละข้อความ ส่งต่อให้พนักงานได้ทีละใบ (LINE รับไม่เกิน 5 ข้อความต่อครั้ง)
import type { LineMessage } from './line-client.js';

export const DEFAULT_LATEST = 2;
export const MAX_INVOICE_LINKS = 5;

export type InvoiceLinkCommand = { kind: 'latest'; count: number } | { kind: 'numbers'; invoiceNos: string[] };

const INVOICE_NO = /IV\d{4}-\d{1,6}/g;

export function parseInvoiceLinkCommand(input: string): InvoiceLinkCommand | null {
  const text = input.replace(/\s+/g, '').toUpperCase();
  const numbers = [...new Set(text.match(INVOICE_NO) ?? [])];
  if (numbers.length) {
    // ต้องเป็นข้อความที่มีแต่คำว่าบิลกับเลขบิล กันข้อความอื่นที่บังเอิญมีเลขบิล (เช่น "จำ ... IV2026-001")
    const rest = text.replace(INVOICE_NO, '').replace(/ใบวางบิล|บิล|ขอ|ส่ง|ลิงก์|PDF|[,、/]|และ/g, '');
    return rest ? null : { kind: 'numbers', invoiceNos: numbers.slice(0, MAX_INVOICE_LINKS) };
  }
  const latest = /^(?:ขอ|ส่ง)?(?:ใบวางบิล|บิล)(?:ที่ออก)?ล่าสุด(\d{1,2})?(?:ใบ|อัน)?$/.exec(text);
  if (!latest) return null;
  const count = latest[1] ? Number(latest[1]) : DEFAULT_LATEST;
  return { kind: 'latest', count: Math.min(Math.max(count, 1), MAX_INVOICE_LINKS) };
}

export interface InvoiceLinkRow {
  invoiceNo: string;
  customerName: string;
  issueDate: string; // YYYY-MM-DD
  netTotal: number;
  status: string;
  url: string;
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const STATUS_NOTE: Record<string, string> = { PAID: ' · รับเงินแล้ว', VOID: ' · ยกเลิกแล้ว' };

// หน้า /iv + download=1 = เปิดแล้วสร้างไฟล์ PDF ทันที · openExternalBrowser=1 = LINE เปิดด้วยเบราว์เซอร์ของเครื่อง (เหมือนลิงก์ใบกำกับ)
export const invoiceDownloadUrl = (origin: string, token: string) => `${origin}/iv?token=${encodeURIComponent(token)}&download=1&openExternalBrowser=1`;

export function buildInvoiceLinkMessages(rows: InvoiceLinkRow[], missing: string[] = []): LineMessage[] {
  const messages: LineMessage[] = rows.slice(0, MAX_INVOICE_LINKS).map((r) => ({
    type: 'text',
    text: [
      `ใบวางบิล ${r.invoiceNo} ${r.customerName}`,
      `วันที่ ${dmy(r.issueDate)} · ยอดสุทธิ ${money(r.netTotal)} บาท${STATUS_NOTE[r.status] ?? ''}`,
      `ดาวน์โหลด PDF: ${r.url}`,
      '(ลิงก์ใช้ได้ 7 วัน)',
    ].join('\n'),
  }));
  if (missing.length) {
    const note: LineMessage = { type: 'text', text: `ไม่พบเลขบิล: ${missing.join(', ')}` };
    // เกิน 5 ข้อความ LINE ไม่รับ - รวมหมายเหตุเข้าข้อความสุดท้ายแทน
    if (messages.length >= MAX_INVOICE_LINKS) messages[messages.length - 1] = { type: 'text', text: `${(messages[messages.length - 1] as { text: string }).text}\n\n${(note as { text: string }).text}` };
    else messages.push(note);
  }
  if (messages.length === 0) messages.push({ type: 'text', text: 'ยังไม่มีใบวางบิลในระบบ' });
  return messages;
}
