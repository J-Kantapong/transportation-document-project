// ลิงก์ "ไปที่งาน" จากหน้าค้นหารถ (ผู้ใช้ 2026-09-25) พาไปหน้าของขั้นนั้นพร้อม ?focus=<เลขตัวถัง>
// components/FocusVehicleRow.tsx (อยู่ใน AppShell) เลื่อนไปที่แถวของรถคันนั้นแล้วไฮไลต์ให้ทุกหน้า
// หน้าที่ซ่อนรถไว้หลังแท็บ/หน้าย่อย/ตัวกรอง/ใบที่ต้องกดเปิด อ่านค่านี้ด้วย focusChassis() แล้วเปิดส่วนนั้นเอง

export const FOCUS_PARAM = "focus";

// อ่านจาก window ไม่ใช้ useSearchParams - หน้าไม่ต้องครอบ Suspense เพิ่ม (เรียกได้เฉพาะใน effect / event ฝั่ง browser)
export function focusChassis(): string {
  if (typeof window === "undefined") return "";
  return new URLSearchParams(window.location.search).get(FOCUS_PARAM)?.trim() ?? "";
}

export function sameChassis(a: string | null | undefined, b: string): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

// หน้า/แท็บของแต่ละขั้นที่รถรออยู่ - ต่างจาก STAGES.href ของภาพรวมตรงที่ชี้ไปหน้าที่มีรายการรถจริง (ไม่ใช่หน้าเมนู)
const STAGE_PAGES: Record<string, string> = {
  transfer: "/registration/new-vehicle/transfer-notice",
  inspectSend: "/registration/new-vehicle/inspection",
  inspectResult: "/registration/new-vehicle/inspection/result",
  submit: "/registration/new-vehicle/submit-documents/submit",
  receipt: "/registration/new-vehicle/receive-receipt",
  plate: "/registration/new-vehicle/receive-plate",
  book: "/registration/new-vehicle/receive-book",
  delivery: "/registration/new-vehicle/delivery",
  plateDelivery: "/registration/new-vehicle/delivery",
  billing: "/accounting/billing",
};

export function stagePageFor(stage: string, fallback: string): string {
  return STAGE_PAGES[stage] ?? fallback;
}

export function focusHref(page: string, chassis: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({ ...extra, [FOCUS_PARAM]: chassis });
  return `${page}?${params.toString()}`;
}
