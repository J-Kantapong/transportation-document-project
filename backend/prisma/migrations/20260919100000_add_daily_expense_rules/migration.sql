-- CreateEnum
CREATE TYPE "DailyExpenseTrigger" AS ENUM ('INSPECTION_DAY');

-- CreateTable
CREATE TABLE "DailyExpenseRule" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "trigger" "DailyExpenseTrigger" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyExpenseRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DailyExpenseRule_code_effectiveFrom_key" ON "DailyExpenseRule"("code", "effectiveFrom");

-- เงื่อนไขที่ผู้ใช้กำหนด (2026-09-19): ค่าคำขอตรวจรถ 25 บาท ทุกวันที่มีการตรวจรถ (ครั้งเดียวต่อวัน).
-- effectiveFrom 2000-01-01 = ใช้กับข้อมูลตรวจรถย้อนหลังทั้งหมดด้วย. seed.ts upsert แถวเดียวกันนี้ซ้ำได้.
INSERT INTO "DailyExpenseRule" ("id", "code", "label", "trigger", "amount", "effectiveFrom", "active", "note")
VALUES (
    'daily_rule_inspection_request_fee_2000',
    'INSPECTION_REQUEST_FEE',
    'ค่าคำขอตรวจรถ',
    'INSPECTION_DAY',
    25,
    '2000-01-01 00:00:00',
    true,
    'คิดครั้งเดียวต่อวัน ในทุกวันที่มีการตรวจรถ ไม่ขึ้นกับจำนวนคัน'
)
ON CONFLICT ("code", "effectiveFrom") DO NOTHING;
