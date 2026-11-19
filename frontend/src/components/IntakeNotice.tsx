// แถบแจ้งในฟอร์มยื่นว่าเติมข้อมูลจากการรับงานของหน้ารวมงานรถเก่าให้แล้ว (คู่กับ lib/use-intake-prefill.ts)
// เปิดหน้ายื่นตรงๆ โดยไม่มี ?intake = แถบบอกให้เริ่มจากหน้ารวมงานรถเก่า (รับงานทางเดียว ผู้ใช้ 2026-11-19)
import Link from "next/link";
import { Notice } from "./ui";
import type { IntakeState } from "@/lib/use-intake-prefill";

export function IntakeNotice({ state }: { state: IntakeState }) {
  if (state.missing) {
    return (
      <Notice tone="info" action={<Link href="/registration/old-vehicle">ไปหน้างานรถเก่า</Link>}>
        งานเก่า: ให้เพิ่มรถเข้าระบบก่อนที่เมนู &quot;งานรถเก่า&quot; (กดรับงาน) แล้วค่อยยื่นจากแถวงาน - ยื่นจากหน้านี้ตรงๆ ระบบจะไม่รับ
      </Notice>
    );
  }
  if (!state.notice) return null;
  return <Notice tone={state.error ? "error" : "success"}>{state.notice}</Notice>;
}
