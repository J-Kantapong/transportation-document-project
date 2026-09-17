"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  type YamahaRelocationEntry,
  type YamahaRelocationSize,
  type YamahaRelocationSummary,
} from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

function currentMonthIso(): string {
  return todayIso().slice(0, 7);
}

function parseCount(text: string): number {
  const n = Number(text);
  return text.trim() !== "" && Number.isInteger(n) && n > 0 ? n : 0;
}

interface YamahaRelocationEntryPageProps {
  size: YamahaRelocationSize;
  title: string;
}

export function YamahaRelocationEntryPage({ size, title }: YamahaRelocationEntryPageProps) {
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const dateIso = useMemo(() => displayDateToIso(dateText.replace(/\D/g, "")), [dateText]);
  const [countText, setCountText] = useState("");
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

  function handleDateTextChange(raw: string) {
    setDateText(formatDateDigits(raw.replace(/\D/g, "").slice(0, 8)));
  }

  const count = parseCount(countText);

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

    setSaving(true);
    setFormMessage({ text: "กำลังบันทึก…" });
    try {
      await api.createYamahaRelocation({ date: dateIso, size, count });
      setFormMessage({ text: "บันทึกแล้ว" });
      setCountText("");
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
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{isoToDisplayDate(entry.date) || entry.date}</td>
                    <td>{entry.count}</td>
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
