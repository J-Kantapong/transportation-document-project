-- Delivery slips: one row per delivery (customer, date, recipient) with what each vehicle got (receipt/book/plate)
-- CreateTable
CREATE TABLE "DeliverySlip" (
    "id" TEXT NOT NULL,
    "slipNo" SERIAL NOT NULL,
    "customerId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "recipient" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeliverySlip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliverySlipItem" (
    "id" TEXT NOT NULL,
    "slipId" TEXT NOT NULL,
    "vehicleId" TEXT NOT NULL,
    "receipt" BOOLEAN NOT NULL,
    "book" BOOLEAN NOT NULL,
    "plate" BOOLEAN NOT NULL,
    "chassis" TEXT NOT NULL,
    "brandName" TEXT NOT NULL,
    "body" TEXT,
    "plateText" TEXT NOT NULL,
    "receiptNo" TEXT,

    CONSTRAINT "DeliverySlipItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DeliverySlip_slipNo_key" ON "DeliverySlip"("slipNo");

-- CreateIndex
CREATE INDEX "DeliverySlip_customerId_idx" ON "DeliverySlip"("customerId");

-- CreateIndex
CREATE INDEX "DeliverySlip_date_idx" ON "DeliverySlip"("date");

-- CreateIndex
CREATE INDEX "DeliverySlipItem_slipId_idx" ON "DeliverySlipItem"("slipId");

-- CreateIndex
CREATE INDEX "DeliverySlipItem_vehicleId_idx" ON "DeliverySlipItem"("vehicleId");

-- AddForeignKey
ALTER TABLE "DeliverySlip" ADD CONSTRAINT "DeliverySlip_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlip" ADD CONSTRAINT "DeliverySlip_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlipItem" ADD CONSTRAINT "DeliverySlipItem_slipId_fkey" FOREIGN KEY ("slipId") REFERENCES "DeliverySlip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlipItem" ADD CONSTRAINT "DeliverySlipItem_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill slips for deliveries saved before this table existed (Vehicle only kept the latest delivery state).
-- 1) Receipt + book delivery: one slip per (customer, deliveredDate, recipient, note). The note loses the
--    "ส่งป้าย dd/mm/yyyy ผู้รับ X" text that DeliveryService appended when the plate followed later.
CREATE TEMP TABLE "_dv" AS
SELECT v."id", v."customerId", v."deliveredDate", v."plateDeliveredDate",
       COALESCE(NULLIF(btrim(v."deliveryRecipient"), ''), 'ไม่ระบุ') AS recipient,
       NULLIF(btrim(regexp_replace(COALESCE(v."deliveryNote", ''), '( · )?ส่งป้าย [0-9/]+ ผู้รับ .*$', '')), '') AS note,
       COALESCE(NULLIF(btrim(substring(v."deliveryNote" from 'ส่งป้าย [0-9/]+ ผู้รับ ([^(·]+)')), ''), 'ไม่ระบุ') AS plate_recipient,
       v."chassis", b."name" AS brand_name, v."body",
       CASE WHEN v."plateCategory" IS NOT NULL AND v."plateNumber" IS NOT NULL THEN v."plateCategory" || ' ' || v."plateNumber" ELSE '' END AS plate_text,
       (SELECT d."receiptNo" FROM "DocumentSubmission" d WHERE d."vehicleId" = v."id" ORDER BY d."createdAt" DESC LIMIT 1) AS receipt_no,
       v."updatedAt"
FROM "Vehicle" v JOIN "Brand" b ON b."id" = v."brandId"
WHERE v."deliveredDate" IS NOT NULL;

INSERT INTO "DeliverySlip" ("id", "customerId", "date", "recipient", "note", "createdAt")
SELECT gen_random_uuid()::text, "customerId", "deliveredDate", recipient, note, MIN("updatedAt")
FROM "_dv"
GROUP BY "customerId", "deliveredDate", recipient, note
ORDER BY "deliveredDate", MIN("updatedAt");

INSERT INTO "DeliverySlipItem" ("id", "slipId", "vehicleId", "receipt", "book", "plate", "chassis", "brandName", "body", "plateText", "receiptNo")
SELECT gen_random_uuid()::text, s."id", dv."id", true, true, dv."plateDeliveredDate" IS NOT DISTINCT FROM dv."deliveredDate",
       dv."chassis", dv.brand_name, dv."body", dv.plate_text, dv.receipt_no
FROM "_dv" dv
JOIN "DeliverySlip" s ON s."customerId" = dv."customerId" AND s."date" = dv."deliveredDate"
  AND s."recipient" = dv.recipient AND s."note" IS NOT DISTINCT FROM dv.note;

-- 2) Plate sent later: one slip per (customer, plateDeliveredDate, recipient read back from the note).
CREATE TEMP TABLE "_plate_slip" AS
SELECT gen_random_uuid()::text AS id, "customerId", "plateDeliveredDate", plate_recipient, MIN("updatedAt") AS created_at
FROM "_dv"
WHERE "plateDeliveredDate" IS NOT NULL AND "plateDeliveredDate" <> "deliveredDate"
GROUP BY "customerId", "plateDeliveredDate", plate_recipient;

INSERT INTO "DeliverySlip" ("id", "customerId", "date", "recipient", "createdAt")
SELECT id, "customerId", "plateDeliveredDate", plate_recipient, created_at FROM "_plate_slip"
ORDER BY "plateDeliveredDate", created_at;

INSERT INTO "DeliverySlipItem" ("id", "slipId", "vehicleId", "receipt", "book", "plate", "chassis", "brandName", "body", "plateText", "receiptNo")
SELECT gen_random_uuid()::text, ps.id, dv."id", false, false, true, dv."chassis", dv.brand_name, dv."body", dv.plate_text, dv.receipt_no
FROM "_dv" dv
JOIN "_plate_slip" ps ON ps."customerId" = dv."customerId" AND ps."plateDeliveredDate" = dv."plateDeliveredDate"
  AND ps.plate_recipient = dv.plate_recipient
WHERE dv."plateDeliveredDate" <> dv."deliveredDate";

DROP TABLE "_plate_slip";
DROP TABLE "_dv";
