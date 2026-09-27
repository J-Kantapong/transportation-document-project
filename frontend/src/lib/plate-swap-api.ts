import { request } from "@/lib/api";
import type { FeeItem, PlateSwapNumberSource } from "@/lib/plate-swap-fee";

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ดู backend/src/plate-swap/
// GET    /api/plate-swaps?status=pending|returned|all&month=YYYY-MM   (งานที่ยกเลิกแล้วไม่แสดง)
// GET    /api/plate-swaps/vehicle-search?chassis=&excludeSwapId=      ค้นรถใหม่ (รถยนต์, สูงสุด 10 คัน) + เหตุผลที่ผูกไม่ได้
// POST   /api/plate-swaps                           บันทึก/ยื่น
// PATCH  /api/plate-swaps/:id {ข้อมูลรถเก่า, submitDate, numberSource, buy*, returnedDate?, remark, expectedUpdatedAt}  แก้งาน
//        (remark บังคับ / expectedUpdatedAt = updatedAt ที่โหลดมา ไม่ตรง = มีคนแก้ไปก่อน -> 409)
// PATCH  /api/plate-swaps/:id/new-vehicle {newVehicleId, remark?}   เปลี่ยนคันที่ลิงก์ (remark บังคับหลังรับกลับ)
// PATCH  /api/plate-swaps/:id/new-plate {newPlateCategory,newPlateNumber, remark?}  กรอก/แก้ทะเบียนใหม่ (remark บังคับหลังรับกลับ)
// POST   /api/plate-swaps/:id/receipts (multipart: file, remark?)   แนบรูปใบเสร็จ (remark บังคับหลังรับกลับ)
// DELETE /api/plate-swaps/:id/receipts/:receiptId {remark?}          (remark บังคับหลังรับกลับ และต้องเหลืออย่างน้อย 1 รูป)
// PATCH  /api/plate-swaps/:id/return {returnedDate}  รับเอกสารกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป, วันที่ไม่เกินวันนี้)
// POST   /api/plate-swaps/:id/undo-return {remark}   ยกเลิกการรับเอกสารกลับที่กดผิด
// POST   /api/plate-swaps/:id/cancel {remark}        ยกเลิกงาน (ไม่ลบแถว - ผู้ใช้ 2026-09-27 ไม่มีการลบงานแล้ว)
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)

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

export interface PlateSwap {
  id: string;
  kind: "OLD_NEW" | "OLD_OLD";
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
  createdAt: string;
  updatedAt: string; // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt
}

export interface CreatePlateSwapInput {
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

export type PlateSwapStatusFilter = "pending" | "returned" | "all";

export const plateSwapApi = {
  list: (status: PlateSwapStatusFilter, month?: string) =>
    request<{ swaps: PlateSwap[] }>(`/api/plate-swaps?status=${status}${month ? `&month=${month}` : ""}`),
  // excludeSwapId = งานที่กำลังเปลี่ยนคัน (รถที่ผูกกับงานนี้เองไม่นับว่าผูกซ้ำ)
  searchNewVehicles: (chassis: string, excludeSwapId?: string) =>
    request<{ vehicles: PlateSwapVehicleHit[] }>(
      `/api/plate-swaps/vehicle-search?chassis=${encodeURIComponent(chassis.trim())}${
        excludeSwapId ? `&excludeSwapId=${encodeURIComponent(excludeSwapId)}` : ""
      }`,
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
};
