"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, type DocumentSubmission } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { JobSheetPrintDialog } from "@/components/JobSheetPrintDialog";
import { classify, GroupTable } from "@/components/SubmittedRecordsView";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { PICK_HREF, RECORDS_HREF, SETTINGS_HREF } from "@/components/submit-flow/shared";
import type { JobSheetKind } from "@/lib/job-sheet-print";

// ขั้น 4 ยื่นแล้ว (ผู้ใช้ 2026-09-25): รถทุกคันที่เพิ่งยื่นในรอบนี้ แยกกลุ่มตามแบบใบส่งงาน (รถยนต์ รย.1 ธรรมดา/ด่วน,
// รย.2+3 / มอเตอร์ไซค์ ธรรมดา/ด่วน) แต่ละกลุ่มมีปุ่มปริ้นใบส่งงาน - ใช้หน้าต่างพิมพ์ตัวเดียวกับหน้าดูข้อมูลที่ยื่นแล้ว
// คันที่ยื่นไม่สำเร็จแสดงพร้อมเหตุผล และยังอยู่ในที่เลือก กลับไปแก้แล้วยื่นใหม่ได้

interface PrintGroup {
  kind: JobSheetKind;
  urgent: boolean;
  title: string;
  rows: DocumentSubmission[];
  note: string;
}

export default function SubmitDonePage() {
  const router = useRouter();
  const { result, setResult, clearSelection, selected } = useSubmitFlow();
  const [records, setRecords] = useState<DocumentSubmission[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [printGroup, setPrintGroup] = useState<PrintGroup | null>(null);

  // ข้อมูลที่ยื่นแล้วแบบเต็ม (ลูกค้า/เจ้าของรถ/ยอด ที่ใบส่งงานใช้) โหลดจากรายการยื่นของวันนั้น แล้วเก็บเฉพาะคันในรอบนี้
  useEffect(() => {
    if (!result || result.succeeded.length === 0) return;
    let cancelled = false;
    const ids = new Set(result.succeeded.map((v) => v.id));
    api
      .listDocumentSubmissions(result.submitDate)
      .then(({ submissions }) => {
        if (cancelled) return;
        setLoadError("");
        setRecords(
          submissions
            .filter((s) => ids.has(s.vehicleId) && s.status === "PENDING")
            .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
        );
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : "โหลดรายการที่ยื่นไม่สำเร็จ"));
    return () => {
      cancelled = true;
    };
  }, [result, reload]);

  if (!result) {
    return (
      <section className="panel empty-page">
        <p style={{ margin: "0 0 12px" }}>ยังไม่มีผลการยื่นในรอบนี้</p>
        <Link href={PICK_HREF} className="primary" style={{ display: "inline-flex" }}>
          ← ไปเลือกรถ
        </Link>
      </section>
    );
  }

  function startNext() {
    setResult(null);
    clearSelection();
    router.push(PICK_HREF);
  }

  const rows = records ?? [];
  const car1 = rows.filter((r) => classify(r.vehicle.body) === "car1");
  type Group = PrintGroup & { showUrgent: boolean; printable: boolean };
  const allGroups: Group[] = [
    { kind: "car", urgent: false, title: "รถยนต์ · รย.1 แบบธรรมดา", rows: car1.filter((r) => !r.urgent), note: "", showUrgent: false, printable: true },
    { kind: "car", urgent: true, title: "รถยนต์ · รย.1 แบบด่วน", rows: car1.filter((r) => r.urgent), note: "ด่วน", showUrgent: false, printable: true },
    { kind: "car", urgent: false, title: "รถยนต์ · รย.2 และ รย.3", rows: rows.filter((r) => classify(r.vehicle.body) === "car23"), note: "", showUrgent: true, printable: true },
    { kind: "moto", urgent: false, title: "มอเตอร์ไซค์ แบบธรรมดา", rows: rows.filter((r) => classify(r.vehicle.body) === "moto" && !r.urgent), note: "", showUrgent: false, printable: true },
    { kind: "moto", urgent: true, title: "มอเตอร์ไซค์ แบบด่วน", rows: rows.filter((r) => classify(r.vehicle.body) === "moto" && r.urgent), note: "", showUrgent: false, printable: true },
    { kind: "car", urgent: false, title: "ไม่ระบุประเภทรถ", rows: rows.filter((r) => classify(r.vehicle.body) === "unknown"), note: "", showUrgent: true, printable: false },
  ];
  const groups = allGroups.filter((g) => g.rows.length > 0);

  return (
    <>
      <section className="panel" style={{ padding: 22, marginBottom: 16 }}>
        <p style={{ margin: "0 0 4px", fontSize: 17, fontWeight: 600 }}>
          {result.succeeded.length > 0 ? `ยื่นแล้ว ${result.succeeded.length} คัน` : "ยังไม่ได้ยื่นคันไหนเลย"}
          {result.failed.length > 0 && <span style={{ color: "#b43434", fontWeight: 500 }}> · ไม่สำเร็จ {result.failed.length} คัน</span>}
        </p>
        <p className="muted" style={{ margin: 0 }}>
          วันที่ยื่นเอกสาร {isoToDisplayDate(result.submitDate)} · กด &quot;ปริ้นใบส่งงาน&quot; ของแต่ละกลุ่มเพื่อพิมพ์ตามแบบรถยนต์ / มอเตอร์ไซค์
        </p>
      </section>

      {result.failed.length > 0 && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <div className="panel-head">
            <h2>
              ยื่นไม่สำเร็จ <span className="muted">· {result.failed.length} คัน</span>
            </h2>
            {selected.length > 0 && (
              <Link href={SETTINGS_HREF} className="text-button">
                ← กลับไปแก้แล้วยื่นใหม่ ({selected.length} คัน)
              </Link>
            )}
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>เลขตัวถัง</th>
                  <th>เจ้าของงาน</th>
                  <th>สาเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {result.failed.map((f) => (
                  <tr key={f.vehicle.id} className="row-failed">
                    <td>{f.vehicle.chassis}</td>
                    <td>{f.vehicle.customerName}</td>
                    <td style={{ whiteSpace: "normal" }}>{f.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {result.succeeded.length > 0 &&
        (loadError ? (
          <section className="panel empty-page" role="alert">
            <p className="customer-message error" style={{ marginBottom: 12 }}>
              ยื่นสำเร็จแล้ว แต่โหลดรายการสำหรับพิมพ์ไม่สำเร็จ: {loadError}
            </p>
            <button type="button" className="primary" onClick={() => setReload((n) => n + 1)}>
              ลองใหม่
            </button>
          </section>
        ) : records === null ? (
          <section className="panel empty-page">กำลังโหลดรายการที่เพิ่งยื่น…</section>
        ) : (
          groups.map((g) => (
            <GroupTable
              key={g.title}
              title={g.title}
              rows={g.rows}
              showUrgent={g.showUrgent}
              onPrint={g.printable ? () => setPrintGroup(g) : undefined}
            />
          ))
        ))}

      <div className="submit-footer">
        <Link href={RECORDS_HREF} className="text-button">
          ดูข้อมูลที่ยื่นแล้วทั้งหมด →
        </Link>
        <button type="button" className="primary" onClick={startNext}>
          ยื่นชุดต่อไป
        </button>
      </div>

      {printGroup && (
        <JobSheetPrintDialog
          key={printGroup.title}
          kind={printGroup.kind}
          urgent={printGroup.urgent}
          groupTitle={printGroup.title}
          rows={printGroup.rows}
          defaultNote={printGroup.note}
          onClose={() => setPrintGroup(null)}
        />
      )}
    </>
  );
}
