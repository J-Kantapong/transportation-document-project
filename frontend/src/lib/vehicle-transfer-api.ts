import { request } from "@/lib/api";

// งานโอน (งานหลัก, ผู้ใช้ 2026-10-02) - ดู backend/src/vehicle-transfer/
// แบบงาน: OWNER = โอนตามผู้ถือกรรมสิทธิ์ (ไม่มีตรวจรถ) / INSPECTION = โอนตรวจรถ (ตรวจรถแยกจากคิวตรวจรถของรถจดใหม่)
// GET    /api/vehicle-transfers?status=all|pending|returned|to-send|to-result|inspected&month=YYYY-MM&transferType=&vehicleClass=
//        pending = รอรับเอกสารกลับ (โอนตรวจรถนับเมื่อตรวจผ่านแล้ว) / to-send, to-result, inspected = ขั้นตรวจรถ / งานที่ยกเลิกแล้วไม่แสดง
// POST   /api/vehicle-transfers   ยื่นงาน (transferType, vehicleClass, customerId = เจ้าของงาน, transferorName, transfereeName, ข้อมูลรถ, submitDate)
//        มอเตอร์ไซค์: ส่ง useRequest (โอนขอใช้) / urgent (ด่วน) / fineAmount (ค่าปรับ) - backend คิด Bill / No Bill / ค่าอากรตามอัตราเอง (vehicle-transfer-fee.ts)
//        รถยนต์: ส่ง billTotal ที่พนักงานกรอก (บังคับ, 0 ได้ - ยังไม่มีอัตรา Bill) + urgent / backend คิด No Bill (ลงขัน 100 + ด่วน 100) / ไม่รับยอด No Bill จากหน้าเว็บ
// PATCH  /api/vehicle-transfers/:id {…, remark, expectedUpdatedAt}  แก้งาน (remark บังคับ / expectedUpdatedAt ไม่ตรง = 409)
// PATCH  /api/vehicle-transfers/:id/inspection-sent {sentDate}                  (เฉพาะโอนตรวจรถ)
// PATCH  /api/vehicle-transfers/:id/inspection-result {result: PASS|FAIL, resultDate}
// POST   /api/vehicle-transfers/:id/inspection-undo {remark}  ถอยหนึ่งขั้น: ล้างผลตรวจ หรือถ้าไม่มีผลก็ล้างวันที่ส่งตรวจ
// POST   /api/vehicle-transfers/:id/receipts (multipart: file, remark?)  แนบรูปใบเสร็จ - อ่าน OCR เติมเลขที่/วันที่/ยอดเงินเมื่อช่องว่างทั้ง 3
//        (โอนตรวจรถแนบได้เมื่อตรวจผ่านแล้วเท่านั้น)
// DELETE /api/vehicle-transfers/:id/receipts/:receiptId {remark?}        (remark บังคับหลังรับกลับ และต้องเหลืออย่างน้อย 1 รูป)
// PATCH  /api/vehicle-transfers/:id/receipt-fields {receiptNo?, receiptDate?, receiptAmount?, remark?}
// PATCH  /api/vehicle-transfers/:id/return {returnedDate}  รับเอกสารกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป, วันที่ไม่เกินวันนี้)
// POST   /api/vehicle-transfers/:id/undo-return {remark}   ยกเลิกการรับเอกสารกลับที่กดผิด
// POST   /api/vehicle-transfers/:id/cancel {remark}        ยกเลิกงาน (ไม่ลบแถว)
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)

export type TransferType = "OWNER" | "INSPECTION";
export type TransferVehicleClass = "CAR" | "MOTO";
export type InspectionResult = "PASS" | "FAIL";

export interface TransferCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface VehicleTransfer {
  id: string;
  transferType: TransferType;
  vehicleClass: TransferVehicleClass;
  customer: TransferCustomer | null;
  transferorName: string; // ผู้ถือกรรมสิทธิ์ผู้โอน
  transfereeName: string; // ผู้รับโอน
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  billTotal: string;
  noBillTotal: string; // รวมค่าอากรแล้ว
  dutyAmount: string; // ค่าอากร - แยกแสดง ไม่นับในยอดรวม
  useRequest: boolean; // โอนขอใช้ (มอเตอร์ไซค์)
  urgent: boolean; // งานด่วน (มอเตอร์ไซค์)
  fineAmount: string; // ค่าปรับ (อยู่ใน billTotal แล้ว)
  inspectionSentDate: string | null;
  inspectionResult: InspectionResult | null;
  inspectionResultDate: string | null;
  returnedDate: string | null; // YYYY-MM-DD
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ แก้เองทีหลังได้เสมอ
  receiptAmount: string | null;
  createdAt: string;
  updatedAt: string; // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt
}

