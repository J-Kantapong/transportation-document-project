import { request } from "@/lib/api";
import type { FeeItem, PlateSwapNumberSource } from "@/lib/plate-swap-fee";

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ดู backend/src/plate-swap/
// GET    /api/plate-swaps?status=pending|returned|all&month=YYYY-MM   (งานที่ยกเลิกแล้วไม่แสดง)
// GET    /api/plate-swaps/vehicle-search?chassis=&excludeSwapId=      ค้นรถใหม่ (รถยนต์, สูงสุด 10 คัน) + เหตุผลที่ผูกไม่ได้
// POST   /api/plate-swaps                           บันทึก/ยื่น (customerId = เจ้าของงาน บังคับตั้งแต่ 2026-09-28)
// PATCH  /api/plate-swaps/:id {customerId?, ข้อมูลรถเก่า, submitDate, numberSource, buy*, returnedDate?, remark, expectedUpdatedAt}  แก้งาน
//        (remark บังคับ / expectedUpdatedAt = updatedAt ที่โหลดมา ไม่ตรง = มีคนแก้ไปก่อน -> 409)
// PATCH  /api/plate-swaps/:id/new-vehicle {newVehicleId, remark?}   เปลี่ยนคันที่ลิงก์ (remark บังคับหลังรับกลับ)
// PATCH  /api/plate-swaps/:id/new-plate {newPlateCategory,newPlateNumber, remark?}  กรอก/แก้ทะเบียนใหม่ (remark บังคับหลังรับกลับ)
// POST   /api/plate-swaps/:id/receipts (multipart: file, remark?)   แนบรูปใบเสร็จ - อ่าน OCR จริงเหมือน Step 5 (ผู้ใช้ 2026-09-28)
//        เติมเลขที่ใบเสร็จ/วันที่/ยอดเงินอัตโนมัติเมื่อช่องยังว่างทั้ง 3 (remark บังคับหลังรับกลับ)
// DELETE /api/plate-swaps/:id/receipts/:receiptId {remark?}          (remark บังคับหลังรับกลับ และต้องเหลืออย่างน้อย 1 รูป)
// PATCH  /api/plate-swaps/:id/receipt-fields {receiptNo?,receiptDate?,receiptAmount?, remark?}  แก้/กรอกเองข้อมูลใบเสร็จ (remark บังคับหลังรับกลับ)
// PATCH  /api/plate-swaps/:id/return {returnedDate}  รับเอกสารกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป, วันที่ไม่เกินวันนี้)
// POST   /api/plate-swaps/:id/undo-return {remark}   ยกเลิกการรับเอกสารกลับที่กดผิด
// POST   /api/plate-swaps/:id/cancel {remark}        ยกเลิกงาน (ไม่ลบแถว - ผู้ใช้ 2026-09-27 ไม่มีการลบงานแล้ว)
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)
//
// รับป้าย/รับเล่ม (ไม่ใช้ AI เหมือน Step 6/7 ปัจจุบัน - ผู้ใช้ 2026-09-28) เฉพาะฝั่งรถเก่าของงานเอง ไม่ผูกกับ returnedDate/gating ใดๆ:
// GET    /api/plate-swaps/plate-queue?status=pending|received|all
// GET    /api/plate-swaps/book-queue?status=pending|received|all
// POST   /api/plate-swaps/:id/plate-photo (multipart: file, date)   แนบรูปป้าย -> บันทึกรับทันที
// PATCH  /api/plate-swaps/:id/plate-photo/date {date, remark}       แก้วันที่รับป้าย
// POST   /api/plate-swaps/:id/plate-photo/detach {remark}           ถอดรูปป้ายที่แนบผิด
// GET    /api/plate-swaps/:id/plate-photo/image                     โหลดรูปป้าย (ต้องแนบ Authorization)
// เหมือนกันทั้งชุดสำหรับ book-photo (รับเล่ม)

