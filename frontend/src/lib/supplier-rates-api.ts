// ราคาซับจดทะเบียนต่างจังหวัด (ผู้ใช้ 2026-10-08) - backend/src/supplier-rates
// GET /api/supplier-rates (พนักงานทุกฝ่าย) · POST /api/supplier-rates (ADMIN, remark บังคับ) · GET /api/supplier-rates/history?province=
// PATCH /api/vehicles/document-submission/:id/supplier-fee = แก้ค่าจ้างซับรายคัน (ขั้นรับใบเสร็จ, remark บังคับ)
import { request, type DocumentSubmission } from "@/lib/api";

export interface SupplierRate {
  province: string;
  configured: boolean; // false = ยังไม่เคยตั้งราคา
  accepts: boolean; // false = ซับไม่รับจดจังหวัดนี้
  serviceFee: number | null;
  channelFee: number | null;
  inspectionFee: number | null;
  total: number | null; // ค่าจ้างซับต่อคัน (3 ช่องรวมกัน) - null = ราคาไม่ครบ/ซับไม่รับ
  plateSwapFee: number | null;
  plateSwapNote: string | null;
  note: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface SupplierRateSave {
  province: string;
  accepts: boolean;
  serviceFee: string;
  channelFee: string;
  inspectionFee: string;
  plateSwapFee: string;
  plateSwapNote: string;
  note: string;
  remark: string;
  expectedUpdatedAt: string | null;
}

export interface SupplierRateHistory {
  id: string;
  action: string;
  remark: string;
  changes: Record<string, { from: unknown; to: unknown } | string>;
  by: string | null;
  at: string;
}

export const supplierRatesApi = {
  list: () => request<{ rates: SupplierRate[]; selfRegisterProvinces: string[] }>("/api/supplier-rates"),
  save: (body: SupplierRateSave) =>
    request<{ province: string; updatedAt: string }>("/api/supplier-rates", { method: "POST", body: JSON.stringify(body) }),
  history: (province: string) =>
    request<{ history: SupplierRateHistory[] }>(`/api/supplier-rates/history?province=${encodeURIComponent(province)}`),
  updateSubmissionFee: (submissionId: string, body: { serviceFee: string; channelFee: string; inspectionFee: string; remark: string }) =>
    request<{ submission: DocumentSubmission }>(`/api/vehicles/document-submission/${submissionId}/supplier-fee`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
};
