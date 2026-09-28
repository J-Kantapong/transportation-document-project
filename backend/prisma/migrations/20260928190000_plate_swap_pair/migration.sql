-- เคส "รถเก่า กับ รถเก่า" ของงานสลับเลข (ผู้ใช้ 2026-09-28: "ให้กรอกข้อมูลในหน้าเดียวเลย 2 คัน" แต่ "แยกเป็น 2 งานในระบบ")
-- pairId = งาน 2 แถวที่มาจากการยื่นสลับครั้งเดียวกันใช้ค่าเดียวกัน ทะเบียนของทั้งคู่ไขว้กัน (newPlate ของแถวนี้ = oldPlate ของคู่)
-- NULL = งาน OLD_NEW ซึ่งไม่มีคู่ - migration นี้เพิ่มอย่างเดียว ไม่แก้/ลบคอลัมน์เดิม และไม่เดาค่าให้งานเก่า

-- AlterTable
ALTER TABLE "PlateSwap" ADD COLUMN     "pairId" TEXT;

-- CreateIndex
CREATE INDEX "PlateSwap_pairId_idx" ON "PlateSwap"("pairId");
