-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "transferDone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "transferCompletedDate" TIMESTAMP(3),
ADD COLUMN     "transferCost" DECIMAL(10,2);
