// อ่านเมล "แจ้งรายละเอียด Invoice เพื่อขอรับใบเสร็จรับเงิน" ของฝ่ายการเงินไทยยามาฮ่า (ผู้ใช้ 2026-11-16)
// ยามาฮ่าส่งมาก่อนวันโอน 2-5 วัน: วันที่โอน + ยอด + เลขบิล และต้องได้ใบกำกับก่อนถึงจะจ่าย (Customer.billingTaxInvoiceBeforePayment)
// ล้วนเป็นฟังก์ชันบริสุทธิ์ ทดสอบใน yamaha-mail.spec.ts

export const YAMAHA_SENDER = 'finance@yamaha-motor.co.th';
const SUBJECT_KEY = 'แจ้งรายละเอียด Invoice';

export interface MailMessage {
  id: string;
  from: string;
  subject: string;
  body: string;
}

export interface YamahaNotice {
  payDate: string; // YYYY-MM-DD
  amount: number;
  invoiceNos: string[];
  revised: boolean; // หัวเรื่อง "Revised ..." = ส่งแก้ไขแทนฉบับก่อน
}

export class MailFormatError extends Error {}

// "TYM_Finance <finance@yamaha-motor.co.th>" -> finance@yamaha-motor.co.th
export function senderAddress(from: string): string {
  const match = from.match(/<([^>]+)>/);
  return (match ? match[1] : from).trim().toLowerCase();
}

// เฉพาะเมลของฝ่ายการเงินที่หัวเรื่องเป็นใบแจ้ง - เมลตอบกลับ (RE:) ของคุณประนอมเรื่องเลขพัสดุมีข้อความเดิมแนบอยู่ จึงต้องไม่นับ
export function isYamahaNotice(message: Pick<MailMessage, 'from' | 'subject'>): boolean {
  return senderAddress(message.from) === YAMAHA_SENDER && message.subject.includes(SUBJECT_KEY) && !/^\s*(re|fw|fwd)\s*:/i.test(message.subject);
}

function parseDate(text: string): string {
  const match = text.match(/วันที่โอนเงิน\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) throw new MailFormatError('ไม่พบ "วันที่โอนเงิน"');
  const year = Number(match[3]) > 2400 ? Number(match[3]) - 543 : Number(match[3]);
  const iso = `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== iso) throw new MailFormatError(`วันที่โอนเงินไม่ถูกต้อง (${match[0].trim()})`);
  return iso;
}

function parseAmount(text: string): number {
  const match = text.match(/ยอดเงินที่โอน\s*:?\s*([\d,]+(?:\.\d+)?)/);
  const amount = match ? Number(match[1].replace(/,/g, '')) : NaN;
  if (!Number.isFinite(amount) || amount <= 0) throw new MailFormatError('ไม่พบ "ยอดเงินที่โอน"');
  return Math.round(amount * 100) / 100;
}

// เลขบิลอยู่ระหว่าง "Invoice ดังนี้" กับ "กรุณาแจ้งวิธีการจัดส่ง" (บางฉบับมี "IV :" นำหน้า, หลายบิลก็เรียงต่อกัน)
function parseInvoiceNos(text: string): string[] {
  const start = text.indexOf('Invoice ดังนี้');
  if (start < 0) throw new MailFormatError('ไม่พบรายการ "Invoice ดังนี้"');
  const rest = text.slice(start);
  const end = rest.indexOf('กรุณาแจ้งวิธี');
  const nos = [...(end > 0 ? rest.slice(0, end) : rest).matchAll(/IV\d{4}-\d{3,}/gi)].map((m) => m[0].toUpperCase());
  const unique = [...new Set(nos)];
  if (unique.length === 0) throw new MailFormatError('ไม่พบเลขบิล (IV…) ในเมล');
  return unique;
}

export function parseYamahaNotice(message: Pick<MailMessage, 'subject' | 'body'>): YamahaNotice {
  // ตัดข้อความที่ตอบกลับ/ส่งต่อซ้อนอยู่ด้านล่างออก (ขึ้นต้นด้วย "From:")
  const text = message.body.replace(/\r/g, '').split(/^From:/m)[0];
  return { payDate: parseDate(text), amount: parseAmount(text), invoiceNos: parseInvoiceNos(text), revised: /revised/i.test(message.subject) };
}
