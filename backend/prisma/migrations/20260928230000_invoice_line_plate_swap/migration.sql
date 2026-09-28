-- วางบิลงานสลับเลข (ผู้ใช้ 2026-09-28): รถใหม่ที่รับเลขจากรถเก่าต้องเก็บค่าใบเสร็จกรมฯ ของรถเก่าด้วย
-- ผู้ใช้เลือก "แยกเก็บ" ไม่รวมเป็นยอดเดียวกับ receiptAmount เพื่อให้ย้อนตรวจได้ว่ามาจากงานสลับเลขไหน ยอดเท่าไร
-- (ยอดค่าธรรมเนียมบนบิล = receiptAmount + swapReceiptAmount)
-- migration นี้เพิ่มอย่างเดียว: บรรทัดบิลเก่าทั้งหมดเป็น NULL แล้วคิดเหมือนเดิมทุกประการ

ALTER TABLE "InvoiceLine" ADD COLUMN     "plateSwapId" TEXT,
ADD COLUMN     "swapReceiptAmount" DECIMAL(12,2);

CREATE INDEX "InvoiceLine_plateSwapId_idx" ON "InvoiceLine"("plateSwapId");

ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_plateSwapId_fkey" FOREIGN KEY ("plateSwapId") REFERENCES "PlateSwap"("id") ON DELETE SET NULL ON UPDATE CASCADE;
