-- ผู้ใช้ 2026-09-27 (แก้บั๊กรอบ 2): แก้/ยกเลิกต้องมีเหตุผลและประวัติ - เพิ่มเฉพาะตารางใหม่และคอลัมน์ที่ว่างได้ ไม่แตะข้อมูลเดิม
-- AuditLog = ประวัติแก้ไข/ยกเลิกของลูกค้า ใบวางบิล ต่อภาษี แจ้งย้ายยามาฮ่า สลับเลข ผู้ใช้ (รถยังใช้ VehicleEditLog)
-- TaxRenewal / YamahaRelocationEntry / PlateSwap: ยกเลิกแบบ soft (cancelledAt ไม่ว่าง = ยกเลิกแล้ว ไม่ลบแถว)
-- Vehicle.billingClosed*: ปิดงาน - วางบิลนอกระบบ (ออกจากคิวรอวางบิลและยอดค้างรับ)

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "billingClosedAt" TIMESTAMP(3),
ADD COLUMN     "billingClosedById" TEXT,
ADD COLUMN     "billingClosedNote" TEXT;

-- AlterTable
ALTER TABLE "PlateSwap" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "YamahaRelocationEntry" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "TaxRenewal" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "remark" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "editedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_entity_entityId_idx" ON "AuditLog"("entity", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_billingClosedById_fkey" FOREIGN KEY ("billingClosedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateSwap" ADD CONSTRAINT "PlateSwap_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YamahaRelocationEntry" ADD CONSTRAINT "YamahaRelocationEntry_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRenewal" ADD CONSTRAINT "TaxRenewal_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
