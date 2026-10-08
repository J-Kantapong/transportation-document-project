-- ผู้ใช้ 2026-10-08 "ช่องผู้ทำ": จดว่าใครคีย์ข้อมูลรถ / ยื่นเอกสาร / บันทึกว่าได้รับใบเสร็จ
-- เพิ่มคอลัมน์ที่ว่างได้เท่านั้น แถวเดิมเป็น NULL (ไม่รู้ว่าใครทำ) ไม่แตะข้อมูลเดิม

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "createdById" TEXT;

-- AlterTable
ALTER TABLE "DocumentSubmission" ADD COLUMN     "createdById" TEXT,
ADD COLUMN     "receivedById" TEXT;

-- CreateIndex
CREATE INDEX "DocumentSubmission_createdById_idx" ON "DocumentSubmission"("createdById");

-- CreateIndex
CREATE INDEX "DocumentSubmission_receivedById_idx" ON "DocumentSubmission"("receivedById");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSubmission" ADD CONSTRAINT "DocumentSubmission_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSubmission" ADD CONSTRAINT "DocumentSubmission_receivedById_fkey" FOREIGN KEY ("receivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