// เจ้าของงาน = ลูกค้าที่ส่งงานมาให้เรา (ผู้ใช้ 2026-09-28: ไว้ส่งงาน/วางบิลให้ถูกเจ้าของ)
// คนละคนกับ oldOwnerName ซึ่งเป็นเจ้าของรถเก่าตามทะเบียน - ห้ามอนุมานจากกัน
export interface PlateSwapCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface PlateSwapNewVehicle {
  id: string;
  chassis: string;
  brandName: string;
  customerName: string;
  plateCategory: string | null;
  plateNumber: string | null;
  // รายการยื่นเอกสารที่ยังมีผลล่าสุด - null = ยังไม่ยื่น / ยื่นไม่ผ่าน / ยกเลิกการยื่น (บอกที่แก้ทะเบียนที่เติมผิดฝั่ง - พบ 2026-09-27)
  activeSubmissionStatus: "PENDING" | "RECEIPT_RECEIVED" | null;
}

// ผลค้นรถใหม่ - linkBlockedReason ไม่ว่าง = ผูกไม่ได้ (ยื่นเอกสารแล้ว / ผูกกับงานอื่นที่ยังเปิดอยู่ - ผู้ใช้ 2026-09-27)
export interface PlateSwapVehicleHit extends PlateSwapNewVehicle {
  linkBlockedReason: string | null;
}

export type PlateSwapKind = "OLD_NEW" | "OLD_OLD";
// ประเภทรถของงาน (ผู้ใช้ให้อัตรามอเตอร์ไซค์ 2026-09-28) - ระบบเดียวกับรถยนต์ แยกด้วยค่านี้
export type PlateSwapVehicleClass = "CAR" | "MOTO";

export interface PlateSwap {
  id: string;
  kind: PlateSwapKind;
  vehicleClass: PlateSwapVehicleClass;
  urgent: boolean; // งานด่วน +50 (No Bill) - มีเฉพาะมอเตอร์ไซค์
  // งานคู่ของเคสรถเก่า-รถเก่า (ผู้ใช้ 2026-09-28: กรอกหน้าเดียว 2 คัน แต่ "แยกเป็น 2 งานในระบบ")
  // null = งาน OLD_NEW ซึ่งไม่มีคู่
  pairId: string | null;
  customer: PlateSwapCustomer | null; // null = งานที่บันทึกก่อน 2026-09-28 (งานใหม่บังคับเลือก)
  oldOwnerName: string;
  oldEngine: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string | null; // ทะเบียนที่รถเก่าได้รับ - ตอนยื่นอาจยังไม่รู้ กรอกทีหลังได้
  newPlateNumber: string | null;
  newVehicle: PlateSwapNewVehicle | null;
  // รถใหม่ถูกบันทึกทะเบียนเป็นทะเบียนใหม่ของรถเก่า (ขั้นยื่นเอกสารเคยเติมผิดฝั่งก่อน 2026-09-27) - รถใหม่ต้องได้ทะเบียนเก่า
  linkedPlateIsNewPlate: boolean;
  submitDate: string; // YYYY-MM-DD
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: string;
  noBillTotal: string;
  returnedDate: string | null; // YYYY-MM-DD
  receipts: { id: string; createdAt: string }[];
  // แยกขั้นรับเอกสารกลับเป็น 3 ขั้น (ผู้ใช้ 2026-09-28) - เฉพาะฝั่งรถเก่าของงานนี้เอง ไม่ผูกกับ returnedDate/กฎใดๆ
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ (ช่องยังว่างทั้ง 3) แก้เองทีหลังได้เสมอ
  receiptAmount: string | null;
  plateReceivedDate: string | null; // YYYY-MM-DD
  platePhotoId: string | null; // ดูรูปที่ plateSwapPlatePhotoImageUrl(id)
  bookReceivedDate: string | null; // YYYY-MM-DD
  bookPhotoId: string | null; // ดูรูปที่ plateSwapBookPhotoImageUrl(id)
  createdAt: string;
  updatedAt: string; // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt
}

