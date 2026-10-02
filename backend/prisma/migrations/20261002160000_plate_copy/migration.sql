-- ผู้ใช้ 2026-10-02: งาน "คัดแผ่นป้ายทะเบียน" ในหมวดอื่นๆ (รถยนต์) - เพิ่มตารางใหม่และคอลัมน์ที่ว่างได้เท่านั้น ไม่แตะข้อมูลเดิม
-- ใบเสร็จเก็บใน ReceiptImage เดิมผ่าน plateCopyId / รูปป้ายที่ได้รับเก็บใน PlatePhoto เดิมผ่าน PlateCopy.platePhotoId

-- CreateTable
CREATE TABLE "PlateCopy" (
    "id" TEXT NOT NULL,
    "vehicleClass" TEXT NOT NULL DEFAULT 'CAR',
    "customerId" TEXT,
    "ownerName" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "chassis" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "plateCategory" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "submitDate" TIMESTAMP(3) NOT NULL,
    "billTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "noBillTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "dutyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "returnedDate" TIMESTAMP(3),
    "receiptNo" TEXT,
    "receiptDate" TIMESTAMP(3),
    "receiptAmount" DECIMAL(12,2),
    "plateReceivedDate" TIMESTAMP(3),
    "platePhotoId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlateCopy_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ReceiptImage" ADD COLUMN     "plateCopyId" TEXT;

-- CreateIndex
CREATE INDEX "PlateCopy_customerId_idx" ON "PlateCopy"("customerId");

-- CreateIndex
CREATE INDEX "PlateCopy_submitDate_idx" ON "PlateCopy"("submitDate");

-- CreateIndex
CREATE INDEX "PlateCopy_returnedDate_idx" ON "PlateCopy"("returnedDate");

-- CreateIndex
CREATE INDEX "PlateCopy_plateReceivedDate_idx" ON "PlateCopy"("plateReceivedDate");

-- CreateIndex
CREATE INDEX "ReceiptImage_plateCopyId_idx" ON "ReceiptImage"("plateCopyId");

-- AddForeignKey
ALTER TABLE "PlateCopy" ADD CONSTRAINT "PlateCopy_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateCopy" ADD CONSTRAINT "PlateCopy_platePhotoId_fkey" FOREIGN KEY ("platePhotoId") REFERENCES "PlatePhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlateCopy" ADD CONSTRAINT "PlateCopy_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_plateCopyId_fkey" FOREIGN KEY ("plateCopyId") REFERENCES "PlateCopy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
