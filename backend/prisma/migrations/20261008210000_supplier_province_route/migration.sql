-- ส่งซับจดทะเบียนต่างจังหวัด (ผู้ใช้ 2026-10-08) - เพิ่มอย่างเดียว ไม่แก้/ลบข้อมูลเดิม
-- 1) รายการยื่นที่เป็นการส่งงานให้ซับ
ALTER TABLE "DocumentSubmission" ADD COLUMN "viaSupplier" BOOLEAN NOT NULL DEFAULT false;

-- 2) ตารางราคาซับต่อจังหวัด
CREATE TABLE "SupplierProvinceRate" (
    "id" TEXT NOT NULL,
    "province" TEXT NOT NULL,
    "accepts" BOOLEAN NOT NULL DEFAULT true,
    "serviceFee" DECIMAL(10,2),
    "channelFee" DECIMAL(10,2),
    "inspectionFee" DECIMAL(10,2),
    "plateSwapFee" DECIMAL(10,2),
    "plateSwapNote" TEXT,
    "note" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedById" TEXT,

    CONSTRAINT "SupplierProvinceRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SupplierProvinceRate_province_key" ON "SupplierProvinceRate"("province");

-- ราคาตั้งต้นจากตารางของซับที่ผู้ใช้ส่งให้ 2026-10-06 (76 จังหวัด ไม่มีกรุงเทพฯ) - พะเยา/แม่ฮ่องสอน ซับไม่รับ
-- คอลัมน์: จังหวัด, รับ, ค่าดำเนินการ, ค่าช่อง, นำรถเข้าตรวจสภาพ, สลับป้าย, หมายเหตุสลับป้าย
INSERT INTO "SupplierProvinceRate" ("id", "province", "accepts", "serviceFee", "channelFee", "inspectionFee", "plateSwapFee", "plateSwapNote", "updatedAt")
SELECT gen_random_uuid()::text, v."province", v."accepts", v."serviceFee", v."channelFee", v."inspectionFee", v."plateSwapFee", v."plateSwapNote", CURRENT_TIMESTAMP
FROM (VALUES
  ('กระบี่', true, 1000, 300, 300, NULL, NULL),
  ('กาญจนบุรี', true, 1000, 200, 300, NULL, NULL),
  ('กาฬสินธุ์', true, 1000, 200, 200, NULL, NULL),
  ('กำแพงเพชร', true, 1000, 300, 300, NULL, NULL),
  ('ขอนแก่น', true, 1000, 500, 300, NULL, 'ไม่รับ'),
  ('จันทบุรี', true, 1000, 200, 300, NULL, NULL),
  ('ฉะเชิงเทรา', true, 1000, 300, 200, NULL, NULL),
  ('ชลบุรี', true, 1000, 200, 300, 500, 'จดพร้อมสลับ'),
  ('ชัยนาท', true, 1000, 300, 200, NULL, NULL),
  ('ชัยภูมิ', true, 1000, 300, 300, NULL, NULL),
  ('ชุมพร', true, 1000, 300, 300, NULL, NULL),
  ('เชียงราย', true, 1000, 200, 200, NULL, NULL),
  ('เชียงใหม่', true, 1000, 300, 200, NULL, 'จดพร้อมสลับ'),
  ('ตรัง', true, 1000, 300, 200, NULL, NULL),
  ('ตราด', true, 1000, 500, 200, NULL, NULL),
  ('ตาก', true, 1000, 300, 300, NULL, NULL),
  ('นครนายก', true, 1000, 200, 200, NULL, NULL),
  ('นครปฐม', true, 1000, 200, 200, 500, 'จดพร้อมสลับ'),
  ('นครพนม', true, 1000, 200, 200, NULL, NULL),
  ('นครราชสีมา', true, 1000, 200, 200, NULL, NULL),
  ('นครศรีธรรมราช', true, 1000, 200, 300, NULL, NULL),
  ('นครสวรรค์', true, 1000, 300, 200, NULL, NULL),
  ('นนทบุรี', true, 1000, 300, 200, 500, 'จดพร้อมสลับ'),
  ('นราธิวาส', true, 1200, 500, 200, NULL, NULL),
  ('น่าน', true, 1000, 300, 300, NULL, NULL),
  ('บึงกาฬ', true, 1000, 200, 200, NULL, NULL),
  ('ลพบุรี', true, 1000, 200, 300, NULL, 'จดพร้อมสลับ'),
  ('บุรีรัมย์', true, 1000, 200, 300, NULL, NULL),
  ('ปทุมธานี', true, 1000, 200, 200, NULL, 'ไม่รับ'),
  ('ประจวบคีรีขันธ์', true, 1000, 300, 200, NULL, NULL),
  ('ปราจีนบุรี', true, 1000, 200, 200, NULL, NULL),
  ('ปัตตานี', true, 1200, 500, 200, NULL, NULL),
  ('พระนครศรีอยุธยา', true, 1000, 200, 200, NULL, NULL),
  ('พะเยา', false, NULL, NULL, NULL, NULL, NULL),
  ('พังงา', true, 1000, 300, 300, NULL, NULL),
  ('พัทลุง', true, 1000, 300, 200, NULL, NULL),
  ('พิจิตร', true, 1000, 300, 300, NULL, NULL),
  ('พิษณุโลก', true, 1000, 200, 300, NULL, NULL),
  ('เพชรบุรี', true, 1000, 200, 200, NULL, NULL),
  ('เพชรบูรณ์', true, 1000, 300, 300, NULL, NULL),
  ('แพร่', true, 1000, 300, 300, NULL, NULL),
  ('ภูเก็ต', true, 1000, 300, 300, NULL, NULL),
  ('มหาสารคาม', true, 1000, 200, 200, NULL, NULL),
  ('มุกดาหาร', true, 1000, 200, 200, NULL, NULL),
  ('แม่ฮ่องสอน', false, NULL, NULL, NULL, NULL, NULL),
  ('ยโสธร', true, 1000, 200, 200, NULL, NULL),
  ('ยะลา', true, 1200, 500, 200, 1000, 'จดก่อนสลับ'),
  ('ร้อยเอ็ด', true, 1000, 200, 200, NULL, NULL),
  ('ระนอง', true, 1000, 300, 300, NULL, NULL),
  ('ระยอง', true, 1000, 200, 300, NULL, 'จดพร้อมสลับ'),
  ('ราชบุรี', true, 1000, 200, 300, 700, 'จดก่อน สลับ'),
  ('ลำปาง', true, 1000, 300, 200, NULL, NULL),
  ('ลำพูน', true, 1000, 300, 200, NULL, NULL),
  ('เลย', true, 1000, 200, 200, NULL, NULL),
  ('ศรีสะเกษ', true, 1000, 200, 200, NULL, NULL),
  ('สกลนคร', true, 1000, 200, 200, NULL, 'จดพร้อมสลับ'),
  ('สงขลา', true, 1000, 300, 200, 600, 'จดก่อน สลับ'),
  ('สตูล', true, 1000, 200, 300, NULL, NULL),
  ('สมุทรปราการ', true, 1000, 200, 200, NULL, 'จดพร้อมสลับ'),
  ('สมุทรสงคราม', true, 1000, 300, 300, NULL, NULL),
  ('สมุทรสาคร', true, 1000, 200, 200, NULL, NULL),
  ('สระแก้ว', true, 1000, 200, 200, NULL, NULL),
  ('สระบุรี', true, 1000, 300, 200, NULL, 'จดพร้อมสลับ'),
  ('สิงห์บุรี', true, 1000, 300, 200, NULL, NULL),
  ('สุโขทัย', true, 1000, 300, 300, NULL, NULL),
  ('สุพรรณบุรี', true, 1000, 200, 200, NULL, 'จดพร้อมสลับ'),
  ('สุราษฎร์ธานี', true, 1000, 200, 200, NULL, 'จดพร้อมสลับ'),
  ('สุรินทร์', true, 1000, 200, 300, NULL, NULL),
  ('หนองคาย', true, 1000, 300, 200, NULL, NULL),
  ('หนองบัวลำภู', true, 1000, 200, 200, NULL, NULL),
  ('อ่างทอง', true, 1000, 300, 200, NULL, NULL),
  ('อำนาจเจริญ', true, 1000, 200, 200, NULL, NULL),
  ('อุดรธานี', true, 1000, 300, 200, 300, 'จดพร้อมสลับ'),
  ('อุตรดิตถ์', true, 1000, 300, 300, NULL, NULL),
  ('อุทัยธานี', true, 1000, 200, 200, NULL, NULL),
  ('อุบลราชธานี', true, 1000, 200, 200, NULL, NULL)
) AS v("province", "accepts", "serviceFee", "channelFee", "inspectionFee", "plateSwapFee", "plateSwapNote")
ON CONFLICT ("province") DO NOTHING;

-- 3) ค่าตรวจรถสมุทรปราการ (ออฟฟิศจดเอง): รถจักรยานยนต์ 200 บาท - ผู้ใช้ให้ราคา 2026-10-08
-- (จักรยานยนต์สาธารณะ 300 บาท ยังใส่ไม่ได้ เพราะยังไม่มีประเภทรถนี้ใน 13 ประเภท)
INSERT INTO "FeeInspectionProvince" ("id", "province", "vehicleType", "amount")
SELECT gen_random_uuid()::text, 'สมุทรปราการ', t, 200
FROM (VALUES ('รย.12-น้อยกว่า 300cc'), ('รย.12-300-799cc'), ('รย.12-800-999cc'), ('รย.12-1000cc ขึ้นไป')) AS x(t)
ON CONFLICT ("province", "vehicleType") DO UPDATE SET "amount" = 200;
