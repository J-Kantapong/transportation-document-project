-- ผู้ใช้ 2026-10-06: ออก 50 ทวิ ให้พนักงาน (ปลายปี) และผู้รับเงินอื่นๆ (เพิ่มเฉพาะตารางใหม่ ไม่แตะข้อมูลเดิม)
-- CreateTable
CREATE TABLE "IssuedWhtCertificate" (
    "id" TEXT NOT NULL,
    "certificateNo" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "number" INTEGER NOT NULL,
    "issueDate" TIMESTAMP(3) NOT NULL,
    "payeeKind" TEXT NOT NULL,
    "employeeId" TEXT,
    "payeeName" TEXT NOT NULL,
    "payeeTaxId" TEXT NOT NULL,
    "payeeAddress" TEXT,
    "formType" TEXT NOT NULL,
    "payMethod" TEXT NOT NULL DEFAULT 'WITHHOLD',
    "totalPaid" DECIMAL(14,2) NOT NULL,
    "totalTax" DECIMAL(14,2) NOT NULL,
    "ssoAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "providentFund" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "payerSnapshot" JSONB NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ISSUED',
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledByName" TEXT,
    "replacesId" TEXT,
    "createdByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuedWhtCertificate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssuedWhtItem" (
    "id" TEXT NOT NULL,
    "certificateId" TEXT NOT NULL,
    "incomeType" TEXT NOT NULL,
    "description" TEXT,
    "paidDate" TIMESTAMP(3) NOT NULL,
    "dateLabel" TEXT,
    "amountPaid" DECIMAL(14,2) NOT NULL,
    "taxWithheld" DECIMAL(14,2) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IssuedWhtItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssuedWhtCertificate_certificateNo_key" ON "IssuedWhtCertificate"("certificateNo");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedWhtCertificate_replacesId_key" ON "IssuedWhtCertificate"("replacesId");

-- CreateIndex
CREATE INDEX "IssuedWhtCertificate_employeeId_idx" ON "IssuedWhtCertificate"("employeeId");

-- CreateIndex
CREATE INDEX "IssuedWhtCertificate_taxYear_status_idx" ON "IssuedWhtCertificate"("taxYear", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IssuedWhtCertificate_taxYear_number_key" ON "IssuedWhtCertificate"("taxYear", "number");

-- CreateIndex
CREATE INDEX "IssuedWhtItem_certificateId_idx" ON "IssuedWhtItem"("certificateId");

-- AddForeignKey
ALTER TABLE "IssuedWhtCertificate" ADD CONSTRAINT "IssuedWhtCertificate_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedWhtCertificate" ADD CONSTRAINT "IssuedWhtCertificate_replacesId_fkey" FOREIGN KEY ("replacesId") REFERENCES "IssuedWhtCertificate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssuedWhtItem" ADD CONSTRAINT "IssuedWhtItem_certificateId_fkey" FOREIGN KEY ("certificateId") REFERENCES "IssuedWhtCertificate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- พนักงานคนเดียวมีใบที่ยังไม่ยกเลิกได้ใบเดียวต่อปีภาษี (Prisma เขียน partial unique index ไม่ได้)
CREATE UNIQUE INDEX "IssuedWhtCertificate_employee_year_active_key" ON "IssuedWhtCertificate" ("employeeId", "taxYear") WHERE "status" = 'ISSUED' AND "employeeId" IS NOT NULL;

-- CreateTable
CREATE TABLE "IssuedWhtSeries" (
    "year" INTEGER NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssuedWhtSeries_pkey" PRIMARY KEY ("year")
);

-- ทะเบียนผู้รับเงิน (ซับ) ไว้ออก 50 ทวิ
-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "taxId" TEXT NOT NULL,
    "address" TEXT,
    "defaultIncomeType" TEXT NOT NULL DEFAULT 'SERVICE',
    "defaultDescription" TEXT,
    "defaultRate" DECIMAL(5,2) NOT NULL DEFAULT 3,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "IssuedWhtCertificate" ADD COLUMN "supplierId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Supplier_taxId_key" ON "Supplier"("taxId");

-- CreateIndex
CREATE INDEX "Supplier_status_idx" ON "Supplier"("status");

-- CreateIndex
CREATE INDEX "IssuedWhtCertificate_supplierId_idx" ON "IssuedWhtCertificate"("supplierId");

-- AddForeignKey
ALTER TABLE "IssuedWhtCertificate" ADD CONSTRAINT "IssuedWhtCertificate_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;
