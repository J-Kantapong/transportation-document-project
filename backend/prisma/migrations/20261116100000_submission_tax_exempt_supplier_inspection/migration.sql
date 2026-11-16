-- รถยกเว้นภาษี + ซับนำรถเข้าตรวจหรือไม่ (ตัวเลือกตอนยื่นเอกสาร / ส่งงานให้ซับ) - additive
ALTER TABLE "DocumentSubmission" ADD COLUMN "taxExempt" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DocumentSubmission" ADD COLUMN "supplierInspection" BOOLEAN NOT NULL DEFAULT true;
