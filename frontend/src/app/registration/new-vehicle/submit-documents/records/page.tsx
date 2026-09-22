"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type DocumentSubmission } from "@/lib/api";
import { SubmittedRecordsView } from "@/components/SubmittedRecordsView";

// ดูข้อมูลที่ยื่นแล้ว - แยกเป็นหน้าของตัวเอง (ผู้ใช้ 2026-09-22: กดจากเมนูแล้วเข้าหน้าถัดไป กด back ของเบราว์เซอร์กลับได้)
export default function SubmitDocumentsRecordsPage() {
  const [records, setRecords] = useState<DocumentSubmission[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api
      .listDocumentSubmissions()
      .then((r) => {
        if (!cancelled) setRecords(r.submissions);
      })
      .catch(() => {
        // ปล่อยรายการว่างไว้ - หน้านี้ไม่มีที่แสดง error message แยกสำหรับ records
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle/submit-documents" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ยื่นเอกสารจดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ดูข้อมูลที่ยื่นแล้ว</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        รายการที่ยื่นแล้ว แยกรถยนต์ / มอเตอร์ไซค์ ตามแบบใบส่งงาน
      </p>
      <SubmittedRecordsView records={records} loading={loading} />
    </section>
  );
}
