import { request } from "@/lib/api";

// ย้ายออก (หมวด "อื่นๆ", ผู้ใช้ 2026-10-06) - ดู backend/src/vehicle-move-out/
// GET    /api/vehicle-move-outs?status=pending|returned|all&month=YYYY-MM&vehicleClass=CAR|MOTO  (งานที่ยกเลิกแล้วไม่แสดง)
// POST   /api/vehicle-move-outs             ยื่นงาน (customerId = เจ้าของงาน, ข้อมูลรถ, submitDate, urgent - ค่าใช้จ่ายมอเตอร์ไซค์ Bill 25 / No Bill 80 (+50 ด่วน) / ค่าอากร 10 backend กำหนดเอง รถยนต์ยังไม่มีอัตรา)
// PATCH  /api/vehicle-move-outs/:id {…, remark, expectedUpdatedAt}  แก้งาน (remark บังคับ / expectedUpdatedAt ไม่ตรง = 409)
// POST   /api/vehicle-move-outs/:id/receipts (multipart: file, remark?)  แนบรูปใบเสร็จ - อ่าน OCR เติมเลขที่/วันที่/ยอดเงินเมื่อช่องว่างทั้ง 3
// DELETE /api/vehicle-move-outs/:id/receipts/:receiptId {remark?}        (remark บังคับหลังรับกลับ และต้องเหลืออย่างน้อย 1 รูป)
// PATCH  /api/vehicle-move-outs/:id/receipt-fields {receiptNo?, receiptDate?, receiptAmount?, remark?}
// PATCH  /api/vehicle-move-outs/:id/return {returnedDate}  รับเอกสารกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป, วันที่ไม่เกินวันนี้)
// POST   /api/vehicle-move-outs/:id/undo-return {remark}   ยกเลิกการรับเอกสารกลับที่กดผิด
// POST   /api/vehicle-move-outs/:id/cancel {remark}        ยกเลิกงาน (ไม่ลบแถว)
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)

export type MoveOutVehicleClass = "CAR" | "MOTO";

export interface MoveOutCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface VehicleMoveOut {
  id: string;
  vehicleClass: MoveOutVehicleClass;
  customer: MoveOutCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  urgent: boolean; // งานด่วน (มอเตอร์ไซค์ ลงขันด่วนเพิ่ม 50)
  billTotal: string;
  noBillTotal: string; // ไม่รวมค่าอากร
  dutyAmount: string; // ค่าอากร - แยกต่างหาก ไม่รวมใน noBillTotal และไม่นับในยอดรวม
  returnedDate: string | null; // YYYY-MM-DD
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ แก้เองทีหลังได้เสมอ
  receiptAmount: string | null;
  createdAt: string;
  updatedAt: string; // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt
}

export interface CreateVehicleMoveOutInput {
  vehicleClass: MoveOutVehicleClass;
  customerId: string;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string;
  urgent: boolean; // รถยนต์ติ๊กไม่ได้ (ยังไม่มีอัตรา)
}

export interface UpdateVehicleMoveOutInput {
  customerId?: string;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string;
  urgent: boolean;
  returnedDate?: string;
  remark: string;
  expectedUpdatedAt: string;
}

export type MoveOutStatusFilter = "pending" | "returned" | "all";

type One = { moveOut: VehicleMoveOut };

export const vehicleMoveOutApi = {
  list: (status: MoveOutStatusFilter, vehicleClass: MoveOutVehicleClass, month?: string) =>
    request<{ moveOuts: VehicleMoveOut[] }>(
      `/api/vehicle-move-outs?status=${status}&vehicleClass=${vehicleClass}${month ? `&month=${month}` : ""}`,
    ),
  create: (data: CreateVehicleMoveOutInput) =>
    request<One>("/api/vehicle-move-outs", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: UpdateVehicleMoveOutInput) =>
    request<One>(`/api/vehicle-move-outs/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  addReceipt: (id: string, image: Blob, fileName: string, remark?: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    if (remark) form.append("remark", remark);
    return request<One>(`/api/vehicle-move-outs/${id}/receipts`, { method: "POST", body: form });
  },
  removeReceipt: (id: string, receiptId: string, remark?: string) =>
    request<One>(`/api/vehicle-move-outs/${id}/receipts/${receiptId}`, { method: "DELETE", body: JSON.stringify({ remark }) }),
  updateReceiptFields: (id: string, data: { receiptNo?: string; receiptDate?: string; receiptAmount?: string }, remark?: string) =>
    request<One>(`/api/vehicle-move-outs/${id}/receipt-fields`, { method: "PATCH", body: JSON.stringify({ ...data, remark }) }),
  markReturned: (id: string, returnedDate: string) =>
    request<One>(`/api/vehicle-move-outs/${id}/return`, { method: "PATCH", body: JSON.stringify({ returnedDate }) }),
  undoReturn: (id: string, remark: string) =>
    request<One>(`/api/vehicle-move-outs/${id}/undo-return`, { method: "POST", body: JSON.stringify({ remark }) }),
  cancel: (id: string, remark: string) =>
    request<{ id: string }>(`/api/vehicle-move-outs/${id}/cancel`, { method: "POST", body: JSON.stringify({ remark }) }),
};
