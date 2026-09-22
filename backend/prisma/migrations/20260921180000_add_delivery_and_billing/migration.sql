-- ส่งงาน (ป้ายตามทีหลังได้) + วางบิลในนามบริษัท: เงื่อนไขวางบิลต่อลูกค้า, ตารางค่าดำเนินการ, ใบวางบิล (IV)

-- AlterTable
ALTER TABLE "Customer" ADD COLUMN "billingVat" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "billingWhtRate" DECIMAL(5,2) NOT NULL DEFAULT 3,
ADD COLUMN "billingWhtSpecialRate" DECIMAL(5,2),
ADD COLUMN "billingWhtSpecialUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "plateDeliveredDate" TIMESTAMP(3);

-- รถที่ Delivery ไปแล้วก่อนหน้านี้ต้องรับป้ายครบก่อนจึงส่งได้ = ส่งป้ายไปพร้อมกันแล้ว
UPDATE "Vehicle" SET "plateDeliveredDate" = "deliveredDate" WHERE "deliveredDate" IS NOT NULL;

-- CreateTable
CREATE TABLE "ServiceFeeRate" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "vehicleKind" TEXT NOT NULL DEFAULT 'ANY',
    "ccMin" DECIMAL(10,2),
    "ccMax" DECIMAL(10,2),
    "amount" DECIMAL(12,2) NOT NULL,
    "vatInclusive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ServiceFeeRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoiceNo" TEXT NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT NOT NULL,
    "customerSnapshot" JSONB NOT NULL,
    "jobLabel" TEXT NOT NULL,
    "extras" JSONB NOT NULL,
    "vatRate" DECIMAL(5,2) NOT NULL,
    "whtRate" DECIMAL(5,2) NOT NULL,
    "feeTotal" DECIMAL(12,2) NOT NULL,
    "serviceTotal" DECIMAL(12,2) NOT NULL,
    "vatAmount" DECIMAL(12,2) NOT NULL,
    "whtAmount" DECIMAL(12,2) NOT NULL,
    "netTotal" DECIMAL(12,2) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "paidDate" TIMESTAMP(3),
    "taxInvoiceNo" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "chassis" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "body" TEXT,
    "plateText" TEXT NOT NULL,
    "receiptNo" TEXT,
    "deliveredDate" TIMESTAMP(3) NOT NULL,
    "receiptAmount" DECIMAL(12,2) NOT NULL,
    "serviceFee" DECIMAL(12,2) NOT NULL,
    "serviceLabel" TEXT,
    "deduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductionNote" TEXT,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ServiceFeeRate_customerId_idx" ON "ServiceFeeRate"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNo_key" ON "Invoice"("invoiceNo");

-- CreateIndex
CREATE INDEX "Invoice_customerId_idx" ON "Invoice"("customerId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE INDEX "InvoiceLine_vehicleId_idx" ON "InvoiceLine"("vehicleId");

-- AddForeignKey
ALTER TABLE "ServiceFeeRate" ADD CONSTRAINT "ServiceFeeRate_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
