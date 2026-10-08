-- คัดแผ่นป้ายทะเบียน: เปิดมอเตอร์ไซค์ + งานด่วน (ผู้ใช้ 2026-10-09) - เพิ่มคอลัมน์อย่างเดียว แถวเดิม = ไม่ด่วน
ALTER TABLE "PlateCopy" ADD COLUMN "urgent" BOOLEAN NOT NULL DEFAULT false;
