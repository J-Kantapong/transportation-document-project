// ข้อความตอบกลับสั้นๆ สำหรับคำสั่งในไลน์ (ฟังก์ชันล้วน ไม่แตะฐานข้อมูล) - ยอดเงินเต็ม ไม่ปัด (ผู้ใช้ 2026-10-07)
import { baht } from './card-parts.js';
import { QUICK_COMMANDS } from './commands.js';
import type { LineMessage, QuickReply } from './line-client.js';

export interface OverviewLike {
  spend: { today: { total: number }; yesterday: { total: number }; last7: { total: number }; month: { total: number } };
  workingCapital: {
    overdue: {
      count: number;
      amount: number;
      customers: Array<{ customerName: string; count: number; amount: number; maxDaysOver: number }>;
    };
  };
  stuck: {
    total: number;
    high: number;
    byKind: { car: number; moto: number };
    items: Array<{ chassis: string; customerName: string; stageLabel: string; days: number; severity: string }>;
  };
}

const MAX_CUSTOMERS = 10;
const MAX_STUCK = 5;

export const quickReply: QuickReply = {
  items: QUICK_COMMANDS.map((c) => ({ type: 'action' as const, action: { type: 'message' as const, label: c.label, text: c.text } })),
};

// ใส่ปุ่มลัดที่ข้อความสุดท้ายของคำตอบ (LINE แสดงปุ่มใต้ข้อความล่าสุดเท่านั้น)
export function withQuickReply(messages: LineMessage[]): LineMessage[] {
  return messages.map((m, i) => (i === messages.length - 1 ? { ...m, quickReply } : m));
}

export const textMessage = (text: string): LineMessage => ({ type: 'text', text });

export function helpText(): string {
  return [
    'คำสั่งทั้งหมด (พิมพ์ หรือกดปุ่มด้านล่าง)',
    '',
    'ดูงาน',
    '• สรุปเช้า',
    '• สรุปเย็น',
    '• ค้างจ่าย (บิลเกินกำหนด)',
    '• รถติดขัด',
    '• ยอดใช้จ่าย',
    '',
    'ตู้ข้อความ (ที่อยู่บริษัท ฯลฯ)',
    '• จำ ที่อยู่บริษัท = 123 ถ.…',
    '• ขอ ที่อยู่',
    '• ลืม ที่อยู่บริษัท',
    '• ตู้เอกสาร (ดูรายการ)',
    '',
    'พิมพ์ "คำสั่ง" เมื่อไหร่ก็ได้เพื่อดูรายการนี้',
  ].join('\n');
}

export function overdueText(overview: OverviewLike): string {
  const { overdue } = overview.workingCapital;
  if (overdue.count === 0) return 'ตอนนี้ไม่มีบิลเกินกำหนด';
  const lines = overdue.customers
    .slice(0, MAX_CUSTOMERS)
    .map((c) => `• ${c.customerName} ${baht(c.amount)} (${c.count} ใบ เกิน ${c.maxDaysOver} วัน)`);
  const more = overdue.customers.length - lines.length;
  return [`บิลเกินกำหนด ${overdue.count} ใบ รวม ${baht(overdue.amount)}`, ...lines, ...(more > 0 ? [`และอีก ${more} ราย`] : [])].join('\n');
}

export function stuckText(overview: OverviewLike): string {
  const { stuck } = overview;
  if (stuck.total === 0) return 'ตอนนี้ไม่มีรถติดขัด';
  const lines = stuck.items
    .slice(0, MAX_STUCK)
    .map((i) => `${i.severity === 'high' ? '‼ ' : '• '}${i.chassis} ${i.customerName} - ${i.stageLabel} ${i.days} วัน`);
  const more = stuck.total - lines.length;
  return [
    `รถติดขัด ${stuck.total} คัน (ด่วน ${stuck.high})`,
    `รถยนต์ ${stuck.byKind.car} · จักรยานยนต์ ${stuck.byKind.moto}`,
    ...lines,
    ...(more > 0 ? [`และอีก ${more} คัน`] : []),
  ].join('\n');
}

export function spendText(overview: OverviewLike): string {
  const { spend } = overview;
  return [
    'ยอดใช้จ่าย',
    `วันนี้ ${baht(spend.today.total)}`,
    `เมื่อวาน ${baht(spend.yesterday.total)}`,
    `7 วันล่าสุด ${baht(spend.last7.total)}`,
    `เดือนนี้ ${baht(spend.month.total)}`,
  ].join('\n');
}
