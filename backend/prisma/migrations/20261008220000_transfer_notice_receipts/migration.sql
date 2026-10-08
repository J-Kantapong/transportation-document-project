-- ใบเสร็จแจ้งย้ายของรถจดใหม่ ขั้น 2 (ผู้ใช้ 2026-10-08) - เพิ่มอย่างเดียว ไม่แก้/ลบข้อมูลเดิม
CREATE TABLE "TransferNoticeReceipt" (
    "id" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "originalName" TEXT,
    "contentHash" TEXT,
    "totalAmount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,

    CONSTRAINT "TransferNoticeReceipt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "TransferNoticeReceipt_storageKey_key" ON "TransferNoticeReceipt"("storageKey");
CREATE UNIQUE INDEX "TransferNoticeReceipt_contentHash_key" ON "TransferNoticeReceipt"("contentHash");

ALTER TABLE "Vehicle" ADD COLUMN "transferReceiptId" TEXT,
ADD COLUMN "transferBillCost" DECIMAL(10,2);
CREATE INDEX "Vehicle_transferReceiptId_idx" ON "Vehicle"("transferReceiptId");
ALTER TABLE "Vehicle" ADD CONSTRAINT "Vehicle_transferReceiptId_fkey" FOREIGN KEY ("transferReceiptId") REFERENCES "TransferNoticeReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ยอดใบเสร็จแจ้งย้ายของรถในบิล (รวมอยู่ในค่าธรรมเนียมราชการของบิล เก็บแยกจาก receiptAmount เหมือน swapReceiptAmount)
ALTER TABLE "InvoiceLine" ADD COLUMN "transferReceiptAmount" DECIMAL(12,2);
