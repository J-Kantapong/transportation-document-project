"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSubmission } from "@/lib/api";
import {
  buildJobSheets,
  formatSheetMoney,
  jobSheetPageCount,
  jobSheetRowsPerPage,
  printJobSheets,
  type JobSheetKind,
} from "@/lib/job-sheet-print";

// ชื่อหัวใบส่งงานเริ่มต้น - แก้ไขได้ก่อนพิมพ์
// - ใบรถยนต์: ชื่อบริษัทของลูกค้าถ้ามี ไม่งั้น "บริษัท {ชื่อลูกค้า}" (ตามตัวอย่าง "บริษัท SP")
// - ใบมอเตอร์ไซค์: หัวใบบอกว่าเป็นงานของใคร = ชื่อลูกค้า (เจ้าของงาน) ตรงๆ ตามตัวอย่าง; กลุ่มด่วนต่อท้าย "(ด่วน)" เพราะใบมอเตอร์ไซค์
//   ไม่มีช่องหมายเหตุ จะได้แยกใบด่วนออกจากใบธรรมดาของเจ้าของงานเดียวกันได้
function defaultTitleFor(kind: JobSheetKind, urgent: boolean): (r: DocumentSubmission) => string {
  return (r) => {
    const c = r.vehicle.customer;
    if (kind === "moto") return urgent ? `${c.name} (ด่วน)` : c.name;
    const company = c.company?.trim();
    if (company) return company;
    return c.name.startsWith("บริษัท") ? c.name : `บริษัท ${c.name}`;
  };
}

interface Props {
  kind: JobSheetKind;
  urgent: boolean;
  groupTitle: string;
  rows: DocumentSubmission[];
  defaultNote: string;
  onClose: () => void;
}

// แสดงเป็นหน้าต่างก่อนพิมพ์: 1 ใบต่อ 1 เจ้าของงานต่อ 1 วันที่ยื่น แก้ชื่อหัวใบ (และหมายเหตุของใบรถยนต์) ได้ แล้วกดพิมพ์
export function JobSheetPrintDialog({ kind, urgent, groupTitle, rows, defaultNote, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState(defaultNote);
  // key ของใบ (JobSheet.key) -> ชื่อหัวใบที่ผู้ใช้แก้ไข
  const [titleEdits, setTitleEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const sheets = useMemo(
    () => buildJobSheets(kind, rows, note, defaultTitleFor(kind, urgent), titleEdits),
    [kind, urgent, rows, note, titleEdits],
  );
  const missingTax = rows.filter((r) => r.taxAmount === null).length;
  const totalPages = sheets.reduce((sum, s) => sum + jobSheetPageCount(s), 0);

  function handlePrint() {
    printJobSheets(sheets);
    dialogRef.current?.close();
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialogRef.current?.close();
      }}
      style={{ width: "min(720px, 94vw)" }}
    >
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ปริ้นใบส่งงาน - {groupTitle}</h2>
      <p className="muted">
        หน้าละ {jobSheetRowsPerPage(kind)} คัน · {sheets.length} ใบ รวม {totalPages} หน้า · {rows.length} คัน
      </p>

      <div style={{ display: "grid", gap: 10, marginTop: 14 }}>
        {sheets.map((sheet) => (
          <div
            key={sheet.key}
            style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 10, alignItems: "center", border: "1px solid #e3e8f1", borderRadius: 8, padding: "10px 12px" }}
          >
            <label className="field" style={{ gap: 4 }}>
              ชื่อหัวใบ · วันที่ {sheet.dateText}
              <input type="text" value={sheet.title} onChange={(e) => setTitleEdits((prev) => ({ ...prev, [sheet.key]: e.target.value }))} />
            </label>
            <div style={{ textAlign: "right", fontSize: 13 }}>
              <div>
                {sheet.rows.length} คัน · {jobSheetPageCount(sheet)} หน้า
              </div>
              <div style={{ fontWeight: 600 }}>
                {kind === "moto" ? "ค่าธรรมเนียมรวม" : "รวม"} {formatSheetMoney(sheet.total)}
              </div>
            </div>
          </div>
        ))}
      </div>

      {kind === "car" && (
        <label className="field" style={{ marginTop: 14 }}>
          หมายเหตุ (พิมพ์ที่หัวใบทุกหน้า)
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      )}

      <p className="muted" style={{ marginTop: 12 }}>
        {kind === "moto"
          ? "ค่าธรรมเนียมในใบ = ค่าธรรมเนียม (Bill) + ค่าภาษี ของแต่ละคัน ไม่รวมลงขัน/ค่าอากร - ใบมอเตอร์ไซค์ไม่พิมพ์ยอดรวม"
          : "ยอดรวม = ค่าธรรมเนียม + ค่าภาษี + ลงขัน (+ ด่วน) ของทุกคันในใบ ไม่รวมค่าอากร"}
      </p>
      {missingTax > 0 && (
        <p className="customer-message error" role="alert">
          {missingTax} คันยังคำนวณภาษีไม่ได้ -{" "}
          {kind === "moto"
            ? "จะพิมพ์ค่าธรรมเนียมของคันเหล่านั้นเป็น \"-\" (ไม่พิมพ์ยอดที่ขาดภาษี)"
            : "จะพิมพ์ค่าภาษีเป็น \"-\" และยอดรวมไม่รวมภาษีของคันเหล่านั้น"}
        </p>
      )}

      <div className="form-actions">
        <button type="button" className="primary" disabled={rows.length === 0} onClick={handlePrint}>
          พิมพ์ {rows.length} คัน
        </button>
      </div>
    </dialog>
  );
}
