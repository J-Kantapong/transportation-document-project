-- รอบจ่ายตามวันในสัปดาห์ของลูกค้า (ผู้ใช้ 2026-10-31, SPI) - additive
ALTER TABLE "Customer" ADD COLUMN "billingPayWeekday" INTEGER;
ALTER TABLE "Customer" ADD COLUMN "billingPayWeeksAfter" INTEGER NOT NULL DEFAULT 1;
