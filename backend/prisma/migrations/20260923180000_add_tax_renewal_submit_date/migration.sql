-- วันที่ยื่นงานของงานต่อภาษี - ผู้ใช้กำหนด 2026-09-23
-- ตาราง TaxRenewal ยังไม่มีแถวในทุก environment จึงเติม NOT NULL ได้ตรงๆ
-- DEFAULT ใส่ไว้ให้ ALTER ผ่านแม้มีแถวค้าง แล้วถอดออกทันทีเพื่อไม่ให้บันทึกใหม่เลี่ยงการกรอกได้
ALTER TABLE "TaxRenewal" ADD COLUMN "submitDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "TaxRenewal" ALTER COLUMN "submitDate" DROP DEFAULT;
