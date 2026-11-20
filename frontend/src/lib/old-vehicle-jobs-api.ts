import { request } from "@/lib/api";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { TRANSPORT_VEHICLE_TYPES, VEHICLE_TYPES } from "@/lib/vehicle-reference-data";

// หน้ารวม "งานรถเก่า" (ผู้ใช้ 2026-11-18) - ดู backend/src/old-vehicle-jobs/
// โฟลว: รับงาน -> เลือกประเภทงาน -> ตรวจรถ (เฉพาะที่ต้องตรวจ) -> ยื่น -> รับเอกสาร -> ส่งงาน (= เสร็จ)
// GET    /api/old-vehicle-jobs?scope=open|done|all&q=&vehicleClass=CAR|MOTO   หน้ารวม (ไม่เกิน 500 คัน)
// GET    /api/old-vehicle-jobs/lookup?chassis=&plateCategory=&plateNumber=    รถที่มีอยู่แล้ว + คำเตือนเลขตัวถัง
// POST   /api/old-vehicle-jobs/intake {customerId, receivedDate, vehicles[]}   รับงาน (หลายคันได้)
// PATCH  /api/old-vehicle-jobs/vehicles/:id {..., remark, expectedUpdatedAt}   แก้ข้อมูลรถ
// PATCH  /api/old-vehicle-jobs/jobs/:id/type {jobType, firstRegistrationDate?, taxExpiryDate?, duplicateReason?}
// POST   /api/old-vehicle-jobs/inspection-sent {sentDate, sentType, items:[{id, cost}]}
// PATCH  /api/old-vehicle-jobs/jobs/:id/inspection-result {result, resultDate}
// POST   /api/old-vehicle-jobs/jobs/:id/inspection-undo {remark}
// POST   /api/old-vehicle-jobs/jobs/:id/block {reason, note?}  ·  POST .../unblock
// POST   /api/old-vehicle-jobs/jobs/:id/cancel {remark}        ยกเลิกการรับงานที่ยังไม่ยื่น
// ชื่องาน / ชื่อสถานะ / เหตุผลติดขัด เป็นสำเนาของ backend/src/old-vehicle-jobs/old-vehicle-job-rules.ts - แก้ให้ตรงกันทั้งสองที่

export type OldVehicleClass = "CAR" | "MOTO";

export const OLD_JOB_TYPES = [
  "PLATE_SWAP",
  "TRANSFER_OWNER",
  "TRANSFER_INSPECTION",
  "TRANSFER_MOVE_IN",
  "TAX_RENEWAL",
  "USE_CANCEL",
  "MOVE_OUT",
  "PLATE_COPY",
] as const;
export type OldJobType = (typeof OLD_JOB_TYPES)[number];

export const OLD_JOB_TYPE_LABEL: Record<OldJobType, string> = {
  PLATE_SWAP: "สลับเลข / เปลี่ยนเลข",
  TRANSFER_OWNER: "โอนตามผู้ถือกรรมสิทธิ์",
  TRANSFER_INSPECTION: "โอนตรวจรถ",
  TRANSFER_MOVE_IN: "โอนย้ายเข้า",
  TAX_RENEWAL: "ต่อภาษี",
  USE_CANCEL: "ยกเลิกการใช้รถ",
  MOVE_OUT: "ย้ายออก",
  PLATE_COPY: "คัดแผ่นป้าย",
};

// คอลัมน์ของตารางช่อง (จอใหญ่): หนึ่งคอลัมน์ต่อกลุ่มงาน - งานโอน 3 แบบอยู่คอลัมน์เดียวกัน
export const OLD_JOB_COLUMNS: { key: string; label: string; types: OldJobType[] }[] = [
  { key: "TRANSFER", label: "งานโอน", types: ["TRANSFER_OWNER", "TRANSFER_INSPECTION", "TRANSFER_MOVE_IN"] },
  { key: "TAX_RENEWAL", label: "ต่อภาษี", types: ["TAX_RENEWAL"] },
  { key: "PLATE_SWAP", label: "สลับเลข", types: ["PLATE_SWAP"] },
  { key: "PLATE_COPY", label: "คัดป้าย", types: ["PLATE_COPY"] },
  { key: "MOVE_OUT", label: "ย้ายออก", types: ["MOVE_OUT"] },
  { key: "USE_CANCEL", label: "ยกเลิกใช้", types: ["USE_CANCEL"] },
];

