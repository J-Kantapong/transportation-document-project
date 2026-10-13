// กันคีย์วันที่ผิด (ผู้ใช้ 2026-10-13): วันที่ผิดเกือบทั้งหมดมาจากไม่กี่เหตุการณ์ที่ผิดทั้งชุด แล้วต้องตามแก้ทีละคัน
// (ใบส่งงาน 61 คันลงวันเสาร์ ทั้งที่ส่งจริงวันจันทร์ / ส่งตรวจ 54 คันลงวันหยุดราชการ) จึงเตือนที่ต้นทางสองแบบ:
// 1. บอกวันในสัปดาห์ของวันที่ที่คีย์ เสาร์-อาทิตย์เป็นสีส้ม (ขนส่งปิด)
// 2. ถามยืนยันก่อนบันทึกหลายคัน โดยเขียนวันที่ให้อ่านออก ("วันเสาร์ที่ 26/09/2026 (อีก 2 วัน) - 61 คัน")
// วันหยุดราชการยังไม่ตรวจ (ผู้ใช้: เปลี่ยนบ่อย เอาเสาร์-อาทิตย์ก่อน) · เป็นคำเตือนฝั่งหน้าจอเท่านั้น backend ไม่ห้าม

import { isoToDisplayDate, todayIso } from "./date";

const WEEKDAYS = ["อาทิตย์", "จันทร์", "อังคาร", "พุธ", "พฤหัสบดี", "ศุกร์", "เสาร์"];
const WEEKDAYS_SHORT = ["อา.", "จ.", "อ.", "พ.", "พฤ.", "ศ.", "ส."];
const DAY_MS = 86_400_000;

// วันในสัปดาห์ของ YYYY-MM-DD (0 = อาทิตย์ ... 6 = เสาร์) - วันที่ไม่ถูกต้อง = null
// คิดจากปฏิทินตรงๆ (เที่ยงคืน UTC ของวันนั้น) ไม่ขึ้นกับเขตเวลาของเครื่อง
export function weekdayOf(iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const time = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(time) ? null : new Date(time).getUTCDay();
}

export const weekdayName = (iso: string) => {
  const day = weekdayOf(iso);
  return day === null ? "" : `วัน${WEEKDAYS[day]}`;
};

export const weekdayShort = (iso: string) => {
  const day = weekdayOf(iso);
  return day === null ? "" : WEEKDAYS_SHORT[day];
};

export function isWeekend(iso: string): boolean {
  const day = weekdayOf(iso);
  return day === 0 || day === 6;
}

// วันนี้ / พรุ่งนี้ / เมื่อวาน / อีก N วัน / ย้อนหลัง N วัน
export function relativeDay(iso: string, today: string = todayIso()): string {
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
  if (Number.isNaN(days)) return "";
  if (days === 0) return "วันนี้";
  if (days === 1) return "พรุ่งนี้";
  if (days === -1) return "เมื่อวาน";
  return days > 0 ? `อีก ${days} วัน` : `ย้อนหลัง ${-days} วัน`;
}

// "วันเสาร์ที่ 26/09/2026 (อีก 2 วัน)"
export function describeDate(iso: string, today: string = todayIso()): string {
  return `${weekdayName(iso)}ที่ ${isoToDisplayDate(iso)} (${relativeDay(iso, today)})`;
}

export const WEEKEND_WARNING = "ตรงกับวันเสาร์-อาทิตย์ (ขนส่งปิด) - ตรวจวันที่อีกครั้ง";

// ข้อความยืนยันก่อนบันทึก: สรุปวันที่ของทุกคันที่กำลังจะบันทึก จัดกลุ่มตามวันที่ (วันที่เก่าสุดก่อน)
// dates = วันที่ YYYY-MM-DD ของแต่ละคัน (คันละหนึ่งค่า - วันที่เดียวกันนับรวมเป็นจำนวนคัน)
export function dateConfirmMessage(action: string, dates: string[], options: { note?: string; today?: string } = {}): string {
  const counts = new Map<string, number>();
  for (const date of dates) counts.set(date, (counts.get(date) ?? 0) + 1);
  const lines = [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, n]) => `${isWeekend(date) ? "⚠ " : "• "}${describeDate(date, options.today)} - ${n} คัน`);
  const weekend = dates.some(isWeekend);
  return [
    `${action} ${dates.length} คัน`,
    "",
    ...lines,
    ...(weekend ? ["", `⚠ ${WEEKEND_WARNING}`] : []),
    ...(options.note ? ["", options.note] : []),
    "",
    "วันที่ถูกต้องใช่ไหม? กด OK เพื่อบันทึก",
  ].join("\n");
}

// ถามยืนยันวันที่ก่อนบันทึก - always: บันทึกหลายคัน ถามทุกครั้ง (วันที่ผิดทั้งชุดแก้ทีละคันทีหลังเสียเวลามาก)
// ไม่ใส่ always: บันทึกคันเดียว ถามเฉพาะเมื่อวันที่ตรงกับเสาร์-อาทิตย์ ไม่รบกวนงานปกติ · คืน true = บันทึกต่อได้
export function confirmDates(action: string, dates: string[], options: { always?: boolean; note?: string } = {}): boolean {
  const valid = dates.filter((date) => weekdayOf(date) !== null);
  if (!valid.length) return true;
  if (!options.always && !valid.some(isWeekend)) return true;
  return window.confirm(dateConfirmMessage(action, valid, { note: options.note }));
}
