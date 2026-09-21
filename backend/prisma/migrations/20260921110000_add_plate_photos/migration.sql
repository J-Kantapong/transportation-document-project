-- รูปป้ายทะเบียน (Step 6 รับป้ายทะเบียน) - AI อ่านทะเบียนจากรูปแล้วจับคู่กับรถที่รอรับป้าย

-- CreateTable
CREATE TABLE "PlatePhoto" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalName" TEXT,
    "extractionSource" TEXT NOT NULL DEFAULT 'NONE',
    "extraction" JSONB,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatePhoto_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "platePhotoId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "PlatePhoto_storageKey_key" ON "PlatePhoto"("storageKey");

-- CreateIndex
CREATE INDEX "PlatePhoto_closedAt_idx" ON "PlatePhoto"("closedAt");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_platePhotoId_fkey" FOREIGN KEY ("platePhotoId") REFERENCES "PlatePhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
