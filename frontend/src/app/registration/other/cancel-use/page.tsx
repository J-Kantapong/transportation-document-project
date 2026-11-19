"use client";

import { ChoiceMenu } from "@/components/ChoiceMenu";
import { CANCEL_USE_VEHICLE_KINDS } from "@/lib/categories";

// ยกเลิกการใช้รถ (ผู้ใช้ 2026-10-02): แยกรถยนต์/รถจักรยานยนต์ก่อน เหมือนการสลับเลข
// แสดงเฉพาะประเภทรถที่บทบาทเข้าได้ และข้ามไปหน้าประเภทนั้นเลยถ้าเหลือประเภทเดียว
export default function CancelUseKindPage() {
  return (
    <ChoiceMenu
      title="ยกเลิกการใช้รถ"
      back={{ href: "/registration/other", label: "อื่นๆ" }}
      choices={CANCEL_USE_VEHICLE_KINDS}
    />
  );
}
