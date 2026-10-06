import { request } from "@/lib/api";
import type { PayslipSignature } from "@/lib/hr-api";

// ลายเซ็นผู้มีอำนาจชุดเดียวกับสลิปเงินเดือน ใช้พิมพ์บนใบเสนอราคา (ผู้ใช้ 2026-10-06) - อ่านผ่านสิทธิ์งานบัญชี (ADMIN + ACCOUNTANT)
// โหลดไม่ได้ (ยังไม่ตั้ง / เครือข่ายล้ม) = null: ใบยังพิมพ์ได้ ช่องเซ็นเว้นว่างเหมือนเดิม
export async function fetchPrintSignature(): Promise<PayslipSignature | null> {
  try {
    const s = await request<Pick<PayslipSignature, "exists" | "signerName" | "imageDataUrl">>("/api/billing/print-signature");
    return s.exists ? { ...s, updatedAt: null, updatedByName: null } : null;
  } catch {
    return null;
  }
}
