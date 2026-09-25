"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, slipNoText, type DeliveryRow } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { downloadDeliverySlipPdf, printDeliverySlips } from "@/lib/delivery-print";
import { jobSheetGroup } from "@/lib/job-sheet";
import { comparePlate } from "@/lib/plate-order";
import { focusChassis, sameChassis } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";

// ส่งงานลูกค้า (พนักงาน): หน้านี้ไม่มีราคา/ยอดบิล เรื่องวางบิลฝ่ายบัญชีทำต่อที่ /accounting/billing (ผู้ใช้ 2026-09-21)
// รถเข้าคิวเมื่อได้รับใบเสร็จ + เล่มแล้ว ป้ายตามทีหลังได้
// ผู้ใช้ 2026-09-26: งานเสร็จเป็น lot แต่บางทีเสร็จไม่หมด -> จัดเป็นการ์ดใบยื่นแบบหน้ารับป้าย/รับเล่ม แสดงทุกคันใน lot
// (คันที่ยังไม่พร้อมเป็นสีจาง ติ๊กไม่ได้) ส่งคันที่พร้อมไปก่อน คันที่เหลืออยู่ในการ์ดเดิมจนส่งครบ
// ติ๊กข้ามการ์ดได้ถ้าเป็นลูกค้าเดียวกัน - บันทึก 1 ครั้ง = ใบส่งงาน DL 1 ใบของลูกค้ารายเดียว

type ItemState = { state: "sent" | "ready" | "waiting"; date?: string | null };

