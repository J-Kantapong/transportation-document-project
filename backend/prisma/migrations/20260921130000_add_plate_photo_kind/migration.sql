-- แยกรูปป้ายรถยนต์/มอเตอร์ไซค์ (ป้ายสองประเภทใช้หมวด+เลขซ้ำกันได้ จึงต้องจับคู่เฉพาะประเภทเดียวกัน)

-- DropIndex
DROP INDEX "PlatePhoto_closedAt_idx";

-- AlterTable
ALTER TABLE "PlatePhoto" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'car';

-- CreateIndex
CREATE INDEX "PlatePhoto_kind_closedAt_idx" ON "PlatePhoto"("kind", "closedAt");
