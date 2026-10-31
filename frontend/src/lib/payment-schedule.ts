// สำเนาของ backend/src/billing/payment-schedule.ts (แก้ให้ตรงกันทั้งสองฝั่ง)
// วันที่คาดว่าจะได้รับเงินของบิล (ผู้ใช้ 2026-10-31: SPI "วางบิลสัปดาห์นี้ ได้เงินวันพฤหัสสัปดาห์หน้า")
export interface PaySchedule {
  creditDays?: number | null;
  payWeekday?: number | null; // 1 = จันทร์ .. 5 = ศุกร์ · null = ใช้เครดิตวัน
  payWeeksAfter?: number | null; // 0 = สัปดาห์เดียวกับวันออกบิล, 1 = สัปดาห์ถัดไป
}

export const PAY_WEEKDAY_LABELS: Record<number, string> = { 1: "จันทร์", 2: "อังคาร", 3: "พุธ", 4: "พฤหัสบดี", 5: "ศุกร์" };
export const PAY_WEEKS_AFTER_MAX = 4;

const DAY_MS = 86_400_000;
const isoWeekday = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;

export function isPayWeekday(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;
}

// issueIso = YYYY-MM-DD -> YYYY-MM-DD หรือ null เมื่อไม่ได้ตั้งรอบ
export function expectedPaymentIso(issueIso: string, schedule: PaySchedule): string | null {
  const issue = new Date(`${issueIso}T00:00:00Z`);
  if (Number.isNaN(issue.getTime())) return null;
  let due: Date | null = null;
  if (isPayWeekday(schedule.payWeekday)) {
    const weeks = schedule.payWeeksAfter ?? 1;
    due = new Date(issue.getTime() + (schedule.payWeekday - isoWeekday(issue) + weeks * 7) * DAY_MS);
    if (due.getTime() < issue.getTime()) due = new Date(due.getTime() + 7 * DAY_MS);
  } else if (schedule.creditDays != null) {
    due = new Date(issue.getTime() + schedule.creditDays * DAY_MS);
  }
  return due ? due.toISOString().slice(0, 10) : null;
}

export function describePaySchedule(schedule: PaySchedule): string {
  if (isPayWeekday(schedule.payWeekday)) {
    const weeks = schedule.payWeeksAfter ?? 1;
    const when = weeks === 0 ? "สัปดาห์เดียวกับที่วางบิล" : weeks === 1 ? "สัปดาห์ถัดจากที่วางบิล" : `${weeks} สัปดาห์หลังวางบิล`;
    return `ได้เงินวัน${PAY_WEEKDAY_LABELS[schedule.payWeekday]} ${when}`;
  }
  if (schedule.creditDays != null) return `เครดิต ${schedule.creditDays} วัน`;
  return "ไม่ได้ตั้งรอบจ่าย";
}
