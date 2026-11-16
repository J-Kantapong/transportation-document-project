-- ราคาซับจังหวัดปทุมธานี (ผู้ใช้ 2026-11-16: ราคาในตารางผิด) -> ค่าดำเนินการ 200 / ค่าช่อง 200 / นำรถเข้าตรวจสภาพ 500
-- แก้เฉพาะเมื่อราคายังไม่ตรง และเก็บประวัติใน AuditLog (entity SupplierProvinceRate) เหมือนแก้จากหน้าจอ
-- ไม่กระทบรถที่ส่งซับไปแล้ว (รายการยื่นเก็บราคา ณ วันที่ส่งไว้เอง)
WITH before AS (
  SELECT "id", "serviceFee", "channelFee", "inspectionFee"
  FROM "SupplierProvinceRate"
  WHERE "province" = 'ปทุมธานี'
    AND ("serviceFee" IS DISTINCT FROM 200 OR "channelFee" IS DISTINCT FROM 200 OR "inspectionFee" IS DISTINCT FROM 500)
),
updated AS (
  UPDATE "SupplierProvinceRate" r
  SET "serviceFee" = 200, "channelFee" = 200, "inspectionFee" = 500, "updatedAt" = CURRENT_TIMESTAMP, "updatedById" = NULL
  FROM before b
  WHERE r."id" = b."id"
  RETURNING r."id"
)
INSERT INTO "AuditLog" ("id", "entity", "entityId", "action", "remark", "changes", "editedById", "createdAt")
SELECT
  'mig20261116' || md5(b."id"),
  'SupplierProvinceRate',
  b."id",
  'update',
  'แก้ราคาซับปทุมธานีตามที่ผู้ใช้แจ้ง 2026-11-16 (ราคาเดิมในตารางผิด)',
  -- เฉพาะช่องที่เปลี่ยนจริง (ช่องที่เท่าเดิมเป็น NULL แล้วถูกตัดออก)
  jsonb_strip_nulls(jsonb_build_object(
    'province', 'ปทุมธานี',
    'serviceFee', CASE WHEN b."serviceFee" IS DISTINCT FROM 200 THEN jsonb_build_object('from', b."serviceFee", 'to', 200) END,
    'channelFee', CASE WHEN b."channelFee" IS DISTINCT FROM 200 THEN jsonb_build_object('from', b."channelFee", 'to', 200) END,
    'inspectionFee', CASE WHEN b."inspectionFee" IS DISTINCT FROM 500 THEN jsonb_build_object('from', b."inspectionFee", 'to', 500) END
  )),
  NULL,
  CURRENT_TIMESTAMP
FROM before b
JOIN updated u ON u."id" = b."id";
