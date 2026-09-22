-- ไฟแนนซ์: หน้าเพิ่มข้อมูลรถจดใหม่ติ๊ก "ไฟแนนซ์" แล้วเลือกบริษัท - เก็บเป็นเจ้าของรถตามทะเบียน (VehicleOwner) ที่อ้างถึง FinanceCompany

-- CreateTable
CREATE TABLE "FinanceCompany" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 1000,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinanceCompany_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "VehicleOwner" ADD COLUMN "financeCompanyId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FinanceCompany_name_key" ON "FinanceCompany"("name");

-- CreateIndex
CREATE INDEX "VehicleOwner_financeCompanyId_idx" ON "VehicleOwner"("financeCompanyId");

-- AddForeignKey
ALTER TABLE "VehicleOwner" ADD CONSTRAINT "VehicleOwner_financeCompanyId_fkey" FOREIGN KEY ("financeCompanyId") REFERENCES "FinanceCompany"("id") ON DELETE SET NULL ON UPDATE CASCADE;
