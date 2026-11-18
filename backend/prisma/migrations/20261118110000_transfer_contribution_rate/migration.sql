-- ลงขันงานโอนรายจังหวัด (ผู้ใช้ 2026-11-18: "โหลดจังหวัดทั่วประเทศ ... ค่าลงขันทำช่องไว้กรอกทีหลัง")
-- 1 แถว = 1 จังหวัด ช่องว่าง (NULL) = ยังไม่ได้ตั้งอัตรา · จังหวัดที่ยังไม่มีแถว = ยังไม่ได้ตั้งทั้งสามช่อง (หน้าจอแสดงครบ 77 จังหวัดเสมอ)
-- แทนอัตราที่เคยเขียนตายตัวในโค้ด: กรุงเทพฯ มอเตอร์ไซค์ 60 / รถยนต์ 100 · สมุทรปราการ มอเตอร์ไซค์ 100 / รถยนต์ 100
CREATE TABLE "TransferContributionRate" (
    "id" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "transferMoto" DECIMAL(10,2),
    "transferCar" DECIMAL(10,2),
    "moveInMoto" DECIMAL(10,2),
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "TransferContributionRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TransferContributionRate_province_key" ON "TransferContributionRate"("province");

INSERT INTO "TransferContributionRate" ("id", "province", "transferMoto", "transferCar", "updatedAt") VALUES
  (gen_random_uuid()::text, 'กรุงเทพมหานคร', 60, 100, CURRENT_TIMESTAMP),
  (gen_random_uuid()::text, 'สมุทรปราการ', 100, 100, CURRENT_TIMESTAMP);
