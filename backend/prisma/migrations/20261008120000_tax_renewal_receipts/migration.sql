-- ใบเสร็จของงานต่อภาษี (ผู้ใช้ 2026-10-08) - additive only
ALTER TABLE "TaxRenewal" ADD COLUMN "receiptNo" TEXT,
ADD COLUMN "receiptDate" TIMESTAMP(3),
ADD COLUMN "receiptAmount" DECIMAL(12,2);

ALTER TABLE "ReceiptImage" ADD COLUMN "taxRenewalId" TEXT;

CREATE INDEX "ReceiptImage_taxRenewalId_idx" ON "ReceiptImage"("taxRenewalId");

ALTER TABLE "ReceiptImage" ADD CONSTRAINT "ReceiptImage_taxRenewalId_fkey" FOREIGN KEY ("taxRenewalId") REFERENCES "TaxRenewal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
