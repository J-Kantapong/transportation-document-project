// การ์ดไลน์ของการจับคู่ยอดเงินเข้ากับบิล (ผู้ใช้ 2026-11-16) - ฟังก์ชันบริสุทธิ์ ทดสอบใน statement-message.spec.ts
import { actionFor, type DepositResult } from './bank-statement.js';
import { text, TONES } from './card-parts.js';
import type { LineMessage } from './line-client.js';

// ข้อมูลใน postback ของปุ่ม: st|<คำสั่ง>|<invoiceId>|<วันที่เงินเข้า>|<หัก ณ ที่จ่าย>
//   tv = ขอออกใบกำกับ (ถามยืนยันก่อน) · tvgo = ยืนยันออกใบกำกับ · pay = ขอบันทึกรับเงิน · paygo = ยืนยันบันทึกรับเงิน
//   tvb / tvbgo = ออกใบกำกับก่อนรับเงิน (เมลแจ้งโอนของยามาฮ่า): วันที่ = วันที่ลูกค้าจะโอน บิลยังรอรับเงิน
export const STATEMENT_ACTIONS = ['tv', 'tvgo', 'pay', 'paygo', 'tvb', 'tvbgo'] as const;
export type StatementAction = (typeof STATEMENT_ACTIONS)[number];
export interface StatementPostback {
  action: StatementAction;
  invoiceId: string;
  date: string;
  whtAmount: number;
}

export const postbackData = (p: StatementPostback) => `st|${p.action}|${p.invoiceId}|${p.date}|${p.whtAmount}`;

export function parseStatementPostback(data: string | undefined): StatementPostback | null {
  const [prefix, action, invoiceId, date, wht, ...rest] = (data ?? '').split('|');
  if (prefix !== 'st' || rest.length || !invoiceId) return null;
  if (!(STATEMENT_ACTIONS as readonly string[]).includes(action ?? '')) return null;
  const whtAmount = Number(wht);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !Number.isFinite(whtAmount) || whtAmount < 0) return null;
  return { action: action as StatementAction, invoiceId, date, whtAmount };
}

export const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const diffText = (diff: number) => (Math.abs(diff) < 0.005 ? 'ตรงเป๊ะ' : `ต่าง ${diff > 0 ? '+' : ''}${money(diff)}`);

export function postbackButton(label: string, data: string, primary = true): Record<string, unknown> {
  // label ของปุ่มใน LINE ยาวได้ไม่เกิน 20 ตัวอักษร
  return { type: 'button', style: primary ? 'primary' : 'secondary', height: 'sm', action: { type: 'postback', label: label.slice(0, 20), data, displayText: label } };
}

const MAX_BUBBLES = 12; // carousel ของ LINE รับไม่เกิน 12 ใบ
const MAX_MATCHES_SHOWN = 3;
const MAX_BUTTONS = 4;

