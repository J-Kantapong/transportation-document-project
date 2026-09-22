"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { isoToDisplayDate } from "@/lib/date";
import { readDraftSummary, type DraftSummary } from "@/lib/submit-documents-draft";

const SUBMIT_HREF = "/registration/new-vehicle/submit-documents/submit";
const RECORDS_HREF = "/registration/new-vehicle/submit-documents/records";

// เมนูของขั้นตอนยื่นเอกสาร - ผู้ใช้ 2026-09-22: ปุ่ม "ยื่นเอกสารจดทะเบียนรถ" และ "ดูข้อมูลที่ยื่นแล้ว" ต้องเป็นการเข้าหน้าถัดไป
// (คนละ URL) ให้กด back ของเบราว์เซอร์กลับมาหน้านี้ได้ จึงเป็น Link แทนการสลับ phase ในหน้าเดียว
export default function SubmitDocumentsMenuPage() {
  // ร่างรายการที่บันทึกไว้ยังไม่ได้ยื่น (จาก localStorage) - อ่านหลัง mount เพราะตอน render ฝั่ง server ไม่มี window
  const [draft, setDraft] = useState<DraftSummary | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDraft(readDraftSummary());
  }, []);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ยื่นเอกสารจดทะเบียนรถใหม่</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        เลือกรถจากคิวที่แจ้งย้าย/ตัดบัญชีและตรวจรถผ่านแล้ว (ผลตรวจมีอายุ 90 วัน) กรองตามวันที่ตรวจ ยี่ห้อ เจ้าของงาน แล้วยืนยันยื่นเอกสาร
      </p>

      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          {draft && (
            <div className="customer-message" role="status" style={{ marginBottom: 6 }}>
              มีรายการที่บันทึกไว้ยังไม่ได้ยื่น {draft.count} คัน (วันที่ยื่น {isoToDisplayDate(draft.submitDate)}) ·{" "}
              <Link href={`${SUBMIT_HREF}?view=batch`} className="text-button">
                ดูรายการ →
              </Link>
            </div>
          )}
          <Link href={SUBMIT_HREF}>
            <strong>ยื่นเอกสารจดทะเบียนรถ</strong>
            <div className="muted">เลือกรถจากคิวรถที่ตรวจผ่านแล้ว</div>
          </Link>
          <Link href={RECORDS_HREF}>
            <strong>ดูข้อมูลที่ยื่นแล้ว</strong>
            <div className="muted">ดูรายการที่ยื่นแล้ว แยกรถยนต์ / มอเตอร์ไซค์ ตามแบบใบส่งงาน</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
