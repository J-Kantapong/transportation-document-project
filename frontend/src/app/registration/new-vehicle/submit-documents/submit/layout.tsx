import type { ReactNode } from "react";
import { SubmitFlowHeader } from "@/components/submit-flow/SubmitFlowHeader";
import { SubmitFlowProvider } from "@/components/submit-flow/SubmitFlowContext";

// ยื่นเอกสาร 3 ขั้น (ผู้ใช้ 2026-09-25): /submit = เลือกรถ, /submit/review = ตรวจทานและตั้งค่า, /submit/done = ผลการยื่น
// layout ไม่ถูกสร้างใหม่ตอนเปลี่ยนหน้าระหว่างขั้น state ของรถที่เลือก/การตั้งค่าจึงอยู่ครบเมื่อกดย้อนกลับ
export default function SubmitFlowLayout({ children }: { children: ReactNode }) {
  return (
    <SubmitFlowProvider>
      <section className="content">
        <SubmitFlowHeader />
        {children}
      </section>
    </SubmitFlowProvider>
  );
}
