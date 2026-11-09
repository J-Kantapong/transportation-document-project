-- ต่อภาษีรถตาม พ.ร.บ.การขนส่งทางบก (รถใหญ่/รถประกอบการ, ผู้ใช้ 2026-11-09) - additive only
-- ต่อจาก 20261109100000_transport_tax_family (เพิ่มค่า enum แยก transaction)

-- วันที่ตรวจสภาพรถ - รถ ขส. ต้องตรวจทุกครั้งก่อนต่อภาษี ต้องมีก่อนบันทึกวันที่ชำระ (รถเล็ก null)
ALTER TABLE "TaxRenewal" ADD COLUMN "inspectionDate" TIMESTAMP(3);

-- อัตราภาษีตาม "น้ำหนักรถ" (กก.) แยกคอลัมน์ตามประเภทใบอนุญาตขนส่ง - บัญชีอัตราภาษีรถตามมาตรา 85 ท้าย พ.ร.บ.การขนส่งทางบก (รถบรรทุกและรถโดยสารใช้ตารางเดียวกัน)
-- TRANSPORT_PRIVATE (ส่วนบุคคล) ผู้ใช้ยืนยันด้วยใบเสร็จจริง 2026-11-09: น้ำหนักรถ 7,800 กก. = 3,600 บาท -> VERIFIED/active
-- อีก 3 คอลัมน์ยังไม่มีใบเสร็จยืนยัน -> DRAFT/inactive (เลือกแล้วคำนวณไม่ได้จนกว่าผู้ใช้จะยืนยันตัวเลข)
-- รถขนาดเล็กมีถึง 3,000 กก. เท่านั้น / ช่วงบนสุด weightTo = NULL
INSERT INTO "GovernmentTaxWeightBracket"
  ("id", "vehicleFamily", "fuelGroup", "weightFrom", "weightTo", "amount", "sortOrder", "status", "active", "legalReference")
SELECT
  gen_random_uuid()::text,
  f.fam::"GovTaxVehicleFamily",
  NULL,
  b.wfrom,
  b.wto,
  CASE f.fam
    WHEN 'TRANSPORT_PRIVATE' THEN b.private
    WHEN 'TRANSPORT_NON_FIXED' THEN b.nonfixed
    WHEN 'TRANSPORT_FIXED' THEN b.fixed
    ELSE b.small
  END,
  b.ord,
  (CASE WHEN f.fam = 'TRANSPORT_PRIVATE' THEN 'VERIFIED' ELSE 'DRAFT' END)::"GovTaxRuleStatus",
  f.fam = 'TRANSPORT_PRIVATE',
  CASE WHEN f.fam = 'TRANSPORT_PRIVATE'
    THEN 'บัญชีอัตราภาษีรถตามมาตรา 85 ท้าย พ.ร.บ.การขนส่งทางบก พ.ศ. 2522 (แก้ไขโดยฉบับที่ 11 พ.ศ. 2550) คอลัมน์ขนส่งส่วนบุคคล - ผู้ใช้ยืนยันด้วยใบเสร็จจริง 3,600 บาท (น้ำหนักรถ 7,800 กก.) 2026-11-09'
    ELSE 'บัญชีอัตราภาษีรถตามมาตรา 85 ท้าย พ.ร.บ.การขนส่งทางบก พ.ศ. 2522 (แก้ไขโดยฉบับที่ 11 พ.ศ. 2550) - ยังไม่มีใบเสร็จจริงยืนยัน (2026-11-09)'
  END
FROM (VALUES
  (0::numeric,    500::numeric,  150, 450, 300, 300::numeric, 0),
  (500::numeric,  750::numeric,  300, 600, 400, 400::numeric, 1),
  (750::numeric,  1000::numeric, 450, 750, 500, 500::numeric, 2),
  (1000::numeric, 1250::numeric, 800, 900, 600, 600::numeric, 3),
  (1250::numeric, 1500::numeric, 1000, 1050, 700, 700::numeric, 4),
  (1500::numeric, 1750::numeric, 1300, 1350, 900, 900::numeric, 5),
  (1750::numeric, 2000::numeric, 1600, 1650, 1100, 1100::numeric, 6),
  (2000::numeric, 2500::numeric, 1900, 1950, 1300, 1300::numeric, 7),
  (2500::numeric, 3000::numeric, 2200, 2250, 1500, 1500::numeric, 8),
  (3000::numeric, 3500::numeric, 2400, 2550, 1700, NULL::numeric, 9),
  (3500::numeric, 4000::numeric, 2600, 2850, 1900, NULL::numeric, 10),
  (4000::numeric, 4500::numeric, 2800, 3150, 2100, NULL::numeric, 11),
  (4500::numeric, 5000::numeric, 3000, 3450, 2300, NULL::numeric, 12),
  (5000::numeric, 6000::numeric, 3200, 3750, 2500, NULL::numeric, 13),
  (6000::numeric, 7000::numeric, 3400, 4050, 2700, NULL::numeric, 14),
  (7000::numeric, NULL::numeric, 3600, 4350, 2900, NULL::numeric, 15)
) AS b(wfrom, wto, private, nonfixed, fixed, small, ord)
CROSS JOIN (VALUES ('TRANSPORT_PRIVATE'), ('TRANSPORT_NON_FIXED'), ('TRANSPORT_FIXED'), ('TRANSPORT_SMALL')) AS f(fam)
WHERE NOT (f.fam = 'TRANSPORT_SMALL' AND b.small IS NULL)
  AND NOT EXISTS (
    SELECT 1 FROM "GovernmentTaxWeightBracket" g
    WHERE g."vehicleFamily" = f.fam::"GovTaxVehicleFamily" AND g."fuelGroup" IS NULL AND g."weightFrom" = b.wfrom
  );
