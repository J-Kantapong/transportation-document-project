"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { timestampToDisplayDate } from "@/lib/date";
import { supplierRatesApi, type SupplierRate, type SupplierRateHistory } from "@/lib/supplier-rates-api";

// ราคาซับจดทะเบียนต่างจังหวัด (ผู้ใช้ 2026-10-08) - ADMIN เท่านั้น (/admin/supplier-rates)
// รถที่จดจังหวัดอื่นนอกจากกรุงเทพฯ/สมุทรปราการ ส่งซับจด ค่าจ้างซับต่อคัน = ค่าดำเนินการ + ค่าช่อง + นำรถเข้าตรวจสภาพ (คิดทุกคัน)
// แก้ราคาต้องมีเหตุผล เก็บประวัติ - ไม่กระทบรถที่ส่งซับไปแล้ว (รายการนั้นเก็บราคา ณ วันที่ส่งไว้เอง)

const money = (n: number | null) => (n === null ? "—" : n.toLocaleString("th-TH", { maximumFractionDigits: 2 }));
const text = (n: number | null) => (n === null ? "" : String(n));

const FIELD_LABEL: Record<string, string> = {
  accepts: "รับจด",
  serviceFee: "ค่าดำเนินการ",
  channelFee: "ค่าช่อง",
  inspectionFee: "นำรถเข้าตรวจสภาพ",
  plateSwapFee: "สลับป้าย",
  plateSwapNote: "หมายเหตุสลับป้าย",
  note: "หมายเหตุ",
};

interface Draft {
  accepts: boolean;
  serviceFee: string;
  channelFee: string;
  inspectionFee: string;
  plateSwapFee: string;
  plateSwapNote: string;
  note: string;
  remark: string;
}

function showValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (value === true) return "รับ";
  if (value === false) return "ไม่รับ";
  return String(value);
}

