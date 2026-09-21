-- เลขที่ใบเสร็จ ("เลขที่" มุมขวาบนของใบเสร็จกรมขนส่ง) - AI อ่านให้ พนักงานแก้ได้ ใช้เรียงคู่กับทะเบียนตอนไปห้องรับป้าย

-- AlterTable
ALTER TABLE "DocumentSubmission" ADD COLUMN "receiptNo" TEXT;
