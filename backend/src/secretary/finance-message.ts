// การ์ดไลน์ "การเงินค้าง" (ผู้ใช้ 2026-10-31: ส่งผ่านเลขาส่วนตัว สั้นๆ) - ส่งต่อจากสรุปเช้าทุกวัน และพิมพ์ "การเงิน" ขอดูเมื่อไหร่ก็ได้
// รายการเดียวกับที่ตรวจด้วยมือวันนั้น: เงินเดือน / รอวางบิล / รอรับเงิน / 50 ทวิ / ใบเสนอราคา / ชุดส่งบัญชีต้นเดือน
// ฟังก์ชันล้วน (ไม่แตะฐานข้อมูล) ข้อมูลมาจาก finance-pending.ts
import { baht, bubble, capList, moreLine, overflowTexts, section, tapTo, text, TONES, urlFor, type Tone } from './card-parts.js';
import type { LineMessage } from './line-client.js';

export type PayrollStatus = 'NONE' | 'DRAFT' | 'APPROVED' | 'PAID';

export interface FinancePending {
  today: string; // YYYY-MM-DD เวลาไทย
  payroll: { month: string; status: PayrollStatus }; // เดือนนี้
  previousPayroll: { month: string; status: PayrollStatus }; // เดือนก่อน
  unbilled: {
    vehicles: number;
    jobs: number;
    oldestDays: number | null; // ส่งงานนานสุดกี่วัน (ใบส่งงานลงวันที่ล่วงหน้า = ไม่นับ)
    customers: Array<{ customerName: string; vehicles: number; jobs: number }>;
  };
  receivables: {
    count: number;
    amount: number;
    company: { count: number; amount: number };
    personal: { count: number; amount: number };
    oldest: { invoiceNo: string; customerName: string; amount: number; days: number } | null;
  };
  wht: { count: number; amount: number; overdue: number; soon: number }; // overdue = เกิน 30 วัน, soon = อีก 5 วันจะเกิน
  quotations: { waiting: number; expired: number; approvedUnused: number; drafts: number };
}

// เงินเดือนเตือนตั้งแต่วันที่ 20 (จ่ายจริงราว 24-25 ของเดือน) - Claude เลือก
export const PAYROLL_REMIND_FROM_DAY = 20;
// ชุดส่งบัญชี / ภ.พ.30 ของเดือนก่อน เตือนวันที่ 1-15 (ระบบรู้ไม่ได้ว่าส่งแล้ว จึงเป็นแค่ข้อเตือน)
export const ACCOUNTING_REMIND_UNTIL_DAY = 15;

const MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

export function previousMonth(month: string): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

const PAYROLL_TEXT: Record<Exclude<PayrollStatus, 'PAID'>, string> = {
  NONE: 'ยังไม่สร้างรอบ',
  DRAFT: 'ยังไม่อนุมัติ',
  APPROVED: 'ยังไม่บันทึกจ่าย',
};

// ข้อเตือนเงินเดือน: เดือนก่อนที่มีรอบแล้วแต่ยังไม่จ่าย (แดง) + เดือนนี้ตั้งแต่วันที่ 20 ถ้ายังไม่จ่าย
// เดือนก่อนที่ไม่มีรอบเลยไม่เตือน (ระบบเริ่มใช้กลางปี บางเดือนไม่มีรอบจริงๆ)
export function payrollTodos(input: Pick<FinancePending, 'today' | 'payroll' | 'previousPayroll'>): Array<{ text: string; tone: Tone }> {
  const out: Array<{ text: string; tone: Tone }> = [];
  const prev = input.previousPayroll;
  if (prev.status === 'DRAFT' || prev.status === 'APPROVED') {
    out.push({ text: `เงินเดือน ${monthLabel(prev.month)} ${PAYROLL_TEXT[prev.status]}`, tone: 'danger' });
  }
  const day = Number(input.today.slice(8, 10));
  if (day >= PAYROLL_REMIND_FROM_DAY && input.payroll.status !== 'PAID') {
    out.push({ text: `เงินเดือน ${monthLabel(input.payroll.month)} ${PAYROLL_TEXT[input.payroll.status]}`, tone: 'danger' });
  }
  return out;
}

export function accountingReminder(today: string): string | null {
  if (Number(today.slice(8, 10)) > ACCOUNTING_REMIND_UNTIL_DAY) return null;
  return `ชุดส่งบัญชี + ภ.พ.30 เดือน ${monthLabel(previousMonth(today.slice(0, 7)))} (ภายในวันที่ 15)`;
}

function line(value: string, tone: Tone, uri: string | undefined, size = 'sm') {
  return text(value, { size, ...(tone === 'neutral' ? {} : { color: TONES[tone].fg }), ...tapTo(uri) });
}

const sub = (value: string, uri?: string) => text(value, { size: 'xs', color: '#888888', ...tapTo(uri) });

