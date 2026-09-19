-- Steps after the DLT receipt: receiving the receipt date, license plate, registration book, and
-- delivery to the customer. A non-null date means the step is done; see schema.prisma.

-- AlterTable
ALTER TABLE "DocumentSubmission" ADD COLUMN "receiptReceivedDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Vehicle"
  ADD COLUMN "plateReceivedDate" TIMESTAMP(3),
  ADD COLUMN "bookReceivedDate" TIMESTAMP(3),
  ADD COLUMN "deliveredDate" TIMESTAMP(3),
  ADD COLUMN "deliveryRecipient" TEXT,
  ADD COLUMN "deliveryNote" TEXT;