// แบบของงานสลับเลข - เลือกตั้งแต่รับงาน (ผู้ใช้ 2026-11-18): รถเก่า กับ รถใหม่ รับคันเดียว / รถเก่า กับ รถเก่า รับ 2 คันพร้อมกัน
// CHANGE = เปลี่ยนเลขทะเบียน (ผู้ใช้ 2026-11-18): รถคันเดียวรับเลขที่ลูกค้าจองไว้ - งานจริงเก็บใน PlateSwap kind CHANGE จึงเป็นแบบหนึ่งของสลับเลข
export type SwapKind = "OLD_NEW" | "OLD_OLD" | "CHANGE";
export const SWAP_KIND_LABEL: Record<SwapKind, string> = { OLD_NEW: "รถเก่า กับ รถใหม่", OLD_OLD: "รถเก่า กับ รถเก่า", CHANGE: "เปลี่ยนเลขทะเบียน" };
export const isSwapKind = (v: string | null | undefined): v is SwapKind => v === "OLD_NEW" || v === "OLD_OLD" || v === "CHANGE";

export type OldJobStatus =
  | "NEW"
  | "TO_INSPECT"
  | "TO_RESULT"
  | "TO_SUBMIT"
  | "TO_PAY"
  | "TO_RECEIPT"
  | "TO_PLATE"
  | "TO_BOOK"
  | "TO_DELIVER"
  | "DONE"
  | "CANCELLED";

export const OLD_JOB_STATUS_LABEL: Record<OldJobStatus, string> = {
  NEW: "รอทำ",
  TO_INSPECT: "รอส่งตรวจ",
  TO_RESULT: "รอผลตรวจ",
  TO_SUBMIT: "รอยื่น",
  TO_PAY: "รอชำระภาษี",
  TO_RECEIPT: "รอใบเสร็จ",
  TO_PLATE: "รอป้าย",
  TO_BOOK: "รอเล่ม",
  TO_DELIVER: "รอส่งงาน",
  DONE: "เสร็จ",
  CANCELLED: "งานถูกยกเลิก",
};
export const OPEN_STATUSES: OldJobStatus[] = ["NEW", "TO_INSPECT", "TO_RESULT", "TO_SUBMIT", "TO_PAY", "TO_RECEIPT", "TO_PLATE", "TO_BOOK", "TO_DELIVER"];
export const isClosedStatus = (status: OldJobStatus) => status === "DONE" || status === "CANCELLED";

export const BLOCK_REASONS: [string, string][] = [
  ["WAIT_CUSTOMER_DOC", "รอเอกสารจากลูกค้า"],
  ["DOC_INVALID", "เอกสารหมดอายุ หรือไม่ถูกต้อง"],
  ["WAIT_FINANCE", "รอไฟแนนซ์"],
  ["WAIT_VEHICLE", "รอลูกค้านำรถมาตรวจ"],
  ["INSPECTION_FAILED", "ตรวจรถไม่ผ่าน รอแก้ไข"],
  ["WAIT_DLT", "รอขนส่ง"],
  ["OTHER", "อื่นๆ"],
];
export const BLOCKED_ALERT_DAYS = 3;

