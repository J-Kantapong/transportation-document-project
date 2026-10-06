-- ผู้ใช้ 2026-10-07: ดึงงานอื่นๆ (งานโอน, ยกเลิกการใช้รถ, คัดแผ่นป้าย, ย้ายออก, ต่อภาษี) เข้าใบวางบิล
-- เพิ่มตารางใหม่และคอลัมน์ที่ว่างได้/มีค่าตั้งต้นเท่านั้น ไม่แตะข้อมูลเดิม

-- AlterTable: บรรทัดที่ผูกกับงานอื่นๆ + snapshot ไว้พิมพ์ใบแนบ
ALTER TABLE "InvoiceItem" ADD COLUMN     "sourceType" TEXT,
ADD COLUMN     "sourceId" TEXT,
ADD COLUMN     "sourceSnapshot" JSONB;

-- AlterTable: รูปแบบหน้าบิล - แถวเก่าได้ GROUPED (แบบเดิม พิมพ์ซ้ำเหมือนเดิม) แล้วค่าตั้งต้นของแถวใหม่เป็น SUMMARY
ALTER TABLE "Invoice" ADD COLUMN     "faceLayout" TEXT NOT NULL DEFAULT 'GROUPED';
ALTER TABLE "Invoice" ALTER COLUMN "faceLayout" SET DEFAULT 'SUMMARY';

-- CreateTable
CREATE TABLE "JobFeeRate" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "jobType" TEXT NOT NULL,
    "vehicleClass" TEXT NOT NULL DEFAULT 'ANY',
    "variant" TEXT,
    "label" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobFeeRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InvoiceItem_sourceType_sourceId_idx" ON "InvoiceItem"("sourceType", "sourceId");

-- CreateIndex
CREATE INDEX "JobFeeRate_customerId_idx" ON "JobFeeRate"("customerId");

-- AddForeignKey
ALTER TABLE "JobFeeRate" ADD CONSTRAINT "JobFeeRate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
