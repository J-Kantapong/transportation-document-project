import { request } from "@/lib/api";
import type { FeeItem, PlateSwapNumberSource } from "@/lib/plate-swap-fee";

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ดู backend/src/plate-swap/
// GET    /api/plate-swaps?status=pending|returned|all&month=YYYY-MM
// GET    /api/plate-swaps/vehicle-search?chassis=   ค้นรถใหม่ในฐานข้อมูลรถจดใหม่ (รถยนต์, สูงสุด 10 คัน)
// POST   /api/plate-swaps                           บันทึก/ยื่น
// PATCH  /api/plate-swaps/:id/new-vehicle {newVehicleId}   เปลี่ยนคันที่ลิงก์ (บังคับมีเสมอ ยกเลิกไม่ได้)
// PATCH  /api/plate-swaps/:id/new-plate {newPlateCategory,newPlateNumber}  กรอก/แก้ทะเบียนใหม่ทีหลัง (ตอนยื่นอาจยังไม่รู้)
// POST   /api/plate-swaps/:id/receipts (multipart: file)   แนบรูปใบเสร็จ
// DELETE /api/plate-swaps/:id/receipts/:receiptId
// PATCH  /api/plate-swaps/:id/return {returnedDate}  รับเอกสารกลับ (ต้องมีรูปใบเสร็จอย่างน้อย 1 รูป)
// DELETE /api/plate-swaps/:id                        ลบงานที่ยังไม่รับเอกสารกลับ
// ตัวรูปใบเสร็จโหลดผ่าน GET /api/receipts/:id/image (ต้องแนบ Authorization)

export interface PlateSwapNewVehicle {
  id: string;
  chassis: string;
  brandName: string;
  customerName: string;
  plateCategory: string | null;
  plateNumber: string | null;
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
  newPlateCategory: string | null; // ตอนยื่นอาจยังไม่รู้ - กรอกทีหลังได้
  newPlateNumber: string | null;
  newVehicle: PlateSwapNewVehicle | null;
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

export type PlateSwapStatusFilter = "pending" | "returned" | "all";

export const plateSwapApi = {
  list: (status: PlateSwapStatusFilter, month?: string) =>
    request<{ swaps: PlateSwap[] }>(`/api/plate-swaps?status=${status}${month ? `&month=${month}` : ""}`),
  searchNewVehicles: (chassis: string) =>
    request<{ vehicles: PlateSwapNewVehicle[] }>(`/api/plate-swaps/vehicle-search?chassis=${encodeURIComponent(chassis.trim())}`),
  create: (data: CreatePlateSwapInput) => request<{ swap: PlateSwap }>("/api/plate-swaps", { method: "POST", body: JSON.stringify(data) }),
  linkNewVehicle: (id: string, newVehicleId: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/new-vehicle`, { method: "PATCH", body: JSON.stringify({ newVehicleId }) }),
  addReceipt: (id: string, image: Blob, fileName: string) => {
    const form = new FormData();
    form.append("file", image, fileName);
    return request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/receipts`, { method: "POST", body: form });
  },
  removeReceipt: (id: string, receiptId: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/receipts/${receiptId}`, { method: "DELETE" }),
  setNewPlate: (id: string, newPlateCategory: string, newPlateNumber: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/new-plate`, {
      method: "PATCH",
      body: JSON.stringify({ newPlateCategory, newPlateNumber }),
    }),
  markReturned: (id: string, returnedDate: string, newPlateCategory?: string, newPlateNumber?: string) =>
    request<{ swap: PlateSwap }>(`/api/plate-swaps/${id}/return`, {
      method: "PATCH",
      body: JSON.stringify({ returnedDate, ...(newPlateCategory && newPlateNumber ? { newPlateCategory, newPlateNumber } : {}) }),
    }),
  remove: (id: string) => request<{ id: string }>(`/api/plate-swaps/${id}`, { method: "DELETE" }),
};
