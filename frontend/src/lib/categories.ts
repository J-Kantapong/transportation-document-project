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
  { title: "การโอน", icon: "transfer", href: "/registration/transfer", color: "#228d91", bg: "#eaf7f7" },
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

// งานย่อยของ "การสลับเลข" (ผู้ใช้ 2026-09-22) - รถเก่า กับ รถเก่า ยังรอเงื่อนไข
export const PLATE_SWAP_SUBTASKS: RegistrationSubtask[] = [
  { title: "รถเก่า กับ รถใหม่ (รถยนต์)", href: "/registration/plate-swap/old-new" },
  { title: "รถเก่า กับ รถเก่า", href: "/registration/plate-swap/old-old" },
];
