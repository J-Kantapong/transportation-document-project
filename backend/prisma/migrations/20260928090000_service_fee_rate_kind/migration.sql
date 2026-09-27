-- ผู้ใช้ 2026-09-28: แถวราคาแยกเป็นราคาหลัก (BASE) กับค่าเพิ่มขอใช้ = จดจังหวัดอื่น (OTHER_PROVINCE) / ด่วน (URGENT) - แถวเดิมทั้งหมดเป็นราคาหลัก
ALTER TABLE "ServiceFeeRate" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'BASE';
