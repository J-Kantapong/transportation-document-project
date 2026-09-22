-- ลบข้อมูลรถจดใหม่ (ผู้ใช้ 2026-09-23): ลบแบบซ่อน (soft delete) ไม่ลบแถวจริง เพราะต้องเก็บเหตุผลที่ลบไว้ตรวจสอบ
-- และให้ ADMIN กู้คืนได้ถ้าลบผิด - ADMIN เท่านั้นที่ลบได้ และลบได้เฉพาะรถที่ยังไม่ยื่นเอกสารจดทะเบียน
-- (ดู backend/src/vehicles/vehicles.service.ts deleteVehicle / restoreVehicle)

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletedReason" TEXT;

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_deletedById_fkey" FOREIGN KEY ("deletedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- เลขตัวถังห้ามซ้ำเฉพาะในกลุ่มรถที่ยังไม่ถูกลบ: ลบรถทิ้งแล้วคีย์เลขตัวถังเดิมเข้ามาใหม่ได้ (ผู้ใช้ 2026-09-23)
-- Prisma ไม่รองรับ partial unique index จึงประกาศเป็น SQL ตรงนี้ และ schema.prisma ไม่มี @unique ที่ chassis แล้ว
-- DropIndex
DROP INDEX "Vehicle_chassis_key";

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_chassis_active_key" ON "Vehicle"("chassis") WHERE "deletedAt" IS NULL;

-- CreateIndex
CREATE INDEX "Vehicle_chassis_idx" ON "Vehicle"("chassis");

-- CreateIndex
CREATE INDEX "Vehicle_deletedAt_idx" ON "Vehicle"("deletedAt");