// ประเภทรถตอนรับงาน: รย. 14 ประเภท + ขส. 4 ประเภท (ขส. ทำได้เฉพาะงานต่อภาษี)
export const OLD_VEHICLE_TYPE_GROUPS: { label: string; types: readonly string[] }[] = [
  { label: "รถตาม พ.ร.บ.รถยนต์ (รย.)", types: VEHICLE_TYPES },
  { label: "รถตาม พ.ร.บ.ขนส่ง (ขส.) - เฉพาะงานต่อภาษี", types: TRANSPORT_VEHICLE_TYPES },
];
export const classOfVehicleType = (vehicleType: string | null | undefined): OldVehicleClass => (isMotorcycleBody(vehicleType) ? "MOTO" : "CAR");
// ค่าตรวจตั้งต้นตอนส่งตรวจนอก ตามประเภทรถ (ชีต 'Rate โอน' ค่าตรวจ, ผู้ใช้ 2026-11-20) - สำเนาฝั่งหลังบ้าน: old-vehicle-job-rules.ts
// ประเภทที่ไม่มีในตาราง (กระบะมีหลังคาแหนบ, รย.17, ขส.) ว่างไว้ให้กรอกเอง
const INSPECTION_COST_BY_TYPE: Record<string, number> = {
  "รย.1-เก๋ง 2 ตอน": 200,
  "รย.1-นั่ง 2 ตอน": 300,
  "รย.1-นั่ง 3 ตอน": 300,
  "รย.2-นั่ง 2 แถว": 500,
  "รย.2-นั่ง 4 ตอน": 500,
  "รย.3-กระบะบรรทุก": 300,
  "รย.3-กระบะบรรทุกมีหลังคา": 1000,
  "รย.3-ตู้บรรทุก": 1000,
  "รย.12-น้อยกว่า 300cc": 100,
  "รย.12-300-799cc": 300,
  "รย.12-800-999cc": 500,
  "รย.12-1000cc ขึ้นไป": 1000,
};
export const defaultInspectionCost = (vehicleType: string | null | undefined) => {
  const cost = vehicleType ? INSPECTION_COST_BY_TYPE[vehicleType] : undefined;
  return cost === undefined ? "" : String(cost);
};

export interface HubCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface HubJobFees {
  bill: number | null; // ต่อภาษีที่ยังไม่ชำระ = null
  noBill: number | null; // ไม่รวมค่าอากร
  duty: number;
  inspectionCost: number; // ค่าตรวจรถ (งานโอนที่มีขั้นตรวจ) แยกจาก noBill
  receiptAmount: number | null; // ยอดบนใบเสร็จจริง
}

export interface HubJob {
  id: string;
  jobType: OldJobType | null;
  jobTypeLabel: string | null;
  jobId: string | null;
  variant: string | null; // งานโอน: OWNER | INSPECTION | MOVE_IN · สลับเลข: OLD_NEW | OLD_OLD
  pair: { vehicleId: string; plate: string } | null; // อีกคันของคู่สลับเลข (รถเก่า กับ รถเก่า)
  // สลับเลข รถเก่า กับ รถใหม่: รถใหม่ที่จะรับเลข (เลือกตอนรับงาน หรือที่ผูกจริงตอนยื่น)
  newVehicle: { id: string; chassis: string; brandName: string; plate: string | null } | null;
  status: OldJobStatus;
  customer: HubCustomer | null;
  receivedDate: string;
  receivedIsBackfill: boolean; // วันที่รับ = วันที่คีย์งานเดิม (ระบบสร้างย้อนหลัง)
  note: string | null;
  firstRegistrationDate: string | null;
  taxExpiryDate: string | null;
  inspectionRequired: boolean;
  inspectionSentType: "OUTSIDE" | "BRING_IN" | null;
  inspectionSentDate: string | null;
  inspectionCost: string;
  inspectionResult: "PASS" | "FAIL" | null;
  inspectionResultDate: string | null;
  blockedAt: string | null;
  blockedDays: number | null;
  blockedReason: string | null;
  blockedReasonLabel: string | null;
  blockedNote: string | null;
  // ยอดเงินของงานที่ยื่นแล้ว / null = ยังไม่ยื่น (ยอดคิดตอนยื่น) หรือบัญชีนี้ไม่เห็นราคา
  fees: HubJobFees | null;
  updatedAt: string;
}

