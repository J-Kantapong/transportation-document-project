-- ผู้ใช้ 2026-10-02: งาน "งานโอน" (โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ) - เพิ่มตารางใหม่และคอลัมน์ที่ว่างได้เท่านั้น ไม่แตะข้อมูลเดิม
-- ใบเสร็จเก็บใน ReceiptImage เดิมผ่าน vehicleTransferId (เหมือน plateSwapId / vehicleUseCancellationId / plateCopyId)

-- CreateTable
CREATE TABLE "VehicleTransfer" (
    "id" TEXT NOT NULL,
    "transferType" TEXT NOT NULL,
    "vehicleClass" TEXT NOT NULL DEFAULT 'CAR',
    "customerId" TEXT,
    "transferorName" TEXT NOT NULL,
    "transfereeName" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "chassis" TEXT NOT NULL,
    "brand" TEXT NOT NULL,
    "plateCategory" TEXT NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "submitDate" TIMESTAMP(3) NOT NULL,
    "billTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "noBillTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "dutyAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "useRequest" BOOLEAN NOT NULL DEFAULT false,
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "fineAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "inspectionSentDate" TIMESTAMP(3),
    "inspectionResult" TEXT,
    "inspectionResultDate" TIMESTAMP(3),
    "returnedDate" TIMESTAMP(3),
    "receiptNo" TEXT,
    "receiptDate" TIMESTAMP(3),
    "receiptAmount" DECIMAL(12,2),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VehicleTransfer_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ReceiptImage" ADD COLUMN     "vehicleTransferId" TEXT;

-- CreateIndex
CREATE INDEX "VehicleTransfer_customerId_idx" ON "VehicleTransfer"("customerId");

-- CreateIndex
CREATE INDEX "VehicleTransfer_submitDate_idx" ON "VehicleTransfer"("submitDate");

-- CreateIndex
CREATE INDEX "VehicleTransfer_returnedDate_idx" ON "VehicleTransfer"("returnedDate");

-- CreateIndex
CREATE INDEX "VehicleTransfer_transferType_idx" ON "VehicleTransfer"("transferType");

-- CreateIndex
CREATE INDEX "ReceiptImage_vehicleTransferId_idx" ON "ReceiptImage"("vehicleTransferId");

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VehicleTransfer" ADD CONSTRAINT "VehicleTransfer_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_vehicleTransferId_fkey" FOREIGN KEY ("vehicleTransferId") REFERENCES "VehicleTransfer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
