-- ผู้ใช้ 2026-10-02: งาน "ยกเลิกการใช้รถ" ในหมวดอื่นๆ - เพิ่มตารางใหม่และคอลัมน์ที่ว่างได้เท่านั้น ไม่แตะข้อมูลเดิม
-- ใบเสร็จของงานนี้เก็บใน ReceiptImage เดิมผ่าน vehicleUseCancellationId (เหมือน plateSwapId ของงานสลับเลข)

-- CreateTable
CREATE TABLE "VehicleUseCancellation" (
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
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleUseCancellation_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ReceiptImage" ADD COLUMN     "vehicleUseCancellationId" TEXT;

-- CreateIndex
CREATE INDEX "VehicleUseCancellation_customerId_idx" ON "VehicleUseCancellation"("customerId");

-- CreateIndex
CREATE INDEX "VehicleUseCancellation_submitDate_idx" ON "VehicleUseCancellation"("submitDate");

-- CreateIndex
CREATE INDEX "VehicleUseCancellation_returnedDate_idx" ON "VehicleUseCancellation"("returnedDate");

-- CreateIndex
CREATE INDEX "ReceiptImage_vehicleUseCancellationId_idx" ON "ReceiptImage"("vehicleUseCancellationId");

-- AddForeignKey
ALTER TABLE "VehicleUseCancellation" ADD CONSTRAINT "VehicleUseCancellation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleUseCancellation" ADD CONSTRAINT "VehicleUseCancellation_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_vehicleUseCancellationId_fkey" FOREIGN KEY ("vehicleUseCancellationId") REFERENCES "VehicleUseCancellation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
