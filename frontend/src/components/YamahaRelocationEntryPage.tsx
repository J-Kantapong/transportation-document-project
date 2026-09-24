"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  ApiError,
  yamahaRelocationAttachmentUrl,
  type YamahaRelocationAttachment,
  type YamahaRelocationEntry,
  type YamahaRelocationSize,
  type YamahaRelocationSummary,
} from "@/lib/api";
import { canEditEntrySteps, getCachedUser, getToken } from "@/lib/auth";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";

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
async function openAuthedFile(url: string, fileName: string) {
  const win = window.open("", "_blank");
  try {
    const token = getToken();
    const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const objectUrl = URL.createObjectURL(await res.blob());
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
    window.alert("เปิดไฟล์ไม่สำเร็จ กรุณาลองใหม่");
  }
}

function AttachmentLink({ attachment }: { attachment: YamahaRelocationAttachment | null }) {
  if (!attachment) return <span className="muted">ไม่มีไฟล์</span>;
  const isPdf = attachment.mimeType === "application/pdf";
  const fileName = attachment.originalName || `${attachment.kind.toLowerCase()}.${isPdf ? "pdf" : "jpg"}`;
  return (
    <button
      type="button"
      className="text-button"
      title={attachment.originalName ?? undefined}
      onClick={() => openAuthedFile(yamahaRelocationAttachmentUrl(attachment.id), fileName)}
    >
      {isPdf ? "📄" : "🖼️"} เปิดไฟล์
    </button>
  );
}

interface FileFieldProps {
  label: string;
  file: File | null;
  disabled: boolean;
  onChange: (file: File | null) => void;
}

// ปุ่มแนบไฟล์ 1 ช่อง: ถ่ายรูป/เลือกไฟล์ (รูปหรือ PDF) แสดงชื่อไฟล์ที่เลือกแล้วและปุ่มเอาออก
function FileField({ label, file, disabled, onChange }: FileFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="field">
      <span>{label} *</span>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          onChange(e.target.files?.[0] ?? null);
          e.target.value = ""; // ให้เลือกไฟล์เดิมซ้ำได้หลังกดเอาออก
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button type="button" style={attachButtonStyle} disabled={disabled} onClick={() => inputRef.current?.click()}>
          📎 {joinLabel(file ? "เปลี่ยน" : "แนบ", label)}
        </button>
        {file ? (
          <>
            <span style={{ fontSize: 13, color: "#34415a", wordBreak: "break-all" }}>
              {file.name} <span className="muted">({formatBytes(file.size)})</span>
            </span>
            <button type="button" className="text-button" disabled={disabled} onClick={() => onChange(null)}>
              เอาออก
            </button>
          </>
        ) : (
          <span className="muted">รูปหรือ PDF ไม่เกิน 8MB</span>
        )}
      </div>
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
  const [receiptFile, setReceiptFile] = useState<File | null>(null);
  const [reportFile, setReportFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [formMessage, setFormMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  const [month, setMonth] = useState(() => currentMonthIso());
  const [entries, setEntries] = useState<YamahaRelocationEntry[]>([]);
  const [summary, setSummary] = useState<YamahaRelocationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

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

  function handleDateTextChange(raw: string) {
    setDateText(formatDateDigits(raw.replace(/\D/g, "").slice(0, 8)));
  }

  const count = parseCount(countText);

  // เลือก/เอาไฟล์ออกแล้วล้างข้อความเตือนเก่า (เช่น "กรุณาแนบไฟล์ใบเสร็จ") ที่ไม่ตรงกับสถานะแล้ว
  // ไฟล์เป็นรูป (ไม่ใช่ PDF) -> ย่อก่อนเก็บ เหมือนช่องแนบรูปอื่นๆ ในระบบ (ไม่มีการอ่านด้วย AI ตรงนี้ ย่อได้เต็มที่)
  async function pickFile(set: (file: File | null) => void, file: File | null) {
    setFormMessage({ text: "" });
    if (!file || !file.type.startsWith("image/")) {
      set(file);
      return;
    }
    try {
      const blob = await compressReceiptImage(file);
      set(new File([blob], compressedFileName(file), { type: "image/jpeg" }));
    } catch {
      set(file); // ย่อไม่สำเร็จ (ไฟล์เปิดไม่ได้) - ใช้ไฟล์เดิม ให้ backend/ผู้ใช้เห็น error ตอนบันทึกแทน
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
    if (!receiptFile) {
      setFormMessage({ text: "กรุณาแนบไฟล์ใบเสร็จ", error: true });
      return;
    }
    if (!reportFile) {
      setFormMessage({ text: "กรุณาแนบไฟล์ Report", error: true });
      return;
    }
    const tooBig = [receiptFile, reportFile].find((f) => f.size > MAX_BYTES);
    if (tooBig) {
      setFormMessage({ text: `ไฟล์ ${tooBig.name} ใหญ่เกิน 8MB`, error: true });
      return;
    }

    setSaving(true);
    setFormMessage({ text: "กำลังอัปโหลดไฟล์และบันทึก…" });
    try {
      await api.createYamahaRelocation({ date: dateIso, size, count, receipt: receiptFile, report: reportFile });
      setFormMessage({ text: "บันทึกแล้ว" });
      setCountText("");
      setReceiptFile(null);
      setReportFile(null);
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
              <label className="field">
                วันที่ *
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="วว/ดด/ปปปป"
                  value={dateText}
                  onChange={(e) => handleDateTextChange(e.target.value)}
                  required
                />
              </label>
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
              <FileField label="ใบเสร็จ" file={receiptFile} disabled={saving} onChange={(f) => pickFile(setReceiptFile, f)} />
              <FileField label="Report" file={reportFile} disabled={saving} onChange={(f) => pickFile(setReportFile, f)} />
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
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            เดือน
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
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
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{isoToDisplayDate(entry.date) || entry.date}</td>
                    <td>{entry.count}</td>
                    <td>
                      <AttachmentLink attachment={entry.receipt} />
                    </td>
                    <td>
                      <AttachmentLink attachment={entry.report} />
                    </td>
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
    </section>
  );
}
