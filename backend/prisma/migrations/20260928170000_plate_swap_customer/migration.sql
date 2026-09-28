-- เจ้าของงานของงานสลับเลข = ลูกค้าที่ส่งงานมาให้เรา (ผู้ใช้ 2026-09-28: "เพิ่มเจ้าของงานที่ดึงมาจากฐานข้อมูลลูกค้าด้วย
-- เวลาจะส่งงานหรือวางบิลจะได้วางถูก") - คนละคนกับ PlateSwap.oldOwnerName ซึ่งเป็นเจ้าของรถเก่าตามทะเบียน
-- (กฎเดียวกับ Vehicle.customerId กับ Vehicle.ownerId: ห้ามอนุมานจากกัน และ migration นี้ไม่เดาย้อนหลังให้งานเก่า)
-- คอลัมน์เป็น NULL ได้เพราะงานที่บันทึกไว้ก่อนวันนี้ยังไม่มีลูกค้า - งานที่บันทึกใหม่บังคับกรอกที่ชั้น service
-- migration นี้เพิ่มอย่างเดียว ไม่แก้/ลบคอลัมน์เดิม

-- AlterTable
ALTER TABLE "PlateSwap" ADD COLUMN     "customerId" TEXT;

-- CreateIndex
CREATE INDEX "PlateSwap_customerId_idx" ON "PlateSwap"("customerId");

-- AddForeignKey
ALTER TABLE "PlateSwap" ADD CONSTRAINT "PlateSwap_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
