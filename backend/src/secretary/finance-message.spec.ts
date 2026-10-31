import { describe, expect, it } from 'vitest';
import { accountingReminder, buildFinanceMessage, monthLabel, payrollTodos, previousMonth, type FinancePending } from './finance-message.js';

const base: FinancePending = {
  today: '2026-10-31',
  payroll: { month: '2026-10', status: 'NONE' },
  previousPayroll: { month: '2026-09', status: 'PAID' },
  unbilled: {
    vehicles: 28,
    jobs: 8,
    oldestDays: 19,
    customers: [
      { customerName: 'SPI', vehicles: 21, jobs: 0 },
      { customerName: 'Spac EV', vehicles: 7, jobs: 0 },
      { customerName: 'YM', vehicles: 0, jobs: 8 },
      { customerName: 'D', vehicles: 1, jobs: 0 },
    ],
  },
  receivables: {
    count: 19,
    amount: 1385773.3,
    company: { count: 12, amount: 1151413.25 },
    personal: { count: 7, amount: 234360.05 },
    oldest: { invoiceNo: 'IV2026-114', customerName: 'YM', amount: 418757.8, days: 57 },
  },
  wht: { count: 16, amount: 10752.25, overdue: 0, soon: 1 },
  quotations: { waiting: 2, expired: 0, approvedUnused: 0, drafts: 1 },
};

const allText = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(allText);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [...(typeof record.text === 'string' ? [record.text] : []), ...Object.values(record).flatMap(allText)];
  }
  return [];
};

function flexOf(input: FinancePending, url?: string) {
  const [message] = buildFinanceMessage(input, url);
  if (message.type !== 'flex') throw new Error('ต้องเป็น flex');
  return message;
}

describe('month helpers', () => {
  it('ชื่อเดือนย่อ และเดือนก่อนข้ามปี', () => {
    expect(monthLabel('2026-10')).toBe('ต.ค. 2026');
    expect(previousMonth('2026-10')).toBe('2026-09');
    expect(previousMonth('2027-01')).toBe('2026-12');
  });
});

describe('payrollTodos', () => {
  it('เดือนนี้เตือนตั้งแต่วันที่ 20 เมื่อยังไม่จ่าย', () => {
    expect(payrollTodos({ ...base, today: '2026-10-19' })).toEqual([]);
    expect(payrollTodos(base).map((t) => t.text)).toEqual(['เงินเดือน ต.ค. 2026 ยังไม่สร้างรอบ']);
    expect(payrollTodos({ ...base, payroll: { month: '2026-10', status: 'APPROVED' } }).map((t) => t.text)).toEqual(['เงินเดือน ต.ค. 2026 ยังไม่บันทึกจ่าย']);
    expect(payrollTodos({ ...base, payroll: { month: '2026-10', status: 'PAID' } })).toEqual([]);
  });

  it('เดือนก่อนที่มีรอบแต่ยังไม่จ่ายเตือนทุกวัน ส่วนเดือนก่อนที่ไม่มีรอบไม่เตือน', () => {
    const early = { ...base, today: '2026-11-03', payroll: { month: '2026-11', status: 'NONE' as const } };
    expect(payrollTodos({ ...early, previousPayroll: { month: '2026-10', status: 'DRAFT' } }).map((t) => t.text)).toEqual(['เงินเดือน ต.ค. 2026 ยังไม่อนุมัติ']);
    expect(payrollTodos({ ...early, previousPayroll: { month: '2026-10', status: 'NONE' } })).toEqual([]);
  });
});

describe('accountingReminder', () => {
  it('เตือนชุดส่งบัญชีของเดือนก่อนเฉพาะวันที่ 1-15', () => {
    expect(accountingReminder('2026-11-01')).toBe('ชุดส่งบัญชี + ภ.พ.30 เดือน ต.ค. 2026 (ภายในวันที่ 15)');
    expect(accountingReminder('2027-01-15')).toContain('ธ.ค. 2026');
    expect(accountingReminder('2026-10-16')).toBeNull();
  });
});

