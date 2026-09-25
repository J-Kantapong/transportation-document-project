"use client";

import { VehicleKindChooser } from "@/components/VehicleKindChooser";

export default function ReceiveReceiptChooserPage() {
  return (
    <VehicleKindChooser
      title="รับใบเสร็จ"
      basePath="/registration/new-vehicle/receive-receipt"
      capture={{ href: "/registration/new-vehicle/receive-receipt/capture", label: "📷 ถ่ายใบเสร็จจากมือถือ" }}
    />
  );
}
