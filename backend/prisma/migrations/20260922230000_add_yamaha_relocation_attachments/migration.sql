-- ไฟล์แนบของรายการแจ้งย้ายยามาฮ่า: ทุกรายการ (จำนวนคันต่อวัน) ต้องแนบ ใบเสร็จ 1 ไฟล์ + Report 1 ไฟล์ เสมอ
-- ตัวไฟล์อยู่ใน storage (ดิสก์เครื่อง/R2) ตารางเก็บแค่ key

-- CreateEnum
CREATE TYPE "YamahaRelocationAttachmentKind" AS ENUM ('RECEIPT', 'REPORT');

-- CreateTable
CREATE TABLE "YamahaRelocationAttachment" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "kind" "YamahaRelocationAttachmentKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YamahaRelocationAttachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "YamahaRelocationAttachment_storageKey_key" ON "YamahaRelocationAttachment"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "YamahaRelocationAttachment_entryId_kind_key" ON "YamahaRelocationAttachment"("entryId", "kind");

-- AddForeignKey
ALTER TABLE "YamahaRelocationAttachment" ADD CONSTRAINT "YamahaRelocationAttachment_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "YamahaRelocationEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