function depositBubble(result: DepositResult): Record<string, unknown> {
  const { deposit, matches } = result;
  const shown = matches.slice(0, MAX_MATCHES_SHOWN);
  const lines: Array<Record<string, unknown>> = [];
  const buttons: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  for (const match of shown) {
    lines.push(text(`${match.label} (${diffText(match.diff)})`, { size: 'xs', color: '#888888', margin: 'md' }));
    for (const { invoice, whtAmount } of match.invoices) {
      const kind = actionFor(invoice);
      const note = kind === 'tax-invoice' ? 'ยังไม่มีใบกำกับ' : invoice.taxInvoiceNo ? `มี ${invoice.taxInvoiceNo} แล้ว รอบันทึกรับเงิน` : 'บัญชีส่วนตัว/ไม่มี VAT';
      lines.push(text(`${invoice.invoiceNo} ${invoice.customerName}`, { size: 'sm', weight: 'bold' }));
      lines.push(text(`ยอดบิล ${money(invoice.netTotal)} · ${note}`, { size: 'xs', color: '#666666' }));
      if (seen.has(invoice.id) || buttons.length >= MAX_BUTTONS) continue;
      seen.add(invoice.id);
      buttons.push(
        kind === 'tax-invoice'
          ? postbackButton(`ใบกำกับ ${invoice.invoiceNo}`, postbackData({ action: 'tv', invoiceId: invoice.id, date: deposit.date, whtAmount }))
          : postbackButton(`รับเงิน ${invoice.invoiceNo}`, postbackData({ action: 'pay', invoiceId: invoice.id, date: deposit.date, whtAmount: 0 }), false),
      );
    }
  }
  if (matches.length > shown.length) lines.push(text(`และอีก ${matches.length - shown.length} แบบที่ยอดใกล้เคียง`, { size: 'xs', color: '#888888' }));
  const ambiguous = matches.length > 1;
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: ambiguous ? TONES.warning.bg : TONES.success.bg,
      contents: [
        text(`เงินเข้า ${dmy(deposit.date)} ${deposit.time}`, { size: 'xs', color: '#666666' }),
        text(`฿${money(deposit.amount)}`, { size: 'xl', weight: 'bold' }),
        text(ambiguous ? `ตรงได้ ${matches.length} แบบ - เลือกให้ถูกบิล` : deposit.channel || deposit.kind, { size: 'xs', color: ambiguous ? TONES.warning.fg : '#666666' }),
      ],
    },
    body: { type: 'box', layout: 'vertical', spacing: 'xs', contents: lines },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: buttons },
  };
}

// คำตอบหลังรับไฟล์ statement: ข้อความสรุป + การ์ดของยอดที่ต้องทำ (ยอดที่ทำแล้ว/ไม่พบบิล อยู่ในข้อความสรุป)
export function buildStatementMessages(results: DepositResult[]): LineMessage[] {
  if (results.length === 0) return [{ type: 'text', text: 'ไฟล์นี้ไม่มีรายการเงินเข้า' }];
  const matched = results.filter((r) => r.state === 'matched');
  const done = results.filter((r) => r.state === 'done');
  const none = results.filter((r) => r.state === 'none');
  const total = results.reduce((s, r) => s + r.deposit.amount, 0);
  const summary = [
    `เงินเข้า ${results.length} รายการ รวม ${money(total)} บาท`,
    `• ต้องทำ ${matched.length} รายการ (กดปุ่มในการ์ดด้านล่าง)`,
    `• บันทึกแล้ว ${done.length} รายการ`,
    `• ไม่พบบิลที่ยอดตรง ${none.length} รายการ`,
  ];
  if (done.length) {
    summary.push('', 'บันทึกแล้ว');
    for (const r of done) summary.push(`${dmy(r.deposit.date)} ${money(r.deposit.amount)} = ${r.done!.invoiceNo} ${r.done!.customerName}${r.done!.taxInvoiceNo ? ` (${r.done!.taxInvoiceNo})` : ''}`);
  }
  if (none.length) {
    summary.push('', 'ไม่พบบิล (อาจเป็นงานนอกระบบ หรือโอนรวมเกิน 4 บิล)');
    for (const r of none) summary.push(`${dmy(r.deposit.date)} ${r.deposit.time} ${money(r.deposit.amount)} ${r.deposit.channel}`);
  }
  const messages: LineMessage[] = [{ type: 'text', text: summary.join('\n').slice(0, 4900) }];
  for (let i = 0; i < matched.length && messages.length < 5; i += MAX_BUBBLES) {
    const chunk = matched.slice(i, i + MAX_BUBBLES);
    messages.push({ type: 'flex', altText: `ยอดเงินเข้าที่ต้องทำ ${chunk.length} รายการ`, contents: { type: 'carousel', contents: chunk.map(depositBubble) } });
  }
  return messages;
}

