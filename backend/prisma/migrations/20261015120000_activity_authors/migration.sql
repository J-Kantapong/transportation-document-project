-- ผู้ทำของงานที่ยังไม่เคยเก็บ (ผู้ใช้ 2026-10-15, หน้าภาพรวมการทำงาน) - เพิ่มคอลัมน์ว่างอย่างเดียว แถวเดิมเป็น NULL
ALTER TABLE "Vehicle" ADD COLUMN "plateReceivedById" TEXT;
ALTER TABLE "Vehicle" ADD COLUMN "bookReceivedById" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "createdById" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "paidById" TEXT;
ALTER TABLE "PlateSwap" ADD COLUMN "createdById" TEXT;
ALTER TABLE "TaxRenewal" ADD COLUMN "createdById" TEXT;
ALTER TABLE "YamahaRelocationEntry" ADD COLUMN "createdById" TEXT;
ALTER TABLE "VehicleTransfer" ADD COLUMN "createdById" TEXT;
ALTER TABLE "VehicleUseCancellation" ADD COLUMN "createdById" TEXT;
ALTER TABLE "PlateCopy" ADD COLUMN "createdById" TEXT;
ALTER TABLE "VehicleMoveOut" ADD COLUMN "createdById" TEXT;
