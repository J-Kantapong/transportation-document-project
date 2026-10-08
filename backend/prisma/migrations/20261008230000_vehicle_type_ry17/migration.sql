-- ประเภทรถใหม่ "รย.17-จักรยานยนต์สาธารณะ" (ผู้ใช้ 2026-10-08) - เพิ่มแถวในตารางค่าใช้จ่ายที่ผูกกับประเภทรถ ไม่แก้ข้อมูลเดิม
-- ค่าตัดบัญชี / แจ้งย้าย / ตรวจรถ กทม. ใช้ค่าเดียวกับ รย.12-น้อยกว่า 300cc (คัดลอกจากแถวนั้น) - แก้ทีหลังได้ถ้าราคาจริงต่างกัน
INSERT INTO "FeeDeregistration" ("id", "vehicleType", "brand", "amount")
SELECT gen_random_uuid()::text, 'รย.17-จักรยานยนต์สาธารณะ', "brand", "amount"
FROM "FeeDeregistration" WHERE "vehicleType" = 'รย.12-น้อยกว่า 300cc'
ON CONFLICT ("vehicleType", "brand") DO NOTHING;

INSERT INTO "FeeRelocate" ("id", "vehicleType", "brand", "noBillAmount", "billAmount")
SELECT gen_random_uuid()::text, 'รย.17-จักรยานยนต์สาธารณะ', "brand", "noBillAmount", "billAmount"
FROM "FeeRelocate" WHERE "vehicleType" = 'รย.12-น้อยกว่า 300cc'
ON CONFLICT ("vehicleType", "brand") DO NOTHING;

INSERT INTO "FeeInspectionBangkok" ("id", "vehicleType", "brand", "amount")
SELECT gen_random_uuid()::text, 'รย.17-จักรยานยนต์สาธารณะ', "brand", "amount"
FROM "FeeInspectionBangkok" WHERE "vehicleType" = 'รย.12-น้อยกว่า 300cc'
ON CONFLICT ("vehicleType", "brand") DO NOTHING;

-- มอเตอร์ไซค์ที่จดสมุทรปราการ (รย.12 / รย.17): ลงขันขั้นยื่นเอกสาร 100 บาท แทน 40 ของกรุงเทพฯ (ผู้ใช้ 2026-10-08) ค่าอากรเหมือนเดิม 10 / 30
INSERT INTO "FeeMotorcycleNoBillParam" ("id", "key", "amount", "note")
VALUES (gen_random_uuid()::text, 'ลงขัน - จดสมุทรปราการ', 100, 'มอเตอร์ไซค์ที่จดสมุทรปราการ (รย.12 / รย.17) - แทนที่ลงขันปกติ 40')
ON CONFLICT ("key") DO UPDATE SET "amount" = 100;

-- ค่าตรวจรถสมุทรปราการ จักรยานยนต์สาธารณะ 300 บาท (ผู้ใช้ให้ราคา 2026-10-08)
INSERT INTO "FeeInspectionProvince" ("id", "province", "vehicleType", "amount")
VALUES (gen_random_uuid()::text, 'สมุทรปราการ', 'รย.17-จักรยานยนต์สาธารณะ', 300)
ON CONFLICT ("province", "vehicleType") DO UPDATE SET "amount" = 300;
