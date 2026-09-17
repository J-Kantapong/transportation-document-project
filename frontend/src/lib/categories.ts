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
  { title: "อื่นๆ", icon: "more", href: "/registration/other", color: "#738197", bg: "#f0f3f7" },
  { title: "งานแจ้งย้ายยามาฮ่า", icon: "move", href: "/registration/yamaha-relocation", color: "#bd8131", bg: "#fff5e8" },
];

export interface RegistrationSubtask {
  title: string;
  href: string;
}

// The four subtask headings under "จดทะเบียนรถใหม่"; only the first is implemented.
export const NEW_VEHICLE_SUBTASKS: RegistrationSubtask[] = [
  { title: "เพิ่มข้อมูลรถจดใหม่", href: "/registration/new-vehicle/entry" },
  { title: "แจ้งย้าย/ตัดบัญชี", href: "/registration/new-vehicle/transfer-notice" },
  { title: "ตรวจรถ", href: "/registration/new-vehicle/inspection" },
  { title: "ยื่นเอกสารจดทะเบียนรถใหม่", href: "/registration/new-vehicle/submit-documents" },
];

// The two subtask headings under "งานแจ้งย้ายยามาฮ่า".
export const YAMAHA_RELOCATION_SUBTASKS: RegistrationSubtask[] = [
  { title: "แจ้งย้ายรถเล็ก", href: "/registration/yamaha-relocation/small" },
  { title: "แจ้งย้ายรถใหญ่", href: "/registration/yamaha-relocation/large" },
];
