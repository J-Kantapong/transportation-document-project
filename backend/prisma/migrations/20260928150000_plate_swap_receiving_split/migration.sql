-- แยกขั้นรับเอกสารกลับของงานสลับเลข (รถเก่า กับ รถใหม่ - รถยนต์) เป็น 3 ขั้น: รับใบเสร็จ (OCR จริง) / รับป้าย / รับเล่ม
-- (ผู้ใช้ 2026-09-28) - returnedDate ความหมายเดิมทุกอย่าง (ยังเป็นตัวตัดสิน "งานเสร็จ" คนเดียว) คอลัมน์ใหม่ทั้งหมดเป็นแค่
-- ข้อมูลบันทึกเพิ่มของฝั่งรถเก่าเอง ไม่ผูกกับ gating ใดๆ และไม่แตะรถใหม่ที่ลิงก์ไว้ - migration นี้เพิ่มอย่างเดียว ไม่แก้/ลบคอลัมน์เดิม

-- AlterTable
ALTER TABLE "PlateSwap" ADD COLUMN     "receiptNo" TEXT,
ADD COLUMN     "receiptDate" TIMESTAMP(3),
ADD COLUMN     "receiptAmount" DECIMAL(12,2),
ADD COLUMN     "plateReceivedDate" TIMESTAMP(3),
ADD COLUMN     "platePhotoId" TEXT,
ADD COLUMN     "bookReceivedDate" TIMESTAMP(3),
ADD COLUMN     "bookPhotoId" TEXT;

-- CreateIndex
CREATE INDEX "PlateSwap_plateReceivedDate_idx" ON "PlateSwap"("plateReceivedDate");

-- CreateIndex
CREATE INDEX "PlateSwap_bookReceivedDate_idx" ON "PlateSwap"("bookReceivedDate");

-- AddForeignKey
ALTER TABLE "PlateSwap" ADD CONSTRAINT "PlateSwap_platePhotoId_fkey" FOREIGN KEY ("platePhotoId") REFERENCES "PlatePhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateSwap" ADD CONSTRAINT "PlateSwap_bookPhotoId_fkey" FOREIGN KEY ("bookPhotoId") REFERENCES "BookPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
