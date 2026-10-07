// ประกอบการ์ดไลน์ "สรุปเช้า" จากข้อมูลภาพรวมผู้บริหาร (ผู้ใช้ 2026-10-07: อ่านบนมือถือ ต้องไม่ยาว ปวดหัว)
// หลักการ: ตัวเลขหลัก 4 ช่อง + "ต้องทำก่อน" ไม่เกิน 3 ข้อ + ลูกค้าค้างจ่ายไม่เกิน 3 ราย (ยอดเงินเต็ม ไม่ปัดเป็นพัน)
// ฟังก์ชันนี้เป็นฟังก์ชันล้วน (ไม่แตะฐานข้อมูล/เครือข่าย) ทดสอบแยกได้
import { baht, bubble, section, tapTo, text, thaiDayLabel, tile, tileRow, TONES, urlFor, type Tone } from './card-parts.js';
import type { LineMessage } from './line-client.js';

export { baht, thaiDayLabel };

export interface MorningInput {
  today: string; // YYYY-MM-DD (เวลาไทย)
  spend: { yesterday: { total: number } };
  workingCapital: {
    overdue: {
      count: number;
      amount: number;
      customers: Array<{ customerName: string; count: number; amount: number; maxDaysOver: number }>;
    };
  };
  stuck: { total: number; high: number };
  alerts: Array<{ severity: string; title: string; detail: string; href?: string }>;
}

const MAX_TODO = 3;
const MAX_CUSTOMERS = 3;

// baseUrl = ที่อยู่เว็บ (ไม่ตั้ง = ไม่มีปุ่ม/ลิงก์) · แตะช่องตัวเลข/ข้อความ/ชื่อลูกค้าเพื่อเข้าหน้างานนั้นได้ (ผู้ใช้ 2026-10-07)
export function buildMorningMessage(input: MorningInput, baseUrl?: string): LineMessage {
  const { overdue } = input.workingCapital;
  const billing = urlFor(baseUrl, '/accounting/billing');
  const stuckTone: Tone = input.stuck.total === 0 ? 'success' : input.stuck.high > 0 ? 'danger' : 'warning';

  const todo = input.alerts.slice(0, MAX_TODO).map((alert, index) =>
    text(`${index + 1}. ${alert.title}${alert.detail ? ` - ${alert.detail}` : ''}`, { size: 'sm', ...tapTo(urlFor(baseUrl, alert.href ?? '/')) }),
  );
  const todoLines = todo.length > 0 ? todo : [text('ไม่มีเรื่องด่วน', { size: 'sm', color: TONES.success.fg })];

  const topCustomers = overdue.customers.slice(0, MAX_CUSTOMERS).map((c) =>
    text(`${c.customerName} ${baht(c.amount)} (${c.count} ใบ เกินกำหนด ${c.maxDaysOver} วัน)`, { size: 'sm', ...tapTo(billing) }),
  );
  const moreCustomers = overdue.customers.length - topCustomers.length;
  if (moreCustomers > 0) topCustomers.push(text(`และอีก ${moreCustomers} ราย`, { size: 'xs', color: '#888888' }));

  const body = [
    tileRow(
      tile('บิลเกินกำหนด', `${overdue.count} ใบ`, overdue.count > 0 ? 'danger' : 'success', overdue.count > 0 ? baht(overdue.amount) : undefined, billing),
      tile('รถติดขัด', `${input.stuck.total} คัน`, stuckTone, undefined, urlFor(baseUrl, '/vehicles?status=problem')),
    ),
    tileRow(
      tile('ใช้เมื่อวาน', baht(input.spend.yesterday.total), 'neutral', undefined, urlFor(baseUrl, '/')),
      tile('ลูกค้าค้างจ่าย', `${overdue.customers.length} ราย`, overdue.customers.length > 0 ? 'danger' : 'success', undefined, billing),
    ),
    section('ต้องทำก่อน', todoLines),
    ...(topCustomers.length > 0 ? [section('ลูกค้าค้างจ่ายเกินกำหนด', topCustomers)] : []),
  ];

  return {
    type: 'flex',
    altText: `สรุปเช้า: บิลเกินกำหนด ${overdue.count} ใบ · รถติดขัด ${input.stuck.total} คัน · ใช้เมื่อวาน ${baht(input.spend.yesterday.total)}`,
    contents: bubble('สรุปเช้า', input.today, body, baseUrl),
  };
}
