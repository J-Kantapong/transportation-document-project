import { round2 } from '../billing/billing-calculator.js';

// คำนวณเงินเดือน (ผู้ใช้ 2026-10-05) - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
// ตัวเลขกฎหมายอยู่ที่นี่ที่เดียว: ตรวจกับ สปส. / กรมสรรพากรก่อนปีที่กฎเปลี่ยน (ผู้ใช้ยืนยันแล้วว่าปี 2569 เพดาน 17,500 = หัก 875)

// ประกันสังคมมาตรา 33: 5% ของค่าจ้าง ฐานค่าจ้างต่ำสุด 1,650 สูงสุดตามปี - เพดานขั้นบันไดตามกฎกระทรวงที่เริ่ม 1 ม.ค. 2569:
// 2569-2571 = 17,500 (สูงสุด 875), 2572-2574 = 20,000 (1,000), 2575 ขึ้นไป = 23,000 (1,150) - ปีก่อน 2569 = 15,000
// (ตรวจกับข่าว/ประกาศทางการ 2026-10-05 และตารางเงินเดือนจริงของผู้ใช้) แต่ละรอบเงินเดือนเก็บอัตรากับเพดานไว้ใน PayrollRun (snapshot)
export const SSO_RATE_PERCENT = 5;
export const SSO_MIN_WAGE_BASE = 1650;
// ปี ค.ศ. ที่เริ่มใช้ -> เพดานฐานค่าจ้าง (เรียงจากปีใหม่ไปเก่า)
const SSO_CAP_BY_YEAR: ReadonlyArray<readonly [number, number]> = [
  [2032, 23_000],
  [2029, 20_000],
  [2026, 17_500],
];
const SSO_CAP_BEFORE = 15_000;

export function ssoWageCapFor(year: number): number {
  return SSO_CAP_BY_YEAR.find(([from]) => year >= from)?.[1] ?? SSO_CAP_BEFORE;
}

// เงินสมทบที่หักพนักงาน = ปัดเป็นบาทเต็ม (สปส. ปัดเศษตามหลักปกติ) ของ 5% x ฐานค่าจ้าง (ไม่ต่ำกว่า 1,650 ไม่เกินเพดาน)
// ฐาน = เงินเดือน (รายได้อื่น เช่น โบนัสไม่นับ - ตั้งเองได้ที่ช่อง "ประกันสังคม" ของรายการ)
export function socialSecurityAmount(salary: number, cap: number, ratePercent = SSO_RATE_PERCENT): number {
  if (!(salary > 0)) return 0;
  const base = Math.min(Math.max(salary, SSO_MIN_WAGE_BASE), cap);
  return Math.round((base * ratePercent) / 100);
}

// ภาษีเงินได้บุคคลธรรมดา อัตราก้าวหน้า (ใช้ตั้งแต่ปีภาษี 2560) - [เพดานเงินได้สุทธิของขั้น, อัตรา]
const TAX_BRACKETS: ReadonlyArray<readonly [number, number]> = [
  [150_000, 0],
  [300_000, 0.05],
  [500_000, 0.1],
  [750_000, 0.15],
  [1_000_000, 0.2],
  [2_000_000, 0.25],
  [5_000_000, 0.3],
  [Number.POSITIVE_INFINITY, 0.35],
];
const EXPENSE_RATE = 0.5;
const EXPENSE_CAP = 100_000; // ค่าใช้จ่ายเงินเดือน 50% ไม่เกิน 100,000
const PERSONAL_ALLOWANCE = 60_000;
const SSO_ANNUAL_DEDUCTION_CAP = 9_000;

