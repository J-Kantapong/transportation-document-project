-- AlterTable
ALTER TABLE "Vehicle" DROP COLUMN "inspectionDone",
DROP COLUMN "inspectionCompletedDate",
DROP COLUMN "inspectionCost",
ADD COLUMN     "inspectionSentType" TEXT,
ADD COLUMN     "inspectionSentDate" TIMESTAMP(3),
ADD COLUMN     "inspectionSentCost" DECIMAL(10,2),
ADD COLUMN     "inspectionResult" TEXT,
ADD COLUMN     "inspectionResultDate" TIMESTAMP(3),
ADD COLUMN     "inspectionResultCost" DECIMAL(10,2),
ADD COLUMN     "inspectionFailRemark" TEXT;
