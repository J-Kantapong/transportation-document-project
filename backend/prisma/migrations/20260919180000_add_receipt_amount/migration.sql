-- The amount printed on the actual DLT receipt, entered by staff when marking the receipt received,
-- so it can be checked against the Bill total (billFeeTotal + taxAmount). See schema.prisma.

-- AlterTable
ALTER TABLE "DocumentSubmission" ADD COLUMN "receiptAmount" DECIMAL(12,2);