describe('buildFinanceMessage', () => {
  it('altText สรุปเรื่องหลัก 3 เรื่องแรก', () => {
    expect(flexOf(base).altText).toBe('การเงินค้าง: เงินเดือน ต.ค. 2026 ยังไม่สร้างรอบ · รอวางบิล 28 คัน + 8 งาน · รอรับเงิน 19 ใบ');
  });

  it('แสดงทุกเรื่องที่ค้าง ยอดเงินเต็ม ลูกค้ารอวางบิลครบทุกราย', () => {
    expect(buildFinanceMessage(base)).toHaveLength(1);
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('• เงินเดือน ต.ค. 2026 ยังไม่สร้างรอบ');
    expect(texts).toContain('• รอวางบิล 28 คัน + 8 งาน (นานสุด 19 วัน)');
    expect(texts).toContain('   YM 8 งาน');
    expect(texts).toContain('   D 1 คัน');
    expect(texts).toContain('• รอรับเงิน 19 ใบ ฿1,385,773.3');
    expect(texts).toContain('   บริษัท 12 ใบ ฿1,151,413.25 · บุคคล 7 ใบ ฿234,360.05');
    expect(texts).toContain('   นานสุด IV2026-114 YM ฿418,757.8 (57 วัน)');
    expect(texts).toContain('• 50 ทวิ ยังไม่ได้รับ 16 ใบ ฿10,752.25 (ใกล้ครบ 1 ใบ)');
    expect(texts).toContain('• ใบเสนอราคา: รออนุมัติ 2 · ฉบับร่าง 1');
    expect(texts.some((t) => t.includes('ชุดส่งบัญชี'))).toBe(false);
  });

  it('ลูกค้ารอวางบิลเกินเพดานการ์ด: การ์ดบอกว่ามีต่อ ที่เหลือครบในข้อความถัดไป', () => {
    const many = Array.from({ length: 18 }, (_, i) => ({ customerName: `C${i + 1}`, vehicles: 1, jobs: 0 }));
    const messages = buildFinanceMessage({ ...base, unbilled: { ...base.unbilled, customers: many } });
    expect(messages).toHaveLength(2);
    const texts = allText(messages[0]);
    expect(texts).toContain('   C15 1 คัน');
    expect(texts).not.toContain('   C16 1 คัน');
    expect(texts).toContain('และอีก 3 รายการ (ต่อในข้อความถัดไป)');
    const rest = messages[1];
    if (rest.type !== 'text') throw new Error('ต้องเป็น text');
    expect(rest.text).toContain('รอวางบิล (ต่อ)');
    expect(rest.text).toContain('C18 1 คัน');
  });

  it('ไม่มีอะไรค้าง = บอกว่าไม่มี', () => {
    const calm: FinancePending = {
      ...base,
      today: '2026-10-18',
      unbilled: { vehicles: 0, jobs: 0, oldestDays: null, customers: [] },
      receivables: { count: 0, amount: 0, company: { count: 0, amount: 0 }, personal: { count: 0, amount: 0 }, oldest: null },
      wht: { count: 0, amount: 0, overdue: 0, soon: 0 },
      quotations: { waiting: 0, expired: 0, approvedUnused: 0, drafts: 0 },
    };
    expect(allText(flexOf(calm).contents)).toContain('ไม่มีงานการเงินค้าง');
    expect(flexOf(calm).altText).toBe('การเงินค้าง: ไม่มี');
  });

  it('แตะแต่ละเรื่องเข้าหน้างานนั้น และไม่มีลิงก์ถ้าไม่ตั้งที่อยู่เว็บ', () => {
    const json = JSON.stringify(flexOf(base, 'https://app.example.com').contents);
    expect(json).toContain('"uri":"https://app.example.com/hr/payroll"');
    expect(json).toContain('"uri":"https://app.example.com/accounting/billing"');
    expect(json).toContain('"uri":"https://app.example.com/accounting/billing?focus=IV2026-114"');
    expect(json).toContain('"uri":"https://app.example.com/accounting/tax-invoices/wht"');
    expect(json).toContain('"uri":"https://app.example.com/accounting/quotations"');
    expect(JSON.stringify(flexOf(base).contents)).not.toContain('"action"');
  });
});
