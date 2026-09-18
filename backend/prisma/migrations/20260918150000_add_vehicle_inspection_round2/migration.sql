-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN     "inspectionRound2Done" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "inspectionRound2Date" TIMESTAMP(3),
ADD COLUMN     "inspectionRound2Cost" DECIMAL(10,2);
