import { describe, expect, it } from 'vitest';
import { computePayroll, monthlyWithholdingTax, payrollTotals, progressiveTax, socialSecurityAmount, ssoWageCapFor } from './payroll-calc.js';

describe('socialSecurityAmount', () => {
  // ตัวเลขจากตารางเงินเดือนจริงของผู้ใช้ (2569: เพดาน 17,500)
  it('matches the real payroll sheet', () => {
    expect(socialSecurityAmount(25_000, 17_500)).toBe(875);
    expect(socialSecurityAmount(17_000, 17_500)).toBe(850);
    expect(socialSecurityAmount(16_000, 17_500)).toBe(800);
    expect(socialSecurityAmount(15_000, 17_500)).toBe(750);
  });
  it('floors the wage base at 1,650 and caps it', () => {
    expect(socialSecurityAmount(1_000, 17_500)).toBe(83);
    expect(socialSecurityAmount(100_000, 17_500)).toBe(875);
  });
  it('is zero without a salary', () => {
    expect(socialSecurityAmount(0, 17_500)).toBe(0);
  });
  it('follows the cap schedule by year', () => {
    expect(ssoWageCapFor(2025)).toBe(15_000);
    expect(ssoWageCapFor(2026)).toBe(17_500);
    expect(ssoWageCapFor(2028)).toBe(17_500);
    expect(ssoWageCapFor(2029)).toBe(20_000);
    expect(ssoWageCapFor(2032)).toBe(23_000);
  });
});

describe('progressiveTax', () => {
  it('is zero up to 150,000', () => {
    expect(progressiveTax(150_000)).toBe(0);
  });
  it('applies each bracket', () => {
    expect(progressiveTax(300_000)).toBe(7_500);
    expect(progressiveTax(380_000)).toBe(15_500);
    expect(progressiveTax(1_000_000)).toBe(7_500 + 20_000 + 37_500 + 50_000);
  });
});

describe('monthlyWithholdingTax', () => {
  it('45,000 salary without social security = 1,291.67', () => {
    // 540,000 - 100,000 - 60,000 = 380,000 -> 15,500 / 12
    expect(monthlyWithholdingTax({ monthlyIncome: 45_000, monthlySso: 0, otherAllowanceYear: 0 })).toBe(1_291.67);
  });
  it('25,000 salary with 875 social security pays no tax', () => {
    expect(monthlyWithholdingTax({ monthlyIncome: 25_000, monthlySso: 875, otherAllowanceYear: 0 })).toBe(0);
  });
  it('extra allowances reduce the tax', () => {
    const base = monthlyWithholdingTax({ monthlyIncome: 45_000, monthlySso: 0, otherAllowanceYear: 0 });
    expect(monthlyWithholdingTax({ monthlyIncome: 45_000, monthlySso: 0, otherAllowanceYear: 60_000 })).toBeLessThan(base);
  });
});

describe('computePayroll', () => {
  const terms = { socialSecurity: true, withholdTax: true, otherAllowance: 0 };
  it('computes net pay for a normal employee', () => {
    const r = computePayroll({ salary: 25_000, otherIncome: 0, otherDeduction: 0 }, terms, 17_500);
    expect(r).toMatchObject({ ssoAmount: 875, taxAmount: 0, netPay: 24_125, ssoManual: false, taxManual: false });
  });
  it('leaves out social security for an employee who is not enrolled', () => {
    const r = computePayroll({ salary: 15_000, otherIncome: 0, otherDeduction: 0 }, { ...terms, socialSecurity: false }, 17_500);
    expect(r.ssoAmount).toBe(0);
    expect(r.netPay).toBe(15_000);
  });
  it('keeps typed-over amounts and flags them', () => {
    const r = computePayroll({ salary: 25_000, otherIncome: 1_000, otherDeduction: 500, sso: 700, tax: 100 }, terms, 17_500);
    expect(r).toMatchObject({ ssoAmount: 700, taxAmount: 100, netPay: 24_700, ssoManual: true, taxManual: true });
  });
  it('treats 0 as a typed-over amount, not as "calculate"', () => {
    const r = computePayroll({ salary: 25_000, otherIncome: 0, otherDeduction: 0, sso: 0 }, terms, 17_500);
    expect(r.ssoAmount).toBe(0);
    expect(r.ssoManual).toBe(true);
  });
  it('does not withhold tax when switched off', () => {
    const r = computePayroll({ salary: 45_000, otherIncome: 0, otherDeduction: 0 }, { socialSecurity: false, withholdTax: false, otherAllowance: 0 }, 17_500);
    expect(r.taxAmount).toBe(0);
    expect(r.netPay).toBe(45_000);
  });
});

describe('payrollTotals', () => {
  it('adds up the run and doubles social security for the remittance', () => {
    const t = payrollTotals([
      { salary: 25_000, otherIncome: 0, ssoAmount: 875, taxAmount: 0, otherDeduction: 0, netPay: 24_125 },
      { salary: 45_000, otherIncome: 1_000, ssoAmount: 0, taxAmount: 1_291.67, otherDeduction: 0, netPay: 44_708.33 },
    ]);
    expect(t).toEqual({ salary: 70_000, otherIncome: 1_000, gross: 71_000, sso: 875, ssoRemit: 1_750, tax: 1_291.67, otherDeduction: 0, net: 68_833.33 });
  });
});