export function progressiveTax(netIncome: number): number {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of TAX_BRACKETS) {
    if (netIncome > lower) tax += (Math.min(netIncome, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

// ภาษีหัก ณ ที่จ่ายต่อเดือน (ภ.ง.ด.1 แบบประมาณการรายปี): เอาเงินได้เดือนนี้ x 12 เป็นเงินได้ทั้งปี หักค่าใช้จ่าย + ลดหย่อนส่วนตัว +
// ประกันสังคมทั้งปี (ไม่เกิน 9,000) + ค่าลดหย่อนอื่นของพนักงาน แล้วคิดอัตราก้าวหน้า หาร 12
// เดือนที่มีรายได้พิเศษ (โบนัส) วิธีนี้เป็นค่าประมาณ - แก้ยอดในรายการได้
export function monthlyWithholdingTax(params: { monthlyIncome: number; monthlySso: number; otherAllowanceYear: number }): number {
  const annual = Math.max(0, params.monthlyIncome) * 12;
  const expense = Math.min(annual * EXPENSE_RATE, EXPENSE_CAP);
  const sso = Math.min(Math.max(0, params.monthlySso) * 12, SSO_ANNUAL_DEDUCTION_CAP);
  const net = Math.max(0, annual - expense - PERSONAL_ALLOWANCE - sso - Math.max(0, params.otherAllowanceYear));
  return round2(progressiveTax(net) / 12);
}

export interface PayrollEmployeeTerms {
  socialSecurity: boolean;
  withholdTax: boolean;
  otherAllowance: number;
}

export interface PayrollAmounts {
  salary: number;
  otherIncome: number;
  otherDeduction: number;
  // ใส่ตัวเลข = พิมพ์ทับ, null/undefined = ให้ระบบคำนวณ
  sso?: number | null;
  tax?: number | null;
}

export interface PayrollResult {
  salary: number;
  otherIncome: number;
  otherDeduction: number;
  ssoAmount: number;
  taxAmount: number;
  netPay: number;
  ssoManual: boolean;
  taxManual: boolean;
}

export function computePayroll(amounts: PayrollAmounts, terms: PayrollEmployeeTerms, ssoCap: number, ssoRatePercent = SSO_RATE_PERCENT): PayrollResult {
  const salary = round2(amounts.salary);
  const otherIncome = round2(amounts.otherIncome);
  const otherDeduction = round2(amounts.otherDeduction);
  const ssoManual = amounts.sso !== null && amounts.sso !== undefined;
  const ssoAmount = ssoManual ? round2(amounts.sso!) : terms.socialSecurity ? socialSecurityAmount(salary, ssoCap, ssoRatePercent) : 0;
  const taxManual = amounts.tax !== null && amounts.tax !== undefined;
  const taxAmount = taxManual
    ? round2(amounts.tax!)
    : terms.withholdTax
      ? monthlyWithholdingTax({ monthlyIncome: salary + otherIncome, monthlySso: ssoAmount, otherAllowanceYear: terms.otherAllowance })
      : 0;
  const netPay = round2(salary + otherIncome - ssoAmount - taxAmount - otherDeduction);
  return { salary, otherIncome, otherDeduction, ssoAmount, taxAmount, netPay, ssoManual, taxManual };
}

export interface PayrollTotals {
  salary: number;
  otherIncome: number;
  gross: number;
  sso: number; // ส่วนที่หักพนักงาน
  ssoRemit: number; // ยอดนำส่ง สปส. (สปส.1-10) = ส่วนพนักงาน + ส่วนนายจ้าง (เท่ากัน)
  tax: number; // ยอดนำส่ง ภ.ง.ด.1
  otherDeduction: number;
  net: number;
}

export function payrollTotals(items: ReadonlyArray<{ salary: number; otherIncome: number; ssoAmount: number; taxAmount: number; otherDeduction: number; netPay: number }>): PayrollTotals {
  const sum = (pick: (i: (typeof items)[number]) => number) => round2(items.reduce((s, i) => s + pick(i), 0));
  const salary = sum((i) => i.salary);
  const otherIncome = sum((i) => i.otherIncome);
  const sso = sum((i) => i.ssoAmount);
  return { salary, otherIncome, gross: round2(salary + otherIncome), sso, ssoRemit: round2(sso * 2), tax: sum((i) => i.taxAmount), otherDeduction: sum((i) => i.otherDeduction), net: sum((i) => i.netPay) };
}
