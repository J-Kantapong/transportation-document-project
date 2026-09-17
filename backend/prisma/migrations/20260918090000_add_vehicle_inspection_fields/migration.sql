-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "inspectionDone" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inspectionCompletedDate" TIMESTAMP(3),
ADD COLUMN     "inspectionCost" DECIMAL(10,2);
