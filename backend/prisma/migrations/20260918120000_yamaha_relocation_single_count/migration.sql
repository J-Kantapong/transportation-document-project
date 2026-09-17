-- Replace billCount/noBillCount with a single count: every vehicle in a day's batch
-- carries both a Bill fee and a No bill fee (not an either/or split across vehicles).
-- Table is empty in dev, so a plain NOT NULL add is safe.

ALTER TABLE "YamahaRelocationEntry" DROP COLUMN "billCount";
ALTER TABLE "YamahaRelocationEntry" DROP COLUMN "noBillCount";
ALTER TABLE "YamahaRelocationEntry" ADD COLUMN "count" INTEGER NOT NULL;
