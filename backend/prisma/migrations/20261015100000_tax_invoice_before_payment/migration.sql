-- ออกใบกำกับภาษีก่อนรับเงิน (ผู้ใช้ 2026-10-15, ยามาฮ่า) - เพิ่มคอลัมน์อย่างเดียว ข้อมูลเดิมไม่เปลี่ยน
ALTER TABLE "Customer" ADD COLUMN "billingTaxInvoiceBeforePayment" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "TaxInvoice" ADD COLUMN "beforePayment" BOOLEAN NOT NULL DEFAULT false;
