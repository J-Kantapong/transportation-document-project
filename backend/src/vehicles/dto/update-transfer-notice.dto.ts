export interface UpdateTransferNoticeDto {
  done: unknown;
  completedDate: unknown; // บังคับเมื่อ done = true
  cost: unknown;
  // สถานะ transferDone ที่หน้าจอโหลดมา - ไม่ตรงกับในฐานข้อมูลแล้ว = มีคนบันทึกไปก่อน ตอบ 409 (ไม่ส่ง = ไม่ตรวจ)
  expectedTransferDone?: unknown;
}
