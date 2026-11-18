-- งานโอนแบบที่ 3: โอนย้ายเข้า (ผู้ใช้ 2026-11-18) - transferType = MOVE_IN (รถย้ายออกจากจังหวัดเดิมแล้ว มาย้ายเข้าพร้อมโอน ป้ายเปลี่ยนเป็นจังหวัดใหม่)
-- เพิ่มคอลัมน์อย่างเดียว งานเดิมไม่เปลี่ยน
ALTER TABLE "VehicleTransfer" ADD COLUMN "moveOutId" TEXT;
ALTER TABLE "VehicleTransfer" ADD COLUMN "newPlateCategory" TEXT;
ALTER TABLE "VehicleTransfer" ADD COLUMN "newPlateNumber" TEXT;
ALTER TABLE "VehicleTransfer" ADD COLUMN "stampDutyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0;
CREATE INDEX "VehicleTransfer_moveOutId_idx" ON "VehicleTransfer"("moveOutId");
