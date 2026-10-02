import { request } from "@/lib/api";

// ยกเลิกการใช้รถ (หมวด "อื่นๆ", ผู้ใช้ 2026-10-02) - ดู backend/src/vehicle-use-cancellation/
// GET    /api/vehicle-use-cancellations?status=pending|returned|all&month=YYYY-MM&vehicleClass=CAR|MOTO  (งานที่ยกเลิกแล้วไม่แสดง)
// POST   /api/vehicle-use-cancellations             ยื่นงาน (customerId = เจ้าของงาน, ข้อมูลรถ, submitDate - ค่าใช้จ่ายตายตัว Bill 25 / No Bill 100 / ค่าอากร 10 แยกต่างหาก backend กำหนดเอง)
// PATCH  /api/vehicle-use-cancellations/:id {…, remark, expectedUpdatedAt}  แก้งาน (remark บังคับ / expectedUpdatedAt ไม่ตรง = 409)
// POST   /api/vehicle-use-cancellations/:id/receipts (multipart: file, remark?)  แนบรูปใบเสร็จ - อ่าน OCR เติมเลขที่/วันที่/ยอดเงินเมื่อช่องว่างทั้ง 3
// DELETE /api/vehicle-use-cancellations/:id/receipts/:receiptId {remark?}        (remark บังคับหลังรับกลับ และต้องเหลืออย่างน้อย 1 รูป)
// PATCH  /api/vehicle-use-cancellations/:id/receipt-fields {receiptNo?, receiptDate?, receiptAmount?, remark?}
// PATCH  /api/vehicle-use-cancellations/:id/return {returnedDate}  รับเอกสารกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป, วันที่ไม่เกินวันนี้)
// POST   /api/vehicle-use-cancellations/:id/undo-return {remark}   ยกเลิกการรับเอกสารกลับที่กดผิด
// POST   /api/vehicle-use-cancellations/:id/cancel {remark}        ยกเลิกงาน (ไม่ลบแถว)
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)

export type CancellationVehicleClass = "CAR" | "MOTO";

export interface CancellationCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface VehicleUseCancellation {
  id: string;
  vehicleClass: CancellationVehicleClass;
  customer: CancellationCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  billTotal: string;
  noBillTotal: string;
  dutyAmount: string; // ค่าอากร - แยกต่างหาก ไม่รวมใน noBillTotal และไม่นับในยอดรวม
  returnedDate: string | null; // YYYY-MM-DD
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ แก้เองทีหลังได้เสมอ
  receiptAmount: string | null;
  createdAt: string;
  updatedAt: string; // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt
}

export interface CreateVehicleUseCancellationInput {
  vehicleClass: CancellationVehicleClass;
  customerId: string;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string;
}

export interface UpdateVehicleUseCancellationInput {
  customerId?: string;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string;
  returnedDate?: string;
  remark: string;
  expectedUpdatedAt: string;
}

export type CancellationStatusFilter = "pending" | "returned" | "all";

type One = { cancellation: VehicleUseCancellation };

export const vehicleUseCancelApi = {
  list: (status: CancellationStatusFilter, vehicleClass: CancellationVehicleClass, month?: string) =>
    request<{ cancellations: VehicleUseCancellation[] }>(
      `/api/vehicle-use-cancellations?status=${status}&vehicleClass=${vehicleClass}${month ? `&month=${month}` : ""}`,
    ),
  create: (data: CreateVehicleUseCancellationInput) =>
    request<One>("/api/vehicle-use-cancellations", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: UpdateVehicleUseCancellationInput) =>
    request<One>(`/api/vehicle-use-cancellations/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  addReceipt: (id: string, image: Blob, fileName: string, remark?: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    if (remark) form.append("remark", remark);
    return request<One>(`/api/vehicle-use-cancellations/${id}/receipts`, { method: "POST", body: form });
  },
  removeReceipt: (id: string, receiptId: string, remark?: string) =>
    request<One>(`/api/vehicle-use-cancellations/${id}/receipts/${receiptId}`, { method: "DELETE", body: JSON.stringify({ remark }) }),
  updateReceiptFields: (id: string, data: { receiptNo?: string; receiptDate?: string; receiptAmount?: string }, remark?: string) =>
    request<One>(`/api/vehicle-use-cancellations/${id}/receipt-fields`, { method: "PATCH", body: JSON.stringify({ ...data, remark }) }),
  markReturned: (id: string, returnedDate: string) =>
    request<One>(`/api/vehicle-use-cancellations/${id}/return`, { method: "PATCH", body: JSON.stringify({ returnedDate }) }),
  undoReturn: (id: string, remark: string) =>
    request<One>(`/api/vehicle-use-cancellations/${id}/undo-return`, { method: "POST", body: JSON.stringify({ remark }) }),
  cancel: (id: string, remark: string) =>
    request<{ id: string }>(`/api/vehicle-use-cancellations/${id}/cancel`, { method: "POST", body: JSON.stringify({ remark }) }),
};
