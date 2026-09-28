-- ส่งงานสลับเลขคืนลูกค้า (ผู้ใช้ 2026-09-28: "สลับเลขลืม Delivery")
-- ใบส่งงานใบเดียวกับงานจดทะเบียนใหม่ได้ จึงผ่อน DeliverySlipItem.vehicleId เป็น NULL แล้วเพิ่ม plateSwapId
-- แถวหนึ่งต้องมีอย่างใดอย่างหนึ่งเท่านั้น - Prisma บังคับ XOR ไม่ได้ จึงบังคับที่ชั้น service
-- vehicleKind เก็บ car|moto ไว้ตัดสินขอบเขตสิทธิ์ (เดิมดูจาก body ซึ่งงานสลับเลขไม่มี ปล่อยว่างจะตีเป็นรถยนต์
-- ทำให้งานมอเตอร์ไซค์หลุดไปอยู่ในขอบเขต STAFF_CAR) / ownerName เก็บชื่อเจ้าของของแถวสลับเลขไว้ปริ้นใบ
-- migration นี้ไม่ลบข้อมูลเดิม: แถวเก่ายังมี vehicleId ครบ ส่วน vehicleKind/ownerName เป็น NULL แล้วโค้ดดู body แทน

-- AlterTable: ผ่อน vehicleId ให้ว่างได้ + คอลัมน์ใหม่
ALTER TABLE "DeliverySlipItem" ALTER COLUMN "vehicleId" DROP NOT NULL;
ALTER TABLE "DeliverySlipItem" ADD COLUMN     "plateSwapId" TEXT,
ADD COLUMN     "vehicleKind" TEXT,
ADD COLUMN     "ownerName" TEXT;

-- CreateIndex
CREATE INDEX "DeliverySlipItem_plateSwapId_idx" ON "DeliverySlipItem"("plateSwapId");

-- AddForeignKey
ALTER TABLE "DeliverySlipItem" ADD CONSTRAINT "DeliverySlipItem_plateSwapId_fkey" FOREIGN KEY ("plateSwapId") REFERENCES "PlateSwap"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable: สถานะส่งงานของงานสลับเลข (ชุดเดียวกับ Vehicle เพื่อให้กฎส่งเล่มก่อน-ป้ายตามทีหลังเหมือนกัน)
ALTER TABLE "PlateSwap" ADD COLUMN     "deliveredDate" TIMESTAMP(3),
ADD COLUMN     "deliveryRecipient" TEXT,
ADD COLUMN     "deliveryNote" TEXT,
ADD COLUMN     "plateDeliveredDate" TIMESTAMP(3);
