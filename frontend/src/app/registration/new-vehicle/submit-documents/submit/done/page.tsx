"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, ApiError, type DocumentSubmission } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";
import { defaultTitleFor, JobSheetPrintDialog } from "@/components/JobSheetPrintDialog";
import { classify, GroupTable } from "@/components/SubmittedRecordsView";
import { useSubmitFlow } from "@/components/submit-flow/SubmitFlowContext";
import { compareSubmittedOrder, isMotoBody, PICK_HREF, RECORDS_HREF, SETTINGS_HREF } from "@/components/submit-flow/shared";
import { buildJobSheets, jobSheetPageCount, printJobSheets, type JobSheetKind } from "@/lib/job-sheet-print";

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

type Group = PrintGroup & { showUrgent: boolean; printable: boolean };

function buildGroups(rows: DocumentSubmission[]): Group[] {
  const car1 = rows.filter((r) => classify(r.vehicle.body) === "car1");
  const allGroups: Group[] = [
    { kind: "car", urgent: false, title: "รถยนต์ · รย.1 แบบธรรมดา", rows: car1.filter((r) => !r.urgent), note: "", showUrgent: false, printable: true },
    { kind: "car", urgent: true, title: "รถยนต์ · รย.1 แบบด่วน", rows: car1.filter((r) => r.urgent), note: "ด่วน", showUrgent: false, printable: true },
    { kind: "car", urgent: false, title: "รถยนต์ · รย.2 และ รย.3", rows: rows.filter((r) => classify(r.vehicle.body) === "car23"), note: "", showUrgent: true, printable: true },
    { kind: "moto", urgent: false, title: "มอเตอร์ไซค์ แบบธรรมดา", rows: rows.filter((r) => classify(r.vehicle.body) === "moto" && !r.urgent), note: "", showUrgent: false, printable: true },
    { kind: "moto", urgent: true, title: "มอเตอร์ไซค์ แบบด่วน", rows: rows.filter((r) => classify(r.vehicle.body) === "moto" && r.urgent), note: "", showUrgent: false, printable: true },
    { kind: "car", urgent: false, title: "ไม่ระบุประเภทรถ", rows: rows.filter((r) => classify(r.vehicle.body) === "unknown"), note: "", showUrgent: true, printable: false },
  ];
  return allGroups.filter((g) => g.rows.length > 0);
}

// ผลการยื่นที่ถามปริ้นไปแล้ว - กลับมาหน้านี้อีก (เช่น ไปหน้าอื่นแล้วกดย้อนกลับ) ไม่เด้งถามซ้ำ
const askedToPrint = new WeakSet<object>();

