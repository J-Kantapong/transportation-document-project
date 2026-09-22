import { request } from "@/lib/api";

// ค้นรูปของรถด้วยเลขตัวถัง - ดู backend/src/receiving/vehicle-photos.service.ts
// ตัวรูปโหลดด้วย receiptImageUrl / platePhotoImageUrl / bookPhotoImageUrl ใน lib/api.ts

export interface VehiclePhotoReceipt {
  id: string;
  createdAt: string;
  submitDate: string; // YYYY-MM-DD
  receiptNo: string | null;
  submissionStatus: string; // PENDING | RECEIPT_RECEIVED | FAILED
}

export interface VehiclePhotoSingle {
  id: string;
  createdAt: string;
  receivedDate: string | null; // YYYY-MM-DD
}

export interface VehiclePhotos {
  id: string;
  chassis: string;
  date: string;
  customerName: string;
  brandName: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  receipts: VehiclePhotoReceipt[];
  platePhoto: VehiclePhotoSingle | null;
  bookPhoto: VehiclePhotoSingle | null;
}

export const vehiclePhotosApi = {
  // GET /api/vehicles/receiving/photos?chassis= (contains, ไม่สนตัวพิมพ์, สูงสุด 10 คัน)
  search: (chassis: string) =>
    request<{ vehicles: VehiclePhotos[] }>(`/api/vehicles/receiving/photos?chassis=${encodeURIComponent(chassis.trim())}`),
};
