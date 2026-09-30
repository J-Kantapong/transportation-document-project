"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  fetchAuthedBlob,
  yamahaRelocationAttachmentUrl,
  type YamahaRelocationAttachment,
  type YamahaRelocationEntry,
  type YamahaRelocationSize,
  type YamahaRelocationSummary,
} from "@/lib/api";
import { canEditEntrySteps, getCachedUser, getToken } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { DateInput } from "@/components/DateInput";
import { downloadYamahaAttachmentsPdf } from "@/lib/yamaha-attachments-pdf";

function currentMonthIso(): string {
  return todayIso().slice(0, 7);
}

function parseCount(text: string): number {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n > 0 ? n : 0;
}

// ไฟล์แนบที่ต้องมีทุกรายการ (ผู้ใช้ 2026-09-22): ใบเสร็จ 1 ไฟล์ + Report 1 ไฟล์ เสมอ
const ACCEPT = "image/*,application/pdf";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_KIND = 10; // เท่ากับ backend (yamaha-relocation.controller.ts)

// ปุ่มแนบไฟล์ (โครงเดียวกับ .filter-chip แต่เป็นสี่เหลี่ยม - ไม่มี class ปุ่มรองใน globals.css)
const attachButtonStyle: React.CSSProperties = {
  border: "1px solid #dce2ec",
  background: "white",
  borderRadius: 8,
  padding: "10px 16px",
  fontSize: 14,
  color: "#2854d9",
};

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

// ต่อคำไทยกับคำอังกฤษให้มีช่องว่าง: "แนบ" + "ใบเสร็จ" = "แนบใบเสร็จ", "แนบ" + "Report" = "แนบ Report"
function joinLabel(prefix: string, label: string): string {
  return /^[A-Za-z]/.test(label) ? `${prefix} ${label}` : `${prefix}${label}`;
}

// ไฟล์อยู่หลัง backend ที่ต้องมี Authorization - <a href> ตรงๆ ส่ง header ไม่ได้ จึงโหลดเป็น blob แล้วเปิดในแท็บใหม่
// (เปิดแท็บก่อน await เพื่อไม่ให้ browser บล็อก popup) ถ้า browser บล็อก popup อยู่ดี ให้ดาวน์โหลดไฟล์แทน
// 401 (token หมดอายุ) fetchAuthedBlob พาไปหน้าล็อกอินเองและล้าง session แล้ว - ไม่ต้องเตือน "เปิดไม่สำเร็จ" ซ้ำ (พบ 2026-09-27)
async function openAuthedFile(url: string, fileName: string) {
  const win = window.open("", "_blank");
  try {
    const objectUrl = URL.createObjectURL(await fetchAuthedBlob(url));
    if (win) {
      win.location.href = objectUrl;
    } else {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = fileName;
      a.click();
    }
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  } catch {
    win?.close();
    if (getToken()) window.alert("เปิดไฟล์ไม่สำเร็จ กรุณาลองใหม่");
  }
}

// ไฟล์แนบของรายการ: แสดงลิงก์ต่อไฟล์ (แนบได้หลายไฟล์ - 2026-09-30) ถ้ามีไฟล์เดียวใช้คำว่า "เปิดไฟล์" เหมือนเดิม
function AttachmentLinks({ attachments }: { attachments: YamahaRelocationAttachment[] }) {
  if (!attachments.length) return <span className="muted">ไม่มีไฟล์</span>;
  return (
    <span style={{ display: "inline-flex", flexWrap: "wrap", gap: "2px 12px" }}>
      {attachments.map((attachment, i) => {
        const isPdf = attachment.mimeType === "application/pdf";
        const fileName = attachment.originalName || `${attachment.kind.toLowerCase()}.${isPdf ? "pdf" : "jpg"}`;
        return (
          <button
            key={attachment.id}
            type="button"
            className="text-button"
            title={attachment.originalName ?? undefined}
            onClick={() => openAuthedFile(yamahaRelocationAttachmentUrl(attachment.id), fileName)}
          >
            {isPdf ? "📄" : "🖼️"} {attachments.length > 1 ? `เปิดไฟล์ ${i + 1}` : "เปิดไฟล์"}
          </button>
        );
      })}
    </span>
  );
}

