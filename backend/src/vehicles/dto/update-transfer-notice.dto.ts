export interface UpdateTransferNoticeDto {
  done: unknown;
  completedDate: unknown; // บังคับเมื่อ done = true
  cost: unknown;
  // สถานะ transferDone ที่หน้าจอโหลดมา - ไม่ตรงกับในฐานข้อมูลแล้ว = มีคนบันทึกไปก่อน ตอบ 409 (ไม่ส่ง = ไม่ตรวจ)
  expectedTransferDone?: unknown;
  // ข้ามใบเสร็จแจ้งย้าย (ผู้ใช้ 2026-10-19): เหตุผลที่ไม่มีใบเสร็จ - ใช้ได้เฉพาะงานแจ้งย้ายที่ยังไม่มีใบเสร็จ
  waiveReceiptReason?: unknown;
}
