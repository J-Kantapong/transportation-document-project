// การ์ดไลน์ "ยามาฮ่าแจ้งโอน" (ผู้ใช้ 2026-11-16) - ฟังก์ชันบริสุทธิ์ ทดสอบใน yamaha-mail.spec.ts
import { text, TONES } from './card-parts.js';
import type { LineMessage } from './line-client.js';
import { dmy, postbackButton, postbackData } from './statement-message.js';
import type { YamahaNotice } from './yamaha-mail.js';

export interface NoticeInvoice {
  invoiceNo: string;
  id: string | null;
  // open = รอรับเงินและยังไม่มีใบกำกับ · has-tv = มีใบกำกับ (ออกก่อนรับเงิน) แล้ว รอรับเงิน · paid = บันทึกรับเงินแล้ว
  // not-found = ไม่มีเลขนี้ในระบบ · unusable = ยกเลิกแล้ว หรือสถานะอื่นที่ออกใบกำกับไม่ได้
  state: 'open' | 'has-tv' | 'paid' | 'not-found' | 'unusable';
  customerName: string;
  netTotal: number;
  whtAmount: number;
  taxInvoiceNo: string | null;
  beforePaymentAllowed: boolean;
}

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const AMOUNT_TOLERANCE = 0.5;
const MAX_BUTTONS = 4;

export const YAMAHA_REPLY_REMINDER = 'ยามาฮ่าขอให้ตอบเมลยืนยัน และสแกนใบกำกับตัวจริงส่งที่ pranom@yamaha-motor.co.th ก่อนส่งเอกสาร';

function describe(inv: NoticeInvoice): string {
  switch (inv.state) {
    case 'open':
      return `ยอดบิล ${money(inv.netTotal)} · ยังไม่มีใบกำกับ${inv.beforePaymentAllowed ? '' : ' · ลูกค้านี้ยังไม่ได้ตั้ง "ออกใบกำกับก่อนรับเงิน"'}`;
    case 'has-tv':
      return `มี ${inv.taxInvoiceNo} แล้ว · รอรับเงิน`;
    case 'paid':
      return 'บันทึกรับเงินแล้ว';
    case 'not-found':
      return 'ไม่พบเลขบิลนี้ในระบบ';
    default:
      return 'บิลนี้ใช้ออกใบกำกับไม่ได้ (ยกเลิกแล้วหรือสถานะอื่น)';
  }
}

// null = ไม่มีอะไรต้องแจ้ง (ทุกบิลมีใบกำกับแล้วหรือบันทึกรับเงินแล้ว - เช่นเมลเก่าที่สคริปต์ส่งซ้ำหลังเซิร์ฟเวอร์รีสตาร์ท)
export function buildYamahaNoticeMessage(notice: YamahaNotice, invoices: NoticeInvoice[]): LineMessage | null {
  if (invoices.length > 0 && invoices.every((i) => i.state === 'paid' || i.state === 'has-tv')) return null;

  const found = invoices.filter((i) => i.state !== 'not-found');
  const billTotal = Math.round(found.reduce((s, i) => s + i.netTotal, 0) * 100) / 100;
  const diff = Math.round((notice.amount - billTotal) * 100) / 100;
  const warnings: string[] = [];
  if (found.length > 0 && Math.abs(diff) > AMOUNT_TOLERANCE) {
    warnings.push(`ยอดในเมล ${money(notice.amount)} ไม่ตรงยอดบิลรวม ${money(billTotal)} (ต่าง ${diff > 0 ? '+' : ''}${money(diff)}) - ตรวจกับบิลก่อนออกใบกำกับ`);
  }
  if (invoices.some((i) => i.state === 'not-found')) warnings.push('มีเลขบิลที่ไม่พบในระบบ');
  if (notice.revised) warnings.push('เมลฉบับแก้ไข (Revised) - ถ้าเคยออกใบกำกับตามฉบับก่อนแล้ว ให้ตรวจว่ายอดและบิลยังตรงกัน');

  const lines: Array<Record<string, unknown>> = [];
  for (const inv of invoices) {
    lines.push(text(inv.customerName ? `${inv.invoiceNo} ${inv.customerName}` : inv.invoiceNo, { size: 'sm', weight: 'bold', margin: 'md' }));
    lines.push(text(describe(inv), { size: 'xs', color: '#666666' }));
  }
  for (const w of warnings) lines.push(text(`⚠ ${w}`, { size: 'xs', color: TONES.danger.fg, margin: 'md' }));
  lines.push(text(YAMAHA_REPLY_REMINDER, { size: 'xs', color: '#888888', margin: 'lg' }));

  const buttons = invoices
    .filter((i) => i.state === 'open' && i.beforePaymentAllowed && i.id)
    .slice(0, MAX_BUTTONS)
    // ป้ายปุ่มยาวได้ 20 ตัวอักษร - ต้องเห็นเลขบิลครบ ไม่งั้นหลายบิลจะเป็นปุ่มหน้าตาเหมือนกัน
    .map((i) => postbackButton(`ใบกำกับ ${i.invoiceNo}`,postbackData({ action: 'tvb', invoiceId: i.id!, date: notice.payDate, whtAmount: i.whtAmount })));

  const needsAction = buttons.length > 0;
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: warnings.length ? TONES.warning.bg : needsAction ? TONES.success.bg : TONES.neutral.bg,
      contents: [
        text(`ยามาฮ่าแจ้งโอน ${dmy(notice.payDate)}${notice.revised ? ' (แก้ไข)' : ''}`, { size: 'xs', color: '#666666' }),
        text(`฿${money(notice.amount)}`, { size: 'xl', weight: 'bold' }),
        text(needsAction ? 'ต้องได้ใบกำกับก่อนถึงจะจ่าย' : 'ไม่มีบิลที่ต้องออกใบกำกับเพิ่ม', { size: 'xs', color: '#666666' }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: lines },
  };
  if (buttons.length) bubble.footer = { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons };
  return { type: 'flex', altText: `ยามาฮ่าแจ้งโอน ${dmy(notice.payDate)} ฿${money(notice.amount)}`, contents: bubble };
}
