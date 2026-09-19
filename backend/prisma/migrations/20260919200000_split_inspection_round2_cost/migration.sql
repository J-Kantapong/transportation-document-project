-- Round-2 inspection cost is now stored as two parts: inspectionRound2Cost keeps the No bill
-- inspection price, and the new inspectionRound2BillCost holds the Bill inspection fee (50 บาท).
-- No round-2 costs had been saved when this ran, so no existing data needs splitting.

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "inspectionRound2BillCost" DECIMAL(10,2);
