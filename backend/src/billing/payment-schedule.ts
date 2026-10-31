// วันที่คาดว่าจะได้รับเงินของบิล (ผู้ใช้ 2026-10-31: SPI "วางบิลสัปดาห์นี้ ได้เงินวันพฤหัสสัปดาห์หน้า")
// - ตั้งรอบวันในสัปดาห์ (billingPayWeekday 1 = จันทร์ .. 5 = ศุกร์ + billingPayWeeksAfter) = วันนั้นของสัปดาห์ที่ N หลังสัปดาห์ที่ออกบิล
//   สัปดาห์เริ่มวันจันทร์ · ถ้าตกก่อนวันออกบิล (สัปดาห์เดียวกัน) เลื่อนไปอีก 1 สัปดาห์
// - ไม่ได้ตั้งรอบวัน = เครดิตวัน (billingCreditDays) เหมือนเดิม · ไม่ได้ตั้งทั้งคู่ = null
// ระบบไม่รู้วันหยุดราชการ: ถ้าวันนั้นเป็นวันหยุด การเตือนจะมาเร็วไป 1 วัน (ผู้ใช้รับได้) - ไฟล์เดียวกันคัดลอกไว้ที่ frontend/src/lib/payment-schedule.ts
export interface PaySchedule {
  billingCreditDays: number | null;
  billingPayWeekday?: number | null;
  billingPayWeeksAfter?: number | null;
}

export const PAY_WEEKDAY_LABELS: Record<number, string> = { 1: 'จันทร์', 2: 'อังคาร', 3: 'พุธ', 4: 'พฤหัสบดี', 5: 'ศุกร์' };
export const PAY_WEEKS_AFTER_MAX = 4;

const DAY_MS = 86_400_000;
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY_MS);
// วันในสัปดาห์แบบจันทร์ = 1 .. อาทิตย์ = 7 (วันที่เก็บเป็นเที่ยงคืน UTC จึงอ่านแบบ UTC)
const isoWeekday = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;

export function isPayWeekday(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5;
}

export function expectedPaymentDate(issueDate: Date, schedule: PaySchedule): Date | null {
  const weekday = schedule.billingPayWeekday;
  if (isPayWeekday(weekday)) {
    const weeksAfter = schedule.billingPayWeeksAfter ?? 1;
    let due = addDays(issueDate, weekday - isoWeekday(issueDate) + weeksAfter * 7);
    if (due.getTime() < issueDate.getTime()) due = addDays(due, 7);
    return due;
  }
  if (schedule.billingCreditDays == null) return null;
  return addDays(issueDate, schedule.billingCreditDays);
}

// ข้อความอธิบายรอบที่ตั้ง ใช้ในหน้าจอ/ประวัติ
export function describePaySchedule(schedule: PaySchedule): string {
  if (isPayWeekday(schedule.billingPayWeekday)) {
    const weeks = schedule.billingPayWeeksAfter ?? 1;
    const when = weeks === 0 ? 'สัปดาห์เดียวกับที่วางบิล' : weeks === 1 ? 'สัปดาห์ถัดจากที่วางบิล' : `${weeks} สัปดาห์หลังวางบิล`;
    return `ได้เงินวัน${PAY_WEEKDAY_LABELS[schedule.billingPayWeekday]} ${when}`;
  }
  if (schedule.billingCreditDays != null) return `เครดิต ${schedule.billingCreditDays} วัน`;
  return 'ไม่ได้ตั้งรอบจ่าย';
}