export interface CreatePlateSwapInput {
  vehicleClass?: PlateSwapVehicleClass; // ไม่ส่ง = CAR
  urgent?: boolean; // งานด่วน (มอเตอร์ไซค์)
  customerId: string; // เจ้าของงาน (บังคับตั้งแต่ 2026-09-28)
  oldOwnerName: string;
  oldEngine: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string; // ทะเบียนใหม่ยังไม่รู้ส่งว่างทั้งคู่ได้ backend เก็บเป็น null
  newPlateNumber: string;
  newVehicleId: string; // บังคับลิงก์ตั้งแต่ตอนยื่น (ผู้ใช้ 2026-09-22)
  submitDate: string;
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
}

// แก้งาน (ผู้ใช้ 2026-09-27) - ส่งเฉพาะช่องที่แก้ได้ทั้งหมดก็ได้ backend บันทึกเฉพาะช่องที่เปลี่ยน / returnedDate เฉพาะงานที่รับกลับแล้ว
export interface UpdatePlateSwapInput {
  urgent?: boolean; // งานด่วน (มอเตอร์ไซค์) - เปลี่ยนแล้วคิดค่าใช้จ่ายใหม่
  customerId?: string; // เปลี่ยนเจ้าของงาน - ไม่ส่ง = ไม่แก้ (ล้างให้ว่างไม่ได้)
  oldOwnerName: string;
  oldEngine: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  submitDate: string;
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
  returnedDate?: string;
  remark: string;
  expectedUpdatedAt: string; // updatedAt ของงานตอนเปิดฟอร์ม - มีคนแก้/รับกลับไปก่อน backend ตอบ 409 (พบ 2026-09-27)
}

// รถ 1 คันในเคส "รถเก่า กับ รถเก่า" - ไม่มีทะเบียนใหม่เพราะระบบเติมให้เองจากทะเบียนของอีกคัน
export interface PlateSwapPairCarInput {
  oldOwnerName: string;
  oldEngine: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
}

export interface CreatePlateSwapPairInput {
  vehicleClass?: PlateSwapVehicleClass;
  urgent?: boolean;
  customerId: string;
  submitDate: string;
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
  carA: PlateSwapPairCarInput;
  carB: PlateSwapPairCarInput;
}

export type PlateSwapStatusFilter = "pending" | "returned" | "all";

// ไม่ส่ง kind = OLD_NEW (หน้าเดิมไม่ต้องแก้) - งานคนละเคสไม่ปนกันในรายการ/คิว
const kindQuery = (kind?: PlateSwapKind) => (kind ? `&kind=${kind}` : "");
// ไม่ส่ง = CAR (หน้าเดิมไม่ต้องแก้) - งานรถยนต์กับมอเตอร์ไซค์แยกรายการกันคนละชุด
const classQuery = (c?: PlateSwapVehicleClass) => (c ? `&vehicleClass=${c}` : "");

