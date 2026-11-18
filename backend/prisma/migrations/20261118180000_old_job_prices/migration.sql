-- ราคางานรถเก่าที่ผู้ใช้ให้ 2026-11-18 (เพิ่มคอลัมน์อย่างเดียว ไม่ลบอะไร)

-- โอนย้ายเข้า รถยนต์: ลงขันรายจังหวัดของรถยนต์ · กรุงเทพฯ 100 ทั้งรถยนต์และมอเตอร์ไซค์ (ช่องมอเตอร์ไซค์ที่ตั้งไว้แล้วไม่ทับ)
ALTER TABLE "TransferContributionRate" ADD COLUMN "moveInCar" DECIMAL(10,2);
INSERT INTO "TransferContributionRate" ("id", "province", "moveInMoto", "moveInCar", "updatedAt")
VALUES (gen_random_uuid()::text, 'กรุงเทพมหานคร', 100, 100, CURRENT_TIMESTAMP)
ON CONFLICT ("province") DO UPDATE
SET "moveInCar" = 100, "moveInMoto" = COALESCE("TransferContributionRate"."moveInMoto", 100), "updatedAt" = CURRENT_TIMESTAMP;

-- ยกเลิกการใช้รถ: งานด่วน (ลงขันด่วนเพิ่ม รถยนต์ 100 / มอเตอร์ไซค์ 50 อยู่ใน noBillTotal)
ALTER TABLE "VehicleUseCancellation" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;

-- สลับเลข รถยนต์: ลงขัน 200 เดิม "รวมด่วนแล้ว" (ผู้ใช้) -> อัตราใหม่ ลงขัน 100 + ลงขันด่วนเพิ่ม 100
-- งานรถยนต์ที่มีอยู่จึงเป็นงานด่วนทั้งหมด: ตั้งธง urgent ให้ตรง (ยอดและรายการ snapshot ไม่แตะ) แก้งานทีหลังยอดจะคิดได้ 200 เท่าเดิม
UPDATE "PlateSwap" SET "urgent" = true WHERE "vehicleClass" = 'CAR' AND "urgent" = false;
