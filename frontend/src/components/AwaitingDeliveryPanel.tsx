"use client";

import { useCallback, useEffect, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { billingApi, slipNoText, type DeliveryRow } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { AGING_COLOR, agingText, agingTone, daysSince } from "@/lib/delivery-aging";
import { deliveryCustomerLabels, deliveryRowCustomer, printDeliverySlips } from "@/lib/delivery-print";
import { DateInput } from "@/components/DateInput";

// "รอลงส่งงาน" บนหน้าวางบิล (ผู้ใช้ 2026-10-08 ตัวช่วยกันลืม ชั้น 2): ของครบแล้ว (ใบเสร็จ+เล่ม / ใบเสร็จของงานอื่น) แต่พนักงานยังไม่ลง
// วันส่งงาน จึงยังไม่เข้าคิววางบิล - บัญชีเห็นตรงนี้และลงส่งงานให้ได้เลย (เป็นใบ DL จริง พิมพ์ให้ลูกค้าเซ็นย้อนหลังได้) แทนที่จะรอพนักงาน
// อ่านจากคิวหน้า Delivery (GET /api/delivery/queue - เปิดให้ ACCOUNTANT อ่าน/บันทึกได้ 2026-10-08) ใช้กฎเดียวกันทุกข้อ: 1 ครั้ง = ลูกค้า 1 ราย รถประเภทเดียว
// only = "jobs" (หน้าวางบิลงานอื่น) แสดงเฉพาะงานอื่น / "all" (หน้าวางบิลรถ) แสดงทุกอย่าง

type Kind = "car" | "moto";
const KIND_LABEL: Record<Kind, string> = { car: "รถยนต์", moto: "จักรยานยนต์" };
const plateOf = (r: DeliveryRow) => (r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—");
// รอส่งครั้งแรก (ใบเสร็จ/เล่ม/ป้ายครบแล้ว) เท่านั้น - ป้ายตามทีหลัง (PLATE_ONLY) ไม่ได้กั้นการวางบิล จึงไม่ต้องเตือนที่นี่
const awaiting = (r: DeliveryRow) => !r.deliveredDate && (r.kind === "FULL" || r.kind === "NO_PLATE");
const whatOf = (r: DeliveryRow) => (r.jobLabel ? `ใบเสร็จ${r.source === "PLATE_COPY" ? " + ป้าย" : ""}` : r.kind === "FULL" ? "เล่ม + ป้าย" : "เล่ม (ป้ายตามทีหลัง)");

export function AwaitingDeliveryPanel({ only, onRecorded }: { only: "all" | "jobs"; onRecorded?: () => void }) {
  const [rows, setRows] = useState<DeliveryRow[]>([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [lastSlip, setLastSlip] = useState<{ id: string; slipNo: number } | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const q = await billingApi.deliveryQueue();
      setRows(q.vehicles.filter((r) => awaiting(r) && (only === "all" || !!r.jobLabel)));
      setFailed(false);
    } catch {
      // บัญชีเก่าที่ยังไม่ได้สิทธิ์อ่านคิว / backend รุ่นก่อน - กล่องนี้ไม่ขึ้น หน้าวางบิลทำงานตามปกติ
      setFailed(true);
    }
  }, [only]);

  useEffect(() => {
    // โหลดครั้งแรก (setState เกิดหลัง await ไม่ใช่ใน effect ตรงๆ) - แบบเดียวกับ DeliveryPage
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const key = (r: DeliveryRow) => `${r.source}:${r.id}`;
  const labels = deliveryCustomerLabels(rows.map(deliveryRowCustomer));
  const nameOf = (r: DeliveryRow) => labels.get(r.customerId) ?? r.customerName;
  const picked = rows.filter((r) => selected.has(key(r)));
  const first = picked[0];
  const lockReason = (r: DeliveryRow): string | null => {
    if (!first) return null;
    if (r.customerId !== first.customerId) return `เลือก ${nameOf(first)} ไว้อยู่ ส่งได้ครั้งละ 1 ลูกค้า`;
    if (r.vehicleKind !== first.vehicleKind) return `เลือก${KIND_LABEL[first.vehicleKind]}ไว้อยู่ ส่งรถยนต์กับจักรยานยนต์คนละใบ`;
    return null;
  };

  const groups = new Map<string, { name: string; rows: DeliveryRow[]; maxDays: number }>();
  for (const r of rows) {
    const g = groups.get(r.customerId) ?? { name: nameOf(r), rows: [], maxDays: 0 };
    g.rows.push(r);
    g.maxDays = Math.max(g.maxDays, daysSince(r.readySince) ?? 0);
    groups.set(r.customerId, g);
  }
  const groupList = [...groups.values()].sort((a, b) => b.maxDays - a.maxDays || a.name.localeCompare(b.name, "th"));
  const worst = groupList.reduce((m, g) => Math.max(m, g.maxDays), 0);
  const tone = agingTone(worst);

  function toggle(r: DeliveryRow, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(key(r));
      else next.delete(key(r));
      return next;
    });
    setMessage({ text: "" });
    setLastSlip(null);
  }

  async function record() {
    const fail = (text: string) => setMessage({ text, error: true });
    if (picked.length === 0) return fail("ติ๊กรายการที่ส่งลูกค้าแล้วอย่างน้อย 1 รายการ");
    const dateIso = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!dateIso) return fail("วันที่ส่งไม่ถูกต้อง");
    if (!recipient.trim()) return fail("ใส่ชื่อผู้รับงาน (คนที่เซ็นรับ)");
    const days = daysSince(dateIso);
    if (days !== null && days > 60 && !window.confirm(`วันที่ส่ง ${isoToDisplayDate(dateIso)} ย้อนหลัง ${days} วัน ถูกต้องหรือไม่`)) return;
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const result = await api.submitDelivery({
        items: picked.map((r) => ({ source: r.source, id: r.id, kind: r.kind })),
        date: dateIso,
        recipient: recipient.trim(),
        note: note.trim(),
      });
      setSelected(new Set());
      setRecipient("");
      setNote("");
      setLastSlip({ id: result.slipId, slipNo: result.slipNo });
      setMessage({ text: `บันทึกใบส่งงาน ${slipNoText(result.slipNo)} แล้ว - รายการเข้าคิววางบิลแล้ว` });
      await load();
      onRecorded?.();
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function printLast() {
    if (!lastSlip) return;
    try {
      printDeliverySlips([await billingApi.deliverySlip(lastSlip.id)]);
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "พิมพ์ใบส่งงานไม่สำเร็จ", error: true });
    }
  }

  if (failed || (rows.length === 0 && !lastSlip)) return null;

  const colorStyle = { background: tone === "late" ? "#fdecea" : tone === "warn" ? "#fff7e6" : "#eef6ff", borderColor: tone === "late" ? "#f1b0a7" : tone === "warn" ? "#f5d28a" : "#bcd4f5", color: tone === "late" ? "#8a1c0f" : tone === "warn" ? "#7a4b00" : "#1f4e8c" };

  return (
    <section style={{ marginTop: 12, padding: "10px 14px", borderRadius: 8, border: "1px solid", fontSize: 14, ...colorStyle }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 14px", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <b>รอลงส่งงาน {rows.length} รายการ</b>
          <span style={{ marginLeft: 8 }}>
            ของครบแล้วแต่ยังไม่มีใบส่งงาน (DL) - วางบิลไม่ได้จนกว่าจะลง
            {worst > 0 ? ` · นานสุด ${worst} วัน` : ""}
          </span>
        </div>
        <button type="button" className="text-button" onClick={() => setOpen((v) => !v)} style={{ color: "inherit", fontWeight: 600 }}>
          {open ? "▾ ซ่อน" : "▸ ดูและลงส่งงานให้"}
        </button>
      </div>
      {open && (
        <div style={{ marginTop: 10, display: "grid", gap: 10, color: "#1d2433" }}>
          <p className="muted" style={{ margin: 0, fontSize: 12 }}>
            ติ๊กรายการที่ส่งลูกค้าไปแล้วจริง ใส่วันที่ส่งจริงและชื่อผู้รับ แล้วกดบันทึก - ได้ใบ DL เหมือนพนักงานลงเอง (พิมพ์ให้ลูกค้าเซ็นย้อนหลังได้) · ยังไม่ได้ส่งจริง อย่าลง
          </p>
          {groupList.map((g) => (
            <div key={g.name} style={{ border: "1px solid #e3e8f0", borderRadius: 8, background: "#fff", padding: "8px 12px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                <b style={{ fontWeight: 600 }}>
                  {g.name} <span className="muted">({g.rows.length} รายการ)</span>
                </b>
                {g.maxDays > 0 && <span style={{ fontSize: 12, fontWeight: 600, color: AGING_COLOR[agingTone(g.maxDays)] }}>{agingText(g.maxDays)}</span>}
              </div>
              <div className="table-wrap" style={{ marginTop: 6 }}>
                <table>
                  <tbody>
                    {g.rows.map((r) => {
                      const lock = selected.has(key(r)) ? null : lockReason(r);
                      const days = daysSince(r.readySince);
                      return (
                        <tr key={key(r)}>
                          <td style={{ width: 28 }}>
                            <input type="checkbox" checked={selected.has(key(r))} disabled={!!lock || saving} title={lock ?? undefined} onChange={(e) => toggle(r, e.target.checked)} aria-label={`ส่งแล้ว ${r.chassis}`} />
                          </td>
                          <td>
                            {r.jobLabel ?? "รถจดใหม่"}
                            {r.jobDetail && r.jobDetail !== r.jobLabel ? <span className="muted"> · {r.jobDetail}</span> : ""}
                            <span className="muted"> · {KIND_LABEL[r.vehicleKind]}</span>
                          </td>
                          <td>
                            {plateOf(r)} <span className="muted">{r.chassis}</span>
                          </td>
                          <td className="muted">{r.brandName}</td>
                          <td>{whatOf(r)}</td>
                          <td style={{ color: AGING_COLOR[agingTone(days)], fontWeight: days && days > 3 ? 600 : undefined, whiteSpace: "nowrap" }}>
                            {r.readySince ? `พร้อมตั้งแต่ ${isoToDisplayDate(r.readySince)}` : ""}
                            {days ? ` (${days} วัน)` : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "flex-end" }}>
            <label className="field">
              <span>วันที่ส่งจริง</span>
              <DateInput value={dateText} onChange={(v) => setDateText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} style={{ width: 130 }} />
            </label>
            <label className="field">
              <span>ผู้รับงาน (คนที่เซ็นรับ)</span>
              <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="ชื่อผู้รับที่ลูกค้า" />
            </label>
            <label className="field">
              <span>หมายเหตุ</span>
              <input type="text" value={note} onChange={(e) => setNote(e.target.value)} placeholder="เช่น ลงย้อนหลัง พนักงานลืมลง" />
            </label>
            <button type="button" className="primary" disabled={saving || picked.length === 0} onClick={record}>
              {saving ? "กำลังบันทึก…" : `ลงส่งงาน ${picked.length} รายการ`}
            </button>
            {lastSlip && (
              <button type="button" onClick={printLast}>
                พิมพ์ใบส่งงาน {slipNoText(lastSlip.slipNo)}
              </button>
            )}
          </div>
          {message.text && (
            <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
              {message.text}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
