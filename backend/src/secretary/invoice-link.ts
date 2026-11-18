// คำสั่งขอลิงก์ดาวน์โหลดเอกสารในไลน์ (ผู้ใช้ 2026-11-16 "ลองส่งใบวางบิลที่ออกล่าสุดสองอันมาหน่อยทางไลน์" แล้วขอใบกำกับภาษีแบบเดียวกัน)
//   ใบวางบิล:    "บิลล่าสุด" / "ใบวางบิลล่าสุด 3" / "บิล IV2026-155" / "IV2026-155 IV2026-156"
//   ใบกำกับภาษี: "ใบกำกับล่าสุด" / "ใบกำกับภาษีล่าสุด 3" / "ใบกำกับ TV2026-146" / "TV2026-146"
// ล่าสุด: ไม่ใส่จำนวน = 2 ใบ สูงสุด 5 ใบ · ตามเลข: สูงสุด 5 ใบ
// ตอบเป็นข้อความธรรมดาใบละข้อความ ส่งต่อให้พนักงานได้ทีละใบ (LINE รับไม่เกิน 5 ข้อความต่อครั้ง)
import type { LineMessage } from './line-client.js';
import type { PrintKind } from './print-link.js';

export const DEFAULT_LATEST = 2;
export const MAX_INVOICE_LINKS = 5;

// doc: iv = ใบวางบิล · tv = ใบกำกับภาษี (ชื่อเดียวกับชนิดของ token ใน print-link.ts)
// kind customer = ใบล่าสุดของลูกค้ารายเดียว ("บิล SPI", ผู้ใช้ 2026-11-18) - มาจาก lookup.ts ที่หาลูกค้าให้แล้ว ไม่ได้มาจาก parseInvoiceLinkCommand
export type InvoiceLinkCommand =
  | { doc: PrintKind; kind: 'latest'; count: number }
  | { doc: PrintKind; kind: 'numbers'; numbers: string[] }
  | { doc: PrintKind; kind: 'customer'; customerId: string; count: number };

const DOCS: Array<{ doc: PrintKind; number: RegExp; words: string }> = [
  // ใบกำกับก่อน: "ใบกำกับ" ไม่มีคำว่า "บิล" แต่กันไว้ไม่ให้รูปแบบของบิลจับคำของใบกำกับ
  { doc: 'tv', number: /TV\d{4}-\d{1,6}/g, words: 'ใบกำกับภาษี|ใบกำกับ' },
  { doc: 'iv', number: /IV\d{4}-\d{1,6}/g, words: 'ใบวางบิล|บิล' },
];

export function parseInvoiceLinkCommand(input: string): InvoiceLinkCommand | null {
  const text = input.replace(/\s+/g, '').toUpperCase();
  for (const { doc, number, words } of DOCS) {
    const numbers = [...new Set(text.match(number) ?? [])];
    if (numbers.length) {
      // ต้องเป็นข้อความที่มีแต่ชื่อเอกสารกับเลขเอกสาร กันข้อความอื่นที่บังเอิญมีเลข (เช่น "จำ ... IV2026-001") และกันเลขสองชนิดปนกัน
      const rest = text.replace(number, '').replace(new RegExp(`${words}|ขอ|ส่ง|ลิงก์|PDF|[,、/]|และ`, 'g'), '');
      return rest ? null : { doc, kind: 'numbers', numbers: numbers.slice(0, MAX_INVOICE_LINKS) };
    }
    const latest = new RegExp(`^(?:ขอ|ส่ง)?(?:${words})(?:ที่ออก)?ล่าสุด(\\d{1,2})?(?:ใบ|อัน)?$`).exec(text);
    if (latest) {
      const count = latest[1] ? Number(latest[1]) : DEFAULT_LATEST;
      return { doc, kind: 'latest', count: Math.min(Math.max(count, 1), MAX_INVOICE_LINKS) };
    }
  }
  return null;
}

export interface InvoiceLinkRow {
  invoiceNo: string;
  customerName: string;
  issueDate: string; // YYYY-MM-DD
  netTotal: number;
  status: string;
  url: string;
}

