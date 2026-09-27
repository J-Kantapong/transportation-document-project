// แก้รายการแจ้งย้ายยามาฮ่าที่บันทึกผิด (ผู้ใช้ 2026-09-27) - JSON ธรรมดา ทุกช่องมาจากคำขอที่ยังไม่ตรวจจึงเป็น unknown
// ช่องที่ไม่ส่งมา (undefined) = ไม่แก้ / remark บังคับทุกครั้ง (บันทึกลง AuditLog)
// ไฟล์แนบแก้ที่นี่ไม่ได้ - แนบไฟล์ผิดให้ยกเลิกรายการ (ไฟล์เดิมแนบใหม่ได้) แล้วบันทึกใหม่
// expected* = ค่าที่หน้าเว็บโหลดมาตอนเปิดฟอร์ม (ตารางนี้ไม่มี updatedAt) - ไม่ตรงกับในระบบ = มีคนแก้ไปก่อน -> 409 (พบ 2026-09-27)
export interface UpdateYamahaRelocationEntryDto {
  date?: unknown;
  size?: unknown;
  count?: unknown;
  remark?: unknown;
  expectedDate?: unknown; // YYYY-MM-DD
  expectedSize?: unknown; // SMALL | LARGE
  expectedCount?: unknown;
}
