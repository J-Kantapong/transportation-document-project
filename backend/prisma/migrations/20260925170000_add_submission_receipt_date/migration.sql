-- The capture-page received date (previous migration) is replaced by the date printed on the receipt
ALTER TABLE "ReceiptImage" DROP COLUMN "receivedDate";

-- Date printed on the receipt, kept separate from receiptReceivedDate (the day the office got it back)
ALTER TABLE "DocumentSubmission" ADD COLUMN "receiptDate" TIMESTAMP(3);