export default function SubmitDonePage() {
  const router = useRouter();
  const { result, setResult, clearSelection, selected } = useSubmitFlow();
  const [records, setRecords] = useState<DocumentSubmission[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [printGroup, setPrintGroup] = useState<PrintGroup | null>(null);
  const printAllRef = useRef<HTMLDialogElement>(null);
  // ใบ (กลุ่ม + เจ้าของงาน) ที่เอาติ๊กออกในป๊อปอัป - เริ่มต้นปริ้นทุกใบ
  const [skippedSheets, setSkippedSheets] = useState<Set<string>>(() => new Set());

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
        // ลำดับที่ยื่น = ลำดับที่เลือก (backend บันทึกทีละคันตามลำดับ) เวลาเท่ากันเรียงด้วย id ให้พิมพ์ได้ลำดับเดิมทุกครั้ง
        setRecords(submissions.filter((s) => ids.has(s.vehicleId) && s.status === "PENDING").sort(compareSubmittedOrder));
      })
      .catch((err) => !cancelled && setLoadError(err instanceof ApiError ? err.message : "โหลดรายการที่ยื่นไม่สำเร็จ"));
    return () => {
      cancelled = true;
    };
  }, [result, reload]);

  // ผู้ใช้ 2026-10-27: ยื่นเสร็จแล้วเด้งถามเลยว่าจะปริ้นใบส่งงานของคันที่เพิ่งยื่น (ยื่น 10 คัน = ปริ้น 10 คัน) หรือยกเลิก
  useEffect(() => {
    // จำว่าถามแล้วตอนปิดป๊อปอัป (onClose) ไม่ใช่ตอนเปิด - หน้าถูก mount ใหม่ระหว่างนั้นก็ยังเด้งถามอยู่
    const dialog = printAllRef.current;
    if (!result || !records || !dialog || dialog.open || askedToPrint.has(result)) return;
    if (!buildGroups(records).some((g) => g.printable)) return;
    dialog.showModal();
  }, [result, records]);

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

  const groups = buildGroups(records ?? []);
  const printable = groups.filter((g) => g.printable);
  const unprintableCount = groups.filter((g) => !g.printable).reduce((sum, g) => sum + g.rows.length, 0);
  // ทุกกลุ่มในงานพิมพ์เดียว 1 ใบต่อเจ้าของงาน: ชื่อหัวใบ/หมายเหตุเริ่มต้นแบบเดียวกับหน้าต่างปริ้นของแต่ละกลุ่ม
  // (อยากแก้ = ยกเลิกแล้วกดปริ้นทีละกลุ่ม) - กุญแจใบรวมชื่อกลุ่ม เพราะเจ้าของงานเดียวกันมีได้ทั้งใบธรรมดาและใบด่วน
  const sheetEntries = printable.flatMap((g) =>
    buildJobSheets(g.kind, g.rows, g.note, defaultTitleFor(g.kind, g.urgent)).map((sheet) => ({ id: `${g.title}|${sheet.key}`, group: g.title, sheet })),
  );
  const chosenSheets = sheetEntries.filter((e) => !skippedSheets.has(e.id)).map((e) => e.sheet);
  const chosenCount = chosenSheets.reduce((sum, s) => sum + s.rows.length, 0);
  const chosenPages = chosenSheets.reduce((sum, s) => sum + jobSheetPageCount(s), 0);

  function toggleSheet(id: string, on: boolean) {
    setSkippedSheets((prev) => {
      const next = new Set(prev);
      if (on) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function printAll() {
    printJobSheets(chosenSheets);
    printAllRef.current?.close();
  }

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
        {/* ยื่นแต่มอเตอร์ไซค์ = เปิดแท็บมอเตอร์ไซค์ของหน้าดูข้อมูลที่ยื่นแล้วเลย */}
        <Link
          href={result.succeeded.length > 0 && result.succeeded.every((v) => isMotoBody(v.body)) ? `${RECORDS_HREF}?tab=moto` : RECORDS_HREF}
          className="text-button"
        >
          ดูข้อมูลที่ยื่นแล้วทั้งหมด →
        </Link>
        <button type="button" className="primary" onClick={startNext}>
          ยื่นชุดต่อไป
        </button>
      </div>

      <dialog
        ref={printAllRef}
        onClose={() => askedToPrint.add(result)}
        onClick={(event) => event.target === event.currentTarget && printAllRef.current?.close()}
        style={{ width: "min(720px, 94vw)" }}
      >
        <button className="close" aria-label="ปิด" onClick={() => printAllRef.current?.close()}>
          ×
        </button>
        <h2>ปริ้นใบส่งงาน</h2>
        <p>
          ยื่นสำเร็จ {result.succeeded.length} คัน · ปริ้นใบส่งงาน <strong>{chosenCount} คัน</strong>{" "}
          <span className="muted">
            ({chosenSheets.length} ใบ รวม {chosenPages} หน้า)
          </span>
        </p>
        <div className="table-wrap" style={{ marginBottom: 12 }}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}>ปริ้น</th>
                <th>วันที่ยื่น</th>
                <th>เจ้าของงาน</th>
                <th>แบบใบส่งงาน</th>
                <th style={{ textAlign: "right" }}>จำนวน</th>
              </tr>
            </thead>
            <tbody>
              {sheetEntries.map((e) => (
                <tr key={e.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`ปริ้นใบของ ${e.sheet.title}`}
                      checked={!skippedSheets.has(e.id)}
                      onChange={(event) => toggleSheet(e.id, event.target.checked)}
                    />
                  </td>
                  <td>{e.sheet.dateText}</td>
                  <td>{e.sheet.title}</td>
                  <td>{e.group}</td>
                  <td style={{ textAlign: "right" }}>{e.sheet.rows.length} คัน</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {unprintableCount > 0 && <p className="customer-message error">{unprintableCount} คันไม่ระบุประเภทรถ ปริ้นใบส่งงานไม่ได้</p>}
        <p className="muted" style={{ fontSize: 13 }}>
          อยากแก้ชื่อหัวใบหรือหมายเหตุก่อนปริ้น กดยกเลิก แล้วกด &quot;ปริ้นใบส่งงาน&quot; ของแต่ละกลุ่ม
        </p>
        <div className="form-actions">
          <button type="button" className="text-button" onClick={() => printAllRef.current?.close()}>
            ยกเลิก
          </button>
          <button type="button" className="primary" disabled={chosenCount === 0} onClick={printAll}>
            ปริ้น {chosenCount} คัน
          </button>
        </div>
      </dialog>

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
