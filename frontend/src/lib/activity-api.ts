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

// ขั้นตอน/ชนิดเหตุการณ์ เรียงตามลำดับงาน - ใช้ทำชิปสรุป "วันนี้ทำอะไรไปกี่รายการ" และกรองตามขั้นตอน
export const ACTIVITY_TYPES: Array<{ type: string; label: string; group: ActivityGroup }> = [
  { type: "vehicle-entry", label: "บันทึกรถ", group: "new" },
  { type: "submit", label: "ยื่นเอกสาร", group: "new" },
  { type: "receipt", label: "รับใบเสร็จ", group: "new" },
  { type: "plate", label: "รับป้าย", group: "new" },
  { type: "book", label: "รับเล่ม", group: "new" },
  { type: "delivery", label: "ส่งงาน", group: "new" },
  { type: "plate-swap", label: "สลับเลข", group: "other" },
  { type: "tax-renewal", label: "ต่อภาษี", group: "other" },
  { type: "yamaha", label: "ยามาฮ่า", group: "other" },
  { type: "transfer", label: "งานโอน", group: "other" },
  { type: "use-cancel", label: "ยกเลิกการใช้รถ", group: "other" },
  { type: "plate-copy", label: "คัดป้าย", group: "other" },
  { type: "move-out", label: "ย้ายออก", group: "other" },
  { type: "invoice", label: "ออกบิล", group: "billing" },
  { type: "paid", label: "รับเงิน", group: "billing" },
  { type: "tax-invoice", label: "ใบกำกับภาษี", group: "billing" },
  { type: "vehicle-edit", label: "แก้ไขข้อมูลรถ", group: "edit" },
  { type: "audit", label: "แก้ไข/ยกเลิกอื่นๆ", group: "edit" },
];

export const activityApi = {
  day(date?: string): Promise<ActivityDay> {
    return request<ActivityDay>(`/api/activity${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  },
};
