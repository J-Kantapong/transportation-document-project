"use client";

import { VehicleKindChooser } from "@/components/VehicleKindChooser";

export default function ReceivePlateChooserPage() {
  return (
    <VehicleKindChooser
      title="รับป้ายทะเบียน"
      basePath="/registration/new-vehicle/receive-plate"
    />
  );
}
