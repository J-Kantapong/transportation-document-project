-- ใบแทนคู่มือจดทะเบียน (กรณีเล่มเต็ม) ในงานต่อภาษี (additive)
ALTER TABLE "TaxRenewal" ADD COLUMN "bookReplacement" BOOLEAN NOT NULL DEFAULT false;