const plateText = (r: DeliveryRow) => (r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—");
const groupLabel = (r: DeliveryRow) => jobSheetGroup(r.body, r.urgent).label;
const lotKeyOf = (r: DeliveryRow) => `${r.submitDate ?? ""}|${groupLabel(r)}|${r.customerId}`;
const fullyDelivered = (r: DeliveryRow) => !!r.deliveredDate && !!r.plateDeliveredDate;

// สถานะแยก ใบเสร็จ / เล่ม / ป้าย ของแต่ละคัน
function itemsOf(r: DeliveryRow): { receipt: ItemState; book: ItemState; plate: ItemState } {
  const docs = (have: boolean): ItemState => (r.deliveredDate ? { state: "sent", date: r.deliveredDate } : { state: have ? "ready" : "waiting" });
  return {
    receipt: docs(r.receiptReceived),
    book: docs(r.bookReceived),
    plate: r.plateDeliveredDate ? { state: "sent", date: r.plateDeliveredDate } : { state: r.plateReceived ? "ready" : "waiting" },
  };
}

const WAIT_TEXT = { receipt: "รอใบเสร็จ", book: "รอเล่ม", plate: "รอป้าย" } as const;

function ItemCell({ item, kind }: { item: ItemState; kind: keyof typeof WAIT_TEXT }) {
  if (item.state === "sent") return <span className="delivery-item sent">ส่งแล้ว {item.date ? isoToDisplayDate(item.date).slice(0, 5) : ""}</span>;
  if (item.state === "ready") return <span className="delivery-item ready">✓ มีแล้ว</span>;
  return <span className="delivery-item waiting">⏳ {WAIT_TEXT[kind]}</span>;
}

interface Lot {
  key: string;
  date: string;
  label: string;
  customerId: string;
  customerName: string;
  rows: DeliveryRow[];
}

export function DeliveryPage() {
  const [queue, setQueue] = useState<DeliveryRow[]>([]);
  const [lotOthers, setLotOthers] = useState<DeliveryRow[]>([]);
  const [recent, setRecent] = useState<DeliveryRow[]>([]);
  const focusApplied = useRef(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openLots, setOpenLots] = useState<Set<string>>(new Set());
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  // ใบส่งงานของการบันทึกครั้งล่าสุด - พิมพ์ให้ผู้รับเซ็นได้ทันที (ใบเก่าพิมพ์ซ้ำได้ที่หน้ารายงานส่งงาน)
  const [lastSlip, setLastSlip] = useState<{ id: string; slipNo: number } | null>(null);
  const [printing, setPrinting] = useState(false);
  // ตัวกรองแบบหน้ารับป้าย/รับเล่ม
  const [fromText, setFromText] = useState("");
  const [toText, setToText] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [receiptQuery, setReceiptQuery] = useState("");
  const [chassisQuery, setChassisQuery] = useState("");
  const [plateQuery, setPlateQuery] = useState("");
  const [sortMode, setSortMode] = useState<"submit" | "plate">("submit");

  async function loadAll() {
    setLoading(true);
    try {
      const [q, r] = await Promise.all([billingApi.deliveryQueue(), billingApi.deliveryRecent()]);
      setQueue(q.vehicles);
      setLotOthers(q.lotVehicles ?? []);
      setRecent(r.vehicles);
      setSelected(new Set());
      // เปิดจากหน้าค้นหารถ (?focus=เลขตัวถัง): กางการ์ดของรถคันนั้นให้ - ครั้งแรกที่โหลดเท่านั้น (lib/vehicle-focus.ts)
      if (!focusApplied.current) {
        focusApplied.current = true;
        const chassis = focusChassis();
        const target = chassis ? q.vehicles.find((v) => sameChassis(v.chassis, chassis)) : undefined;
        if (target) setOpenLots(new Set([lotKeyOf(target)]));
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

  const queueIds = new Set(queue.map((r) => r.id));
  const pickable = (r: DeliveryRow) => queueIds.has(r.id) && r.kind !== "WAITING_PLATE";

  // การ์ด = ใบยื่น (วันที่ยื่น + กลุ่ม + ลูกค้า) ที่มีอย่างน้อย 1 คันพร้อมส่ง
  const lotMap = new Map<string, Lot>();
  for (const r of [...queue, ...lotOthers]) {
    const key = lotKeyOf(r);
    const lot = lotMap.get(key) ?? { key, date: r.submitDate ?? "", label: groupLabel(r), customerId: r.customerId, customerName: r.customerName, rows: [] };
    lot.rows.push(r);
    lotMap.set(key, lot);
  }
  const allLots = [...lotMap.values()]
    .filter((lot) => lot.rows.some(pickable))
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || a.label.localeCompare(b.label, "th") || a.customerName.localeCompare(b.customerName, "th"));

  // ช่องวันที่ที่ยังพิมพ์ไม่ครบ = ยังไม่กรอง
  const fromIso = displayDateToIso(fromText.replace(/\D/g, ""));
  const toIso = displayDateToIso(toText.replace(/\D/g, ""));
  const receiptNeedle = receiptQuery.replace(/\s/g, "");
  const chassisNeedle = chassisQuery.replace(/\s/g, "").toUpperCase();
  const plateNeedle = plateQuery.replace(/\s/g, "");
  const searching = !!(receiptNeedle || chassisNeedle || plateNeedle);
  const filtering = !!(fromIso || toIso || searching || ownerFilter);
  const owners = [...new Set(allLots.map((lot) => lot.customerName))].sort((a, b) => a.localeCompare(b, "th"));
  const rowMatches = (r: DeliveryRow) =>
    (!receiptNeedle || (r.receiptNo ?? "").includes(receiptNeedle)) &&
    (!chassisNeedle || r.chassis.toUpperCase().includes(chassisNeedle)) &&
    (!plateNeedle || `${r.plateCategory ?? ""}${r.plateNumber ?? ""}`.replace(/\s/g, "").includes(plateNeedle));
  const lots = allLots.filter(
    (lot) =>
      (!fromIso || lot.date >= fromIso) &&
      (!toIso || lot.date <= toIso) &&
      (!ownerFilter || lot.customerName === ownerFilter) &&
      (!searching || lot.rows.some(rowMatches)),
  );
  const orderRows = (rows: DeliveryRow[]) =>
    [...rows].sort(
      sortMode === "plate" ? comparePlate : (a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? "") || a.chassis.localeCompare(b.chassis),
    );

  // ติ๊กได้เฉพาะลูกค้าเดียวกับคันแรกที่ติ๊ก (ใบส่งงาน 1 ใบ = ลูกค้า 1 ราย)
  const allRows = [...queue, ...lotOthers];
  const selectedRows = allRows.filter((r) => selected.has(r.id));
  const selectedCustomerId = selectedRows[0]?.customerId ?? "";
  const selectedCustomerName = selectedRows[0]?.customerName ?? "";
  const lotCount = new Set(selectedRows.map(lotKeyOf)).size;
  const lockedOut = (customerId: string) => !!selectedCustomerId && customerId !== selectedCustomerId;

  function setMany(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setLastSlip(null);
    setMessage({ text: "" });
  }

  function toggleLot(key: string) {
    setOpenLots((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  const recentRows = recent.filter((r) => !ownerFilter || r.customerName === ownerFilter);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>Delivery</h1>
      <p>ติ๊กคันที่ส่งให้ลูกค้าแล้ว ใส่วันที่ส่งและผู้รับ แล้วกดบันทึก รถที่ส่งแล้วจะไปรอฝ่ายบัญชีวางบิลต่อ ใบยื่นที่ยังไม่พร้อมทุกคัน ส่งคันที่พร้อมไปก่อนได้</p>
      <Link href="/registration/new-vehicle/delivery/report" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        รายงานส่งงาน / พิมพ์ใบส่งงานย้อนหลัง →
      </Link>

      {message.error && selected.size === 0 && !lastSlip && (
        <div className="customer-message error" role="alert" style={{ marginTop: 16 }}>
          {message.text}
        </div>
      )}

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>รอส่ง ({filtering ? `${lots.length} จาก ${allLots.length}` : allLots.length} ใบยื่น)</h2>
          {filtering && (
            <button
              type="button"
              className="text-button"
              onClick={() => {
                setFromText("");
                setToText("");
                setOwnerFilter("");
                setReceiptQuery("");
                setChassisQuery("");
                setPlateQuery("");
              }}
            >
              ล้างตัวกรอง
            </button>
          )}
        </div>
        {!loading && allLots.length > 0 && (
          <>
            <div className="queue-filter">
              <label className="field">
                <span>วันที่ยื่น ตั้งแต่</span>
                <DateInput value={fromText} onChange={(v) => setFromText(formatDateDigits(v.replace(/\D/g, "").slice(0, 8)))} />
              </label>
              <label className="field">
                <span>ถึง</span>
                <DateInput value={toText} onChange={(v) => setToText(formatDateDigits(v.replace(/\D/g, "").slice(0, 8)))} />
              </label>
              <label className="field">
                <span>เจ้าของงาน</span>
                <select value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
                  <option value="">ทุกราย</option>
                  {owners.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>เลขที่ใบเสร็จ</span>
                <input type="text" inputMode="numeric" value={receiptQuery} onChange={(e) => setReceiptQuery(e.target.value.replace(/[^\d/]/g, ""))} placeholder="เช่น 0035" />
              </label>
              <label className="field">
                <span>เลขตัวรถ</span>
                <input type="text" value={chassisQuery} onChange={(e) => setChassisQuery(e.target.value)} placeholder="บางส่วนก็ได้" />
              </label>
              <label className="field">
                <span>ทะเบียน</span>
                <input type="text" value={plateQuery} onChange={(e) => setPlateQuery(e.target.value)} placeholder="เช่น 9กข 1148" />
              </label>
            </div>
            <div className="queue-toolbar">
              <span className="queue-toolbar-group">
                <span className="queue-sort" role="group" aria-label="ลำดับรถ">
                  <button type="button" className={sortMode === "submit" ? "active" : undefined} aria-pressed={sortMode === "submit"} onClick={() => setSortMode("submit")}>
                    ลำดับที่ยื่น
                  </button>
                  <button type="button" className={sortMode === "plate" ? "active" : undefined} aria-pressed={sortMode === "plate"} onClick={() => setSortMode("plate")}>
                    เรียงตามหมวด
                  </button>
                </span>
                <button type="button" className="text-button" onClick={() => setOpenLots(new Set(lots.map((lot) => lot.key)))}>
                  ขยายทั้งหมด
                </button>
                <button type="button" className="text-button" onClick={() => setOpenLots(new Set())}>
                  พับทั้งหมด
                </button>
              </span>
              {selected.size > 0 && (
                <button type="button" className="text-button" onClick={() => setSelected(new Set())}>
                  ล้างที่เลือก ({selected.size} คัน)
                </button>
              )}
            </div>
          </>
        )}

        {loading ? (
          <div className="customer-message" role="status" style={{ padding: "0 23px 20px" }}>
            กำลังโหลด...
          </div>
        ) : allLots.length === 0 ? (
          <div className="empty-customers">ไม่มีรถที่รอส่ง (ต้องได้รับใบเสร็จและเล่มทะเบียนก่อน)</div>
        ) : (
          <div className="queue-sheets">
            {lots.length === 0 && <div className="empty-customers">ไม่มีใบยื่นที่ตรงกับตัวกรอง</div>}
            {lots.map((lot) => {
              const open = searching || openLots.has(lot.key);
              const ready = lot.rows.filter(pickable);
              const done = lot.rows.filter(fullyDelivered).length;
              const notReady = lot.rows.length - ready.length - done;
              const pickedHere = ready.filter((r) => selected.has(r.id)).length;
              const locked = lockedOut(lot.customerId);
              const rows = orderRows(lot.rows);
              return (
                <div key={lot.key} className={`queue-sheet${notReady > 0 ? " warn" : ""}${open ? " open" : ""}`}>
                  <div
                    className="queue-sheet-head"
                    role="button"
                    tabIndex={0}
                    aria-expanded={open}
                    onClick={() => toggleLot(lot.key)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        toggleLot(lot.key);
                      }
                    }}
                  >
                    <span className="queue-sheet-title">
                      <input
                        type="checkbox"
                        className="queue-check"
                        checked={pickedHere > 0 && pickedHere === ready.length}
                        ref={(el) => {
                          if (el) el.indeterminate = pickedHere > 0 && pickedHere < ready.length;
                        }}
                        disabled={locked}
                        title={locked ? `เลือก ${selectedCustomerName} ไว้อยู่ ส่งได้ครั้งละ 1 ลูกค้า` : "เลือกคันที่พร้อมส่งทั้งใบ"}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        onChange={(e) => setMany(ready.map((r) => r.id), e.target.checked)}
                        aria-label="เลือกคันที่พร้อมส่งทั้งใบ"
                      />
                      <span className="queue-caret">{open ? "▾" : "▸"}</span>
                      {lot.date ? isoToDisplayDate(lot.date) : "ไม่ทราบวันที่ยื่น"} · {lot.label} · {lot.customerName}
                    </span>
                    <span className="queue-sheet-counts">
                      {lot.rows.length} คัน · <b style={{ color: "#1f7a4d", margin: "0 4px" }}>พร้อมส่ง {ready.length}</b>
                      {done > 0 && ` · ส่งครบแล้ว ${done}`}
                      {pickedHere > 0 && <span className="badge done queue-warn">เลือกแล้ว {pickedHere}</span>}
                      {notReady > 0 && <span className="badge warn queue-warn">⚠ ยังไม่พร้อม {notReady}</span>}
                    </span>
                  </div>
                  {open && (
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th style={{ width: 40 }}>ลำดับ</th>
                            <th style={{ width: 40 }}>ส่ง</th>
                            <th>เลขตัวถัง</th>
                            <th>ทะเบียน</th>
                            <th>เลขที่ใบเสร็จ</th>
                            <th>ใบเสร็จ</th>
                            <th>เล่ม</th>
                            <th>ป้าย</th>
                            <th>ยี่ห้อ / ประเภทรถ</th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((r, i) => {
                            const can = pickable(r);
                            const items = itemsOf(r);
                            return (
                              <tr key={r.id} className={can ? undefined : "delivery-row-muted"}>
                                <td>{i + 1}</td>
                                <td>
                                  {can ? (
                                    <input
                                      type="checkbox"
                                      checked={selected.has(r.id)}
                                      disabled={locked}
                                      onChange={(e) => setMany([r.id], e.target.checked)}
                                      aria-label={`ส่งแล้ว ${r.chassis}`}
                                    />
                                  ) : null}
                                </td>
                                <td>{r.chassis}</td>
                                <td>{plateText(r)}</td>
                                <td>{r.receiptNo || "—"}</td>
                                <td>
                                  <ItemCell item={items.receipt} kind="receipt" />
                                </td>
                                <td>
                                  <ItemCell item={items.book} kind="book" />
                                </td>
                                <td>
                                  <ItemCell item={items.plate} kind="plate" />
                                </td>
                                <td>
                                  {r.brandName}
                                  <div className="muted">{r.body || "—"}</div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

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

      {/* แถบบันทึกค้างล่างจอ: มีคันที่เลือก = ฟอร์มบันทึก, เพิ่งบันทึก = ปุ่มพิมพ์ใบส่งงาน */}
      {(selected.size > 0 || lastSlip) && (
        <div className="delivery-bar" role="region" aria-label="บันทึกการส่ง">
          {selected.size > 0 ? (
            <>
              <div className="delivery-bar-summary">
                <b>เลือก {selected.size} คัน</b>
                <span className="muted">
                  {selectedCustomerName}
                  {lotCount > 1 ? ` · จาก ${lotCount} ใบยื่น` : ""}
                </span>
              </div>
              <label className="field">
                <span>วันที่ส่ง</span>
                <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))} style={{ width: 130 }} />
              </label>
              <label className="field">
                <span>ผู้รับงาน</span>
                <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} placeholder="ชื่อผู้รับที่ลูกค้า" />
              </label>
              <label className="field">
                <span>หมายเหตุ</span>
                <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              <button className="primary" disabled={saving} onClick={handleSubmit}>
                {saving ? "กำลังบันทึก…" : `บันทึกส่งงาน ${selected.size} คัน`}
              </button>
              {message.text && (
                <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ flexBasis: "100%" }}>
                  {message.text}
                </div>
              )}
            </>
          ) : (
            lastSlip && (
              <>
                <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ flex: 1 }}>
                  {message.text}
                </div>
                <button className="primary" disabled={printing} onClick={() => outputSlip(lastSlip.id, "print")}>
                  {printing ? "กำลังเตรียม…" : `พิมพ์ใบส่งงาน ${slipNoText(lastSlip.slipNo)}`}
                </button>
                <button className="primary" disabled={printing} onClick={() => outputSlip(lastSlip.id, "pdf")}>
                  บันทึก PDF
                </button>
                <button className="text-button" onClick={() => setLastSlip(null)}>
                  ปิด
                </button>
              </>
            )
          )}
        </div>
      )}
    </section>
  );
}
