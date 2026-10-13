export interface CreateVehiclesDto {
  vehicles: unknown;
  // คำเตือนข้อมูลน่าจะคีย์ผิด (ผู้ใช้ 2026-10-13, ดู vehicle-data-check.ts): ไม่ส่ง = ตอบ 409 needsConfirm พร้อม warnings รายแถว
  // พนักงานตรวจกับเอกสารแล้วหน้าจอส่งซ้ำพร้อม key ของทุกคำเตือนที่เห็น (warnings[].warnings[].key)
  confirmedWarnings?: unknown;
}
