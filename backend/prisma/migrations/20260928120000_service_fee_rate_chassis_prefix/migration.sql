-- ผู้ใช้ 2026-09-28: ราคาแยกตามเลขตัวถังขึ้นต้น (MC Superbike: ML/JH ราคาต่างกันแต่ CC ทับซ้อนกัน) - คอลัมน์เดียว เว้นว่างได้
ALTER TABLE "ServiceFeeRate" ADD COLUMN "chassisPrefix" TEXT;
