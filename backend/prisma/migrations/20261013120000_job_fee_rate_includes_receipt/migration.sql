-- JobFeeRate.includesReceipt: ราคาเหมารวมค่าใบเสร็จแล้ว (YMAC) ค่าบริการ = ราคา - ใบเสร็จจริงของงานนั้น (เพิ่มอย่างเดียว)
ALTER TABLE "JobFeeRate" ADD COLUMN "includesReceipt" BOOLEAN NOT NULL DEFAULT false;