export interface ConfirmCard {
  title: string;
  lines: string[];
  warnings: string[];
  // null = ทำต่อไม่ได้ (เช่น ข้อมูลลูกค้าไม่ครบ) จึงไม่มีปุ่มยืนยัน
  confirm: { label: string; data: string } | null;
}

export function buildConfirmMessage(card: ConfirmCard): LineMessage {
  const body: Array<Record<string, unknown>> = [
    ...card.lines.map((l) => text(l, { size: 'sm' })),
    ...card.warnings.map((w) => text(`⚠ ${w}`, { size: 'xs', color: TONES.danger.fg, margin: 'md' })),
  ];
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: { type: 'box', layout: 'vertical', contents: [text(card.title, { weight: 'bold', size: 'md' })] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
  };
  if (card.confirm) bubble.footer = { type: 'box', layout: 'vertical', contents: [postbackButton(card.confirm.label, card.confirm.data)] };
  return { type: 'flex', altText: card.title, contents: bubble };
}

export function buildIssuedMessage(input: { taxInvoiceNo: string; invoiceNo: string; customerName: string; date: string; printUrl?: string; beforePayment?: boolean }): LineMessage {
  const bubble: Record<string, unknown> = {
    type: 'bubble',
    size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: TONES.success.bg, contents: [text(`ออก ${input.taxInvoiceNo} แล้ว`, { weight: 'bold', size: 'md', color: TONES.success.fg })] },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        text(`${input.invoiceNo} ${input.customerName}`, { size: 'sm' }),
        text(`วันที่ใบกำกับ ${dmy(input.date)} · ${input.beforePayment ? 'ออกก่อนรับเงิน บิลยังรอรับเงิน' : 'บันทึกรับเงินแล้ว'}`, { size: 'sm' }),
        text(input.printUrl ? 'กดปุ่มเพื่อดาวน์โหลด PDF หรือเปิดใบกำกับ (ต้นฉบับ + สำเนา) · ข้อความถัดไปคือลิงก์ดาวน์โหลดสำหรับส่งต่อให้พนักงาน ลิงก์ใช้ได้ 7 วัน' : 'เปิดปริ้นได้ที่หน้าใบกำกับภาษีในระบบ', { size: 'xs', color: '#666666' }),
      ],
    },
  };
  if (input.printUrl) {
    bubble.footer = {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: [
        { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: 'ดาวน์โหลด PDF', uri: pdfDownloadUrl(input.printUrl) } },
        { type: 'button', style: 'secondary', height: 'sm', action: { type: 'uri', label: 'เปิดใบกำกับ', uri: input.printUrl } },
      ],
    };
  }
  return { type: 'flex', altText: `ออก ${input.taxInvoiceNo} แล้ว`, contents: bubble };
}

// ลิงก์ดาวน์โหลด PDF (ผู้ใช้ 2026-11-16 "ส่งเป็นลิ้งดาวโหลดมาเลย"): หน้า /tv เดิม + download=1 = เปิดแล้วสร้างไฟล์ PDF ให้ทันที
// openExternalBrowser=1 = LINE เปิดด้วยเบราว์เซอร์ของเครื่อง (เบราว์เซอร์ในแอป LINE บันทึกไฟล์ไม่ได้)
export function pdfDownloadUrl(printUrl: string): string {
  return `${printUrl}${printUrl.includes('?') ? '&' : '?'}download=1&openExternalBrowser=1`;
}

// ข้อความธรรมดาที่มีลิงก์ดาวน์โหลด - กดค้างแล้วส่งต่อให้พนักงานได้ (การ์ดส่งต่อยากกว่า)
export function buildDownloadLinkMessage(input: { taxInvoiceNo: string; customerName: string; printUrl: string }): LineMessage {
  return { type: 'text', text: `ดาวน์โหลด PDF ${input.taxInvoiceNo} ${input.customerName}\n${pdfDownloadUrl(input.printUrl)}\n(ลิงก์ใช้ได้ 7 วัน)` };
}
