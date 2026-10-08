-- ส่งงานลูกค้าสำหรับงานอื่นๆ (ผู้ใช้ 2026-10-08): งานโอน / ยกเลิกการใช้รถ / ย้ายออก / คัดแผ่นป้าย / ต่อภาษี ต้องส่งใบเสร็จให้ลูกค้า
-- เซ็นรับ (ใบ DL จากหน้า Delivery) ก่อนจึงวางบิลได้ เหมือนรถจดใหม่
ALTER TABLE "VehicleTransfer" ADD COLUMN "deliveredDate" TIMESTAMP(3), ADD COLUMN "deliveryRecipient" TEXT, ADD COLUMN "deliveryNote" TEXT;
ALTER TABLE "VehicleUseCancellation" ADD COLUMN "deliveredDate" TIMESTAMP(3), ADD COLUMN "deliveryRecipient" TEXT, ADD COLUMN "deliveryNote" TEXT;
ALTER TABLE "VehicleMoveOut" ADD COLUMN "deliveredDate" TIMESTAMP(3), ADD COLUMN "deliveryRecipient" TEXT, ADD COLUMN "deliveryNote" TEXT;
ALTER TABLE "PlateCopy" ADD COLUMN "deliveredDate" TIMESTAMP(3), ADD COLUMN "deliveryRecipient" TEXT, ADD COLUMN "deliveryNote" TEXT;
ALTER TABLE "TaxRenewal" ADD COLUMN "deliveryRecipient" TEXT, ADD COLUMN "deliveryNote" TEXT;

CREATE INDEX "VehicleTransfer_deliveredDate_idx" ON "VehicleTransfer"("deliveredDate");
CREATE INDEX "VehicleUseCancellation_deliveredDate_idx" ON "VehicleUseCancellation"("deliveredDate");
CREATE INDEX "VehicleMoveOut_deliveredDate_idx" ON "VehicleMoveOut"("deliveredDate");
CREATE INDEX "PlateCopy_deliveredDate_idx" ON "PlateCopy"("deliveredDate");

ALTER TABLE "DeliverySlipItem" ADD COLUMN "jobType" TEXT, ADD COLUMN "jobId" TEXT, ADD COLUMN "jobDetail" TEXT;
CREATE INDEX "DeliverySlipItem_jobType_jobId_idx" ON "DeliverySlipItem"("jobType", "jobId");

-- งานที่วางบิลไปแล้ว (อยู่ในบิลที่ไม่ VOID) ถือว่าส่งลูกค้าแล้วในวันที่รับใบเสร็จกลับ ไม่งั้นจะกลับไปเป็น "รอส่งงาน" ทั้งที่เก็บเงินแล้ว
-- งานที่รับใบเสร็จกลับแล้วแต่ยังไม่วางบิล ปล่อยว่างไว้ให้เข้าคิว Delivery (พนักงานลงส่งงานย้อนหลังได้)
UPDATE "VehicleTransfer" t SET "deliveredDate" = t."returnedDate"
WHERE t."returnedDate" IS NOT NULL AND t."deliveredDate" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceItem" i JOIN "Invoice" inv ON inv."id" = i."invoiceId" WHERE i."sourceType" = 'TRANSFER' AND i."sourceId" = t."id" AND inv."status" <> 'VOID');
UPDATE "VehicleUseCancellation" t SET "deliveredDate" = t."returnedDate"
WHERE t."returnedDate" IS NOT NULL AND t."deliveredDate" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceItem" i JOIN "Invoice" inv ON inv."id" = i."invoiceId" WHERE i."sourceType" = 'USE_CANCEL' AND i."sourceId" = t."id" AND inv."status" <> 'VOID');
UPDATE "VehicleMoveOut" t SET "deliveredDate" = t."returnedDate"
WHERE t."returnedDate" IS NOT NULL AND t."deliveredDate" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceItem" i JOIN "Invoice" inv ON inv."id" = i."invoiceId" WHERE i."sourceType" = 'MOVE_OUT' AND i."sourceId" = t."id" AND inv."status" <> 'VOID');
UPDATE "PlateCopy" t SET "deliveredDate" = COALESCE(GREATEST(t."returnedDate", t."plateReceivedDate"), t."returnedDate")
WHERE t."returnedDate" IS NOT NULL AND t."deliveredDate" IS NULL
  AND EXISTS (SELECT 1 FROM "InvoiceItem" i JOIN "Invoice" inv ON inv."id" = i."invoiceId" WHERE i."sourceType" = 'PLATE_COPY' AND i."sourceId" = t."id" AND inv."status" <> 'VOID');
