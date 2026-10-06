import { round2 } from '../billing/billing-calculator.js';

// 50 ทวิ ที่บริษัทออกให้ผู้รับเงิน (ผู้ใช้ 2026-10-06) - ส่วนที่เป็นกฎล้วนๆ (ไม่แตะฐานข้อมูล) แยกไว้ทดสอบได้
// ผู้รับ: EMPLOYEE (ปลายปีจากเงินเดือน -> ภ.ง.ด.1ก) และ OTHER (บุคคลธรรมดาอื่น เช่น ซับ -> ภ.ง.ด.3)

export const INCOME_TYPES = ['SALARY', 'FEE', 'ROYALTY', 'INTEREST', 'SERVICE', 'OTHER'] as const;
export type IncomeType = (typeof INCOME_TYPES)[number];

// ข้อของฟอร์ม 50 ทวิ: 1 = 40(1), 2 = 40(2), 3 = 40(3), 4 = 40(4)(ก), 5 = มาตรา 3 เตรส (จ้างทำของ ค่าบริการ ค่าขนส่ง ฯลฯ), 6 = อื่นๆ
export const INCOME_TYPE_LABEL: Record<IncomeType, string> = {
  SALARY: 'เงินเดือน ค่าจ้าง เบี้ยเลี้ยง โบนัส ฯลฯ ตามมาตรา 40 (1)',
  FEE: 'ค่าธรรมเนียม ค่านายหน้า ฯลฯ ตามมาตรา 40 (2)',
  ROYALTY: 'ค่าแห่งลิขสิทธิ์ ฯลฯ ตามมาตรา 40 (3)',
  INTEREST: 'ดอกเบี้ย ฯลฯ ตามมาตรา 40 (4) (ก)',
  SERVICE: 'การจ่ายเงินที่ต้องหักภาษี ณ ที่จ่ายตามมาตรา 3 เตรส (จ้างทำของ ค่าบริการ ค่าขนส่ง ฯลฯ)',
  OTHER: 'อื่นๆ',
};

export const FORM_TYPES = ['PND1K', 'PND3'] as const;
export type FormType = (typeof FORM_TYPES)[number];
export const PAY_METHODS = ['WITHHOLD', 'FOREVER', 'ONCE'] as const;
export type PayMethod = (typeof PAY_METHODS)[number];

export const MAX_ITEMS = 12;
export const MAX_AMOUNT = 99_999_999;

// เลขที่ปีภาษี 2026 = 2026-001 (รูปแบบเดียวกับใบที่บริษัทออกจากไฟล์เดิม) ตั้งแต่ปีภาษี 2027 = IW2027-001 (ผู้ใช้ 2026-10-06: รูปแบบเดิมใช้ถึงสิ้นปี 2026 เท่านั้น)
// ลำดับ 3 หลักขึ้นไป ใช้ปีภาษี (ไม่ใช่ปีที่ออก) - 50 ทวิ ของเงินเดือนปี 2026 ที่ออกเดือนม.ค. 2027 จึงยังเป็น 2026-xxx
export const WHT_NO_PREFIX_LAST_YEAR = 2026;
export const formatCertificateNo = (taxYear: number, number: number): string => `${taxYear > WHT_NO_PREFIX_LAST_YEAR ? 'IW' : ''}${taxYear}-${String(number).padStart(3, '0')}`;

// เลขประจำตัวประชาชน/ผู้เสียภาษี 13 หลักของไทย: หลักที่ 13 = (11 - (ผลรวม digit_i x (14 - i), i=1..12) mod 11) mod 10
export function thaiIdCheckDigit(first12: string): number {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (13 - i);
  return (11 - (sum % 11)) % 10;
}

export const isValidThaiId = (id: string): boolean => /^\d{13}$/.test(id) && thaiIdCheckDigit(id) === Number(id[12]);

export interface RawItem {
  incomeType?: unknown;
  description?: unknown;
  paidDate?: unknown;
  dateLabel?: unknown;
  amountPaid?: unknown;
  taxWithheld?: unknown;
}

export interface CleanItem {
  incomeType: IncomeType;
  description: string | null;
  paidDate: string; // ค.ศ. YYYY-MM-DD
  dateLabel: string | null;
  amountPaid: number;
  taxWithheld: number;
}

const isIsoDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00.000Z`).toISOString().slice(0, 10) === v;

// ตรวจและทำความสะอาดบรรทัดเงินได้ - คืนข้อความผิดพลาดภาษาไทย (string) หรือรายการที่ใช้ได้
export function cleanItems(raw: unknown, taxYear: number, kind: 'EMPLOYEE' | 'OTHER'): { items: CleanItem[] } | { error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { error: 'ต้องมีรายการเงินได้อย่างน้อย 1 บรรทัด' };
  if (raw.length > MAX_ITEMS) return { error: `รายการเงินได้ได้ไม่เกิน ${MAX_ITEMS} บรรทัด` };
  const items: CleanItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const line = `บรรทัดที่ ${i + 1}`;
    const r = (raw[i] ?? {}) as RawItem;
    if (!INCOME_TYPES.includes(r.incomeType as IncomeType)) return { error: `${line}: ประเภทเงินได้ไม่ถูกต้อง` };
    const incomeType = r.incomeType as IncomeType;
    if (kind === 'EMPLOYEE' && incomeType !== 'SALARY') return { error: `${line}: 50 ทวิ ของพนักงานใช้ได้เฉพาะเงินเดือน 40(1)` };
    if (kind === 'OTHER' && incomeType === 'SALARY') return { error: `${line}: เงินเดือน 40(1) ออกให้พนักงานจากหน้ารอบปีเท่านั้น` };
    if (!isIsoDate(r.paidDate)) return { error: `${line}: วันที่จ่ายไม่ถูกต้อง` };
    if (Number(r.paidDate.slice(0, 4)) !== taxYear) return { error: `${line}: วันที่จ่ายต้องอยู่ในปีภาษี ${taxYear + 543}` };
    if (typeof r.amountPaid !== 'number' || !Number.isFinite(r.amountPaid) || r.amountPaid <= 0 || r.amountPaid > MAX_AMOUNT) return { error: `${line}: จำนวนเงินที่จ่ายต้องมากกว่า 0` };
    if (typeof r.taxWithheld !== 'number' || !Number.isFinite(r.taxWithheld) || r.taxWithheld < 0) return { error: `${line}: ภาษีที่หักต้องเป็นจำนวนเงินตั้งแต่ 0 ขึ้นไป` };
    const amountPaid = round2(r.amountPaid);
    const taxWithheld = round2(r.taxWithheld);
    if (taxWithheld > amountPaid) return { error: `${line}: ภาษีที่หักมากกว่าเงินที่จ่าย` };
    const text = (v: unknown, max: number, label: string): string | null | { error: string } => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'string') return { error: `${line}: ${label}ต้องเป็นข้อความ` };
      const t = v.trim();
      if (t.length > max) return { error: `${line}: ${label}ยาวเกิน ${max} ตัวอักษร` };
      return t || null;
    };
    const description = text(r.description, 120, 'รายละเอียด');
    if (description && typeof description === 'object') return description;
    const dateLabel = text(r.dateLabel, 40, 'ข้อความวันที่');
    if (dateLabel && typeof dateLabel === 'object') return dateLabel;
    if ((incomeType === 'SERVICE' || incomeType === 'OTHER') && !description) return { error: `${line}: ระบุรายละเอียดของเงินได้ (เช่น ค่าจ้างทำของ)` };
    items.push({ incomeType, description: description as string | null, paidDate: r.paidDate, dateLabel: dateLabel as string | null, amountPaid, taxWithheld });
  }
  return { items };
}

export const totalsOf = (items: Array<{ amountPaid: number; taxWithheld: number }>) => ({
  totalPaid: round2(items.reduce((s, i) => s + i.amountPaid, 0)),
  totalTax: round2(items.reduce((s, i) => s + i.taxWithheld, 0)),
});

const SHORT_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];

// ข้อความวันที่ของพนักงานรายปี: จ่ายเดือนเดียว = "ต.ค. 2026", หลายเดือน = "ม.ค. - ธ.ค. 2026" (ปี ค.ศ. ตามฟอร์มของบริษัท) (เดือนแรก - เดือนสุดท้ายที่จ่ายจริง)
export function periodLabel(payDates: string[]): string {
  const months = payDates.map((d) => ({ y: Number(d.slice(0, 4)), m: Number(d.slice(5, 7)) - 1 })).sort((a, b) => a.y * 12 + a.m - (b.y * 12 + b.m));
  const first = months[0];
  const last = months[months.length - 1];
  if (!first) return '';
  return first.y === last.y && first.m === last.m ? `${SHORT_MONTHS[last.m]} ${last.y}` : `${SHORT_MONTHS[first.m]} - ${SHORT_MONTHS[last.m]} ${last.y}`;
}
