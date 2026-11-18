import { VehicleTransferMenu } from "@/components/VehicleTransferMenu";

// โอนย้ายเข้า (ผู้ใช้ 2026-11-18): ยื่น -> ตรวจรถ -> รับใบเสร็จ (กรอกทะเบียนใหม่ของจังหวัดที่ย้ายเข้า)
export default function TransferMoveInPage() {
  return <VehicleTransferMenu transferType="MOVE_IN" />;
}
