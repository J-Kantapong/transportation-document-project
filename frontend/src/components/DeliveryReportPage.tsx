"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";
import { ApiError } from "@/lib/api";
import { activeSlip, billingApi, slipNoText, type DeliveryRow, type DeliverySlip } from "@/lib/billing-api";
import { getCachedUser, vehicleScopeFor, type VehicleScope } from "@/lib/auth";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  countItems,
  downloadDeliveryReportPdf,
  downloadDeliverySlipPdf,
  printDeliveryReport,
  printDeliverySlips,
  type DeliveryReportInput,
} from "@/lib/delivery-print";
import { DateInput } from "@/components/DateInput";
import { DeliverySlipCancelDialog, DeliverySlipEditDialog } from "@/components/DeliverySlipDialogs";

// รายงานส่งงานย้อนหลัง (ผู้ใช้ 2026-09-25): ใบส่งงานตามช่วงวันที่ส่ง แยกรายคันว่าส่งใบเสร็จ / เล่ม / ป้าย
// พิมพ์ใบส่งงานซ้ำได้ทีละใบ + ท้ายรายงานมีรถที่ป้ายยังค้างส่ง - ไม่มีราคา (DELIVERY เปิดหน้านี้ได้)
const firstOfMonthIso = () => `${todayIso().slice(0, 8)}01`;
const Tick = ({ sent }: { sent: boolean }) => (sent ? <span className="badge done">✓</span> : <span className="muted">—</span>);
const CANCELLED_ROW = { color: "#9aa3b5", textDecoration: "line-through" } as const;

// แก้ / ยกเลิกใบส่งงาน (ผู้ใช้ 2026-09-26): ADMIN ทุกใบ, STAFF_CAR ใบรถยนต์, STAFF_MOTO ใบจักรยานยนต์ - DELIVERY ดูอย่างเดียว
// backend ตรวจซ้ำอีกชั้น (access-policy.ts + DeliveryService.assertItemInScope)
function canManageSlip(slip: DeliverySlip, scope: VehicleScope | null): boolean {
  if (!scope || scope === "NONE" || slip.cancelledAt) return false;
  return slip.items
    .filter((i) => !i.cancelledAt)
    .every((i) => scope === "ALL" || (scope === "MOTO") === isMotorcycleBody(i.body));
}

