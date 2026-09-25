"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, slipNoText, type DeliveryKind, type DeliveryRow } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { downloadDeliverySlipPdf, printDeliverySlips } from "@/lib/delivery-print";
import { comparePlate } from "@/lib/plate-order";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";

// ส่งงานลูกค้า (พนักงาน): ติ๊กคันที่ส่งแล้ว ใส่วันที่ส่ง + ผู้รับ แล้วกดบันทึกครั้งเดียวทั้งชุด - หน้านี้ไม่มีราคา/ยอดบิล
// เรื่องวางบิลฝ่ายบัญชีทำต่อที่ /accounting/billing (ผู้ใช้ 2026-09-21) รถเข้าคิวเมื่อได้รับใบเสร็จ + เล่มแล้ว ป้ายตามทีหลังได้
const KIND_TEXT: Record<DeliveryKind, string> = {
  FULL: "ใบเสร็จ เล่ม ป้าย",
  NO_PLATE: "ใบเสร็จ เล่ม",
  PLATE_ONLY: "ป้ายอย่างเดียว",
  WAITING_PLATE: "—",
};

const plateText = (r: DeliveryRow) => (r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—");

export function DeliveryPage() {
  const [queue, setQueue] = useState<DeliveryRow[]>([]);
  const [recent, setRecent] = useState<DeliveryRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  const focusApplied = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  // ใบส่งงานของการบันทึกครั้งล่าสุด - พิมพ์ให้ผู้รับเซ็นได้ทันที (ใบเก่าพิมพ์ซ้ำได้ที่หน้ารายงานส่งงาน)
  const [lastSlip, setLastSlip] = useState<{ id: string; slipNo: number } | null>(null);
  const [printing, setPrinting] = useState(false);

  async function loadAll() {
    setLoading(true);
    try {
      const [q, r] = await Promise.all([billingApi.deliveryQueue(), billingApi.deliveryRecent()]);
      setQueue(q.vehicles);
      setRecent(r.vehicles);
      setSelected(new Set());
      // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): เลือกลูกค้าของรถคันนั้นให้ - ครั้งแรกที่โหลดเท่านั้น (lib/vehicle-focus.ts)
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const target = chassis ? q.vehicles.find((v) => sameChassis(v.chassis, chassis)) : undefined;
        if (target) setCustomerId(target.customerId);
      }
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "โหลดรายการไม่สำเร็จ", error: true });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; loadAll sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadAll();
  }, []);

  const customers = useMemo(() => {
    const map = new Map<string, { id: string; name: string; ready: number; plateOnly: number }>();
    for (const r of queue) {
      const c = map.get(r.customerId) ?? { id: r.customerId, name: r.customerName, ready: 0, plateOnly: 0 };
      if (r.kind === "FULL" || r.kind === "NO_PLATE") c.ready += 1;
      if (r.kind === "PLATE_ONLY") c.plateOnly += 1;
      map.set(r.customerId, c);
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, "th"));
  }, [queue]);

  // ส่งงานทีละลูกค้า (ผู้รับคนเดียวกัน) - ถ้ายังไม่ได้เลือก ใช้ลูกค้ารายแรกที่มีงาน
  const activeCustomerId = customers.some((c) => c.id === customerId) ? customerId : (customers[0]?.id ?? "");
  const rows = useMemo(() => queue.filter((r) => r.customerId === activeCustomerId).sort(comparePlate), [queue, activeCustomerId]);
  const pickable = rows.filter((r) => r.kind !== "WAITING_PLATE");
  const recentRows = recent.filter((r) => !activeCustomerId || r.customerId === activeCustomerId);

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setSelected(new Set());
    setMessage({ text: "" });
    setLastSlip(null);
  }

  async function outputSlip(id: string, as: "print" | "pdf") {
    setPrinting(true);
    try {
      const slip = await billingApi.deliverySlip(id);
      if (as === "pdf") await downloadDeliverySlipPdf(slip);
      else printDeliverySlips([slip]);
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "สร้างใบส่งงานไม่สำเร็จ", error: true });
    } finally {
      setPrinting(false);
    }
  }

  function toggle(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function handleSubmit() {
    const fail = (text: string) => setMessage({ text, error: true });
    if (selected.size === 0) return fail("ติ๊กรถที่ส่งแล้วอย่างน้อย 1 คัน");
    const dateIso = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!dateIso) return fail("วันที่ส่งไม่ถูกต้อง");
    if (!recipient.trim()) return fail("ใส่ชื่อผู้รับงาน");

    setSaving(true);
    setLastSlip(null);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      const result = await billingApi.submitDelivery({ vehicleIds: [...selected], date: dateIso, recipient, note });
      const parts = [
        result.delivered ? `ส่งงาน ${result.delivered} คัน ส่งต่อให้บัญชีรอวางบิล` : "",
        result.plateOnly ? `ส่งป้าย ${result.plateOnly} คัน` : "",
        result.platePending ? `ป้ายค้างส่ง ${result.platePending} คัน` : "",
      ].filter(Boolean);
      setRecipient("");
      setNote("");
      await loadAll();
      setLastSlip({ id: result.slipId, slipNo: result.slipNo });
      setMessage({ text: `บันทึกแล้ว ใบส่งงาน ${slipNoText(result.slipNo)}: ${parts.join(" · ")}` });
    } catch (err) {
      fail(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>Delivery</h1>
      <p>ติ๊กคันที่ส่งให้ลูกค้าแล้ว ใส่วันที่ส่งและผู้รับ แล้วกดบันทึก รถที่ส่งแล้วจะไปรอฝ่ายบัญชีวางบิลต่อ</p>
      <Link href="/registration/new-vehicle/delivery/report" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        รายงานส่งงาน / พิมพ์ใบส่งงานย้อนหลัง →
      </Link>

      {/* อยู่นอกฟอร์ม: ส่งครบทุกคันแล้วฟอร์มจะหายไป แต่ยังต้องพิมพ์ใบส่งงานได้ */}
      {lastSlip && (
        <div
          className={`customer-message${message.error ? " error" : " success"}`}
          role="status"
          style={{ marginTop: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}
        >
          <span>{message.text}</span>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="primary" disabled={printing} onClick={() => outputSlip(lastSlip.id, "print")}>
              {printing ? "กำลังเตรียม…" : `พิมพ์ใบส่งงาน ${slipNoText(lastSlip.slipNo)}`}
            </button>
            <button className="primary" disabled={printing} onClick={() => outputSlip(lastSlip.id, "pdf")}>
              บันทึก PDF
            </button>
          </span>
        </div>
      )}

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : customers.length === 0 ? (
        <section className="panel" style={{ marginTop: 20 }}>
          <div className="empty-customers">ไม่มีรถที่รอส่ง (ต้องได้รับใบเสร็จและเล่มทะเบียนก่อน)</div>
        </section>
      ) : (
        <>
          <div className="inspect-filter" style={{ padding: "20px 0 0" }}>
            {customers.map((c) => (
              <button key={c.id} className={`filter-chip${c.id === activeCustomerId ? " selected" : ""}`} onClick={() => chooseCustomer(c.id)}>
                {c.name} · พร้อมส่ง {c.ready}
                {c.plateOnly ? ` · ป้ายค้างส่ง ${c.plateOnly}` : ""}
              </button>
            ))}
          </div>

          <div className="lower" style={{ marginTop: 16 }}>
            <section className="panel">
              <div className="panel-head">
                <h2>รอส่ง ({pickable.length})</h2>
                <div>
                  <button className="text-button" onClick={() => setSelected(new Set(pickable.map((r) => r.id)))}>
                    เลือกทุกคัน
                  </button>
                  <button className="text-button" onClick={() => setSelected(new Set())}>
                    ไม่เลือกเลย
                  </button>
                </div>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ส่งแล้ว</th>
                      <th>ทะเบียน</th>
                      <th>เลขตัวถัง</th>
                      <th>ยี่ห้อ / ประเภทรถ</th>
                      <th>เลขที่ใบเสร็จ</th>
                      <th>ส่งรอบนี้</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.id} style={r.kind === "WAITING_PLATE" ? { color: "#8a94a6" } : undefined}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(r.id)}
                            disabled={r.kind === "WAITING_PLATE"}
                            onChange={(e) => toggle(r.id, e.target.checked)}
                            aria-label={`ส่งแล้ว ${plateText(r)}`}
                          />
                        </td>
                        <td>{plateText(r)}</td>
                        <td>{r.chassis}</td>
                        <td>
                          {r.brandName}
                          <div className="muted">{r.body || "—"}</div>
                        </td>
                        <td>{r.receiptNo || "—"}</td>
                        <td>
                          {r.kind === "PLATE_ONLY" ? <span className="badge">{KIND_TEXT[r.kind]}</span> : KIND_TEXT[r.kind]}
                          {r.kind === "NO_PLATE" && <div className="muted">ป้ายยังไม่ออก ส่งตามทีหลัง</div>}
                          {r.kind === "PLATE_ONLY" && r.deliveredDate && <div className="muted">ส่งเล่มไปแล้ว {isoToDisplayDate(r.deliveredDate)}</div>}
                          {r.kind === "WAITING_PLATE" && <div className="muted">ส่งเล่มไปแล้ว รอป้ายออก</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="panel" style={{ padding: "22px 23px", alignSelf: "start", overflow: "visible" }}>
              <h2 style={{ marginBottom: 16 }}>บันทึกการส่ง ({selected.size} คัน)</h2>
              <div style={{ display: "grid", gap: 14 }}>
                <label className="field">
                  วันที่ส่ง
                  <DateInput
                    value={dateText}
                    onChange={(value) => setDateText(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
                  />
                </label>
                <label className="field">
                  ผู้รับงาน
                  <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="ชื่อผู้รับที่ลูกค้า" />
                </label>
                <label className="field">
                  หมายเหตุ
                  <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
                </label>
                <button className="primary" style={{ justifyContent: "center" }} disabled={saving} onClick={handleSubmit}>
                  บันทึกส่งงาน{selected.size ? ` ${selected.size} คัน` : ""}
                </button>
                {message.text && !lastSlip && (
                  <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
                    {message.text}
                  </div>
                )}
              </div>
            </section>
          </div>
        </>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>ส่งแล้วล่าสุด ({recentRows.length})</h2>
        </div>
        {recentRows.length === 0 ? (
          <div className="empty-customers">ยังไม่มีรายการที่ส่งแล้ว</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ส่ง</th>
                  <th>ชื่อลูกค้า</th>
                  <th>ทะเบียน</th>
                  <th>เลขตัวถัง</th>
                  <th>ผู้รับ</th>
                  <th>ป้าย</th>
                  <th>วางบิล</th>
                  <th>หมายเหตุ</th>
                </tr>
              </thead>
              <tbody>
                {recentRows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.deliveredDate ? isoToDisplayDate(r.deliveredDate) : "—"}</td>
                    <td>{r.customerName}</td>
                    <td>{plateText(r)}</td>
                    <td>{r.chassis}</td>
                    <td>{r.recipient || "—"}</td>
                    <td>
                      {r.plateDeliveredDate ? <span className="badge done">ส่งแล้ว {isoToDisplayDate(r.plateDeliveredDate)}</span> : <span className="badge warn">ค้างส่ง</span>}
                    </td>
                    <td>{r.invoiceNo ? <span className="badge done">{r.invoiceNo}</span> : <span className="badge">อยู่ที่บัญชี</span>}</td>
                    <td>{r.note || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}
