-- ยกเลิกใบส่งงาน / รายคันที่คีย์ผิด (ผู้ใช้ 2026-09-26): เก็บใบและรายการไว้พร้อมเหตุผล ไม่ลบ

-- AlterTable
ALTER TABLE "DeliverySlip" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "DeliverySlipItem" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AddForeignKey
ALTER TABLE "DeliverySlip" ADD CONSTRAINT "DeliverySlip_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliverySlipItem" ADD CONSTRAINT "DeliverySlipItem_cancelledById_fkey" FOREIGN KEY ("cancelledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
