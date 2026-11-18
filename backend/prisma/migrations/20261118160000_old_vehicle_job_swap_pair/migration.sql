-- งานรถเก่า: สลับเลขแบบ รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า ตั้งแต่ตอนรับงาน (ผู้ใช้ 2026-11-18)
-- jobVariant = แบบย่อยของงานที่รู้ตั้งแต่รับงาน (ตอนนี้ใช้กับสลับเลข: OLD_NEW | OLD_OLD) / pairId = รหัสคู่ของสองคันที่สลับเลขกัน
-- เพิ่มคอลัมน์อย่างเดียว แถวเดิมเป็น null
ALTER TABLE "OldVehicleJob" ADD COLUMN "jobVariant" TEXT;
ALTER TABLE "OldVehicleJob" ADD COLUMN "pairId" TEXT;
CREATE INDEX "OldVehicleJob_pairId_idx" ON "OldVehicleJob"("pairId");
