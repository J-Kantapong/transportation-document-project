"use client";

import { BookPhotoPanel } from "@/components/BookPhotoPanel";

// หน้าถ่ายรูปเล่มทะเบียนบนมือถือ - คนที่ถือเล่มอยู่ถ่ายแล้วยืนยันได้ทันที (หรือปล่อยให้ออฟฟิศยืนยันจากหน้ารับเล่มทะเบียน)
export default function BookCaptureRoute() {
  return (
    <section className="content">
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, marginBottom: 14 }}>ถ่ายรูปเล่มทะเบียน</h1>
        <BookPhotoPanel compact />
      </div>
    </section>
  );
}
