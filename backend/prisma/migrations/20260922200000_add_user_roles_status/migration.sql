-- ระบบล็อกอิน/สมัคร/อนุมัติ (2026-09-22): User ถือได้หลายบทบาท (roles[]) + สถานะรออนุมัติ + ผูกบัญชีลูกค้ากับ Customer
-- ตาราง User ยังไม่มีข้อมูล จึง DROP คอลัมน์ role เดิมได้เลย

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'DISABLED');

-- AlterEnum
ALTER TYPE "UserRole" ADD VALUE 'ACCOUNTANT';
ALTER TYPE "UserRole" ADD VALUE 'DELIVERY';
ALTER TYPE "UserRole" ADD VALUE 'CUSTOMER';

-- AlterTable
ALTER TABLE "User" DROP COLUMN "role",
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "customerId" TEXT,
ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "phone" TEXT,
ADD COLUMN     "requestedCompany" TEXT,
ADD COLUMN     "requestedRole" "UserRole",
ADD COLUMN     "roles" "UserRole"[] DEFAULT ARRAY[]::"UserRole"[],
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'PENDING';

-- AlterTable: ลูกค้ายืนยันรับของใน portal
ALTER TABLE "Vehicle" ADD COLUMN "deliveryConfirmedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");
CREATE INDEX "User_customerId_idx" ON "User"("customerId");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "User" ADD CONSTRAINT "User_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
