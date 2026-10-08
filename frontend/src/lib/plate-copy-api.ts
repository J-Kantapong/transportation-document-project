import { request } from "@/lib/api";

// คัดแผ่นป้ายทะเบียน (หมวด "อื่นๆ", ผู้ใช้ 2026-10-02) - รถยนต์เท่านั้น ดู backend/src/plate-copy/
// GET    /api/plate-copies?status=pending|returned|all&month=YYYY-MM   (งานที่ยกเลิกแล้วไม่แสดง)
// POST   /api/plate-copies             ยื่นงาน (customerId = เจ้าของงาน, ข้อมูลรถ, submitDate - ค่าใช้จ่ายตายตัว Bill 205 / No Bill 100 / ค่าอากร 10 backend กำหนดเอง)
// PATCH  /api/plate-copies/:id {…, remark, expectedUpdatedAt}  แก้งาน (remark บังคับ / expectedUpdatedAt ไม่ตรง = 409)
// POST   /api/plate-copies/:id/receipts (multipart: file, remark?)  แนบรูปใบเสร็จ - อ่าน OCR เติมเลขที่/วันที่/ยอดเงินเมื่อช่องว่างทั้ง 3
// DELETE /api/plate-copies/:id/receipts/:receiptId {remark?}        (remark บังคับหลังรับกลับ และต้องเหลืออย่างน้อย 1 รูป)
// PATCH  /api/plate-copies/:id/receipt-fields {receiptNo?, receiptDate?, receiptAmount?, remark?}
// PATCH  /api/plate-copies/:id/return {returnedDate}  รับใบเสร็จกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป, วันที่ไม่เกินวันนี้)
// POST   /api/plate-copies/:id/undo-return {remark}   ยกเลิกการรับใบเสร็จกลับที่กดผิด
// POST   /api/plate-copies/:id/cancel {remark}        ยกเลิกงาน (ไม่ลบแถว)
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)
//
// รับป้าย (ไม่ใช้ AI ไม่ผูกกับ returnedDate) - แนบรูปป้ายที่ได้รับ + วันที่รับ บันทึกทันที:
// GET    /api/plate-copies/plate-queue?status=pending|received|all
// POST   /api/plate-copies/:id/plate-photo (multipart: file, date)   แนบรูปป้าย -> บันทึกรับทันที
// PATCH  /api/plate-copies/:id/plate-photo/date {date, remark}       แก้วันที่รับป้าย
// POST   /api/plate-copies/:id/plate-photo/detach {remark}           ถอดรูปป้ายที่แนบผิด
// GET    /api/plate-copies/:id/plate-photo/image                     โหลดรูปป้าย (ต้องแนบ Authorization) - plateCopyPlatePhotoImageUrl ใน lib/api.ts

export interface PlateCopyCustomer {
  id: string;
  name: string;
  company: string | null;
}

import type { PlateCopyType } from "@/lib/plate-copy-fee";

export interface PlateCopy {
  id: string;
  customer: PlateCopyCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  copyType: PlateCopyType;
  billTotal: string;
  noBillTotal: string;
  dutyAmount: string; // ค่าอากร - แยกต่างหาก ไม่รวมใน noBillTotal และไม่นับในยอดรวม
  returnedDate: string | null; // YYYY-MM-DD
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ แก้เองทีหลังได้เสมอ
  receiptAmount: string | null;
  plateReceivedDate: string | null; // YYYY-MM-DD - วันที่รับป้าย (ตั้งพร้อมรูป)
  platePhotoId: string | null; // ดูรูปที่ plateCopyPlatePhotoImageUrl(id)
  createdAt: string;
  updatedAt: string; // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt
}

export interface CreatePlateCopyInput {
  customerId: string;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  copyType: PlateCopyType;
  submitDate: string;
}

export interface UpdatePlateCopyInput {
  customerId?: string;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  copyType: PlateCopyType;
  submitDate: string;
  returnedDate?: string;
  remark: string;
  expectedUpdatedAt: string;
}

export type PlateCopyStatusFilter = "pending" | "returned" | "all";

type One = { plateCopy: PlateCopy };

export const plateCopyApi = {
  list: (status: PlateCopyStatusFilter, month?: string) =>
    request<{ plateCopies: PlateCopy[] }>(`/api/plate-copies?status=${status}${month ? `&month=${month}` : ""}`),
  create: (data: CreatePlateCopyInput) => request<One>("/api/plate-copies", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: UpdatePlateCopyInput) => request<One>(`/api/plate-copies/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  addReceipt: (id: string, image: Blob, fileName: string, remark?: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    if (remark) form.append("remark", remark);
    return request<One>(`/api/plate-copies/${id}/receipts`, { method: "POST", body: form });
  },
  removeReceipt: (id: string, receiptId: string, remark?: string) =>
    request<One>(`/api/plate-copies/${id}/receipts/${receiptId}`, { method: "DELETE", body: JSON.stringify({ remark }) }),
  updateReceiptFields: (id: string, data: { receiptNo?: string; receiptDate?: string; receiptAmount?: string }, remark?: string) =>
    request<One>(`/api/plate-copies/${id}/receipt-fields`, { method: "PATCH", body: JSON.stringify({ ...data, remark }) }),
  markReturned: (id: string, returnedDate: string) =>
    request<One>(`/api/plate-copies/${id}/return`, { method: "PATCH", body: JSON.stringify({ returnedDate }) }),
  undoReturn: (id: string, remark: string) => request<One>(`/api/plate-copies/${id}/undo-return`, { method: "POST", body: JSON.stringify({ remark }) }),
  cancel: (id: string, remark: string) => request<{ id: string }>(`/api/plate-copies/${id}/cancel`, { method: "POST", body: JSON.stringify({ remark }) }),

  // รับป้าย
  plateQueue: (status: "pending" | "received" | "all") => request<{ plateCopies: PlateCopy[] }>(`/api/plate-copies/plate-queue?status=${status}`),
  attachPlatePhoto: (id: string, image: Blob, fileName: string, date: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    form.append("date", date);
    return request<One>(`/api/plate-copies/${id}/plate-photo`, { method: "POST", body: form });
  },
  updatePlateReceivedDate: (id: string, date: string, remark: string) =>
    request<One>(`/api/plate-copies/${id}/plate-photo/date`, { method: "PATCH", body: JSON.stringify({ date, remark }) }),
  detachPlatePhoto: (id: string, remark: string) =>
    request<One>(`/api/plate-copies/${id}/plate-photo/detach`, { method: "POST", body: JSON.stringify({ remark }) }),
};