// ลูกค้ารอวางบิลแสดงครบทุกราย (ผู้ใช้ 2026-10-08 "ข้อมูลควรครบก่อน") เกินเพดานการ์ดไปต่อในข้อความถัดไปเหมือนสรุปเช้า
export function buildFinanceMessage(input: FinancePending, baseUrl?: string): LineMessage[] {
  const billing = urlFor(baseUrl, '/accounting/billing');
  const lines: Array<Record<string, unknown>> = [];
  const summary: string[] = [];
  let restCustomers: string[] = [];

  for (const todo of payrollTodos(input)) {
    lines.push(line(`• ${todo.text}`, todo.tone, urlFor(baseUrl, '/hr/payroll')));
    summary.push(todo.text);
  }

  const { unbilled } = input;
  if (unbilled.vehicles + unbilled.jobs > 0) {
    const parts = [unbilled.vehicles ? `${unbilled.vehicles} คัน` : '', unbilled.jobs ? `${unbilled.jobs} งาน` : ''].filter(Boolean).join(' + ');
    const oldest = unbilled.oldestDays && unbilled.oldestDays > 0 ? ` (นานสุด ${unbilled.oldestDays} วัน)` : '';
    lines.push(line(`• รอวางบิล ${parts}${oldest}`, unbilled.oldestDays && unbilled.oldestDays > 7 ? 'danger' : 'warning', billing));
    const customerLines = unbilled.customers.map((c) => {
      const what = [c.vehicles ? `${c.vehicles} คัน` : '', c.jobs ? `${c.jobs} งาน` : ''].filter(Boolean).join(' + ');
      return `   ${c.customerName} ${what}`;
    });
    const listed = capList(customerLines);
    restCustomers = listed.rest;
    for (const l of listed.shown) lines.push(sub(l, billing));
    lines.push(...moreLine(listed.rest.length));
    summary.push(`รอวางบิล ${parts}`);
  }

  const { receivables } = input;
  if (receivables.count > 0) {
    lines.push(line(`• รอรับเงิน ${receivables.count} ใบ ${baht(receivables.amount)}`, 'neutral', billing));
    const split = [
      receivables.company.count ? `บริษัท ${receivables.company.count} ใบ ${baht(receivables.company.amount)}` : '',
      receivables.personal.count ? `บุคคล ${receivables.personal.count} ใบ ${baht(receivables.personal.amount)}` : '',
    ].filter(Boolean);
    if (split.length) lines.push(sub(`   ${split.join(' · ')}`, billing));
    const o = receivables.oldest;
    if (o && o.days > 0) lines.push(sub(`   นานสุด ${o.invoiceNo} ${o.customerName} ${baht(o.amount)} (${o.days} วัน)`, urlFor(baseUrl, `/accounting/billing?focus=${o.invoiceNo}`)));
    summary.push(`รอรับเงิน ${receivables.count} ใบ`);
  }

  const { wht } = input;
  if (wht.count > 0) {
    const note = [wht.overdue ? `เกิน 30 วัน ${wht.overdue} ใบ` : '', wht.soon ? `ใกล้ครบ ${wht.soon} ใบ` : ''].filter(Boolean).join(' · ');
    lines.push(line(`• 50 ทวิ ยังไม่ได้รับ ${wht.count} ใบ ${baht(wht.amount)}${note ? ` (${note})` : ''}`, wht.overdue ? 'danger' : wht.soon ? 'warning' : 'neutral', urlFor(baseUrl, '/accounting/tax-invoices/wht')));
    summary.push(`50 ทวิ ${wht.count} ใบ`);
  }

  const q = input.quotations;
  const qParts = [
    q.approvedUnused ? `อนุมัติแล้วยังไม่ออกบิล ${q.approvedUnused}` : '',
    q.expired ? `หมดอายุ ${q.expired}` : '',
    q.waiting ? `รออนุมัติ ${q.waiting}` : '',
    q.drafts ? `ฉบับร่าง ${q.drafts}` : '',
  ].filter(Boolean);
  if (qParts.length) {
    lines.push(line(`• ใบเสนอราคา: ${qParts.join(' · ')}`, q.approvedUnused || q.expired ? 'warning' : 'neutral', urlFor(baseUrl, '/accounting/quotations')));
    summary.push('ใบเสนอราคา');
  }

  const accounting = accountingReminder(input.today);
  if (accounting) lines.push(line(`• ${accounting}`, 'neutral', urlFor(baseUrl, '/accounting/tax-invoices')));

  const body = lines.length > 0 ? lines : [text('ไม่มีงานการเงินค้าง', { size: 'sm', color: TONES.success.fg })];
  const overflow = overflowTexts('การเงินค้าง', [{ title: 'รอวางบิล', lines: restCustomers.map((l) => l.trim()) }]);
  return [
    {
      type: 'flex',
      altText: summary.length ? `การเงินค้าง: ${summary.slice(0, 3).join(' · ')}` : 'การเงินค้าง: ไม่มี',
      contents: bubble('การเงินค้าง', input.today, [section('ต้องทำ / ต้องตาม', body)], baseUrl),
    },
    ...overflow.map((t): LineMessage => ({ type: 'text', text: t })),
  ];
}
