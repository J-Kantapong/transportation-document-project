"use client";

import { ChoiceMenu, type Choice } from "@/components/ChoiceMenu";
import { plateSwapSubtasks } from "@/lib/categories";

// ผู้ใช้ 2026-09-28: แยกรถยนต์/รถจักรยานยนต์ก่อน แล้วค่อยแตกเป็น รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า ในแต่ละประเภท
// แสดงเฉพาะประเภทที่บทบาทเข้างานย่อยได้ - เหลือประเภทเดียว (เช่น STAFF_CAR) ข้ามไปหน้าประเภทนั้นเลย
const CHOICES: Choice[] = [
  {
    title: "รถยนต์",
    href: "/registration/plate-swap/car",
    accessHrefs: plateSwapSubtasks("car").map((t) => t.href),
  },
  {
    title: "รถจักรยานยนต์",
    href: "/registration/plate-swap/moto",
    accessHrefs: plateSwapSubtasks("moto").map((t) => t.href),
  },
];

export default function PlateSwapPage() {
  return <ChoiceMenu title="การสลับเลข" choices={CHOICES} />;
}
