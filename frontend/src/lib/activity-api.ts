import { request } from "@/lib/api";

// ภาพรวมการทำงาน (ADMIN) - GET /api/activity?date=YYYY-MM-DD ดู backend/src/activity/activity.service.ts

export type ActivityGroup = "new" | "other" | "billing" | "edit";

export interface ActivityEvent {
  id: string;
  at: string;
  timed: boolean; // false = รู้แค่วันที่ ไม่มีเวลา
  type: string;
  group: ActivityGroup;
  title: string;
  kind: "car" | "moto" | null; // null = ไม่แยกประเภท (เอกสารการเงิน ยามาฮ่า แก้ไขทั่วไป)
  ref: string | null;
  customer: string | null;
  detail: string | null;
  bill: number | null;
  noBill: number | null;
  duty: number | null;
  amount: number | null;
  cancelled: boolean; // ยกเลิกแล้ว: แสดงไว้แต่ไม่นับในยอดรวม
  actor: string | null;
  href: string;
}

export interface ActivityDay {
  date: string;
  today: string;
  prev: string;
  next: string | null;
  events: ActivityEvent[];
  counts: Record<string, number>;
  kinds: { car: number; moto: number };
  totals: { bill: number; noBill: number; duty: number; spend: number; invoiced: number; collected: number };
}

export const ACTIVITY_GROUPS: Array<{ key: ActivityGroup; label: string }> = [
  { key: "new", label: "จดทะเบียนรถใหม่" },
  { key: "other", label: "งานอื่นๆ" },
  { key: "billing", label: "การเงิน" },
  { key: "edit", label: "แก้ไข / ยกเลิก" },
];

export const activityApi = {
  day(date?: string): Promise<ActivityDay> {
    return request<ActivityDay>(`/api/activity${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  },
};
