// ใบเสร็จแจ้งย้ายของรถจดใหม่ ขั้น 2 (ผู้ใช้ 2026-10-08) - backend/src/transfer-notice-receipts
// งานแจ้งย้าย (จดต่างจังหวัด) ต้องแนบใบเสร็จก่อนติ๊กดำเนินการแล้ว · ใบเสร็จ 1 ใบผูกได้หลายคัน ระบบหารยอดเท่ากันต่อคัน
// POST /api/transfer-notice-receipts (multipart: file, vehicleIds "id1,id2", totalAmount, amounts ไม่บังคับ)
// GET /:id · GET /:id/file · PATCH /:id { totalAmount, amounts?, remark } · POST /:id/detach { vehicleId, remark }
import { fetchAuthedBlob, request } from "@/lib/api";

export interface TransferReceiptShare {
  id: string;
  amount: number;
}

export interface TransferReceiptDetail {
  id: string;
  totalAmount: number;
  mimeType: string;
  originalName: string | null;
  createdAt: string;
  vehicles: Array<{ id: string; chassis: string; customerName: string; transferDone: boolean; amount: number | null }>;
}

// หารยอดเท่ากันต่อคัน เศษสตางค์ลงคันสุดท้าย - แบบเดียวกับ backend (splitEvenly) ใช้แสดงตัวอย่างก่อนบันทึก
export function splitEvenly(total: number, count: number): number[] {
  const satang = Math.round(total * 100);
  const base = Math.floor(satang / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? satang - base * (count - 1) : base) / 100);
}

export const transferReceiptsApi = {
  attach: (file: File, vehicleIds: string[], totalAmount: string) => {
    const form = new FormData();
    form.append("file", file);
    form.append("vehicleIds", vehicleIds.join(","));
    form.append("totalAmount", totalAmount);
    return request<{ id: string; totalAmount: number; vehicles: TransferReceiptShare[] }>("/api/transfer-notice-receipts", { method: "POST", body: form });
  },
  get: (id: string) => request<TransferReceiptDetail>(`/api/transfer-notice-receipts/${id}`),
  update: (id: string, body: { totalAmount: string; remark: string }) =>
    request<{ id: string; totalAmount: number; vehicles: TransferReceiptShare[] }>(`/api/transfer-notice-receipts/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  detach: (id: string, body: { vehicleId: string; remark: string }) =>
    request<{ id: string; deleted: boolean; vehicles: TransferReceiptShare[] }>(`/api/transfer-notice-receipts/${id}/detach`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // เปิดไฟล์ใบเสร็จในแท็บใหม่ (ไฟล์ต้องล็อกอิน จึงโหลดเป็น blob ก่อน)
  openFile: async (id: string) => {
    const tab = window.open("", "_blank");
    try {
      const url = URL.createObjectURL(await fetchAuthedBlob(`/api/transfer-notice-receipts/${id}/file`));
      if (tab) tab.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (err) {
      tab?.close();
      throw err;
    }
  },
};