interface FileFieldProps {
  label: string;
  files: File[];
  disabled: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
}

// ปุ่มแนบไฟล์ 1 ช่อง: ถ่ายรูป/เลือกไฟล์ (รูปหรือ PDF) เลือกได้หลายไฟล์ เพิ่มทีหลังได้ แสดงชื่อไฟล์ที่เลือกแล้วและปุ่มเอาออกทีละไฟล์
function FileField({ label, files, disabled, onAdd, onRemove }: FileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <span>{label} *</span>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          onAdd(Array.from(e.target.files ?? []));
          e.target.value = ""; // ให้เลือกไฟล์เดิมซ้ำได้หลังกดเอาออก
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" style={attachButtonStyle} disabled={disabled || files.length >= MAX_FILES_PER_KIND} onClick={() => inputRef.current?.click()}>
          📎 {joinLabel(files.length ? "เพิ่ม" : "แนบ", label)}
        </button>
        {!files.length && <span className="muted">รูปหรือ PDF ไม่เกิน 8MB (แนบได้หลายไฟล์)</span>}
      </div>
      {files.map((file, i) => (
        <div key={`${file.name}-${i}`} style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: "#34415a", wordBreak: "break-all" }}>
            {i + 1}. {file.name} <span className="muted">({formatBytes(file.size)})</span>
          </span>
          <button type="button" className="text-button" disabled={disabled} onClick={() => onRemove(i)}>
            เอาออก
          </button>
        </div>
      ))}
    </div>
  );
}

interface YamahaRelocationEntryPageProps {
  size: YamahaRelocationSize;
  title: string;
}

