import type { DocumentSubmissionOptionsDto } from './document-submission-options.dto.js';

export interface CreateDocumentSubmissionDto extends DocumentSubmissionOptionsDto {
  submitDate: unknown; // ค.ศ. YYYY-MM-DD
  plateCategory?: unknown;
  plateNumber?: unknown;
  // ประเภทเจ้าของรถ (INDIVIDUAL/JURISTIC) ของรถที่ยังไม่มีเจ้าของ - ผู้ใช้เลือกแค่ประเภท ไม่ต้องจัดการ VehicleOwner รายชื่อเอง
  // DocumentSubmissionService.submit() สร้าง VehicleOwner แบบไม่ระบุชื่อแล้วผูกกับ Vehicle.ownerId ก่อนคำนวณภาษี
  // รถที่มีเจ้าของแล้วใช้ของเดิมเสมอ (ส่งมาคนละประเภท = 400 ให้โหลดใหม่ - พบ 2026-09-27) undefined = ใช้เจ้าของรถเดิม
  ownerType?: unknown;
}