export interface HubVehicle {
  id: string;
  vehicleType: string | null;
  vehicleClass: OldVehicleClass;
  plateCategory: string;
  plateNumber: string;
  chassis: string;
  engine: string | null;
  brand: string | null;
  ownerName: string | null; // ผู้ถือกรรมสิทธิ์
  possessorName: string | null; // ผู้ครอบครอง (ไม่บังคับ) - งานโอนตามผู้ถือกรรมสิทธิ์ใช้เป็นผู้รับโอน
  ownerType: "INDIVIDUAL" | "JURISTIC" | null; // null = ยังไม่ได้ระบุ (รับก่อนมีช่องนี้ / แถวย้อนหลัง)
  financed: boolean; // ติดไฟแนนซ์ - ownerType คือประเภทผู้เช่าซื้อ
  updatedAt: string;
  jobs: HubJob[];
}

// ข้อมูลที่ฟอร์มยื่นของหน้างานเดิมใช้เติมให้เอง เมื่อเปิดจากหน้ารวม (?intake=<id> - รอบ 2 ผู้ใช้ 2026-11-18)
// รถที่พบในฐานข้อมูลรถจดใหม่ (รถที่เราจดเอง) - ฟอร์มรับงานเติมช่องที่ยังว่างให้ (ผู้ใช้ 2026-11-19)
export interface NewVehiclePrefill {
  vehicleType: string | null;
  chassis: string;
  engine: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  brand: string | null;
  ownerName: string | null;
  possessorName: string | null;
  ownerType: "INDIVIDUAL" | "JURISTIC" | null;
  financed: boolean;
}

export interface IntakePrefill {
  vehicle: HubVehicle;
  job: HubJob;
  pairVehicle: HubVehicle | null; // อีกคันของคู่สลับเลข รถเก่า กับ รถเก่า
}

export interface IntakeVehicleInput {
  vehicleId?: string;
  vehicleType?: string;
  plateCategory?: string;
  plateNumber?: string;
  chassis?: string;
  engine?: string;
  brand?: string;
  ownerName?: string; // ผู้ถือกรรมสิทธิ์
  possessorName?: string;
  ownerType?: "INDIVIDUAL" | "JURISTIC"; // บังคับเมื่อรับรถคันใหม่
  financed?: boolean;
  jobType?: OldJobType | "";
  swapKind?: SwapKind; // สลับเลข: บังคับ
  pairKey?: string; // สลับเลข รถเก่า กับ รถเก่า: ค่าเดียวกันในสองคันของคู่
  newVehicleId?: string; // สลับเลข รถเก่า กับ รถใหม่: รถใหม่ที่จะรับเลข (ไม่บังคับ)
  firstRegistrationDate?: string;
  taxExpiryDate?: string;
  note?: string;
  duplicateReason?: string;
}

export interface UpdateOldVehicleInput {
  vehicleType: string;
  plateCategory: string;
  plateNumber: string;
  chassis: string;
  engine: string;
  brand: string;
  ownerName: string;
  possessorName: string;
  ownerType?: "INDIVIDUAL" | "JURISTIC"; // ไม่ส่ง = คงค่าเดิม
  financed?: boolean;
  remark: string;
  expectedUpdatedAt: string;
}

type One = { vehicle: HubVehicle };
const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });

export const oldVehicleJobsApi = {
  // scope "inspection" = เฉพาะรถที่มีงานต้องตรวจรถและยังไม่ยื่น (หน้าตรวจรถ)
  list: (scope: "open" | "done" | "all" | "inspection", q = "", vehicleClass?: OldVehicleClass) => {
    const params = new URLSearchParams({ scope });
    if (q) params.set("q", q);
    if (vehicleClass) params.set("vehicleClass", vehicleClass);
    // counts = จำนวนรถที่ยังมีงานค้าง / งานเสร็จหมดแล้ว ตามคำค้นเดียวกัน (ทุกช่วงงาน)
    return request<{ vehicles: HubVehicle[]; truncated: boolean; counts: { open: number; done: number } }>(`/api/old-vehicle-jobs?${params}`);
  },
  // แถวรับงาน 1 งาน + ข้อมูลรถ - ฟอร์มยื่นของหน้างานเดิมใช้เติมข้อมูลให้เอง (?intake=<id>)
  job: (id: string) => request<IntakePrefill>(`/api/old-vehicle-jobs/jobs/${encodeURIComponent(id)}`),
  // คำแนะนำระหว่างพิมพ์ในฟอร์มรับงาน: รถเก่าในระบบ (old) + รถจดใหม่ที่ยังไม่เคยรับงาน (fresh)
  suggest: (q: string) => request<{ old: HubVehicle[]; fresh: NewVehiclePrefill[] }>(`/api/old-vehicle-jobs/suggest?${new URLSearchParams({ q })}`),
  financeCompanies: () => request<{ names: string[] }>("/api/old-vehicle-jobs/finance-companies"),
  lookup: (chassis: string, plateCategory = "", plateNumber = "") =>
    request<{ vehicle: HubVehicle | null; plateMatches: HubVehicle[]; warnings: string[]; newVehicle: NewVehiclePrefill | null }>(
      `/api/old-vehicle-jobs/lookup?${new URLSearchParams({ chassis, plateCategory, plateNumber })}`,
    ),
  intake: (data: { customerId: string; receivedDate: string; vehicles: IntakeVehicleInput[] }) =>
    request<{ vehicles: HubVehicle[] }>("/api/old-vehicle-jobs/intake", json("POST", data)),
  updateVehicle: (id: string, data: UpdateOldVehicleInput) => request<One>(`/api/old-vehicle-jobs/vehicles/${id}`, json("PATCH", data)),
  chooseType: (
    id: string,
    data: { jobType: OldJobType; swapKind?: SwapKind; newVehicleId?: string; firstRegistrationDate?: string; taxExpiryDate?: string; duplicateReason?: string },
  ) =>
    request<One>(`/api/old-vehicle-jobs/jobs/${id}/type`, json("PATCH", data)),
  sendInspection: (data: { sentDate: string; sentType: "OUTSIDE" | "BRING_IN"; items: { id: string; cost: string }[] }) =>
    request<{ vehicles: HubVehicle[] }>("/api/old-vehicle-jobs/inspection-sent", json("POST", data)),
  recordInspectionResult: (id: string, result: "PASS" | "FAIL", resultDate: string) =>
    request<One>(`/api/old-vehicle-jobs/jobs/${id}/inspection-result`, json("PATCH", { result, resultDate })),
  undoInspection: (id: string, remark: string) => request<One>(`/api/old-vehicle-jobs/jobs/${id}/inspection-undo`, json("POST", { remark })),
  block: (id: string, reason: string, note: string) => request<One>(`/api/old-vehicle-jobs/jobs/${id}/block`, json("POST", { reason, note })),
  unblock: (id: string) => request<One>(`/api/old-vehicle-jobs/jobs/${id}/unblock`, json("POST", {})),
  cancel: (id: string, remark: string) => request<{ id: string }>(`/api/old-vehicle-jobs/jobs/${id}/cancel`, json("POST", { remark })),
};

export const OLD_VEHICLE_HOME = "/registration/old-vehicle";
export const OLD_VEHICLE_INSPECTION = "/registration/old-vehicle/inspection";