export function YamahaRelocationEntryPage({ size, title }: YamahaRelocationEntryPageProps) {
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const dateIso = useMemo(() => displayDateToIso(dateText.replace(/\D/g, "")), [dateText]);
  const [countText, setCountText] = useState("");
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [reportFiles, setReportFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [formMessage, setFormMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  const [month, setMonth] = useState(() => currentMonthIso());
  const [entries, setEntries] = useState<YamahaRelocationEntry[]>([]);
  const [summary, setSummary] = useState<YamahaRelocationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  // ✎ แก้ / ยกเลิกรายการที่บันทึกผิด (ผู้ใช้ 2026-09-27)
  const [dialog, setDialog] = useState<{ kind: "edit" | "cancel"; entry: YamahaRelocationEntry } | null>(null);

  async function load(forMonth: string) {
    if (!forMonth) return;
    setLoading(true);
    setListError("");
    try {
      const data = await api.listYamahaRelocation(size, forMonth);
      setEntries(data.entries);
      setSummary(data.summary);
    } catch (err) {
      setListError(err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ");
      setEntries([]);
      setSummary(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-filter-change; load() sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, size]);

  // บันทึกได้เฉพาะ ADMIN/STAFF_ENTRY (backend กัน POST อยู่แล้ว) - กลุ่มอื่นเห็นแค่รายการ
  // localStorage อ่านได้เฉพาะฝั่ง browser จึงตั้งค่าใน effect
  const [canEdit, setCanEdit] = useState(false);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanEdit(canEditEntrySteps(getCachedUser()?.roles ?? []));
  }, []);

  // พิมพ์ปี พ.ศ. ตามใบเสร็จได้ - ครบ 8 หลักแล้วแปลงเป็น ค.ศ. ให้ (เดิมขึ้น "กรุณากรอกวันที่ให้ถูกต้อง" - พบ 2026-09-27)
  function handleDateTextChange(raw: string) {
    setDateText(formatDateDigitsCe(raw.replace(/\D/g, "").slice(0, 8)));
  }

  const count = parseCount(countText);

  // เลือก/เอาไฟล์ออกแล้วล้างข้อความเตือนเก่า (เช่น "กรุณาแนบไฟล์ใบเสร็จ") ที่ไม่ตรงกับสถานะแล้ว
  // ไฟล์เป็นรูป (ไม่ใช่ PDF) -> ย่อก่อนเก็บ เหมือนช่องแนบรูปอื่นๆ ในระบบ (ไม่มีการอ่านด้วย AI ตรงนี้ ย่อได้เต็มที่)
  async function addFiles(set: React.Dispatch<React.SetStateAction<File[]>>, picked: File[]) {
    setFormMessage({ text: "" });
    const prepared: File[] = [];
    for (const file of picked) {
      if (!file.type.startsWith("image/")) {
        prepared.push(file);
        continue;
      }
      try {
        const blob = await compressReceiptImage(file);
        prepared.push(new File([blob], compressedFileName(file), { type: "image/jpeg" }));
      } catch {
        prepared.push(file); // ย่อไม่สำเร็จ (ไฟล์เปิดไม่ได้) - ใช้ไฟล์เดิม ให้ backend/ผู้ใช้เห็น error ตอนบันทึกแทน
      }
    }
    set((prev) => [...prev, ...prepared].slice(0, MAX_FILES_PER_KIND));
  }

  function removeFile(set: React.Dispatch<React.SetStateAction<File[]>>, index: number) {
    setFormMessage({ text: "" });
    set((prev) => prev.filter((_, i) => i !== index));
  }

  // Export รูปใบเสร็จ + Report ของเดือนที่เลือกเป็น PDF เรียงวันที่เก่าสุด -> ใหม่สุด (ผู้ใช้ 2026-09-30)
  async function exportPdf() {
    setExporting(true);
    setListError("");
    try {
      const result = await downloadYamahaAttachmentsPdf(
        entries,
        `yamaha-${size === "SMALL" ? "small" : "large"}-${month}.pdf`,
        (done, total) => setExportProgress(`กำลังสร้าง PDF ${done}/${total} หน้า…`),
      );
      const notes: string[] = [];
      if (!result.pages) notes.push("ไม่มีรูปให้ export (มีแต่ไฟล์ PDF)");
      if (result.skippedPdfs.length) notes.push(`ข้ามไฟล์ที่เป็น PDF ${result.skippedPdfs.length} ไฟล์ (รวมเข้า PDF ไม่ได้): ${result.skippedPdfs.join(", ")}`);
      if (notes.length) window.alert(notes.join("\n"));
    } catch {
      window.alert("สร้าง PDF ไม่สำเร็จ กรุณาลองใหม่");
    } finally {
      setExporting(false);
      setExportProgress("");
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!dateIso) {
      setFormMessage({ text: "กรุณากรอกวันที่ให้ถูกต้อง", error: true });
      return;
    }
    if (count === 0) {
      setFormMessage({ text: "กรุณาระบุจำนวนคันอย่างน้อย 1 คัน", error: true });
      return;
    }
    if (!receiptFiles.length) {
      setFormMessage({ text: "กรุณาแนบไฟล์ใบเสร็จ", error: true });
      return;
    }
    if (!reportFiles.length) {
      setFormMessage({ text: "กรุณาแนบไฟล์ Report", error: true });
      return;
    }
    const tooBig = [...receiptFiles, ...reportFiles].find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      setFormMessage({ text: `ไฟล์ ${tooBig.name} ใหญ่เกิน 8MB`, error: true });
      return;
    }

    setSaving(true);
    setFormMessage({ text: "กำลังอัปโหลดไฟล์และบันทึก…" });
    try {
      await api.createYamahaRelocation({ date: dateIso, size, count, receipts: receiptFiles, reports: reportFiles });
      setFormMessage({ text: "บันทึกแล้ว" });
      setCountText("");
      setReceiptFiles([]);
      setReportFiles([]);
      if (dateIso.slice(0, 7) === month) {
        await load(month);
      }
    } catch (err) {
      setFormMessage({ text: err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content">
      <Link href="/registration/yamaha-relocation" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← งานแจ้งย้ายยามาฮ่า
      </Link>
      <h1>{title}</h1>

      {canEdit && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-head">
            <h2>บันทึกรายการแจ้งย้าย</h2>
          </div>
          <form className="customer-form" onSubmit={handleSubmit}>
            <div className="customer-grid">
              <div className="field">
                <span>วันที่ *</span>
                <DateInput
                  value={dateText}
                  onChange={(value) => handleDateTextChange(value)}
                  required
                />
              </div>
              <label className="field">
                จำนวนคัน *
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={countText}
                  onChange={(e) => setCountText(e.target.value)}
                  required
                />
              </label>
            </div>
            <p className="muted" style={{ margin: "14px 0 6px" }}>
              ทุกรายการต้องแนบไฟล์ 2 อย่างเสมอ: 1) ใบเสร็จ 2) Report
            </p>
            <div className="customer-grid">
              <FileField
                label="ใบเสร็จ"
                files={receiptFiles}
                disabled={saving}
                onAdd={(f) => addFiles(setReceiptFiles, f)}
                onRemove={(i) => removeFile(setReceiptFiles, i)}
              />
              <FileField
                label="Report"
                files={reportFiles}
                disabled={saving}
                onAdd={(f) => addFiles(setReportFiles, f)}
                onRemove={(i) => removeFile(setReportFiles, i)}
              />
            </div>
            <div className="form-actions">
              <button className="primary" type="submit" disabled={saving}>
                บันทึก
              </button>
              <span
                className={`customer-message${formMessage.error ? " error" : formMessage.text ? " success" : ""}`}
                role="status"
              >
                {formMessage.text}
              </span>
            </div>
          </form>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>รายการที่เพิ่มใหม่</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
            <button type="button" style={attachButtonStyle} disabled={exporting || loading || !entries.length} onClick={exportPdf}>
              {exporting ? exportProgress || "กำลังสร้าง PDF…" : "⬇ Export รูปใบเสร็จ + Report (PDF)"}
            </button>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              เดือน
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
            </label>
          </div>
        </div>

        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : listError ? (
          <div className="empty-customers" role="alert">
            {listError}
          </div>
        ) : !entries.length ? (
          <div className="empty-customers">ยังไม่มีรายการในเดือนนี้</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>จำนวนคัน</th>
                  <th>ใบเสร็จ</th>
                  <th>Report</th>
                  {canEdit && <th />}
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{isoToDisplayDate(entry.date) || entry.date}</td>
                    <td>{entry.count}</td>
                    <td>
                      <AttachmentLinks attachments={entry.receipts} />
                    </td>
                    <td>
                      <AttachmentLinks attachments={entry.reports} />
                    </td>
                    {canEdit && (
                      <td>
                        <button type="button" className="text-button" onClick={() => setDialog({ kind: "edit", entry })}>
                          ✎ แก้
                        </button>
                        <button
                          type="button"
                          className="text-button"
                          style={{ color: "#b43434" }}
                          onClick={() => setDialog({ kind: "cancel", entry })}
                        >
                          ยกเลิก
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {summary && (
          <div
            style={{
              padding: "18px 23px",
              borderTop: "1px solid #edf0f6",
              fontSize: 13,
              color: "#576781",
            }}
          >
            <strong style={{ color: "#34415a" }}>รวม: {summary.totalCount} คัน</strong>
          </div>
        )}
      </div>

      {dialog && (
        <EntryDialog
          kind={dialog.kind}
          entry={dialog.entry}
          onClose={() => setDialog(null)}
          onDone={(text) => {
            setFormMessage({ text });
            void load(month);
          }}
        />
      )}
    </section>
  );
}

const SIZE_LABEL: Record<YamahaRelocationSize, string> = { SMALL: "รถเล็ก", LARGE: "รถใหญ่" };

// ✎ แก้ / ยกเลิกรายการที่บันทึกผิด (ผู้ใช้ 2026-09-27) - ADMIN / STAFF_ENTRY ต้องระบุเหตุผลเสมอ (เก็บประวัติ)
// แก้ได้: วันที่ / รถเล็ก-รถใหญ่ / จำนวนคัน (ไฟล์แนบคงเดิม) - แนบไฟล์ผิดให้ยกเลิกแล้วบันทึกใหม่ (ไฟล์เดิมแนบใหม่ได้)
function EntryDialog({
  kind,
  entry,
  onClose,
  onDone,
}: {
  kind: "edit" | "cancel";
  entry: YamahaRelocationEntry;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dateText, setDateText] = useState(() => isoToDisplayDate(entry.date));
  const [size, setSize] = useState<YamahaRelocationSize>(entry.size);
  const [countText, setCountText] = useState(String(entry.count));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  async function confirm() {
    setError("");
    try {
      if (kind === "edit") {
        const date = displayDateToIso(dateText.replace(/\D/g, ""));
        if (!date) return setError("วันที่ไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
        const count = parseCount(countText);
        if (count === 0) return setError("กรุณาระบุจำนวนคันอย่างน้อย 1 คัน");
        if (date === entry.date && size === entry.size && count === entry.count) return setError("ไม่มีข้อมูลที่เปลี่ยน");
        if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้");
        setSaving(true);
        // ส่งค่าที่โหลดมาด้วย - มีคนแก้ไปก่อนระหว่างที่เปิดฟอร์มค้างไว้ backend ตอบ 409 ไม่ทับของเขา (พบ 2026-09-27)
        await api.updateYamahaRelocation(entry.id, {
          date,
          size,
          count,
          remark: remark.trim(),
          expectedDate: entry.date,
          expectedSize: entry.size,
          expectedCount: entry.count,
        });
        onDone(
          size !== entry.size
            ? `แก้รายการแล้ว - ย้ายไปหน้า${SIZE_LABEL[size]}`
            : date.slice(0, 7) !== entry.date.slice(0, 7)
              ? `แก้รายการแล้ว - ย้ายไปเดือน ${date.slice(5, 7)}/${date.slice(0, 4)}`
              : "แก้รายการแล้ว",
        );
      } else {
        if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่ยกเลิก");
        setSaving(true);
        await api.cancelYamahaRelocation(entry.id, remark.trim());
        onDone("ยกเลิกรายการแล้ว - ไฟล์ใบเสร็จ/Report เดิมนำไปแนบกับรายการใหม่ได้");
      }
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>{kind === "edit" ? "แก้รายการแจ้งย้าย" : "ยกเลิกรายการแจ้งย้าย"}</h2>
      <p className="muted">
        {SIZE_LABEL[entry.size]} · {isoToDisplayDate(entry.date)} · {entry.count} คัน
      </p>
      {kind === "edit" ? (
        <div className="customer-grid" style={{ marginTop: 12 }}>
          <div className="field">
            <span>วันที่ *</span>
            <DateInput
              value={dateText}
              onChange={(value) => setDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
              required
            />
          </div>
          <label className="field">
            จำนวนคัน *
            <input type="number" min={1} step={1} value={countText} onChange={(e) => setCountText(e.target.value)} required />
          </label>
          <label className="field">
            รถเล็ก / รถใหญ่
            <select value={size} onChange={(e) => setSize(e.target.value as YamahaRelocationSize)}>
              <option value="SMALL">รถเล็ก</option>
              <option value="LARGE">รถใหญ่</option>
            </select>
          </label>
        </div>
      ) : (
        <p style={{ marginTop: 12 }}>
          รายการนี้จะหายจากรายการและยอดรวมของเดือน (ยังเก็บไว้ในประวัติพร้อมเหตุผล) - ไฟล์ใบเสร็จและ Report เดิมนำไปแนบกับรายการที่บันทึกใหม่ได้
        </p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        {kind === "edit" ? "เหตุผลที่แก้ *" : "เหตุผลที่ยกเลิก *"}
        <input
          type="text"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          placeholder={kind === "edit" ? "เช่น พิมพ์จำนวนคันเกิน" : "เช่น บันทึกซ้ำ / แนบไฟล์ผิด"}
        />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={confirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : kind === "edit" ? "บันทึกการแก้ไข" : "ยืนยันยกเลิก"}
        </button>
      </div>
    </dialog>
  );
}
