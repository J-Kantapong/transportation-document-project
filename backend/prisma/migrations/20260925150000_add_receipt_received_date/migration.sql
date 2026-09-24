-- Receipt received date entered on the capture page (used instead of the receipt-check page date)
ALTER TABLE "ReceiptImage" ADD COLUMN "receivedDate" TIMESTAMP(3);
