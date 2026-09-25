"use client";

import { VehicleKindChooser } from "@/components/VehicleKindChooser";

export default function ReceiveBookChooserPage() {
  return (
    <VehicleKindChooser
      title="รับเล่มทะเบียน"
      basePath="/registration/new-vehicle/receive-book"
    />
  );
}
