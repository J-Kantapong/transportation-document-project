import type { DocumentSubmissionOptionsDto } from './document-submission-options.dto.js';

export interface CreateDocumentSubmissionDto extends DocumentSubmissionOptionsDto {
  submitDate: unknown; // ค.ศ. YYYY-MM-DD
  plateCategory?: unknown;
  plateNumber?: unknown;
  // ประเภทเจ้าของรถ (INDIVIDUAL/JURISTIC) - ผู้ใช้เลือกแค่ประเภท ไม่ต้องจัดการ VehicleOwner รายชื่อเอง
  // DocumentSubmissionService.submit() จะ find-or-create VehicleOwner แบบไม่ระบุชื่อที่ตรงประเภทให้เอง
  // แล้วผูกกับ Vehicle.ownerId ก่อนคำนวณภาษี - undefined = ไม่แก้ไขเจ้าของรถเดิม (ใช้ตอนนำเข้าหลายคัน
  // พร้อมกัน ซึ่งไม่ทราบเจ้าของรถ)
  ownerType?: unknown;
}
