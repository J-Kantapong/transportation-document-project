-- การสลับเลข (ผู้ใช้ 2026-09-22): รถยนต์ แบบรถเก่า <-> รถใหม่ ก่อน - หนึ่งแถว = งานของรถเก่า 1 คัน
-- ลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ได้ (newVehicleId) ใบเสร็จตอนรับเอกสารกลับแนบผ่าน ReceiptImage.plateSwapId

-- CreateEnum
CREATE TYPE "PlateSwapKind" AS ENUM ('OLD_NEW', 'OLD_OLD');

-- CreateEnum
CREATE TYPE "PlateSwapNumberSource" AS ENUM ('NEW_UNUSED', 'AUCTION_RESERVED');

-- CreateTable
CREATE TABLE "PlateSwap" (
    "id" TEXT NOT NULL,
    "kind" "PlateSwapKind" NOT NULL DEFAULT 'OLD_NEW',
    "vehicleClass" TEXT NOT NULL DEFAULT 'CAR',
    "oldOwnerName" TEXT NOT NULL,
    "oldEngine" TEXT NOT NULL,
    "oldChassis" TEXT NOT NULL,
    "oldBrand" TEXT NOT NULL,
    "oldPlateCategory" TEXT NOT NULL,
    "oldPlateNumber" TEXT NOT NULL,
    "newPlateCategory" TEXT,
    "newPlateNumber" TEXT,
    "newVehicleId" TEXT,
    "submitDate" TIMESTAMP(3) NOT NULL,
    "numberSource" "PlateSwapNumberSource" NOT NULL,
    "buyNormalPlate" BOOLEAN NOT NULL DEFAULT false,
    "buyAuctionPlate" BOOLEAN NOT NULL DEFAULT false,
    "billItems" JSONB NOT NULL,
    "noBillItems" JSONB NOT NULL,
    "billTotal" DECIMAL(12,2) NOT NULL,
    "noBillTotal" DECIMAL(12,2) NOT NULL,
    "returnedDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlateSwap_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "ReceiptImage" ADD COLUMN "plateSwapId" TEXT;

-- CreateIndex
CREATE INDEX "PlateSwap_newVehicleId_idx" ON "PlateSwap"("newVehicleId");
CREATE INDEX "PlateSwap_submitDate_idx" ON "PlateSwap"("submitDate");
CREATE INDEX "PlateSwap_returnedDate_idx" ON "PlateSwap"("returnedDate");
CREATE INDEX "ReceiptImage_plateSwapId_idx" ON "ReceiptImage"("plateSwapId");

-- AddForeignKey
ALTER TABLE "PlateSwap" ADD CONSTRAINT "PlateSwap_newVehicleId_fkey" FOREIGN KEY ("newVehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_plateSwapId_fkey" FOREIGN KEY ("plateSwapId") REFERENCES "PlateSwap"("id") ON DELETE CASCADE ON UPDATE CASCADE;
