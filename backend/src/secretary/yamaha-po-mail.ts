// เมลจากระบบจัดซื้อของไทยยามาฮ่า (ผู้ใช้ 2026-11-16 "PO มา / DO มา ต้องเตือน เพราะต้องออกใบวางบิล")
//  - PO: accounting.info@… หัวเรื่อง "You have received purchase order (PO) …" เนื้อความ "หมายเลข po : AC693788, AC693767"
//  - DO: purchasing@…      หัวเรื่อง "Received Delivery Order: DO-20261109-089" (หรือ Cancelled) เนื้อความมี Purchase Order No. / Invoice No.
// เมลเป็นข้อมูลจากภายนอก: อ่านแค่เลขเอกสาร แล้วส่งการ์ดแจ้งเจ้าของ ไม่บันทึกหรือออกเอกสารใดๆ จากเมล
// ล้วนเป็นฟังก์ชันบริสุทธิ์ ทดสอบใน yamaha-po-mail.spec.ts
import { text, TONES, urlFor } from './card-parts.js';
import type { LineMessage } from './line-client.js';
import { MailFormatError, senderAddress, type MailMessage } from './yamaha-mail.js';

export const YAMAHA_PO_SENDER = 'accounting.info@yamaha-motor.co.th';
export const YAMAHA_DO_SENDER = 'purchasing@yamaha-motor.co.th';
const PO_SUBJECT_KEY = 'purchase order (PO)';
const DO_SUBJECT = /^\s*(Received|Cancelled|Canceled|Rejected)\s+Delivery Order\s*:\s*(DO-\d{8}-\d{1,5})\s*$/i;
const NOT_REPLY = /^\s*(re|fw|fwd)\s*:/i;
const MAX_POS = 10;
export const QUOTATIONS_PATH = '/accounting/quotations';

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const quotedCut = (body: string) => body.replace(/\r/g, '').split(/^From:/m)[0];

// ---------- PO ----------

export function isYamahaPoMail(message: Pick<MailMessage, 'from' | 'subject'>): boolean {
  return senderAddress(message.from) === YAMAHA_PO_SENDER && message.subject.toLowerCase().includes(PO_SUBJECT_KEY.toLowerCase()) && !NOT_REPLY.test(message.subject);
}

// เลข PO อยู่หลัง "หมายเลข po :" บรรทัดเดียว คั่นด้วยจุลภาค
export function parseYamahaPoMail(message: Pick<MailMessage, 'body'>): string[] {
  const match = quotedCut(message.body).match(/หมายเลข\s*po\s*:\s*([^\n]*)/i);
  if (!match) throw new MailFormatError('ไม่พบ "หมายเลข po"');
  const nos = [...match[1].matchAll(/[A-Z]{1,4}\d{4,10}/gi)].map((m) => m[0].toUpperCase());
  const unique = [...new Set(nos)].slice(0, MAX_POS);
  if (unique.length === 0) throw new MailFormatError('ไม่พบเลข PO ในเมล');
  return unique;
}

export interface PoStatus {
  poNumber: string;
  // billed = มีใบวางบิลที่ใช้ PO นี้แล้ว · approved = บันทึก PO ในใบเสนอราคาแล้ว แต่ยังไม่ออกใบวางบิล · new = ยังไม่เคยบันทึก PO นี้
  state: 'billed' | 'approved' | 'new';
  quotationNo: string | null;
  invoiceNo: string | null;
}

export interface WaitingQuotation {
  quotationNo: string;
  title: string;
  netTotal: number;
}

function describePo(po: PoStatus): string {
  if (po.state === 'billed') return `ออกใบวางบิล ${po.invoiceNo} แล้ว`;
  if (po.state === 'approved') return `บันทึกใน ${po.quotationNo} แล้ว · ยังไม่ได้ออกใบวางบิล`;
  return 'ยังไม่ได้บันทึก PO นี้ในใบเสนอราคา';
}

