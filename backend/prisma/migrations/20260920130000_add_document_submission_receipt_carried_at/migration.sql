-- ตรวจใบยื่นในหน้ารับใบเสร็จแล้ว คันที่ยังไม่มีใบเสร็จและยังไม่รู้สาเหตุ ย้ายไปรายการ "ค้างจากใบก่อน"
-- NULL = ยังอยู่ในใบยื่นเดิม (ยังไม่ได้ตรวจ)

-- AlterTable
ALTER TABLE "DocumentSubmission" ADD COLUMN "receiptCarriedAt" TIMESTAMP(3);
