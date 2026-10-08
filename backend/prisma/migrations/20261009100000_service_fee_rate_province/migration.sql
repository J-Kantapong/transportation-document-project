-- ราคาแยกตามจังหวัดที่จดทะเบียน / ประเภทรถ ในตารางค่าดำเนินการ (ผู้ใช้ 2026-10-09, บางบ่ออารียนต์: จดสมุทรปราการ 935, ป้ายเหลือง รย.17 1,400)
ALTER TABLE "ServiceFeeRate" ADD COLUMN "registrationProvince" TEXT, ADD COLUMN "bodyPrefix" TEXT;
