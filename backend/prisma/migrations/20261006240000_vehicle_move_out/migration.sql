-- ผู้ใช้ 2026-10-06: งาน "ย้ายออก" ในหมวดอื่นๆ (เก็บข้อมูลแบบยกเลิกการใช้รถ) - เพิ่มตารางใหม่และคอลัมน์ที่ว่างได้เท่านั้น ไม่แตะข้อมูลเดิม
-- ใบเสร็จของงานนี้เก็บใน ReceiptImage เดิมผ่าน vehicleMoveOutId

-- CreateTable
CREATE TABLE "VehicleMoveOut" (
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
    "urgent" BOOLEAN NOT NULL DEFAULT false,
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

    CONSTRAINT "VehicleMoveOut_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ReceiptImage" ADD COLUMN     "vehicleMoveOutId" TEXT;

-- CreateIndex
CREATE INDEX "VehicleMoveOut_customerId_idx" ON "VehicleMoveOut"("customerId");

-- CreateIndex
CREATE INDEX "VehicleMoveOut_submitDate_idx" ON "VehicleMoveOut"("submitDate");

-- CreateIndex
CREATE INDEX "VehicleMoveOut_returnedDate_idx" ON "VehicleMoveOut"("returnedDate");

-- CreateIndex
CREATE INDEX "ReceiptImage_vehicleMoveOutId_idx" ON "ReceiptImage"("vehicleMoveOutId");

-- AddForeignKey
ALTER TABLE "VehicleMoveOut" ADD CONSTRAINT "VehicleMoveOut_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleMoveOut" ADD CONSTRAINT "VehicleMoveOut_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_vehicleMoveOutId_fkey" FOREIGN KEY ("vehicleMoveOutId") REFERENCES "VehicleMoveOut"("id") ON DELETE CASCADE ON UPDATE CASCADE;
