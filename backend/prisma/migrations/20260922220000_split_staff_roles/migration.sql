-- แยกบทบาทพนักงาน (ผู้ใช้ 2026-09-22): STAFF -> STAFF_ENTRY (ขั้น 1-3 ทุกประเภทรถ) + STAFF_CAR / STAFF_MOTO
-- (ขั้น 4-8 เฉพาะรถยนต์ / จักรยานยนต์) Postgres ลบค่า enum ไม่ได้ จึงสร้าง type ใหม่แล้วย้ายคอลัมน์
-- ผู้ถือ STAFF เดิม (ตอนนี้ไม่มี) จะได้ครบทั้ง 3 บทบาทใหม่ เพื่อไม่ให้สิทธิ์หายไป

CREATE TYPE "UserRole_new" AS ENUM ('ADMIN', 'STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT', 'DELIVERY', 'CUSTOMER');

ALTER TABLE "User" ALTER COLUMN "roles" DROP DEFAULT;

ALTER TABLE "User"
  ALTER COLUMN "roles" TYPE "UserRole_new"[]
  USING (
    CASE
      WHEN 'STAFF' = ANY("roles"::text[])
        THEN array_cat(array_remove("roles"::text[], 'STAFF'), ARRAY['STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO'])
      ELSE "roles"::text[]
    END
  )::"UserRole_new"[];

ALTER TABLE "User"
  ALTER COLUMN "requestedRole" TYPE "UserRole_new"
  USING (CASE WHEN "requestedRole"::text = 'STAFF' THEN 'STAFF_ENTRY' ELSE "requestedRole"::text END)::"UserRole_new";

ALTER TABLE "User" ALTER COLUMN "roles" SET DEFAULT ARRAY[]::"UserRole_new"[];

DROP TYPE "UserRole";
ALTER TYPE "UserRole_new" RENAME TO "UserRole";
