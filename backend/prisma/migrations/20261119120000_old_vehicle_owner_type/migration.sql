-- ประเภทเจ้าของรถ + ติดไฟแนนซ์ ตอนรับงานรถเก่า (additive)
ALTER TABLE "OldVehicle" ADD COLUMN "ownerType" "OwnerType";
ALTER TABLE "OldVehicle" ADD COLUMN "financed" BOOLEAN NOT NULL DEFAULT false;