export function DeliveryReportPage() {
  const [fromText, setFromText] = useState(isoToDisplayDate(firstOfMonthIso()));
  const [toText, setToText] = useState(isoToDisplayDate(todayIso()));
  const [range, setRange] = useState({ from: firstOfMonthIso(), to: todayIso() });
  const [slips, setSlips] = useState<DeliverySlip[]>([]);
  const [queue, setQueue] = useState<DeliveryRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [makingPdf, setMakingPdf] = useState(false);
  const [editScope, setEditScope] = useState<VehicleScope | null>(null);
  const [dialog, setDialog] = useState<{ kind: "edit" | "cancel"; slip: DeliverySlip } | null>(null);
  const [showCancelled, setShowCancelled] = useState(true);
  const [notice, setNotice] = useState("");

  async function savePdf(make: () => Promise<void>) {
    setMakingPdf(true);
    setError("");
    try {
      await make();
    } catch {
      setError("สร้างไฟล์ PDF ไม่สำเร็จ ลองใหม่อีกครั้ง หรือใช้ปุ่มพิมพ์แล้วเลือกบันทึกเป็น PDF");
    } finally {
      setMakingPdf(false);
    }
  }

  async function load(from: string, to: string) {
    setLoading(true);
    setError("");
    try {
      const [s, q] = await Promise.all([billingApi.deliverySlips({ from, to }), billingApi.deliveryQueue()]);
      setSlips(s.slips);
      setQueue(q.vehicles);
      setRange({ from, to });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "โหลดรายงานไม่สำเร็จ");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // สิทธิ์แก้/ยกเลิก: DELIVERY ดูได้อย่างเดียว - อ่านหลัง mount เพื่อไม่ให้ hydration ไม่ตรง
    const roles = (getCachedUser()?.roles ?? []).filter((r) => r !== "DELIVERY");
    if (roles.some((r) => r === "ADMIN" || r === "STAFF_CAR" || r === "STAFF_MOTO")) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditScope(vehicleScopeFor(roles));
    }
  }, []);

  function replaceSlip(updated: DeliverySlip, message: string) {
    setSlips((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setNotice(message);
    // รถที่ยกเลิกกลับเข้าคิว -> รายการป้ายค้างส่งเปลี่ยนตาม
    billingApi
      .deliveryQueue()
      .then((q) => setQueue(q.vehicles))
      .catch(() => undefined);
  }

  useEffect(() => {
    // Standard fetch-on-mount; load sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(firstOfMonthIso(), todayIso());
  }, []);

  function applyRange() {
    const from = fromText ? displayDateToIso(fromText.replace(/\D/g, "")) : "";
    const to = toText ? displayDateToIso(toText.replace(/\D/g, "")) : "";
    if ((fromText && !from) || (toText && !to)) return setError("วันที่ไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (from && to && from > to) return setError("วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด");
    load(from, to);
  }

  // ตัวเลือกลูกค้า = ลูกค้าที่มีใบส่งงานในช่วงนี้หรือมีป้ายค้างส่ง
  const customers = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of slips) map.set(s.customer.id, s.customer.displayName);
    for (const r of queue) if (r.deliveredDate) map.set(r.customerId, r.customerName);
    return [...map].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "th"));
  }, [slips, queue]);
  const activeCustomer = customers.find((c) => c.id === customerId) ?? null;

  const customerSlips = slips.filter((s) => !activeCustomer || s.customer.id === activeCustomer.id);
  const shownSlips = customerSlips.filter((s) => showCancelled || !s.cancelledAt);
  // พิมพ์ / นับ / PDF ใช้เฉพาะคันที่ยังไม่ยกเลิก
  const liveSlips = customerSlips.filter((s) => !s.cancelledAt).map(activeSlip);
  const cancelledCount = customerSlips.length - liveSlips.length;
  // ส่งเล่มไปแล้วแต่ป้ายยังไม่ได้ส่ง (รอป้ายออก / ป้ายมาแล้วรอส่ง) - ไม่ขึ้นกับช่วงวันที่
  const platePending = queue.filter((r) => r.deliveredDate && (!activeCustomer || r.customerId === activeCustomer.id));
  const counts = countItems(liveSlips.flatMap((s) => s.items));
  const report: DeliveryReportInput = { ...range, customerName: activeCustomer?.name ?? null, slips: liveSlips, platePending };

  return (
    <section className="content">
      <Link href="/registration/new-vehicle/delivery" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← Delivery
      </Link>
      <h1 tabIndex={-1}>รายงานส่งงาน</h1>
      <p>ดูว่าส่งอะไรให้ลูกค้าไปแล้วบ้าง แยกใบเสร็จ / เล่ม / ป้าย พิมพ์ใบส่งงานซ้ำได้ และดูคันที่ป้ายยังค้างส่ง</p>

      <section className="panel" style={{ marginTop: 20, padding: "18px 23px", overflow: "visible" }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field">
            ส่งตั้งแต่วันที่
            <DateInput
              value={fromText}
              onChange={(value) => setFromText(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
            />
          </label>
          <label className="field">
            ถึงวันที่
            <DateInput
              value={toText}
              onChange={(value) => setToText(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
            />
          </label>
          <label className="field">
            ลูกค้า
            <select value={activeCustomer?.id ?? ""} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">ทุกลูกค้า</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button className="primary" disabled={loading} onClick={applyRange}>
            แสดง
          </button>
          <button className="primary" disabled={loading} onClick={() => printDeliveryReport(report)}>
            พิมพ์รายงาน
          </button>
          <button className="primary" disabled={loading || makingPdf} onClick={() => savePdf(() => downloadDeliveryReportPdf(report))}>
            {makingPdf ? "กำลังสร้าง PDF…" : "บันทึกรายงานเป็น PDF"}
          </button>
        </div>
        {error && (
          <div className="customer-message error" role="status" style={{ marginTop: 14 }}>
            {error}
          </div>
        )}
        {notice && (
          <div className="customer-message" role="status" style={{ marginTop: 14 }}>
            {notice}
          </div>
        )}
      </section>

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : (
        <>
          <div className="stats" style={{ marginTop: 20 }}>
            {[
              ["ใบส่งงาน", `${liveSlips.length} ใบ · ${counts.vehicles} คัน`],
              ["ใบเสร็จ", counts.receipt],
              ["เล่มทะเบียน", counts.book],
              ["ป้าย", counts.plate],
            ].map(([label, value]) => (
              <div className="stat" key={label}>
                <div className="stat-top">{label}</div>
                <strong style={{ fontSize: 24 }}>{value}</strong>
              </div>
            ))}
          </div>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head">
              <h2>ส่งแล้ว ({liveSlips.length} ใบ)</h2>
              {cancelledCount > 0 && (
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 14 }}>
                  <input type="checkbox" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} />
                  แสดงใบที่ยกเลิก ({cancelledCount})
                </label>
              )}
            </div>
            {shownSlips.length === 0 ? (
              <div className="empty-customers">ไม่มีการส่งงานในช่วงนี้</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ทะเบียน</th>
                      <th>เลขตัวถัง</th>
                      <th>ยี่ห้อ</th>
                      <th>เลขที่ใบเสร็จ</th>
                      <th>ใบเสร็จ</th>
                      <th>เล่ม</th>
                      <th>ป้าย</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownSlips.map((s) => (
                      <Fragment key={s.id}>
                        <tr style={{ background: s.cancelledAt ? "#fbf1f1" : "#f5f7fb" }}>
                          <td colSpan={7}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                              <span>
                                <b style={s.cancelledAt ? CANCELLED_ROW : undefined}>{slipNoText(s.slipNo)}</b> · {isoToDisplayDate(s.date)} ·{" "}
                                {s.customer.displayName} · ผู้รับ {s.recipient}
                                {s.note ? ` · ${s.note}` : ""}
                                {s.createdBy ? <span className="muted"> · บันทึกโดย {s.createdBy}</span> : null}
                                {s.cancelledAt && (
                                  <span className="badge" style={{ marginLeft: 8, background: "#fdecec", color: "#c0392b" }}>
                                    ยกเลิกแล้ว
                                  </span>
                                )}
                              </span>
                              {!s.cancelledAt && (
                                <span>
                                  <button className="text-button" onClick={() => printDeliverySlips([activeSlip(s)])}>
                                    พิมพ์ใบส่งงาน
                                  </button>
                                  <button className="text-button" disabled={makingPdf} onClick={() => savePdf(() => downloadDeliverySlipPdf(activeSlip(s)))}>
                                    บันทึก PDF
                                  </button>
                                  {canManageSlip(s, editScope) && (
                                    <>
                                      <button className="text-button" onClick={() => setDialog({ kind: "edit", slip: s })}>
                                        ✎ แก้
                                      </button>
                                      <button className="text-button" style={{ color: "#c0392b" }} onClick={() => setDialog({ kind: "cancel", slip: s })}>
                                        ยกเลิก
                                      </button>
                                    </>
                                  )}
                                </span>
                              )}
                            </div>
                            {s.cancelledAt && (
                              <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                                เหตุผลที่ยกเลิก: {s.cancelReason}
                                {s.cancelledBy ? ` · โดย ${s.cancelledBy}` : ""}
                              </div>
                            )}
                          </td>
                        </tr>
                        {s.items.map((i) => (
                          <tr key={`${s.id}-${i.vehicleId}`} style={i.cancelledAt ? CANCELLED_ROW : undefined}>
                            <td>{i.plateText || "—"}</td>
                            <td>{i.chassis}</td>
                            <td>{i.brandName}</td>
                            <td>{i.receiptNo || "—"}</td>
                            <td>
                              <Tick sent={i.receipt} />
                            </td>
                            <td>
                              <Tick sent={i.book} />
                            </td>
                            <td>
                              <Tick sent={i.plate} />
                            </td>
                          </tr>
                        ))}
                        {!s.cancelledAt && s.items.some((i) => i.cancelledAt) && (
                          <tr>
                            <td colSpan={7} className="muted" style={{ fontSize: 13 }}>
                              {s.items
                                .filter((i) => i.cancelledAt)
                                .map((i) => `ยกเลิก ${i.chassis}: ${i.cancelReason}${i.cancelledBy ? ` (${i.cancelledBy})` : ""}`)
                                .join(" · ")}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel" style={{ marginTop: 20 }}>
            <div className="panel-head">
              <h2>ป้ายค้างส่ง ({platePending.length})</h2>
            </div>
            {platePending.length === 0 ? (
              <div className="empty-customers">ไม่มีป้ายค้างส่ง</div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>ลูกค้า</th>
                      <th>ทะเบียน</th>
                      <th>เลขตัวถัง</th>
                      <th>ส่งเล่มเมื่อ</th>
                      <th>สถานะ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {platePending.map((r) => (
                      <tr key={r.id}>
                        <td>{r.customerName}</td>
                        <td>{r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—"}</td>
                        <td>{r.chassis}</td>
                        <td>{r.deliveredDate ? isoToDisplayDate(r.deliveredDate) : "—"}</td>
                        <td>
                          {r.kind === "PLATE_ONLY" ? <span className="badge warn">ป้ายมาแล้ว รอส่ง</span> : <span className="badge">รอป้ายออก</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
      {dialog?.kind === "edit" && (
        <DeliverySlipEditDialog
          slip={dialog.slip}
          onClose={() => setDialog(null)}
          onSaved={(updated) => replaceSlip(updated, `แก้ใบส่งงาน ${slipNoText(updated.slipNo)} แล้ว`)}
        />
      )}
      {dialog?.kind === "cancel" && (
        <DeliverySlipCancelDialog
          slip={dialog.slip}
          onClose={() => setDialog(null)}
          onCancelled={(updated) => replaceSlip(updated, `ยกเลิกการส่งใน ${slipNoText(updated.slipNo)} แล้ว - รถกลับเข้าคิว Delivery ให้บันทึกส่งใหม่`)}
        />
      )}
    </section>
  );
}