export const plateSwapApi = {
  list: (status: PlateSwapStatusFilter, month?: string, kind?: PlateSwapKind, vehicleClass?: PlateSwapVehicleClass) =>
    request<{ swaps: PlateSwap[] }>(`/api/plate-swaps?status=${status}${month ? `&month=${month}` : ""}${kindQuery(kind)}${classQuery(vehicleClass)}`),
  // ยื่นงาน "รถเก่า กับ รถเก่า" - ส่ง 2 คันในคำขอเดียว ได้กลับมา 2 งานที่ผูกกัน
  createPair: (data: CreatePlateSwapPairInput) =>
    request<{ swaps: PlateSwap[] }>("/api/plate-swaps/pair", { method: "POST", body: JSON.stringify(data) }),
  // excludeSwapId = งานที่กำลังเปลี่ยนคัน (รถที่ผูกกับงานนี้เองไม่นับว่าผูกซ้ำ)
  searchNewVehicles: (chassis: string, excludeSwapId?: string, vehicleClass?: PlateSwapVehicleClass) =>
    request<{ vehicles: PlateSwapVehicleHit[] }>(
      `/api/plate-swaps/vehicle-search?chassis=${encodeURIComponent(chassis.trim())}${
        excludeSwapId ? `&excludeSwapId=${encodeURIComponent(excludeSwapId)}` : ""
      }${classQuery(vehicleClass)}`,
    ),
  create: (data: CreatePlateSwapInput) => request<{ swap: PlateSwap }>("/api/plate-swaps", { method: "POST", body: JSON.stringify(data) }),
  update: (id: string, data: UpdatePlateSwapInput) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
  linkNewVehicle: (id: string, newVehicleId: string, remark?: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/new-vehicle`, { method: "PATCH", body: JSON.stringify({ newVehicleId, remark }) }),
  addReceipt: (id: string, image: Blob, fileName: string, remark?: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    if (remark) form.append("remark", remark);
    return request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/receipts`, { method: "POST", body: form });
  },
  removeReceipt: (id: string, receiptId: string, remark?: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/receipts/${receiptId}`, { method: "DELETE", body: JSON.stringify({ remark }) }),
  setNewPlate: (id: string, newPlateCategory: string, newPlateNumber: string, remark?: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/new-plate`, {
      method: "PATCH",
      body: JSON.stringify({ newPlateCategory, newPlateNumber, remark }),
    }),
  markReturned: (id: string, returnedDate: string, newPlateCategory?: string, newPlateNumber?: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/return`, {
      method: "PATCH",
      body: JSON.stringify({ returnedDate, ...(newPlateCategory && newPlateNumber ? { newPlateCategory, newPlateNumber } : {}) }),
    }),
  undoReturn: (id: string, remark: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/undo-return`, { method: "POST", body: JSON.stringify({ remark }) }),
  cancel: (id: string, remark: string) => request<{ id: string }>(`/api/plate-swaps/${id}/cancel`, { method: "POST", body: JSON.stringify({ remark }) }),
  // แก้/กรอกเองเลขที่ใบเสร็จ/วันที่/ยอดเงิน (remark บังคับหลังรับเอกสารกลับ)
  updateReceiptFields: (id: string, data: { receiptNo?: string; receiptDate?: string; receiptAmount?: string }, remark?: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/receipt-fields`, { method: "PATCH", body: JSON.stringify({ ...data, remark }) }),

  // รับป้าย/รับเล่ม (ไม่ใช้ AI - ผู้ใช้ 2026-09-28) - เฉพาะฝั่งรถเก่าของงานเอง ไม่ผูกกับ returnedDate/gating ใดๆ
  plateQueue: (status: "pending" | "received" | "all", kind?: PlateSwapKind, vehicleClass?: PlateSwapVehicleClass) =>
    request<{ swaps: PlateSwap[] }>(`/api/plate-swaps/plate-queue?status=${status}${kindQuery(kind)}${classQuery(vehicleClass)}`),
  bookQueue: (status: "pending" | "received" | "all", kind?: PlateSwapKind, vehicleClass?: PlateSwapVehicleClass) =>
    request<{ swaps: PlateSwap[] }>(`/api/plate-swaps/book-queue?status=${status}${kindQuery(kind)}${classQuery(vehicleClass)}`),
  attachPlatePhoto: (id: string, image: Blob, fileName: string, date: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    form.append("date", date);
    return request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/plate-photo`, { method: "POST", body: form });
  },
  updatePlateReceivedDate: (id: string, date: string, remark: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/plate-photo/date`, { method: "PATCH", body: JSON.stringify({ date, remark }) }),
  detachPlatePhoto: (id: string, remark: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/plate-photo/detach`, { method: "POST", body: JSON.stringify({ remark }) }),
  attachBookPhoto: (id: string, image: Blob, fileName: string, date: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    form.append("date", date);
    return request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/book-photo`, { method: "POST", body: form });
  },
  updateBookReceivedDate: (id: string, date: string, remark: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/book-photo/date`, { method: "PATCH", body: JSON.stringify({ date, remark }) }),
  detachBookPhoto: (id: string, remark: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/book-photo/detach`, { method: "POST", body: JSON.stringify({ remark }) }),
};
