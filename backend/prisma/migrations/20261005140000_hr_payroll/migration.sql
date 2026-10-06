-- ผู้ใช้ 2026-10-05: ฝ่ายบุคคล / เงินเดือน - ทะเบียนพนักงาน + รอบเงินเดือนรายเดือน (เพิ่มเฉพาะตารางใหม่ ไม่แตะข้อมูลเดิม)
-- CreateTable
CREATE TABLE "Employee" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "prefix" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT,
    "position" TEXT,
    "idType" TEXT NOT NULL DEFAULT 'CITIZEN',
    "idNumber" TEXT NOT NULL,
    "birthDate" TIMESTAMP(3),
    "startDate" TIMESTAMP(3),
    "baseSalary" DECIMAL(12,2) NOT NULL,
    "socialSecurity" BOOLEAN NOT NULL DEFAULT true,
    "withholdTax" BOOLEAN NOT NULL DEFAULT true,
    "otherAllowance" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "resignedDate" TIMESTAMP(3),
    "userId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "payDate" TIMESTAMP(3),
    "ssoRate" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "ssoWageCap" DECIMAL(12,2) NOT NULL,
    "createdByName" TEXT,
    "approvedAt" TIMESTAMP(3),
    "approvedByName" TEXT,
    "paidAt" TIMESTAMP(3),
    "paidByName" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "cancelledByName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "position" TEXT,
    "salary" DECIMAL(12,2) NOT NULL,
    "otherIncome" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherIncomeNote" TEXT,
    "ssoAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "otherDeduction" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deductionNote" TEXT,
    "netPay" DECIMAL(12,2) NOT NULL,
    "ssoManual" BOOLEAN NOT NULL DEFAULT false,
    "taxManual" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PayrollItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Employee_code_key" ON "Employee"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_idNumber_key" ON "Employee"("idNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Employee_userId_key" ON "Employee"("userId");

-- CreateIndex
CREATE INDEX "Employee_status_idx" ON "Employee"("status");

-- CreateIndex
CREATE INDEX "PayrollRun_month_idx" ON "PayrollRun"("month");

-- เดือนเดียวมีรอบเงินเดือนที่ไม่ยกเลิกได้รอบเดียว (ยกเลิกแล้วสร้างใหม่ได้)
CREATE UNIQUE INDEX "PayrollRun_month_active_key" ON "PayrollRun"("month") WHERE "cancelledAt" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "PayrollItem_runId_employeeId_key" ON "PayrollItem"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "PayrollItem_employeeId_idx" ON "PayrollItem"("employeeId");

-- AddForeignKey
ALTER TABLE "Employee" ADD CONSTRAINT "Employee_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollItem" ADD CONSTRAINT "PayrollItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