export interface CreateVehicleTransferInput {
  transferType: TransferType;
  vehicleClass: TransferVehicleClass;
  customerId: string;
  transferorName: string;
  transfereeName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string;
  // มอเตอร์ไซค์ส่ง useRequest / urgent / fineAmount รถยนต์ส่ง billTotal / urgent
  useRequest?: boolean;
  urgent?: boolean;
  fineAmount?: string;
  billTotal?: string;
}

export interface UpdateVehicleTransferInput {
  vehicleClass: TransferVehicleClass;
  customerId?: string;
  transferorName: string;
  transfereeName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string;
  useRequest?: boolean;
  urgent?: boolean;
  fineAmount?: string;
  billTotal?: string;
  returnedDate?: string;
  remark: string;
  expectedUpdatedAt: string;
}

export type TransferStatusFilter = "all" | "pending" | "returned" | "to-send" | "to-result" | "inspected";

type One = { transfer: VehicleTransfer };

export const vehicleTransferApi = {
  list: (status: TransferStatusFilter, transferType: TransferType, month?: string) =>
    request<{ transfers: VehicleTransfer[] }>(`/api/vehicle-transfers?status=${status}&transferType=${transferType}${month ? `&month=${month}` : ""}`),
  create: (data: CreateVehicleTransferInput) => request<One>("/api/vehicle-transfers", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: UpdateVehicleTransferInput) =>
    request<One>(`/api/vehicle-transfers/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  markInspectionSent: (id: string, sentDate: string) =>
    request<One>(`/api/vehicle-transfers/${id}/inspection-sent`, { method: "PATCH", body: JSON.stringify({ sentDate }) }),
  recordInspectionResult: (id: string, result: InspectionResult, resultDate: string) =>
    request<One>(`/api/vehicle-transfers/${id}/inspection-result`, { method: "PATCH", body: JSON.stringify({ result, resultDate }) }),
  undoInspection: (id: string, remark: string) =>
    request<One>(`/api/vehicle-transfers/${id}/inspection-undo`, { method: "POST", body: JSON.stringify({ remark }) }),
  addReceipt: (id: string, image: Blob, fileName: string, remark?: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    if (remark) form.append("remark", remark);
    return request<One>(`/api/vehicle-transfers/${id}/receipts`, { method: "POST", body: form });
  },
  removeReceipt: (id: string, receiptId: string, remark?: string) =>
    request<One>(`/api/vehicle-transfers/${id}/receipts/${receiptId}`, { method: "DELETE", body: JSON.stringify({ remark }) }),
  updateReceiptFields: (id: string, data: { receiptNo?: string; receiptDate?: string; receiptAmount?: string }, remark?: string) =>
    request<One>(`/api/vehicle-transfers/${id}/receipt-fields`, { method: "PATCH", body: JSON.stringify({ ...data, remark }) }),
  markReturned: (id: string, returnedDate: string) =>
    request<One>(`/api/vehicle-transfers/${id}/return`, { method: "PATCH", body: JSON.stringify({ returnedDate }) }),
  undoReturn: (id: string, remark: string) =>
    request<One>(`/api/vehicle-transfers/${id}/undo-return`, { method: "POST", body: JSON.stringify({ remark }) }),
  cancel: (id: string, remark: string) =>
    request<{ id: string }>(`/api/vehicle-transfers/${id}/cancel`, { method: "POST", body: JSON.stringify({ remark }) }),
};

// ใช้ได้ทั้งฝั่ง server component (เมนู) และ client component (หน้างาน)
export const TRANSFER_TYPE_LABEL: Record<TransferType, string> = { OWNER: "โอนตามผู้ถือกรรมสิทธิ์", INSPECTION: "โอนตรวจรถ" };
const TRANSFER_TYPE_SEGMENT: Record<TransferType, string> = { OWNER: "owner", INSPECTION: "inspection" };
export const transferHome = (transferType: TransferType) => `/registration/transfer/${TRANSFER_TYPE_SEGMENT[transferType]}`;
