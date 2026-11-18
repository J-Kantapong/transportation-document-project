-- ใบเสนอราคา: ผูกบรรทัดกับงานที่ดึงมา (ผู้ใช้ 2026-11-18 - งานโอนย้ายเข้า) เหมือน InvoiceItem.sourceType/sourceId ไม่มี FK
-- ใช้กันเสนอราคาซ้ำ และให้งานหลุดจากคิววางบิลงานอื่นๆ เองเมื่อใบเสนอราคาออกเลข/ออกบิลแล้ว - เพิ่มคอลัมน์อย่างเดียว บรรทัดเดิมเป็น NULL
ALTER TABLE "QuotationItem" ADD COLUMN "sourceType" TEXT;
ALTER TABLE "QuotationItem" ADD COLUMN "sourceId" TEXT;
CREATE INDEX "QuotationItem_sourceType_sourceId_idx" ON "QuotationItem"("sourceType", "sourceId");
