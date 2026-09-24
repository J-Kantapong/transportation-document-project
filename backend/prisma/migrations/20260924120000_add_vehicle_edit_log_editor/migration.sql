-- บันทึกว่าใครเป็นคนแก้ในประวัติการแก้ไขข้อมูลรถ (ผู้ใช้ 2026-09-24) - แถวเก่าเป็น NULL (ไม่รู้ผู้แก้)
-- AlterTable
ALTER TABLE "VehicleEditLog" ADD COLUMN     "editedById" TEXT;

-- CreateIndex
CREATE INDEX "VehicleEditLog_editedById_idx" ON "VehicleEditLog"("editedById");

-- AddForeignKey
ALTER TABLE "VehicleEditLog" ADD CONSTRAINT "VehicleEditLog_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
