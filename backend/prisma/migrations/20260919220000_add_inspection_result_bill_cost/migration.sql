-- The inspection result now records the Bill part (ค่าตรวจรถ (Bill), round 2 only) next to the No bill
-- part (inspectionResultCost): pass = the Bill paid at send, fail = 0 (refunded), round 1 = NULL.

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "inspectionResultBillCost" DECIMAL(10,2);
