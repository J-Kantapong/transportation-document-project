-- ใบเสนอราคา (ผู้ใช้ 2026-10-01) - เพิ่มอย่างเดียว ไม่แก้ข้อมูลเดิม

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "billingRequiresQuotation" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Invoice" ADD COLUMN     "quotationId" TEXT,
ADD COLUMN     "quotationNo" TEXT,
ADD COLUMN     "poNumber" TEXT;

-- CreateTable
CREATE TABLE "QuotationSeries" (
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotationSeries_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "quotationNo" TEXT,
    "baseNo" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "replacesId" TEXT,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "customerId" TEXT,
    "customerSnapshot" JSONB NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "validDays" INTEGER NOT NULL DEFAULT 30,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "conditions" TEXT,
    "account" TEXT NOT NULL DEFAULT 'COMPANY',
    "vatRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "whtRate" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "feeTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "serviceTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "goodsTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "vatAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "whtAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "yamahaMonth" TEXT,
    "yamahaCounts" JSONB,
    "approvedDate" TIMESTAMP(3),
    "poNumber" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "originalName" TEXT,
    "contentHash" TEXT,
    "rejectReason" TEXT,
    "ratesAppliedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuotationItem" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "cost" DECIMAL(12,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "rateKind" TEXT,
    "vehicleKind" TEXT,
    "ccMin" DECIMAL(10,2),
    "ccMax" DECIMAL(10,2),
    "chassisPrefix" TEXT,
    "vatInclusive" BOOLEAN NOT NULL DEFAULT false,
    "includesReceipt" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "QuotationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_quotationNo_key" ON "Quotation"("quotationNo");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_replacesId_key" ON "Quotation"("replacesId");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_storageKey_key" ON "Quotation"("storageKey");

-- CreateIndex
CREATE UNIQUE INDEX "Quotation_contentHash_key" ON "Quotation"("contentHash");

-- CreateIndex
CREATE INDEX "Quotation_customerId_idx" ON "Quotation"("customerId");

-- CreateIndex
CREATE INDEX "Quotation_status_idx" ON "Quotation"("status");

-- CreateIndex
CREATE INDEX "Quotation_yamahaMonth_idx" ON "Quotation"("yamahaMonth");

-- CreateIndex
CREATE INDEX "QuotationItem_quotationId_idx" ON "QuotationItem"("quotationId");

-- ใบเสนอราคา 1 ใบมีบิลที่ยังใช้อยู่ได้ใบเดียว (บิลที่ยกเลิกแล้วไม่นับ ออกใหม่ได้) - Prisma ประกาศ partial index ไม่ได้
CREATE UNIQUE INDEX "Invoice_quotation_active_key" ON "Invoice"("quotationId") WHERE "status" <> 'VOID';

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "Quotation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuotationItem" ADD CONSTRAINT "QuotationItem_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "Quotation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
