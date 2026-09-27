-- ผู้ใช้ 2026-09-27: บัญชีรับเงินของลูกค้า (บริษัท/บุคคล พร้อมวันเริ่มใช้) และบันทึกการจ่ายของลูกค้ารายคัน (SPI)
-- เพิ่มเฉพาะตารางใหม่ ไม่แตะข้อมูลเดิม - ลูกค้าที่ไม่มีแถวใน CustomerAccountPeriod = บัญชีบริษัท
-- CreateTable
CREATE TABLE "CustomerAccountPeriod" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "remark" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomerAccountPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPayment" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "account" TEXT NOT NULL,
    "paidDate" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "whtAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reference" TEXT,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledById" TEXT,

    CONSTRAINT "CustomerPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerPaymentLine" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "vehicleId" TEXT,
    "chassis" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomerPaymentLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CustomerAccountPeriod_customerId_effectiveFrom_key" ON "CustomerAccountPeriod"("customerId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CustomerPayment_customerId_paidDate_idx" ON "CustomerPayment"("customerId", "paidDate");

-- CreateIndex
CREATE INDEX "CustomerPaymentLine_paymentId_idx" ON "CustomerPaymentLine"("paymentId");

-- CreateIndex
CREATE INDEX "CustomerPaymentLine_vehicleId_idx" ON "CustomerPaymentLine"("vehicleId");

-- AddForeignKey
ALTER TABLE "CustomerAccountPeriod" ADD CONSTRAINT "CustomerAccountPeriod_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerAccountPeriod" ADD CONSTRAINT "CustomerAccountPeriod_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPayment" ADD CONSTRAINT "CustomerPayment_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPaymentLine" ADD CONSTRAINT "CustomerPaymentLine_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "CustomerPayment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerPaymentLine" ADD CONSTRAINT "CustomerPaymentLine_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- บิลบัญชีบุคคล (ผู้ใช้ 2026-09-27): บัญชีของบิล - บิลเดิมทั้งหมดเป็นบัญชีบริษัท
ALTER TABLE "Invoice" ADD COLUMN "account" TEXT NOT NULL DEFAULT 'COMPANY';

-- ราคาเหมารวมค่าใบเสร็จ (ผู้ใช้ 2026-09-27, YMAC) - แถวราคาเดิมทั้งหมดเป็นค่าดำเนินการล้วน
ALTER TABLE "ServiceFeeRate" ADD COLUMN "includesReceipt" BOOLEAN NOT NULL DEFAULT false;
