-- AlterTable: คัดป้ายแค่ใบเดียว (BOTH / SINGLE_NORMAL / SINGLE_AUCTION) - แถวเดิมเป็น BOTH
ALTER TABLE "PlateCopy" ADD COLUMN "copyType" TEXT NOT NULL DEFAULT 'BOTH';
