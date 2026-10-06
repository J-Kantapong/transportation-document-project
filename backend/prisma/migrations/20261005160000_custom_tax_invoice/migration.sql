-- ใบกำกับภาษีกำหนดเองของงานนอกระบบ (ผู้ใช้ 2026-10-05): ไม่ผูกใบวางบิล - เพิ่มอย่างเดียว ใบเดิมไม่กระทบ

-- AlterTable
ALTER TABLE "TaxInvoice" ALTER COLUMN "invoiceId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "TaxInvoiceItem" (
    "id" TEXT NOT NULL,
    "taxInvoiceId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaxInvoiceItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxInvoiceItem_taxInvoiceId_idx" ON "TaxInvoiceItem"("taxInvoiceId");

-- AddForeignKey
ALTER TABLE "TaxInvoiceItem" ADD CONSTRAINT "TaxInvoiceItem_taxInvoiceId_fkey" FOREIGN KEY ("taxInvoiceId") REFERENCES "TaxInvoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
