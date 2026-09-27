export interface UpdateVehicleDto {
  date: unknown;
  customerId: unknown;
  chassis: unknown;
  engine: unknown;
  brandId: unknown;
  fuel: unknown;
  cc: unknown;
  weight: unknown;
  color: unknown;
  body: unknown;
  registrationProvince: unknown;
  ownerProvince: unknown;
  remark: unknown; // เหตุผลที่แก้ไข - บังคับกรอกทุกครั้ง
  // แก้ช่องที่ขั้นตอนถัดไปใช้ไปแล้ว (ผู้ใช้ 2026-09-27): ไม่ส่ง confirm = ตอบ 409 needsConfirm พร้อมขั้นตอนที่กระทบ
  // ผู้ใช้กดยืนยันแล้วหน้าจอส่งซ้ำพร้อม confirm: true และ confirmedSteps = confirmKey ของทุกคำเตือนที่เห็น (affected[].confirmKey)
  // (มีขั้นตอนเพิ่มจากที่เห็น เช่น มีคนยื่นเอกสารระหว่างนั้น หรือสถานะของขั้นตอนเดิมเปลี่ยน = เตือนใหม่อีกครั้ง)
  confirm?: unknown;
  confirmedSteps?: unknown;
}
