import { request } from "@/lib/api";
import { submitWriteScopeFor, type UserRole, type VehicleScope } from "@/lib/auth";
import { deliveryCustomerLabels } from "@/lib/delivery-print";

// ใบส่งงานรวมทุกประเภท (ผู้ใช้ 2026-10-05) - อ่านอย่างเดียว ไม่มีราคา ดู backend/src/delivery/delivery-sheet.service.ts
// GET /api/delivery/sheet?from=YYYY-MM-DD&to=YYYY-MM-DD&customerId= -> { rows, truncated }
// วันที่ของแต่ละประเภท: รถจดใหม่/สลับเลข = วันที่บนใบ DL, ต่อภาษี = วันที่คืนเอกสารให้ลูกค้า,
// ยกเลิกการใช้รถ/คัดป้าย/งานโอน = วันที่รับเอกสารกลับ, ยามาฮ่า = วันที่แจ้งย้าย
// แก้วันที่ผิด: ใบ DL ใช้หน้าต่างแก้ใบเดิม, ประเภทอื่นเรียก PATCH ของงานนั้น (ต้องมีเหตุผล บันทึกประวัติฝั่ง backend)
export type SheetSource = "VEHICLE" | "PLATE_SWAP" | "TAX_RENEWAL" | "USE_CANCEL" | "PLATE_COPY" | "TRANSFER" | "MOVE_OUT" | "YAMAHA";

export interface SheetCustomer {
  id: string;
  name: string;
  company: string | null;
  branch: string | null;
}

export interface SheetRow {
  key: string;
  source: SheetSource;
  jobId: string;
  date: string; // YYYY-MM-DD
  dateLabel: string;
  customer: SheetCustomer | null;
  kind: "car" | "moto" | null;
  chassis: string;
  plateText: string;
  brand: string;
  ownerName: string | null;
  detail: string;
  book: boolean | null; // เฉพาะแถวจากใบ DL
  plate: boolean | null;
  slipId: string | null;
  slipNo: number | null;
  updatedAt: string | null;
}

export const SHEET_SOURCE_ORDER: SheetSource[] = ["VEHICLE", "PLATE_SWAP", "TAX_RENEWAL", "USE_CANCEL", "PLATE_COPY", "TRANSFER", "MOVE_OUT", "YAMAHA"];

export const SHEET_SOURCE_LABEL: Record<SheetSource, string> = {
  VEHICLE: "รถจดใหม่",
  PLATE_SWAP: "สลับเลข",
  TAX_RENEWAL: "ต่อภาษี",
  USE_CANCEL: "ยกเลิกการใช้รถ",
  PLATE_COPY: "คัดแผ่นป้ายทะเบียน",
  TRANSFER: "งานโอน",
  MOVE_OUT: "ย้ายออก",
  YAMAHA: "แจ้งย้ายยามาฮ่า",
};

export const fetchDeliverySheet = (params: { from?: string; to?: string; customerId?: string }) =>
  request<{ rows: SheetRow[]; truncated: boolean }>(
    `/api/delivery/sheet?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as string[][])}`,
  );

export const NO_OWNER_ID = "NONE";
export const NO_OWNER_LABEL = "ไม่ระบุเจ้าของงาน";

export interface SheetSection {
  source: SheetSource;
  rows: SheetRow[];
}

// ใบ 1 ใบ = เจ้าของงาน 1 ราย x 1 วัน แบ่งช่วงตามประเภทงาน
export interface SheetGroup {
  key: string; // customerId|YYYY-MM-DD
  customerId: string;
  ownerLabel: string;
  date: string;
  sections: SheetSection[];
  count: number;
  slipNos: number[]; // เลขใบ DL ที่รวมอยู่ในใบนี้ (อ้างอิง)
}

export const ownerIdOf = (row: SheetRow) => row.customer?.id ?? NO_OWNER_ID;

// ชื่อเจ้าของงานที่แสดง (ชื่อซ้ำต่อผู้ติดต่อ/สาขา - หลักเดียวกับรายงานส่งงานและใบ DL)
export function sheetOwnerLabels(customers: Iterable<SheetCustomer>): Map<string, string> {
  const labels = deliveryCustomerLabels(customers);
  labels.set(NO_OWNER_ID, NO_OWNER_LABEL);
  return labels;
}

