"use client";

import { ChoiceMenu } from "@/components/ChoiceMenu";
import { MOVE_OUT_VEHICLE_KINDS } from "@/lib/categories";

// ย้ายออก (ผู้ใช้ 2026-10-06): แยกรถยนต์/รถจักรยานยนต์ก่อน เหมือนการสลับเลข
// แสดงเฉพาะประเภทรถที่บทบาทเข้าได้ และข้ามไปหน้าประเภทนั้นเลยถ้าเหลือประเภทเดียว
export default function MoveOutKindPage() {
  return (
    <ChoiceMenu
      title="ย้ายออก"
      back={{ href: "/registration/other", label: "อื่นๆ" }}
      choices={MOVE_OUT_VEHICLE_KINDS}
    />
  );
}
