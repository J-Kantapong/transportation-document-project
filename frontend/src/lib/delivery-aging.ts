import { todayIso } from "@/lib/date";

// ตัวช่วยกันลืมลงวันส่งงาน (ผู้ใช้ 2026-10-08): ของครบแล้ว (ใบเสร็จ+เล่ม / ใบเสร็จของงานอื่น) แต่ยังไม่มีใบ DL ค้างกี่วัน
// เกิน 3 วัน = สีส้ม, เกิน 7 วัน = สีแดง (ค่าเดียวกับ STAGES.delivery / jobDelivery ของภาพรวม - backend/src/overview/overview-process.ts)
export const DELIVERY_WARN_DAYS = 3;
export const DELIVERY_LATE_DAYS = 7;

export type AgingTone = "ok" | "warn" | "late";

// จำนวนวันตั้งแต่วันที่ (YYYY-MM-DD) ถึงวันนี้ - null = ไม่มีวันที่
export function daysSince(iso: string | null | undefined, today = todayIso()): number | null {
  if (!iso) return null;
  const a = Date.parse(`${iso}T00:00:00Z`);
  const b = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

export function agingTone(days: number | null): AgingTone {
  if (days === null) return "ok";
  if (days > DELIVERY_LATE_DAYS) return "late";
  if (days > DELIVERY_WARN_DAYS) return "warn";
  return "ok";
}

export const AGING_COLOR: Record<AgingTone, string | undefined> = { ok: undefined, warn: "#bb6a00", late: "#c0392b" };

// ข้อความสั้นไว้ขึ้นป้าย: "พร้อมส่งมา 5 วัน" - วันแรกไม่ต้องเตือน
export function agingText(days: number | null): string {
  if (days === null || days <= 0) return "";
  return `พร้อมส่งมา ${days} วัน`;
}
