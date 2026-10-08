import { redirect } from "next/navigation";

// หน้า Delivery ย้ายไป /delivery (ผู้ใช้ 2026-10-08: เป็นขั้นร่วมของทุกงาน ไม่ใช่เฉพาะรถจดใหม่) - ลิงก์เก่ายังเปิดได้
export default function Page() {
  redirect("/delivery");
}