// ใบกำกับภาษี: ยอดแยกบรรทัดตามหน้าใบ (ผู้ใช้ 2026-11-16 "สรุปยอดมาด้วยพร้อมระบุหัก ณ ที่จ่าย vat เท่าไหร่")
export interface TaxInvoiceLinkRow {
  taxInvoiceNo: string;
  invoiceNo: string | null; // null = ใบกำกับกำหนดเอง ไม่มีใบวางบิล
  customerName: string;
  issueDate: string; // YYYY-MM-DD
  vatRate: number;
  feeTotal: number;
  serviceTotal: number;
  goodsTotal: number;
  vatAmount: number;
  grandTotal: number; // ก่อนหัก ณ ที่จ่าย
  whtAmount: number;
  receivedAmount: number;
  beforePayment: boolean;
  status: string;
  url: string;
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const percent = (n: number) => String(Number(n.toFixed(2)));
const STATUS_NOTE: Record<string, string> = { PAID: ' · รับเงินแล้ว', VOID: ' · ยกเลิกแล้ว', CANCELLED: ' · ยกเลิกแล้ว' };
const LINK_NOTE = '(ลิงก์ใช้ได้ 7 วัน)';

// หน้า /iv หรือ /tv + download=1 = เปิดแล้วสร้างไฟล์ PDF ทันที · openExternalBrowser=1 = LINE เปิดด้วยเบราว์เซอร์ของเครื่อง
export const documentDownloadUrl = (origin: string, doc: PrintKind, token: string) => `${origin}/${doc}?token=${encodeURIComponent(token)}&download=1&openExternalBrowser=1`;
export const invoiceDownloadUrl = (origin: string, token: string) => documentDownloadUrl(origin, 'iv', token);

// เกิน 5 ข้อความ LINE ไม่รับ - หมายเหตุเลขที่ไม่พบรวมเข้าข้อความสุดท้ายแทน
function withMissing(texts: string[], missing: string[], label: string, empty: string): LineMessage[] {
  const out = texts.slice(0, MAX_INVOICE_LINKS);
  if (missing.length) {
    const note = `ไม่พบเลข${label}: ${missing.join(', ')}`;
    if (out.length >= MAX_INVOICE_LINKS) out[out.length - 1] = `${out[out.length - 1]}\n\n${note}`;
    else out.push(note);
  }
  if (out.length === 0) out.push(empty);
  return out.map((text): LineMessage => ({ type: 'text', text }));
}

export function buildInvoiceLinkMessages(rows: InvoiceLinkRow[], missing: string[] = []): LineMessage[] {
  const texts = rows.map((r) =>
    [`ใบวางบิล ${r.invoiceNo} ${r.customerName}`, `วันที่ ${dmy(r.issueDate)} · ยอดสุทธิ ${money(r.netTotal)} บาท${STATUS_NOTE[r.status] ?? ''}`, `ดาวน์โหลด PDF: ${r.url}`, LINK_NOTE].join('\n'),
  );
  return withMissing(texts, missing, 'บิล', 'ยังไม่มีใบวางบิลในระบบ');
}

export function buildTaxInvoiceLinkMessages(rows: TaxInvoiceLinkRow[], missing: string[] = []): LineMessage[] {
  const texts = rows.map((r) => {
    // รูปแบบที่ผู้ใช้เลือก 2026-11-16 (ลองแบบสั้น 5 บรรทัดแล้วกลับมาใช้แบบแยกบรรทัด): เพิ่ม % ของหัก ณ ที่จ่าย และบรรทัดสุดท้ายเรียก "ยอดรวม"
    const lines = [
      `ใบกำกับภาษี ${r.taxInvoiceNo} ${r.customerName}`,
      `วันที่ ${dmy(r.issueDate)}${r.invoiceNo ? ` · บิล ${r.invoiceNo}` : ''}${r.beforePayment ? ' · ออกก่อนรับเงิน' : ''}${STATUS_NOTE[r.status] ?? ''}`,
      '',
    ];
    // บรรทัดยอดเท่าที่มีจริง (ค่าธรรมเนียมทดรองจ่ายไม่คิด VAT อยู่นอกฐานภาษี)
    if (r.feeTotal > 0) lines.push(`ค่าธรรมเนียม ${money(r.feeTotal)}`);
    if (r.serviceTotal > 0) lines.push(`ค่าบริการ ${money(r.serviceTotal)}`);
    if (r.goodsTotal > 0) lines.push(`ค่าสินค้า ${money(r.goodsTotal)}`);
    // % หัก ณ ที่จ่าย = ยอดที่หักจริง ÷ ค่าบริการ (ฐานของการหัก) - ใบกำกับเก็บแต่ยอดเงิน ไม่ได้เก็บอัตรา · ไม่มีค่าบริการ = ไม่แสดง %
    const whtRate = r.whtAmount > 0 && r.serviceTotal > 0 ? `${percent((r.whtAmount / r.serviceTotal) * 100)}% ` : '';
    lines.push(
      `VAT ${percent(r.vatRate)}% ${money(r.vatAmount)}`,
      `รวมทั้งสิ้น ${money(r.grandTotal)}`,
      r.whtAmount > 0 ? `หัก ณ ที่จ่าย ${whtRate}${money(r.whtAmount)}` : 'หัก ณ ที่จ่าย ไม่มี',
      `ยอดรวม ${money(r.receivedAmount)} บาท`,
      '',
      `ดาวน์โหลด PDF: ${r.url}`,
      LINK_NOTE,
    );
    return lines.join('\n');
  });
  return withMissing(texts, missing, 'ใบกำกับ', 'ยังไม่มีใบกำกับภาษีในระบบ');
}