// เรียงตามชื่อเจ้าของงาน แล้ววันที่เก่าก่อน (ส่งงานตามลำดับวัน) - ในใบเรียงตามประเภทงาน ทะเบียน เลขตัวถัง (backend เรียงมาแล้ว)
export function groupSheetRows(rows: SheetRow[], labels: Map<string, string>): SheetGroup[] {
  const groups = new Map<string, SheetGroup>();
  for (const row of rows) {
    const customerId = ownerIdOf(row);
    const key = `${customerId}|${row.date}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, customerId, ownerLabel: labels.get(customerId) ?? row.customer?.company ?? row.customer?.name ?? NO_OWNER_LABEL, date: row.date, sections: [], count: 0, slipNos: [] };
      groups.set(key, group);
    }
    let section = group.sections.find((s) => s.source === row.source);
    if (!section) {
      section = { source: row.source, rows: [] };
      group.sections.push(section);
    }
    section.rows.push(row);
    group.count += 1;
    if (row.slipNo !== null && !group.slipNos.includes(row.slipNo)) group.slipNos.push(row.slipNo);
  }
  const list = [...groups.values()];
  for (const g of list) {
    g.sections.sort((a, b) => SHEET_SOURCE_ORDER.indexOf(a.source) - SHEET_SOURCE_ORDER.indexOf(b.source));
    g.slipNos.sort((a, b) => a - b);
  }
  return list.sort((a, b) => a.ownerLabel.localeCompare(b.ownerLabel, "th") || a.date.localeCompare(b.date));
}

// สิทธิ์แก้วันที่ (ตรงกับ backend: ใบ DL / ต่อภาษี / ยกเลิกการใช้รถ / คัดป้าย / งานโอน = ADMIN, STAFF_CAR รถยนต์, STAFF_MOTO จักรยานยนต์;
// ยามาฮ่า = ADMIN / STAFF_ENTRY) - DELIVERY / ACCOUNTANT ดูอย่างเดียว backend ตรวจซ้ำ
export function canEditSheetRow(row: SheetRow, roles: UserRole[]): boolean {
  if (row.source === "YAMAHA") return roles.includes("ADMIN") || roles.includes("STAFF_ENTRY");
  // งานอื่นที่ส่งก่อนมีใบ DL (ผู้ใช้ 2026-10-08): วันที่ส่งไม่มีใบให้แก้ - ยกเว้นต่อภาษีที่ยังแก้วันที่คืนลูกค้าที่กรอกมือได้
  if (row.slipId === null && ["USE_CANCEL", "PLATE_COPY", "TRANSFER", "MOVE_OUT"].includes(row.source)) return false;
  const scope: VehicleScope = submitWriteScopeFor(roles);
  if (scope === "NONE") return false;
  return scope === "ALL" || (scope === "MOTO") === (row.kind === "moto");
}

const patch = (path: string, body: unknown) => request<unknown>(path, { method: "PATCH", body: JSON.stringify(body) });

// แก้วันที่ของงานที่ไม่ใช่ใบ DL (ใบ DL แก้ผ่าน billingApi.updateDeliverySlip) - ใช้ route แก้งานเดิมของแต่ละประเภท
// ส่งเฉพาะวันที่ + เหตุผล (+ ค่าที่โหลดมากันแก้ทับกัน) backend ตรวจช่วงวันที่/สิทธิ์/บันทึกประวัติเอง
export function updateSheetRowDate(row: SheetRow, date: string, remark: string): Promise<unknown> {
  const guard = row.updatedAt ? { expectedUpdatedAt: row.updatedAt } : {};
  const id = encodeURIComponent(row.jobId);
  switch (row.source) {
    case "TAX_RENEWAL":
      return patch(`/api/tax-renewals/${id}`, { deliveredDate: date, remark, ...guard });
    case "YAMAHA":
      return patch(`/api/yamaha-relocation/${id}`, { date, remark, expectedDate: row.date });
    default:
      // รถจดใหม่ / สลับเลข / งานอื่นที่ส่งผ่านใบ DL แก้ที่ใบ - งานที่ส่งก่อนมีใบ DL ไม่มีวันที่ให้แก้ (canEditSheetRow ซ่อนปุ่มแล้ว)
      return Promise.reject(new Error("ใบส่งงาน DL แก้ผ่านหน้าต่างแก้ใบ"));
  }
}
