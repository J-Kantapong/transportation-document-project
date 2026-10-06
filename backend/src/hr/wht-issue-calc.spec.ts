import { cleanItems, formatCertificateNo, isValidThaiId, periodLabel, thaiIdCheckDigit, totalsOf } from './wht-issue-calc.js';

// สร้างเลข 13 หลักที่ถูกต้องจาก 12 หลักแรก (ไม่ใส่เลขจริงของใครลงในเทสต์)
const withCheckDigit = (first12: string) => `${first12}${thaiIdCheckDigit(first12)}`;

describe('isValidThaiId', () => {
  it('accepts a number whose 13th digit is the checksum and rejects a wrong digit, short, or non-numeric input', () => {
    const ok = withCheckDigit('123456789012');
    expect(isValidThaiId(ok)).toBe(true);
    const wrong = `${ok.slice(0, 12)}${(Number(ok[12]) + 1) % 10}`;
    expect(isValidThaiId(wrong)).toBe(false);
    expect(isValidThaiId('12345678901')).toBe(false);
    expect(isValidThaiId('abcdefghijklm')).toBe(false);
  });
});

describe('formatCertificateNo', () => {
  it('uses the plain year-number format for 2026 and the IW prefix from 2027, padded to three digits', () => {
    expect(formatCertificateNo(2026, 7)).toBe('2026-007');
    expect(formatCertificateNo(2026, 1234)).toBe('2026-1234');
    expect(formatCertificateNo(2027, 1)).toBe('IW2027-001');
  });
});

describe('periodLabel', () => {
  it('shows one month, or first - last month in the Buddhist year', () => {
    expect(periodLabel(['2026-10-31'])).toBe('ต.ค. 2026');
    expect(periodLabel(['2026-12-30', '2026-01-31', '2026-06-30'])).toBe('ม.ค. - ธ.ค. 2026');
  });
});

const line = (over: Record<string, unknown> = {}) => ({ incomeType: 'SERVICE', description: 'ค่าจ้างทำของ', paidDate: '2026-05-10', amountPaid: 10000, taxWithheld: 300, ...over });

describe('cleanItems', () => {
  it('accepts a normal service line and totals it', () => {
    const r = cleanItems([line(), line({ paidDate: '2026-06-10', amountPaid: 5000.555, taxWithheld: 150 })], 2026, 'OTHER');
    expect('items' in r && totalsOf(r.items)).toEqual({ totalPaid: 15000.56, totalTax: 450 });
  });

  it.each([
    ['empty list', [], 'อย่างน้อย 1'],
    ['unknown income type', [line({ incomeType: 'X' })], 'ประเภทเงินได้'],
    ['salary for an OTHER payee', [line({ incomeType: 'SALARY' })], 'พนักงาน'],
    ['date outside the tax year', [line({ paidDate: '2025-12-31' })], 'ปีภาษี'],
    ['impossible date', [line({ paidDate: '2026-02-30' })], 'วันที่จ่าย'],
    ['zero amount', [line({ amountPaid: 0 })], 'มากกว่า 0'],
    ['negative tax', [line({ taxWithheld: -1 })], 'ตั้งแต่ 0'],
    ['tax above the amount paid', [line({ amountPaid: 100, taxWithheld: 101 })], 'มากกว่าเงินที่จ่าย'],
    ['service line without a description', [line({ description: '  ' })], 'รายละเอียด'],
    ['more than 12 lines', Array.from({ length: 13 }, () => line()), 'ไม่เกิน 12'],
  ])('rejects %s', (_name, items, message) => {
    const r = cleanItems(items, 2026, 'OTHER');
    expect(r).toMatchObject({ error: expect.stringContaining(message) });
  });

  it('only allows salary lines for an employee certificate', () => {
    expect(cleanItems([line({ incomeType: 'SALARY', description: null })], 2026, 'EMPLOYEE')).toHaveProperty('items');
    expect(cleanItems([line()], 2026, 'EMPLOYEE')).toMatchObject({ error: expect.stringContaining('เงินเดือน') });
  });
});