// หน้าที่ต้องไปทำขั้นถัดไปของงานนั้น (รอบที่ 1: ขั้นยื่นและหลังจากนั้นยังอยู่ในหน้าเดิมของแต่ละงาน)
// null = ทำในหน้ารวมนี้เอง (เลือกประเภทงาน) หรือไม่มีอะไรต้องทำ (เสร็จ / ถูกยกเลิก)
export function nextStepHref(vehicle: HubVehicle, job: HubJob): string | null {
  const { status, jobType } = job;
  if (!jobType || status === "NEW" || isClosedStatus(status)) return null;
  if (status === "TO_DELIVER") return "/delivery";
  const href = stepHref(vehicle, job);
  if (!href) return null;
  // flow = งานที่กำลังทำตามขั้น: แถบ OldJobFlowBar พาไปหน้าขั้นถัดไปเองเมื่อบันทึกขั้นนี้เสร็จ (ผู้ใช้ 2026-11-19)
  const params = new URLSearchParams({ [OLD_JOB_FLOW_PARAM]: job.id });
  // ขั้นยื่น: พก id ของแถวรับงานไปด้วย ฟอร์มยื่นจะเติมข้อมูลรถ / เจ้าของงานให้เอง ไม่ต้องกรอกซ้ำ
  if (status === "TO_SUBMIT") params.set("intake", job.id);
  // ขั้นอื่นเป็นคิวหลายคัน: เลื่อนไปไฮไลต์แถวของรถคันนี้ (FocusVehicleRow)
  else params.set("focus", vehicle.chassis);
  return `${href}?${params.toString()}`;
}

export const OLD_JOB_FLOW_PARAM = "flow";

// ขั้นที่ flow พาไปต่อเอง - ส่งงาน (Delivery) ไม่พาไป ให้กลับหน้ารวม (ผู้ใช้ 2026-11-19: "จนจบก่อนถึง Delivery")
export const isFlowEndStatus = (status: OldJobStatus) => status === "TO_DELIVER" || isClosedStatus(status);

function stepHref(vehicle: HubVehicle, job: HubJob): string | null {
  const seg = vehicle.vehicleClass === "MOTO" ? "moto" : "car";
  const { status, jobType } = job;
  if (!jobType) return null;
  // ตรวจรถก่อนยื่นทำในหน้าตรวจรถของงานรถเก่า - งานโอนลำดับเดิมที่ยื่นไปแล้วยังตรวจในหน้าของงานโอน
  if (status === "TO_INSPECT" && !job.jobId) return OLD_VEHICLE_INSPECTION;
  if (status === "TO_RESULT" && !job.jobId) return `${OLD_VEHICLE_INSPECTION}/result`;
  switch (jobType) {
    case "PLATE_SWAP": {
      const base = `/registration/plate-swap/${seg}/${job.variant === "CHANGE" ? "change" : job.variant === "OLD_OLD" ? "old-old" : "old-new"}`;
      const page = status === "TO_SUBMIT" ? "submit" : status === "TO_PLATE" ? "receive-plate" : status === "TO_BOOK" ? "receive-book" : "receive-receipt";
      return `${base}/${page}`;
    }
    case "TRANSFER_OWNER":
    case "TRANSFER_INSPECTION":
    case "TRANSFER_MOVE_IN": {
      const kind = job.variant === "MOVE_IN" ? "move-in" : job.variant === "INSPECTION" ? "inspection" : "owner";
      const page = status === "TO_SUBMIT" ? "submit" : status === "TO_INSPECT" || status === "TO_RESULT" ? "inspect" : "return";
      return `/registration/transfer/${kind}/${page}`;
    }
    case "TAX_RENEWAL":
      return status === "TO_RECEIPT" ? "/registration/tax-renewal/receipt" : "/registration/tax-renewal";
    case "USE_CANCEL":
      return `/registration/other/cancel-use/${seg}/${status === "TO_SUBMIT" ? "submit" : "return"}`;
    case "MOVE_OUT":
      return `/registration/other/move-out/${seg}/${status === "TO_SUBMIT" ? "submit" : "return"}`;
    case "PLATE_COPY":
      return `/registration/other/plate-copy/${status === "TO_SUBMIT" ? "submit" : status === "TO_PLATE" ? "receive-plate" : "return"}`;
  }
}

export const plateOf = (v: Pick<HubVehicle, "plateCategory" | "plateNumber">) => `${v.plateCategory} ${v.plateNumber}`;
export const customerLabel = (c: HubCustomer | null) => (c ? (c.company ?? c.name) : "ยังไม่ระบุ");
