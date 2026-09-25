import { redirect } from "next/navigation";

// หน้าถ่ายรูปบนมือถือเดิม (ถาดรูปให้ AI จับคู่) ยกเลิกแล้ว (ผู้ใช้ 2026-09-26) - แนบรูปทีละคันจากคิวแทน ลิงก์/บุ๊กมาร์กเก่ามาที่หน้าเลือกประเภทรถ
export default function ReceiveBookCaptureRedirect() {
  redirect("/registration/new-vehicle/receive-book");
}
