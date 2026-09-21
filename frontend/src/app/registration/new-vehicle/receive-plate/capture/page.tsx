"use client";

import { PlatePhotoPanel } from "@/components/PlatePhotoPanel";

// หน้าถ่ายรูปป้ายบนมือถือ - คนที่ถือป้ายอยู่ถ่ายแล้วยืนยันได้ทันที (หรือปล่อยให้ออฟฟิศยืนยันจากหน้ารับป้ายทะเบียน)
export default function PlateCaptureRoute() {
  return (
    <section className="content">
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 12 }}>ถ่ายรูปป้ายทะเบียน</h1>
        <PlatePhotoPanel compact />
      </div>
    </section>
  );
}
