"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSubmission } from "@/lib/api";
import {
  buildJobSheets,
  formatSheetMoney,
  jobSheetPageCount,
  JOB_SHEET_ROWS_PER_PAGE,
  printJobSheets,
} from "@/lib/job-sheet-print";

// ชื่อหัวใบส่งงานเริ่มต้น: ชื่อบริษัทของลูกค้าถ้ามี ไม่งั้น "บริษัท {ชื่อลูกค้า}" (ตามตัวอย่าง "บริษัท SP") - แก้ไขได้ก่อนพิมพ์
function defaultTitle(r: DocumentSubmission): string {
  const c = r.vehicle.customer;
  const company = c.company?.trim();
  if (company) return company;
  return c.name.startsWith("บริษัท") ? c.name : `บริษัท ${c.name}`;
}

interface Props {
  groupTitle: string;
  rows: DocumentSubmission[];
  defaultNote: string;
  onClose: () => void;
}

// แสดงเป็นหน้าต่างก่อนพิมพ์: 1 ใบต่อ 1 บริษัทต่อ 1 วันที่ยื่น แก้ชื่อหัวใบ/หมายเหตุได้ แล้วกดพิมพ์ (หน้าละ 20 คัน)
export function JobSheetPrintDialog({ groupTitle, rows, defaultNote, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState(defaultNote);
  // key ของใบ (JobSheet.key) -> ชื่อหัวใบที่ผู้ใช้แก้ไข
  const [titleEdits, setTitleEdits] = useState<Record<string, string>>({});

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  const sheets = useMemo(() => buildJobSheets(rows, note, defaultTitle, titleEdits), [rows, note, titleEdits]);
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
        หน้าละ {JOB_SHEET_ROWS_PER_PAGE} คัน · {sheets.length} ใบ รวม {totalPages} หน้า · {rows.length} คัน
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
              <div style={{ fontWeight: 600 }}>รวม {formatSheetMoney(sheet.total)}</div>
            </div>
          </div>
        ))}
      </div>

      <label className="field" style={{ marginTop: 14 }}>
        หมายเหตุ (พิมพ์ที่หัวใบทุกหน้า)
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
      </label>

      <p className="muted" style={{ marginTop: 12 }}>
        ยอดรวม = ค่าธรรมเนียม + ค่าภาษี + ลงขัน (+ ด่วน) ของทุกคันในใบ ไม่รวมค่าอากร
      </p>
      {missingTax > 0 && (
        <p className="customer-message error" role="alert">
          {missingTax} คันยังคำนวณภาษีไม่ได้ - จะพิมพ์ค่าภาษีเป็น &quot;-&quot; และยอดรวมไม่รวมภาษีของคันเหล่านั้น
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
