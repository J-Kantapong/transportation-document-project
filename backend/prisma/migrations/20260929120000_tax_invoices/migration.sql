-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "billingCreditDays" INTEGER;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "dueDate" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TaxInvoiceSeries" (
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxInvoiceSeries_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "TaxInvoice" (
    "id" TEXT NOT NULL,
    "taxInvoiceNo" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "customerSnapshot" JSONB NOT NULL,
    "buyerNotVatRegistered" BOOLEAN NOT NULL DEFAULT false,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "feeTotal" DECIMAL(12,2) NOT NULL,
    "serviceTotal" DECIMAL(12,2) NOT NULL,
    "goodsTotal" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "grandTotal" DECIMAL(12,2) NOT NULL,
    "whtAmount" DECIMAL(12,2) NOT NULL,
    "receivedAmount" DECIMAL(12,2) NOT NULL,
    "whtMethod" TEXT NOT NULL DEFAULT 'NONE',
    "whtCertificateId" TEXT,
    "whtRemindedAt" TIMESTAMP(3),
    "replacesId" TEXT,
    "replacementIssuedAt" TIMESTAMP(3),
    "replacementReason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhtCertificate" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "certificateNo" TEXT,
    "certificateDate" TIMESTAMP(3),
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "originalName" TEXT,
    "contentHash" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,

    CONSTRAINT "WhtCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_taxInvoiceNo_key" ON "TaxInvoice"("taxInvoiceNo");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_replacesId_key" ON "TaxInvoice"("replacesId");

-- CreateIndex
CREATE INDEX "TaxInvoice_invoiceId_idx" ON "TaxInvoice"("invoiceId");

-- CreateIndex
CREATE INDEX "TaxInvoice_customerId_idx" ON "TaxInvoice"("customerId");

-- CreateIndex
CREATE INDEX "TaxInvoice_issueDate_idx" ON "TaxInvoice"("issueDate");

-- CreateIndex
CREATE INDEX "TaxInvoice_whtCertificateId_idx" ON "TaxInvoice"("whtCertificateId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_year_number_key" ON "TaxInvoice"("year", "number");

-- CreateIndex
CREATE UNIQUE INDEX "WhtCertificate_storageKey_key" ON "WhtCertificate"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "WhtCertificate_contentHash_key" ON "WhtCertificate"("contentHash");

-- CreateIndex
CREATE INDEX "WhtCertificate_customerId_idx" ON "WhtCertificate"("customerId");

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_whtCertificateId_fkey" FOREIGN KEY ("whtCertificateId") REFERENCES "WhtCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "TaxInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhtCertificate" ADD CONSTRAINT "WhtCertificate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- บิล 1 ใบมีใบกำกับที่ยังใช้อยู่ได้ใบเดียว (ใบที่ยกเลิกแล้วไม่นับ)
CREATE UNIQUE INDEX "TaxInvoice_invoice_active_key" ON "TaxInvoice"("invoiceId") WHERE "status" = 'ISSUED';