// null = ทุก PO ออกใบวางบิลแล้ว (เช่นเมลเก่าที่สคริปต์ส่งซ้ำ) ไม่ต้องแจ้ง
export function buildYamahaPoMessage(pos: PoStatus[], waiting: WaitingQuotation[], baseUrl?: string): LineMessage | null {
  const todo = pos.filter((p) => p.state !== 'billed');
  if (todo.length === 0) return null;

  const lines: Array<Record<string, unknown>> = [];
  for (const po of pos) {
    lines.push(text(`PO ${po.poNumber}`, { size: 'sm', weight: 'bold', margin: 'md' }));
    lines.push(text(describePo(po), { size: 'xs', color: po.state === 'billed' ? '#666666' : TONES.danger.fg }));
  }
  if (todo.some((p) => p.state === 'new')) {
    if (waiting.length > 0) {
      lines.push(text('ใบเสนอราคาที่รออนุมัติ', { size: 'xs', color: '#888888', margin: 'lg' }));
      for (const q of waiting.slice(0, 8)) lines.push(text(`${q.quotationNo} ${q.title} · ${money(q.netTotal)}`.trim(), { size: 'xs' }));
    } else {
      lines.push(text('ไม่มีใบเสนอราคาที่รออนุมัติในระบบ - ตรวจว่า PO นี้เป็นของงานไหน', { size: 'xs', color: TONES.danger.fg, margin: 'lg' }));
    }
  }
  lines.push(text('ขั้นตอน: บันทึกอนุมัติใบเสนอราคา (ใส่เลข PO) แล้วกด "ออกใบวางบิลจากใบนี้" · รายละเอียด PO ดูที่ purchase.yamaha-motor.co.th', { size: 'xs', color: '#888888', margin: 'lg' }));

  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: TONES.warning.bg,
      contents: [
        text('ยามาฮ่าส่ง PO มาแล้ว', { size: 'xs', color: '#666666' }),
        text(todo.map((p) => p.poNumber).join(', '), { size: 'lg', weight: 'bold' }),
        text(`ต้องออกใบวางบิล ${todo.length} ใบ`, { size: 'xs', color: TONES.warning.fg }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: lines },
  };
  const uri = urlFor(baseUrl, QUOTATIONS_PATH);
  if (uri) bubble.footer = { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: 'เปิดใบเสนอราคา', uri } }] };
  return { type: 'flex', altText: `ยามาฮ่าส่ง PO ${todo.map((p) => p.poNumber).join(', ')} - ต้องออกใบวางบิล`, contents: bubble };
}

// ---------- DO ----------

export interface YamahaDoMail {
  doNumber: string;
  received: boolean; // false = Cancelled / Rejected
  statusWord: string;
  poNumber: string | null;
  invoiceNo: string | null;
  reason: string | null;
}

export function isYamahaDoMail(message: Pick<MailMessage, 'from' | 'subject'>): boolean {
  return senderAddress(message.from) === YAMAHA_DO_SENDER && DO_SUBJECT.test(message.subject);
}

// ค่าหลังป้ายชื่อในบรรทัดเดียวกัน (Gmail แปลงตัวหนาเป็น *…* ได้ จึงยอมให้มี * คั่น)
function field(body: string, label: string): string | null {
  const match = body.match(new RegExp(`${label}\\.?[*: \\t]*([^\\n]*)`, 'i'));
  const value = match?.[1].replace(/\*/g, '').trim();
  return value ? value.slice(0, 200) : null;
}

export function parseYamahaDoMail(message: Pick<MailMessage, 'subject' | 'body'>): YamahaDoMail {
  const subject = message.subject.match(DO_SUBJECT);
  if (!subject) throw new MailFormatError('หัวเรื่องไม่ใช่ Delivery Order');
  const body = quotedCut(message.body);
  const po = field(body, 'Purchase Order No')?.match(/^[A-Z]{1,4}\d{4,10}$/i)?.[0].toUpperCase() ?? null;
  const invoiceNo = field(body, 'Invoice No')?.match(/^IV\d{4}-\d{3,}$/i)?.[0].toUpperCase() ?? null;
  const statusWord = subject[1][0].toUpperCase() + subject[1].slice(1).toLowerCase();
  return { doNumber: subject[2].toUpperCase(), received: statusWord === 'Received', statusWord, poNumber: po, invoiceNo, reason: field(body, 'Reason of \\w+') };
}

export function buildYamahaDoMessage(mail: YamahaDoMail): LineMessage {
  const lines = [
    text(mail.doNumber, { size: 'sm', weight: 'bold' }),
    text(`PO ${mail.poNumber ?? '-'} · บิล ${mail.invoiceNo ?? '-'}`, { size: 'xs', color: '#666666' }),
    ...(mail.reason ? [text(`เหตุผล: ${mail.reason}`, { size: 'xs', color: TONES.danger.fg })] : []),
    text(mail.received ? 'ยามาฮ่ารับเอกสารแล้ว รอเมลแจ้งวันโอนเงินจากฝ่ายการเงิน' : 'ต้องตรวจในระบบ PR-Online แล้วออก Delivery Order ใหม่ ไม่งั้นยามาฮ่าจะไม่จ่ายบิลนี้', {
      size: 'xs',
      color: mail.received ? '#888888' : TONES.danger.fg,
      margin: 'md',
    }),
  ];
  const tone = mail.received ? TONES.success : TONES.danger;
  const title = mail.received ? 'ยามาฮ่ารับ DO แล้ว' : `ยามาฮ่า${mail.statusWord === 'Rejected' ? 'ตีกลับ' : 'ยกเลิก'} DO`;
  return {
    type: 'flex',
    altText: `${title} ${mail.doNumber}${mail.invoiceNo ? ` (${mail.invoiceNo})` : ''}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: tone.bg, contents: [text(title, { size: 'md', weight: 'bold', color: tone.fg })] },
      body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: lines },
    },
  };
}
