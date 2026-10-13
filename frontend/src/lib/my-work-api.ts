import { request } from "@/lib/api";

// งานของฉัน (ผู้ใช้ 2026-10-13) - GET /api/my-work ดู backend/src/my-work/my-work.service.ts
// รายการติดขัด + ตัวช่วยตรวจ + คิวค้าง เฉพาะขั้นที่บทบาทของผู้ใช้ทำได้ ไม่มีราคาของออฟฟิศ (ยอดบิลเฉพาะเรื่องของบัญชี)

export type VehicleKind = "car" | "moto";
export type Severity = "high" | "medium" | "info";

export interface WorkRow {
  key: string;
  kind: VehicleKind | null;
  title: string;
  chassis: string | null;
  customerName: string;
  stageLabel: string;
  since: string | null;
  days: number | null;
  overdueDays: number;
  severity: Severity;
  reason: string;
  amount: number | null;
  href: string; // ลิงก์ไปจัดการ สร้างจาก backend ตามบทบาท
}

export interface WorkCheck {
  key: string;
  owner: "entry" | "submit" | "delivery" | "accounting";
  severity: Severity;
  title: string;
  lesson: string;
  items: WorkRow[];
  total: number;
}

export interface StageSummary {
  key: string;
  label: string;
  href: string;
  sla: number;
  kinds: VehicleKind[];
  pending: { car: number; moto: number };
  oldestDays: number | null;
  lateCount: number;
}

export interface MyWork {
  today: string;
  roles: string[];
  summary: { problems: number; high: number; checks: number; pending: number };
  problems: WorkRow[];
  problemTotal: number;
  checks: WorkCheck[];
  stages: StageSummary[];
}

export const myWorkApi = {
  get(): Promise<MyWork> {
    return request<MyWork>("/api/my-work");
  },
};
