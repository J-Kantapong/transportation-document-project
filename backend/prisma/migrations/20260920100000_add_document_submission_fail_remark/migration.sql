-- ยื่นไม่สำเร็จ (FAILED) ต้องมีเหตุผลทุกครั้ง - แสดงในคิวรอยื่นเอกสารเมื่อรถกลับมาทำ Step 4 ใหม่
-- Rows already marked FAILED before this change keep NULL.

-- AlterTable
ALTER TABLE "DocumentSubmission" ADD COLUMN "failRemark" TEXT;
