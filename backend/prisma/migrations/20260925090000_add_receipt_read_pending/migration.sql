-- Receipts picked from the gallery are stored first and read by AI in the background
ALTER TABLE "ReceiptImage" ADD COLUMN "readPending" BOOLEAN NOT NULL DEFAULT false;
