"use client";

import { VehicleKindChooser } from "@/components/VehicleKindChooser";
import { useCanEditReceipts } from "@/components/ReceiptPhotos";

export default function ReceiveReceiptChooserPage() {
  // ลิงก์หน้าถ่ายใบเสร็จแสดงเฉพาะคนที่ส่งรูปได้ - ACCOUNTANT อ่านอย่างเดียว (พบ 2026-09-27)
  const canEdit = useCanEditReceipts();
  return (
    <VehicleKindChooser
      title="รับใบเสร็จ"
      basePath="/registration/new-vehicle/receive-receipt"
      capture={canEdit ? { href: "/registration/new-vehicle/receive-receipt/capture", label: "📷 ถ่ายใบเสร็จจากมือถือ" } : undefined}
    />
  );
}
