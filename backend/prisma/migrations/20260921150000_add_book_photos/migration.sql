-- รูปเล่มทะเบียน (Step 7 รับเล่มทะเบียน) - AI อ่านเลขตัวรถ/ทะเบียนจากรูปแล้วจับคู่กับรถที่รอรับเล่ม

-- CreateTable
CREATE TABLE "BookPhoto" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalName" TEXT,
    "extractionSource" TEXT NOT NULL DEFAULT 'NONE',
    "extraction" JSONB,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookPhoto_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "bookPhotoId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "BookPhoto_storageKey_key" ON "BookPhoto"("storageKey");

-- CreateIndex
CREATE INDEX "BookPhoto_closedAt_idx" ON "BookPhoto"("closedAt");

-- AddForeignKey
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_bookPhotoId_fkey" FOREIGN KEY ("bookPhotoId") REFERENCES "BookPhoto"("id") ON DELETE SET NULL ON UPDATE CASCADE;
