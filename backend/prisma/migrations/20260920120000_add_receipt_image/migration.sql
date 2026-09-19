-- รูปใบเสร็จที่ถ่าย/อัปโหลดในหน้ารับใบเสร็จ - ตัวไฟล์อยู่ใน storage ตารางนี้เก็บ key + ผลที่อ่านได้
-- submissionId NULL = อัปโหลดหลายใบแล้วยังไม่ได้จับคู่กับรถ

-- CreateTable
CREATE TABLE "ReceiptImage" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalName" TEXT,
    "extractionSource" TEXT NOT NULL DEFAULT 'NONE',
    "extraction" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptImage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptImage_storageKey_key" ON "ReceiptImage"("storageKey");

-- CreateIndex
CREATE INDEX "ReceiptImage_submissionId_idx" ON "ReceiptImage"("submissionId");

-- AddForeignKey
ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "DocumentSubmission"("id") ON DELETE SET NULL ON UPDATE CASCADE;