export function SupplierRatesPage() {
  const [rates, setRates] = useState<SupplierRate[]>([]);
  const [selfProvinces, setSelfProvinces] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState("");

  const dialogRef = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<SupplierRate | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const historyRef = useRef<HTMLDialogElement>(null);
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [history, setHistory] = useState<SupplierRateHistory[] | null>(null);
  const [historyError, setHistoryError] = useState("");

  async function load() {
    try {
      const result = await supplierRatesApi.list();
      setRates(result.rates);
      setSelfProvinces(result.selfRegisterProvinces);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "โหลดราคาซับไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดข้อมูลครั้งแรกหลัง mount
    void load();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim();
    return q ? rates.filter((r) => r.province.includes(q)) : rates;
  }, [rates, query]);
  const notReady = rates.filter((r) => r.accepts && r.total === null).length;
  const refused = rates.filter((r) => !r.accepts).length;

  function openEdit(rate: SupplierRate) {
    setEditing(rate);
    setDraft({
      accepts: rate.accepts,
      serviceFee: text(rate.serviceFee),
      channelFee: text(rate.channelFee),
      inspectionFee: text(rate.inspectionFee),
      plateSwapFee: text(rate.plateSwapFee),
      plateSwapNote: rate.plateSwapNote ?? "",
      note: rate.note ?? "",
      remark: "",
    });
    setError("");
    dialogRef.current?.showModal();
  }

  async function save() {
    if (!editing || !draft) return;
    const amounts: Array<[string, string]> = [
      ["ค่าดำเนินการ", draft.serviceFee],
      ["ค่าช่อง", draft.channelFee],
      ["นำรถเข้าตรวจสภาพ", draft.inspectionFee],
    ];
    for (const [label, value] of amounts) {
      const v = value.trim();
      if (draft.accepts && !v) return setError(`กรอก${label} (ไม่มีให้ใส่ 0)`);
      if (v && !/^\d{1,7}(\.\d{1,2})?$/.test(v)) return setError(`${label}ต้องเป็นตัวเลขตั้งแต่ 0`);
    }
    if (draft.plateSwapFee.trim() && !/^\d{1,7}(\.\d{1,2})?$/.test(draft.plateSwapFee.trim())) return setError("ราคาสลับป้ายต้องเป็นตัวเลขตั้งแต่ 0");
    if (!draft.remark.trim()) return setError("ระบุเหตุผลที่แก้ เช่น ซับแจ้งขึ้นราคา");
    setSaving(true);
    setError("");
    try {
      await supplierRatesApi.save({
        province: editing.province,
        accepts: draft.accepts,
        serviceFee: draft.serviceFee.trim(),
        channelFee: draft.channelFee.trim(),
        inspectionFee: draft.inspectionFee.trim(),
        plateSwapFee: draft.plateSwapFee.trim(),
        plateSwapNote: draft.plateSwapNote.trim(),
        note: draft.note.trim(),
        remark: draft.remark.trim(),
        expectedUpdatedAt: editing.updatedAt,
      });
      dialogRef.current?.close();
      setNotice(`บันทึกราคาซับของ${editing.province}แล้ว - ใช้กับรถที่ส่งซับตั้งแต่นี้ไป`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
      if (err instanceof ApiError && err.status === 409) void load();
    } finally {
      setSaving(false);
    }
  }

  async function openHistory(province: string) {
    setHistoryOf(province);
    setHistory(null);
    setHistoryError("");
    historyRef.current?.showModal();
    try {
      setHistory((await supplierRatesApi.history(province)).history);
    } catch (err) {
      setHistoryError(err instanceof ApiError ? err.message : "โหลดประวัติไม่สำเร็จ");
    }
  }

  const set = (patch: Partial<Draft>) => setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
  const digits = (value: string) => value.replace(/[^\d.]/g, "");

  return (
    <div className="content">
      <h1>ราคาซับจดต่างจังหวัด</h1>
      <p className="muted" style={{ marginBottom: 16, maxWidth: 820 }}>
        รถที่จดทะเบียนจังหวัดอื่นนอกจาก{selfProvinces.join(" และ ") || "กรุงเทพมหานคร และ สมุทรปราการ"} ออฟฟิศแจ้งย้ายแล้วส่งซับจดให้
        ค่าจ้างซับต่อคัน = ค่าดำเนินการ + ค่าช่อง + นำรถเข้าตรวจสภาพ ระบบใส่ให้ตอนส่งงานที่หน้ายื่นเอกสาร
        การแก้ราคาที่นี่ใช้กับรถที่ส่งซับตั้งแต่นี้ไป ไม่เปลี่ยนรถที่ส่งไปแล้ว
      </p>

      {notice && (
        <p className="customer-message success" role="status" style={{ marginBottom: 12 }}>
          {notice}
        </p>
      )}
      {loadError && (
        <p className="customer-message error" role="alert" style={{ marginBottom: 12 }}>
          {loadError}
        </p>
      )}

      <section className="panel" style={{ padding: 22 }}>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 14 }}>
          <label className="field" style={{ minWidth: 220 }}>
            ค้นหาจังหวัด
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="พิมพ์ชื่อจังหวัด" />
          </label>
          <span className="muted" style={{ fontSize: 13 }}>
            {rates.length} จังหวัด · ซับไม่รับ {refused} · ยังไม่มีราคา {notReady}
          </span>
        </div>

        {loading ? (
          <div className="empty-customers">กำลังโหลด…</div>
        ) : shown.length === 0 ? (
          <div className="empty-customers">ไม่พบจังหวัดที่ค้นหา</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>จังหวัด</th>
                  <th style={{ textAlign: "right" }}>ค่าดำเนินการ</th>
                  <th style={{ textAlign: "right" }}>ค่าช่อง</th>
                  <th style={{ textAlign: "right" }}>นำรถเข้าตรวจสภาพ</th>
                  <th style={{ textAlign: "right" }}>รวมต่อคัน</th>
                  <th>สลับป้าย (อ้างอิง)</th>
                  <th>แก้ล่าสุด</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.province}>
                    <td>
                      {r.province}{" "}
                      {!r.accepts ? (
                        <span className="badge warn">ซับไม่รับ</span>
                      ) : r.total === null ? (
                        <span className="badge warn">ยังไม่มีราคา</span>
                      ) : null}
                      {r.note && <div style={{ fontSize: 12, color: "#8a94a6" }}>{r.note}</div>}
                    </td>
                    <td style={{ textAlign: "right" }}>{money(r.serviceFee)}</td>
                    <td style={{ textAlign: "right" }}>{money(r.channelFee)}</td>
                    <td style={{ textAlign: "right" }}>{money(r.inspectionFee)}</td>
                    <td style={{ textAlign: "right", fontWeight: 600 }}>{money(r.total)}</td>
                    <td>{[r.plateSwapFee !== null ? money(r.plateSwapFee) : null, r.plateSwapNote].filter(Boolean).join(" · ") || "—"}</td>
                    <td style={{ fontSize: 12, color: "#576781" }}>
                      {r.updatedAt ? `${timestampToDisplayDate(r.updatedAt)}${r.updatedBy ? ` · ${r.updatedBy}` : ""}` : "—"}
                    </td>
                    <td style={{ whiteSpace: "nowrap" }}>
                      <button type="button" className="text-button" onClick={() => openEdit(r)}>
                        ✎ แก้
                      </button>{" "}
                      {r.configured && (
                        <button type="button" className="text-button" onClick={() => openHistory(r.province)}>
                          ประวัติ
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <dialog
        ref={dialogRef}
        style={{ width: "min(520px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !saving) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>ราคาซับ - {editing?.province}</h2>
        {draft && (
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input type="checkbox" checked={draft.accepts} onChange={(e) => set({ accepts: e.target.checked })} />
              ซับรับจดทะเบียนจังหวัดนี้
            </label>
            {!draft.accepts && (
              <p className="customer-message error" role="alert">
                รถที่จดจังหวัดนี้จะส่งซับไม่ได้ ระบบจะแจ้งเหตุผลที่หน้ายื่นเอกสาร
              </p>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
              <label className="field">
                ค่าดำเนินการ
                <input type="text" inputMode="decimal" value={draft.serviceFee} onChange={(e) => set({ serviceFee: digits(e.target.value) })} />
              </label>
              <label className="field">
                ค่าช่อง
                <input type="text" inputMode="decimal" value={draft.channelFee} onChange={(e) => set({ channelFee: digits(e.target.value) })} />
              </label>
              <label className="field">
                นำรถเข้าตรวจสภาพ
                <input type="text" inputMode="decimal" value={draft.inspectionFee} onChange={(e) => set({ inspectionFee: digits(e.target.value) })} />
              </label>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 2fr", gap: 10 }}>
              <label className="field">
                สลับป้าย (อ้างอิง)
                <input type="text" inputMode="decimal" value={draft.plateSwapFee} onChange={(e) => set({ plateSwapFee: digits(e.target.value) })} />
              </label>
              <label className="field">
                หมายเหตุสลับป้าย
                <input type="text" maxLength={200} value={draft.plateSwapNote} onChange={(e) => set({ plateSwapNote: e.target.value })} />
              </label>
            </div>
            <label className="field">
              หมายเหตุ
              <input type="text" maxLength={200} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
            </label>
            <label className="field">
              เหตุผลที่แก้ *
              <input type="text" maxLength={200} value={draft.remark} onChange={(e) => set({ remark: e.target.value })} placeholder="เช่น ซับแจ้งขึ้นราคา 01/11/2026" />
            </label>
          </div>
        )}
        {error && (
          <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" className="primary" disabled={saving} onClick={save}>
            {saving ? "กำลังบันทึก…" : "บันทึก"}
          </button>
          <button type="button" className="text-button" disabled={saving} onClick={() => dialogRef.current?.close()}>
            ยกเลิก
          </button>
        </div>
      </dialog>

      <dialog
        ref={historyRef}
        style={{ width: "min(640px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget) historyRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => historyRef.current?.close()}>
          ×
        </button>
        <h2>ประวัติราคาซับ - {historyOf}</h2>
        {historyError ? (
          <p className="customer-message error" role="alert">
            {historyError}
          </p>
        ) : history === null ? (
          <div className="empty-customers">กำลังโหลด…</div>
        ) : history.length === 0 ? (
          <div className="empty-customers">ยังไม่มีการแก้ไข (ราคาตั้งต้นจากตารางของซับ)</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {history.map((h) => (
              <div key={h.id} style={{ borderBottom: "1px solid #edf0f5", paddingBottom: 10 }}>
                <div style={{ fontSize: 13, color: "#576781" }}>
                  {timestampToDisplayDate(h.at)} · {h.by ?? "ระบบ"}
                </div>
                <div style={{ margin: "4px 0" }}>เหตุผล: {h.remark}</div>
                <div style={{ fontSize: 13 }}>
                  {Object.entries(h.changes)
                    .filter(([, change]) => typeof change === "object" && change !== null)
                    .map(([field, change]) => {
                      const c = change as { from: unknown; to: unknown };
                      return (
                        <div key={field}>
                          {FIELD_LABEL[field] ?? field}: {showValue(c.from)} → {showValue(c.to)}
                        </div>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
        )}
      </dialog>
    </div>
  );
}
