-- กันอัปโหลดรูปเดิมซ้ำ (ผู้ใช้ 2026-09-24): SHA-256 ของไฟล์ในทุกตารางรูป/ไฟล์แนบ - แถวเก่าเป็น NULL (ไม่ตรวจซ้ำ)
-- AlterTable
ALTER TABLE "ReceiptImage" ADD COLUMN     "contentHash" TEXT;
ALTER TABLE "YamahaRelocationAttachment" ADD COLUMN     "contentHash" TEXT;
ALTER TABLE "PlatePhoto" ADD COLUMN     "contentHash" TEXT;
ALTER TABLE "BookPhoto" ADD COLUMN     "contentHash" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "ReceiptImage_contentHash_key" ON "ReceiptImage"("contentHash");
CREATE UNIQUE INDEX "YamahaRelocationAttachment_contentHash_key" ON "YamahaRelocationAttachment"("contentHash");
CREATE UNIQUE INDEX "PlatePhoto_contentHash_key" ON "PlatePhoto"("contentHash");
CREATE UNIQUE INDEX "BookPhoto_contentHash_key" ON "BookPhoto"("contentHash");
