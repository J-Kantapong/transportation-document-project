"use client";

import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { api, ApiError, type DocumentSubmission } from "@/lib/api";
import { SubmittedRecordsView } from "@/components/SubmittedRecordsView";
import { isInWriteScope, useWriteScope } from "@/components/submit-flow/shared";

type DateCount = { date: string; count: number };

// ดูข้อมูลที่ยื่นแล้ว - แยกเป็นหน้าของตัวเอง (ผู้ใช้ 2026-09-22: กดจากเมนูแล้วเข้าหน้าถัดไป กด back ของเบราว์เซอร์กลับได้)
// โหลดรายการวันที่ทั้งหมดก่อน แล้วโหลดรายการทีละวัน (พบ 2026-09-27: เดิมโหลด 2,000 รายการล่าสุดทีเดียว วันเก่าหายเงียบๆ
// และโหลดพลาดแล้วขึ้นว่ายังไม่มีข้อมูล) - ไม่มีตัวเลือก "ทุกวันที่" แล้ว
export default function SubmitDocumentsRecordsPage() {
  // ยกเลิกรายการที่ยื่นแล้วได้เฉพาะคนที่ยื่นเอกสารได้ (ADMIN / STAFF_CAR / STAFF_MOTO ตาม SUBMIT ใน access-policy.ts) และเฉพาะ
  // ประเภทรถที่บัญชีนั้นบันทึกได้ - ACCOUNTANT ดูอย่างเดียว (ตอน render ฝั่ง server ถือว่ายกเลิกไม่ได้)
  const writeScope = useWriteScope();
  const [dates, setDates] = useState<DateCount[]>([]);
  const [datesLoaded, setDatesLoaded] = useState(false);
  // undefined = ยังไม่ได้เลือก -> ใช้วันที่ล่าสุดที่มีข้อมูล
  const [dateChoice, setDateChoice] = useState<string | undefined>(undefined);
  const [records, setRecords] = useState<DocumentSubmission[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);

  const date = dateChoice !== undefined && dates.some((d) => d.date === dateChoice) ? dateChoice : (dates[0]?.date ?? "");

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการวันที่ตอนเปิดหน้า/กดลองใหม่
    setLoading(true);
    setLoadError("");
    api
      .listDocumentSubmissionDates()
      .then((r) => {
        if (cancelled) return;
        setDates(r.dates);
        setDatesLoaded(true);
        if (r.dates.length === 0) setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof ApiError ? err.message : "โหลดรายการวันที่ไม่สำเร็จ");
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  useEffect(() => {
    if (!datesLoaded || !date) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการของวันที่ที่เลือก
    setLoading(true);
    setLoadError("");
    // ล้างรายการของวันก่อน ไม่ให้พิมพ์ใบส่งงานของวันเดิมระหว่างที่วันใหม่ยังโหลดไม่เสร็จ
    setRecords([]);
    setTruncated(false);
    api
      .listDocumentSubmissions(date)
      .then((r) => {
        if (cancelled) return;
        setRecords(r.submissions);
        setTruncated(!!r.hasMore);
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : "โหลดรายการที่ยื่นไม่สำเร็จ"))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [datesLoaded, date, reload]);

  function removeRecord(id: string) {
    setRecords((prev) => prev.filter((r) => r.id !== id));
    setDates((prev) => prev.map((d) => (d.date === date ? { ...d, count: Math.max(0, d.count - 1) } : d)));
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle/submit-documents" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ยื่นเอกสารจดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ดูข้อมูลที่ยื่นแล้ว</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        รายการที่ยื่นแล้ว แยกรถยนต์ / มอเตอร์ไซค์ ตามแบบใบส่งงาน
      </p>
      {/* แท็บรถยนต์/มอเตอร์ไซค์อยู่ใน URL (useSearchParams ต้องอยู่ใต้ Suspense) */}
      <Suspense>
        <SubmittedRecordsView
          dates={dates}
          date={date}
          onDateChange={setDateChoice}
          records={date ? records : []}
          loading={loading}
          loadError={loadError}
          onRetry={() => setReload((n) => n + 1)}
          truncated={truncated}
          canCancel={writeScope === "NONE" ? undefined : (r) => isInWriteScope(writeScope, r.vehicle.body)}
          onRecordRemoved={removeRecord}
        />
      </Suspense>
    </section>
  );
}
