-- Round-2 inspection (90 days after the first pass) no longer has its own tab/columns. It reuses the
-- normal send -> result flow, with "inspectionRound" saying which round the current send/result belongs
-- to. The Bill part of the inspection fee (50 บาท, round 2 only) moves to inspectionSentBillCost.

-- AlterTable
ALTER TABLE "Vehicle" ADD COLUMN "inspectionRound" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Vehicle" RENAME COLUMN "inspectionRound2BillCost" TO "inspectionSentBillCost";

-- Cars already sent for round 2 under the old tab: keep the round-1 record in VehicleEditLog, then
-- turn the round-2 send into the current send (awaiting a result).
INSERT INTO "VehicleEditLog" ("id", "vehicleId", "remark", "changes", "editedAt")
SELECT
  gen_random_uuid()::text,
  "id",
  'เริ่มตรวจรอบ 2 (ย้ายข้อมูลจากแท็บตรวจรถรอบ 2 เดิม)',
  json_build_object(
    'inspectionRound', json_build_object('from', '1', 'to', '2'),
    'inspectionSentDate', json_build_object('from', to_char("inspectionSentDate", 'YYYY-MM-DD'), 'to', to_char("inspectionRound2Date", 'YYYY-MM-DD')),
    'inspectionSentCost', json_build_object('from', "inspectionSentCost"::text, 'to', "inspectionRound2Cost"::text),
    'inspectionResult', json_build_object('from', "inspectionResult", 'to', NULL),
    'inspectionResultDate', json_build_object('from', to_char("inspectionResultDate", 'YYYY-MM-DD'), 'to', NULL),
    'inspectionResultCost', json_build_object('from', "inspectionResultCost"::text, 'to', NULL)
  )::text,
  NOW()
FROM "Vehicle"
WHERE "inspectionRound2Done" = true;

UPDATE "Vehicle"
SET "inspectionRound" = 2,
    "inspectionSentDate" = "inspectionRound2Date",
    "inspectionSentCost" = "inspectionRound2Cost",
    "inspectionResult" = NULL,
    "inspectionResultDate" = NULL,
    "inspectionResultCost" = NULL,
    "inspectionFailRemark" = NULL
WHERE "inspectionRound2Done" = true;

ALTER TABLE "Vehicle" DROP COLUMN "inspectionRound2Done",
DROP COLUMN "inspectionRound2Date",
DROP COLUMN "inspectionRound2Cost";
