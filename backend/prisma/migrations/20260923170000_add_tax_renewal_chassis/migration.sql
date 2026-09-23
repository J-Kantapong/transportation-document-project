-- เลขตัวถัง (บังคับ) และเลขเครื่อง (ไม่บังคับ) ของงานต่อภาษี - ผู้ใช้กำหนด 2026-09-23
-- ตาราง TaxRenewal เพิ่งสร้างและยังไม่มีแถวในทุก environment จึงเติม NOT NULL ได้ตรงๆ
-- DEFAULT '' ใส่ไว้เพื่อให้ ALTER ผ่านแม้มีแถวค้างอยู่ แล้วถอดออกทันทีเพื่อไม่ให้บันทึกใหม่เลี่ยงการกรอกได้
ALTER TABLE "TaxRenewal" ADD COLUMN "chassis" TEXT NOT NULL DEFAULT '';
ALTER TABLE "TaxRenewal" ALTER COLUMN "chassis" DROP DEFAULT;
ALTER TABLE "TaxRenewal" ADD COLUMN "engine" TEXT;
