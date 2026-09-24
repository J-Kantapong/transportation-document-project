import { request } from "@/lib/api";

// ภาพรวมผู้บริหาร (ADMIN) - GET /api/overview?date=YYYY-MM-DD ดู backend/src/overview/overview.service.ts
// "ใช้เงิน" = เงินที่ร้านจ่ายออกในแต่ละงาน (Bill + No bill), "รับเงิน" = บิลที่บันทึกรับเงินแล้ว

export interface SpendSum {
  total: number;
  bill: number;
  noBill: number;
  other: number; // ค่าแจ้งย้าย/ตัดบัญชี (ไม่ได้แยก Bill/No bill)
}

export interface DailyPoint {
  date: string;
  spend: number;
  bill: number;
  noBill: number;
  other: number;
  billed: number;
  collected: number;
  submitted: number;
}

export interface AgingBucket {
  key: string;
  label: string;
  amount: number;
  count: number;
}

export interface ForecastWeek {
  weekStart: string;
  weekEnd: string;
  inflow: number;
  overdueInflow: number;
  outflow: number;
  net: number;
  cumulativeNet: number;
}

export type VehicleKind = "car" | "moto";

// ค่าที่แยกรถยนต์/จักรยานยนต์ - null = ขั้นนี้ไม่มีรถประเภทนั้น, unsplit = ข้อมูลที่ไม่ได้แยกประเภท (ยามาฮ่า)
export interface SplitValue {
  car: number | null;
  moto: number | null;
  unsplit?: number;
}

// งานแต่ละขั้นตอน: ทำไปในวันที่เลือก / ค่าใช้จ่ายวันนั้น / ค้างอยู่ตอนนี้
export interface ProcessRow {
  key: string;
  group: "new" | "other";
  label: string;
  href: string;
  done: SplitValue;
  doneNote: string | null;
  spend: SplitValue | null;
  pending: SplitValue | null;
  oldestDays: number | null;
  lateCount: number;
  sla: number | null;
}

export interface StuckItem {
  id: string;
  source: "vehicle" | "plateSwap" | "taxRenewal";
  kind: VehicleKind;
  customerName: string;
  brandName: string | null;
  chassis: string;
  plate: string | null;
  stage: string;
  stageLabel: string;
  href: string;
  since: string;
  days: number;
  overdueDays: number;
  severity: "high" | "medium";
  reason: string;
}

export interface OverviewAlert {
  key: string;
  severity: "high" | "medium" | "info";
  title: string;
  detail: string;
  href: string;
}

export interface Overview {
  asOf: string;
  today: string;
  generatedAt: string;
  spend: {
    today: SpendSum;
    yesterday: SpendSum;
    last7: SpendSum;
    prev7: SpendSum;
    last30: SpendSum;
    prev30: SpendSum;
    month: SpendSum;
    changeVsYesterday: number | null;
    changeVs7: number | null;
    changeVs30: number | null;
    categories: Array<{ key: string; label: string; today: number; last30: number }>;
  };
  cash: {
    collectedToday: number;
    collected7: number;
    collected30: number;
    collectedMonth: number;
    billedToday: number;
    billed30: number;
    billedMonth: number;
    net30: number;
    netMonth: number;
    daily: DailyPoint[];
  };
  workingCapital: {
    inProcess: { amount: number; count: number };
    unbilled: { amount: number; count: number };
    receivable: { amount: number; count: number };
    total: number;
    aging: AgingBucket[];
    unbilledAging: AgingBucket[];
    topCustomers: Array<{ customerId: string; name: string; receivable: number; unbilled: number; total: number }>;
    avgDaysToPay: number | null;
    avgBillingLagDays: number | null;
    paySamples: number;
  };
  forecast: {
    weeks: ForecastWeek[];
    atRiskAmount: number;
    atRiskCount: number;
    avgDailySpend: number;
    assumptions: { payDays: number; payDaysFromHistory: boolean; billingLagDays: number; paySamples: number };
  };
  process: ProcessRow[];
  stuck: { total: number; byKind: { car: number; moto: number }; high: number; items: StuckItem[] };
  alerts: OverviewAlert[];
}

export const overviewApi = {
  get(date?: string): Promise<Overview> {
    return request<Overview>(`/api/overview${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  },
};
