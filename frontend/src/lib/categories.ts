import type { IconName } from "@/components/Icon";

export interface RegistrationCategory {
  title: string;
  icon: IconName;
  href: string;
  color: string;
  bg: string;
}

// Matches the `types` array in prototype/sites-reference/dist/index.html.
export const REGISTRATION_CATEGORIES: RegistrationCategory[] = [
  { title: "จดทะเบียนรถใหม่", icon: "car", href: "/registration/new-vehicle", color: "#2854d9", bg: "#edf2ff" },
  { title: "การสลับเลข", icon: "swap", href: "/registration/plate-swap", color: "#7560c7", bg: "#f2eeff" },
  { title: "งานโอน", icon: "transfer", href: "/registration/transfer", color: "#228d91", bg: "#eaf7f7" },
  { title: "ต่อภาษี", icon: "card", href: "/registration/tax-renewal", color: "#2f8a5b", bg: "#eaf7f0" },
  { title: "งานแจ้งย้ายยามาฮ่า", icon: "move", href: "/registration/yamaha-relocation", color: "#bd8131", bg: "#fff5e8" },
  { title: "อื่นๆ", icon: "more", href: "/registration/other", color: "#738197", bg: "#f0f3f7" },
];

export interface RegistrationSubtask {
  title: string;
  href: string;
}

// The subtask headings under "จดทะเบียนรถใหม่". The last four (รับใบเสร็จ ... Delivery) are
// title-only placeholders until the user describes their workflow.
export const NEW_VEHICLE_SUBTASKS: RegistrationSubtask[] = [
  { title: "เพิ่มข้อมูลรถจดใหม่", href: "/registration/new-vehicle/entry" },
  { title: "แจ้งย้าย/ตัดบัญชี", href: "/registration/new-vehicle/transfer-notice" },
  { title: "ตรวจรถ", href: "/registration/new-vehicle/inspection" },
  { title: "ยื่นเอกสารจดทะเบียนรถใหม่", href: "/registration/new-vehicle/submit-documents" },
  { title: "รับใบเสร็จ", href: "/registration/new-vehicle/receive-receipt" },
  { title: "รับป้ายทะเบียน", href: "/registration/new-vehicle/receive-plate" },
  { title: "รับเล่มทะเบียน", href: "/registration/new-vehicle/receive-book" },
  { title: "Delivery", href: "/registration/new-vehicle/delivery" },
];

// The two subtask headings under "งานแจ้งย้ายยามาฮ่า".
export const YAMAHA_RELOCATION_SUBTASKS: RegistrationSubtask[] = [
  { title: "แจ้งย้ายรถเล็ก", href: "/registration/yamaha-relocation/small" },
  { title: "แจ้งย้ายรถใหญ่", href: "/registration/yamaha-relocation/large" },
];

// งานย่อยของ "การสลับเลข" แยกตามประเภทรถ (ผู้ใช้ 2026-09-28: รถยนต์/มอเตอร์ไซค์ก่อน แล้วค่อยแตกเป็น 2 เคสเดิม)
// รถเก่า กับ รถเก่า (ทั้งสองประเภทรถ) และมอเตอร์ไซค์ทั้งหมด ยังรอเงื่อนไขจากผู้ใช้ (EmptyWorkPage)
export type PlateSwapVehicleKind = "car" | "moto";

export function plateSwapSubtasks(kind: PlateSwapVehicleKind): RegistrationSubtask[] {
  const label = kind === "car" ? "รถยนต์" : "รถจักรยานยนต์";
  return [
    { title: `รถเก่า กับ รถใหม่ (${label})`, href: `/registration/plate-swap/${kind}/old-new` },
    { title: "รถเก่า กับ รถเก่า", href: `/registration/plate-swap/${kind}/old-old` },
  ];
}

// งานย่อยของ "อื่นๆ" (ผู้ใช้ 2026-10-02: ยกเลิกการใช้รถ + คัดแผ่นป้ายทะเบียน - งานอื่นๆ ที่จะตามมายังรอผู้ใช้กำหนด)
export const OTHER_SUBTASKS: RegistrationSubtask[] = [
  { title: "ยกเลิกการใช้รถ", href: "/registration/other/cancel-use" },
  { title: "คัดแผ่นป้ายทะเบียน", href: "/registration/other/plate-copy" },
  { title: "ย้ายออก", href: "/registration/other/move-out" },
];

// ยกเลิกการใช้รถ แยกตามประเภทรถ (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO เหมือนงานสลับเลข)
// ย้ายออก แยกตามประเภทรถ (ผู้ใช้ 2026-10-06) เหมือนยกเลิกการใช้รถ
export const MOVE_OUT_VEHICLE_KINDS: RegistrationSubtask[] = [
  { title: "รถยนต์", href: "/registration/other/move-out/car" },
  { title: "รถจักรยานยนต์", href: "/registration/other/move-out/moto" },
];

export const CANCEL_USE_VEHICLE_KINDS: RegistrationSubtask[] = [
  { title: "รถยนต์", href: "/registration/other/cancel-use/car" },
  { title: "รถจักรยานยนต์", href: "/registration/other/cancel-use/moto" },
];

// งานโอน (ผู้ใช้ 2026-10-02): 2 แบบ - โอนตามผู้ถือกรรมสิทธิ์ (ไม่มีตรวจรถ) / โอนตรวจรถ (มีตรวจรถ แยกจากคิวตรวจรถของรถจดใหม่)
export const TRANSFER_TYPES: RegistrationSubtask[] = [
  { title: "โอนตามผู้ถือกรรมสิทธิ์", href: "/registration/transfer/owner" },
  { title: "โอนตรวจรถ", href: "/registration/transfer/inspection" },
];
