// ลงขันงานโอนรายจังหวัด (ผู้ใช้ 2026-11-18) - backend/src/vehicle-transfer/transfer-contribution-rates.service.ts
// GET  /api/transfer-contribution-rates  ครบ 77 จังหวัด ช่องว่าง (null) = ยังไม่ได้ตั้งอัตรา (กลุ่มยื่นเอกสาร + บัญชีอ่านได้)
// POST /api/transfer-contribution-rates  { province, transferMoto, transferCar, moveInMoto, note, remark?, expectedUpdatedAt } (ADMIN)
//      ช่องว่าง = ยังไม่ตั้ง · เติมช่องที่ยังว่างไม่ต้องมี remark แก้/ลบอัตราที่เคยตั้งแล้วต้องมี · expectedUpdatedAt ไม่ตรง = 409
import { request } from "@/lib/api";

export interface TransferContributionRate {
  province: string;
  transferMoto: number | null; // ลงขันโอน (มอเตอร์ไซค์)
  transferCar: number | null; // ลงขันโอน (รถยนต์)
  moveInMoto: number | null; // ลงขันโอนย้ายเข้า (มอเตอร์ไซค์)
  note: string | null;
  updatedAt: string | null; // null = ยังไม่เคยตั้ง
  updatedBy: string | null;
}

export interface TransferContributionRateSave {
  province: string;
  transferMoto: string;
  transferCar: string;
  moveInMoto: string;
  note: string;
  remark: string;
  expectedUpdatedAt: string | null;
}

export const transferContributionRatesApi = {
  list: () => request<{ rates: TransferContributionRate[] }>("/api/transfer-contribution-rates"),
  save: (body: TransferContributionRateSave) =>
    request<{ province: string; updatedAt: string }>("/api/transfer-contribution-rates", { method: "POST", body: JSON.stringify(body) }),
};
