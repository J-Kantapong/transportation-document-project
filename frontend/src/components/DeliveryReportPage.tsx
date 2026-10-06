"use client";

import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { activeSlip, billingApi, slipNoText, type DeliveryRow, type DeliverySlip } from "@/lib/billing-api";
import { canAccessPage, getCachedUser, submitWriteScopeFor, writeScopeFor, type VehicleScope } from "@/lib/auth";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { focusHref } from "@/lib/vehicle-focus";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  countItems,
  deliveryCustomerLabels,
  deliveryRowCustomer,
  downloadDeliveryReportPdf,
  downloadDeliverySlipPdf,
  hiddenItemsOf,
  printDeliveryReport,
  printDeliverySlips,
  slipCancelledForViewer,
  type DeliveryCustomer,
  type DeliveryReportInput,
} from "@/lib/delivery-print";
import { DateInput } from "@/components/DateInput";
import { DeliveryReportTabs } from "@/components/DeliverySheetPage";
import { DeliveryAddPlateDialog, DeliverySlipCancelDialog, DeliverySlipEditDialog } from "@/components/DeliverySlipDialogs";

// รายงานส่งงานย้อนหลัง (ผู้ใช้ 2026-09-25): ใบส่งงานตามช่วงวันที่ส่ง แยกรายคันว่าส่งเล่ม / ป้าย (ใบเสร็จไปกับใบวางบิล ผู้ใช้ 2026-09-26)
// พิมพ์ใบส่งงานซ้ำได้ทีละใบ + ท้ายรายงานมีรถที่ป้ายยังค้างส่ง - ไม่มีราคา (DELIVERY เปิดหน้านี้ได้)
// ACCOUNTANT เปิดหน้านี้ได้แบบอ่านอย่างเดียว (ผู้ใช้ 2026-09-27) แต่เปิดหน้า Delivery ไม่ได้ - ลิงก์ไปหน้านั้นจึงซ่อน
const firstOfMonthIso = () => `${todayIso().slice(0, 8)}01`;
const DELIVERY_PAGE = "/registration/new-vehicle/delivery";
const BILLING_PAGE = "/accounting/billing";
const Tick = ({ sent }: { sent: boolean }) => (sent ? <span className="badge done">✓</span> : <span className="muted">—</span>);
const CANCELLED_ROW = { color: "#9aa3b5", textDecoration: "line-through" } as const;

// แก้ / ยกเลิกใบส่งงาน (ผู้ใช้ 2026-09-26): ADMIN ทุกใบ, STAFF_CAR ใบรถยนต์, STAFF_MOTO ใบจักรยานยนต์ - DELIVERY ดูอย่างเดียว
// backend ตรวจซ้ำอีกชั้น (access-policy.ts + DeliveryService.assertItemInScope)
// แถวงานสลับเลขไม่มี body - ดู vehicleKind ที่ backend ส่งมาให้ ไม่งั้นงานมอเตอร์ไซค์จะถูกตีเป็นรถยนต์ (ผู้ใช้ 2026-09-28)
function inScope(row: { body: string | null; vehicleKind?: "car" | "moto" | null }, scope: VehicleScope | null): boolean {
  if (!scope || scope === "NONE") return false;
  const moto = row.vehicleKind ? row.vehicleKind === "moto" : isMotorcycleBody(row.body);
  return scope === "ALL" || (scope === "MOTO") === moto;
}

// ยกเลิก: backend ตรวจขอบเขตเฉพาะคันที่เลือก (DeliveryService.cancelSlip) -> ปุ่มขึ้นเมื่อมีคันที่ยังไม่ยกเลิกในขอบเขตการแก้
// อย่างน้อย 1 คัน ใบเก่าที่รวมสองประเภท: STAFF_CAR (+ ACCOUNTANT / DELIVERY ที่เห็นทุกคัน) ยกเลิกคันรถยนต์ของตัวเองได้
// คันอีกประเภทติ๊กไม่ได้ในหน้าต่างยกเลิก (พบ 2026-09-27: เดิมต้องการทุกคันในขอบเขต -> ปุ่มหายสำหรับบัญชีที่เห็นทุกคัน
// และ [].every = true -> ใบที่ยกเลิกครบทุกคันที่เห็นแล้วยังมีปุ่ม)
function canCancelSlip(slip: DeliverySlip, scope: VehicleScope | null): boolean {
  if (slip.cancelledAt) return false;
  return slip.items.some((i) => !i.cancelledAt && inScope(i, scope));
}

// แก้ผู้รับ/วันที่: ใช้ร่วมกันทั้งใบ backend ต้องการให้ทุกคันที่ยังไม่ยกเลิกอยู่ในขอบเขต รวมคันที่บัญชีนี้มองไม่เห็นด้วย
// (ใบเก่าที่รวมรถยนต์ + จักรยานยนต์ - เดิมปุ่มขึ้นแต่กดแล้วถูกปฏิเสธทุกครั้ง พบ 2026-09-27)
function canEditSlip(slip: DeliverySlip, scope: VehicleScope | null): boolean {
  if (slip.cancelledAt || hiddenItemsOf(slip) > 0) return false;
  const live = slip.items.filter((i) => !i.cancelledAt);
  return live.length > 0 && live.every((i) => inScope(i, scope));
}

export function DeliveryReportPage() {
  // ถึงวันที่ว่าง = ไม่จำกัด - ใบที่คีย์วันส่งล่วงหน้า (ทำได้ตามปกติ) ต้องเห็นด้วย (พบ 2026-09-27: เดิมสิ้นสุดที่วันนี้ ใบพรุ่งนี้หาย)
  const [fromText, setFromText] = useState(isoToDisplayDate(firstOfMonthIso()));
  const [toText, setToText] = useState("");
  const [range, setRange] = useState({ from: firstOfMonthIso(), to: "" });
  const [slips, setSlips] = useState<DeliverySlip[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [pendingRows, setPendingRows] = useState<DeliveryRow[]>([]);
  const [customerId, setCustomerId] = useState("");
  // ตัวเลือกลูกค้าสะสมจากทุกครั้งที่โหลด - กรองลูกค้าฝั่ง server แล้วรายการอื่นยังเลือกได้
  // เก็บชื่อ/บริษัท/สาขาตามรหัสลูกค้า ชื่อที่แสดงมาจาก deliveryCustomerLabels (ชื่อซ้ำต่อผู้ติดต่อ/สาขา - F47 2026-09-27)
  const [customerInfo, setCustomerInfo] = useState<Record<string, DeliveryCustomer>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [makingPdf, setMakingPdf] = useState(false);
  const [editScope, setEditScope] = useState<VehicleScope | null>(null);
  // ประเภทรถที่บันทึกส่งที่หน้า Delivery ได้ (สำเนาของ currentDeliveryScope ใน backend) - ป้ายค้างส่งแสดงตามขอบเขตการอ่าน
  // ซึ่งกว้างกว่าได้ (STAFF_CAR + ACCOUNTANT) คันนอกขอบเขตไม่มีในคิวหน้า Delivery จึงไม่แสดงลิงก์ไปบันทึก
  const [deliverScope, setDeliverScope] = useState<VehicleScope | null>(null);
  // ลิงก์กลับ: หน้า Delivery ถ้าเปิดได้ ไม่งั้นหน้าวางบิล (ACCOUNTANT) - null = ยังไม่รู้บทบาท / เปิดไม่ได้ทั้งคู่
  const [backLink, setBackLink] = useState<{ href: string; label: string } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "edit" | "cancel"; slip: DeliverySlip } | null>(null);
  const [plateDialog, setPlateDialog] = useState<DeliveryRow | null>(null);
  const [showCancelled, setShowCancelled] = useState(true);
  const [notice, setNotice] = useState("");
  const loadSeq = useRef(0);
  const lastRefresh = useRef(0);

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

  // ลูกค้าส่งไปกรองที่ server (เพดาน 500 ใบนับเฉพาะลูกค้านั้น) - quiet = โหลดเบื้องหลังตอนกลับมาที่แท็บ ผลครั้งล่าสุดเท่านั้นที่ใช้
  async function load(from: string, to: string, customer: string, options: { quiet?: boolean } = {}) {
    const seq = ++loadSeq.current;
    if (!options.quiet) {
      setLoading(true);
      setError("");
    }
    try {
      // ป้ายค้างส่งใช้ขอบเขตการอ่านเดียวกับใบส่งงาน ไม่ใช่คิวหน้า Delivery (พบ 2026-09-27: STAFF_CAR + ACCOUNTANT จักรยานยนต์หาย)
      const [s, q] = await Promise.all([billingApi.deliverySlips({ from, to, customerId: customer }), api.deliveryPlatePending()]);
      if (seq !== loadSeq.current) return;
      const rows = q.vehicles;
      setSlips(s.slips);
      setTruncated(!!s.truncated);
      setPendingRows(rows);
      setRange({ from, to });
      setCustomerInfo((prev) => {
        const next = { ...prev };
        for (const slip of s.slips) next[slip.customer.id] = slip.customer;
        for (const r of rows) if (r.deliveredDate) next[r.customerId] = deliveryRowCustomer(r);
        return next;
      });
    } catch (err) {
      if (seq === loadSeq.current) setError(err instanceof ApiError ? err.message : "โหลดรายงานไม่สำเร็จ");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }

  useEffect(() => {
    // สิทธิ์แก้/ยกเลิก: ADMIN / STAFF_CAR / STAFF_MOTO ตามขอบเขตการแก้ - DELIVERY / ACCOUNTANT ดูอย่างเดียว
    // ถือ DELIVERY / ACCOUNTANT คู่กับ STAFF_* ก็แก้ได้เฉพาะประเภทรถของ STAFF_* (submitWriteScopeFor ตรงกับ backend, พบ 2026-09-27)
    // อ่านหลัง mount เพื่อไม่ให้ hydration ไม่ตรง
    const roles = getCachedUser()?.roles ?? [];
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditScope(submitWriteScopeFor(roles));
    // ลิงก์ "บันทึกส่งป้าย →" พาไปหน้า Delivery - ACCOUNTANT เปิดหน้านั้นไม่ได้ (writeScopeFor ให้ ALL) จึงไม่แสดง (ผู้ใช้ 2026-09-27)
    const canDeliver = canAccessPage(DELIVERY_PAGE, roles);
    setDeliverScope(!canDeliver ? "NONE" : roles.includes("DELIVERY") ? "ALL" : writeScopeFor(roles));
    setBackLink(
      canDeliver
        ? { href: DELIVERY_PAGE, label: "← Delivery" }
        : canAccessPage(BILLING_PAGE, roles)
          ? { href: BILLING_PAGE, label: "← วางบิล" }
          : null,
    );
  }, []);

  // โหลดช่วงเดิมใหม่เบื้องหลัง: ใบอื่นที่ค้างบนจอ (ป้ายส่งตามในใบไหน) + ป้ายค้างส่ง ต้องตรงกับ server ทั้งคู่
  function reloadQuietly() {
    load(range.from, range.to, customerId, { quiet: true });
  }

  function replaceSlip(updated: DeliverySlip, message: string) {
    setSlips((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    setNotice(message);
    // ยกเลิก/แก้ใบส่งป้าย -> ใบส่งเล่มอีกใบที่บอก "ป้ายส่งตามใน ..." ต้องเปลี่ยนตาม, รถที่ยกเลิกกลับเข้ารายการป้ายค้างส่ง
    // (พบ 2026-09-27: เดิมเปลี่ยนแค่ใบที่แก้ ใบส่งเล่มยังอ้างใบส่งป้ายที่ยกเลิกแล้วขณะที่รถขึ้นป้ายค้างส่ง)
    reloadQuietly();
  }

  useEffect(() => {
    // Standard fetch-on-mount; load sets the loading flag before its first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(firstOfMonthIso(), "", "");
  }, []);

  // หน้าเปิดค้างไว้ (พบ 2026-09-27): กลับมาที่แท็บนี้แล้วโหลดช่วงเดิมใหม่เบื้องหลัง - ยกเว้นตอนเปิดหน้าต่างแก้/ยกเลิก หรือกำลังทำ PDF
  const idle = !dialog && !plateDialog && !makingPdf;
  useEffect(() => {
    if (!idle) return;
    function refresh() {
      if (document.visibilityState !== "visible" || Date.now() - lastRefresh.current < 2000) return;
      lastRefresh.current = Date.now();
      load(range.from, range.to, customerId, { quiet: true });
    }
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [idle, range.from, range.to, customerId]);

  function applyRange() {
    const from = fromText ? displayDateToIso(fromText.replace(/\D/g, "")) : "";
    const to = toText ? displayDateToIso(toText.replace(/\D/g, "")) : "";
    if ((fromText && !from) || (toText && !to)) return setError("วันที่ไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (from && to && from > to) return setError("วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด");
    load(from, to, customerId);
  }

  function chooseCustomer(id: string) {
    setCustomerId(id);
    load(range.from, range.to, id);
  }

  // ตัวเลือกลูกค้า = ลูกค้าที่เคยมีใบส่งงานในรายงานนี้หรือมีป้ายค้างส่ง
  const customerLabels = useMemo(() => deliveryCustomerLabels(Object.values(customerInfo)), [customerInfo]);
  const labelOf = (id: string, fallback: string) => customerLabels.get(id) ?? fallback;
  const customers = useMemo(
    () => Array.from(customerLabels, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "th")),
    [customerLabels],
  );
  const activeCustomer = customers.find((c) => c.id === customerId) ?? null;

  const customerSlips = slips.filter((s) => !customerId || s.customer.id === customerId);
  // ใบที่คันที่บัญชีนี้เห็นถูกยกเลิกครบแล้ว (ใบเก่าที่รวมสองประเภท) นับเป็นใบที่ยกเลิกสำหรับบัญชีนี้ - ไม่นับ/ไม่พิมพ์ใบว่าง
  const shownSlips = customerSlips.filter((s) => showCancelled || !slipCancelledForViewer(s));
  // พิมพ์ / นับ / PDF ใช้เฉพาะคันที่ยังไม่ยกเลิก
  const liveSlips = customerSlips.filter((s) => !slipCancelledForViewer(s)).map(activeSlip);
  const cancelledCount = customerSlips.length - liveSlips.length;
  // ส่งเล่มไปแล้วแต่ป้ายยังไม่ได้ส่ง (รอป้ายออก / ป้ายมาแล้วรอส่ง) - ไม่ขึ้นกับช่วงวันที่
  const platePending = pendingRows.filter((r) => r.deliveredDate && (!customerId || r.customerId === customerId));
  const liveItems = liveSlips.flatMap((s) => s.items);
  const counts = countItems(liveItems);
  // คัน = นับรถไม่ซ้ำ: ส่งเล่มใบหนึ่งแล้วส่งป้ายตามอีกใบในช่วงเดียวกัน = 1 คัน (พบ 2026-09-27: เดิมนับ 2)
  // นับด้วยที่มา + id ของงาน ไม่ใช่ id ของแถว - แถวงานสลับเลขไม่มี vehicleId (ผู้ใช้ 2026-09-28)
  const vehicleCount = new Set(liveItems.map((i) => `${i.source}:${i.plateSwapId ?? i.vehicleId ?? i.id}`)).size;
  const report: DeliveryReportInput = { ...range, customerName: activeCustomer?.name ?? null, slips: liveSlips, platePending, customerLabels, truncated };
  const canAddPlate = (r: DeliveryRow) => r.kind === "PLATE_ONLY" && !!r.bookSlip && inScope(r, editScope);

  return (
    <section className="content">
      {backLink && (
        <Link href={backLink.href} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
          {backLink.label}
        </Link>
      )}
      <h1 tabIndex={-1}>รายงานส่งงาน</h1>
      <p>ดูว่าส่งอะไรให้ลูกค้าไปแล้วบ้าง แยกเล่ม / ป้าย (ใบเสร็จส่งพร้อมใบวางบิล) พิมพ์ใบส่งงานซ้ำได้ และดูคันที่ป้ายยังค้างส่ง</p>
      <DeliveryReportTabs current="slips" />

      <section className="panel" style={{ marginTop: 20, padding: "18px 23px", overflow: "visible" }}>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field">
            ส่งตั้งแต่วันที่
            <DateInput
              value={fromText}
              onChange={(value) => setFromText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
            />
          </label>
          <label className="field">
            ถึงวันที่
            <DateInput
              value={toText}
              onChange={(value) => setToText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
              placeholder="ไม่จำกัด"
            />
          </label>
          <label className="field">
            ลูกค้า
            <select value={activeCustomer?.id ?? ""} onChange={(e) => chooseCustomer(e.target.value)}>
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
        {truncated && !loading && (
          <div className="customer-message" role="status" style={{ marginTop: 14, color: "#bb6a00" }}>
            ⚠ ใบส่งงานในช่วงนี้มีมากกว่า 500 ใบ แสดงเฉพาะ 500 ใบล่าสุด - เลือกช่วงวันที่ให้สั้นลงหรือเลือกลูกค้า เพื่อให้เห็นครบ
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
              ["ใบส่งงาน", `${liveSlips.length} ใบ · ${vehicleCount} คัน`],
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
                      <th>เล่ม</th>
                      <th>ป้าย</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownSlips.map((s) => {
                      // gone = ยกเลิกทั้งใบ หรือคันที่บัญชีนี้เห็นถูกยกเลิกครบแล้ว (ใบเก่าที่รวมสองประเภท) - ไม่มีปุ่มพิมพ์/PDF/แก้/ยกเลิก
                      const gone = slipCancelledForViewer(s);
                      const hidden = hiddenItemsOf(s);
                      const cancellable = !gone && canCancelSlip(s, editScope);
                      const editable = !gone && canEditSlip(s, editScope);
                      return (
                        <Fragment key={s.id}>
                          <tr style={{ background: gone ? "#fbf1f1" : "#f5f7fb" }}>
                            <td colSpan={6}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                                <span>
                                  <b style={gone ? CANCELLED_ROW : undefined}>{slipNoText(s.slipNo)}</b> · {isoToDisplayDate(s.date)} ·{" "}
                                  {labelOf(s.customer.id, s.customer.displayName)} · ผู้รับ {s.recipient}
                                  {s.note ? ` · ${s.note}` : ""}
                                  {s.createdBy ? <span className="muted"> · บันทึกโดย {s.createdBy}</span> : null}
                                  {gone && (
                                    <span className="badge" style={{ marginLeft: 8, background: "#fdecec", color: "#c0392b" }}>
                                      {s.cancelledAt ? "ยกเลิกแล้ว" : "ยกเลิกครบทุกคันที่ดูแลแล้ว"}
                                    </span>
                                  )}
                                </span>
                                {!gone && (
                                  <span>
                                    <button className="text-button" onClick={() => printDeliverySlips([activeSlip(s)])}>
                                      พิมพ์ใบส่งงาน
                                    </button>
                                    <button className="text-button" disabled={makingPdf} onClick={() => savePdf(() => downloadDeliverySlipPdf(activeSlip(s)))}>
                                      บันทึก PDF
                                    </button>
                                    {editable && (
                                      <button className="text-button" onClick={() => setDialog({ kind: "edit", slip: s })}>
                                        ✎ แก้
                                      </button>
                                    )}
                                    {cancellable && (
                                      <button className="text-button" style={{ color: "#c0392b" }} onClick={() => setDialog({ kind: "cancel", slip: s })}>
                                        ยกเลิก
                                      </button>
                                    )}
                                  </span>
                                )}
                              </div>
                              {/* ใบเก่าที่รวมรถยนต์ + จักรยานยนต์: บัญชีที่ไม่เห็นบางคัน (hidden) หรือเห็นแต่แก้ได้บางคัน (ยกเลิกได้ แก้ทั้งใบไม่ได้) */}
                              {!gone && (hidden > 0 || (cancellable && !editable)) && (
                                <div className="muted" style={{ marginTop: 4, fontSize: 13, color: "#bb6a00" }}>
                                  ใบนี้ส่งรถยนต์กับจักรยานยนต์รวมกัน (ก่อนแยกใบ)
                                  {hidden > 0 ? ` มีรถอีก ${hidden} คันที่บัญชีนี้ไม่ได้ดูแล - แสดง/พิมพ์เฉพาะคันในขอบเขต` : ""}
                                  {cancellable && !editable ? " - ยกเลิกได้เฉพาะคันประเภทที่บัญชีนี้ดูแล แก้ผู้รับ/วันที่ทั้งใบให้ ADMIN ทำ" : ""}
                                </div>
                              )}
                              {s.cancelledAt ? (
                                <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                                  เหตุผลที่ยกเลิก: {s.cancelReason}
                                  {s.cancelledBy ? ` · โดย ${s.cancelledBy}` : ""}
                                </div>
                              ) : gone && hidden > 0 ? (
                                <div className="muted" style={{ marginTop: 4, fontSize: 13 }}>
                                  ใบนี้ส่งรถยนต์กับจักรยานยนต์รวมกัน (ก่อนแยกใบ) - ยังมีรถอีก {hidden} คันที่บัญชีนี้ไม่ได้ดูแลซึ่งยังไม่ได้ยกเลิก
                                </div>
                              ) : null}
                            </td>
                          </tr>
                          {s.items.map((i) => {
                            const later = i.plateSentLater;
                            return (
                              <tr key={i.id} style={i.cancelledAt ? CANCELLED_ROW : undefined}>
                                <td>{i.plateText || "—"}</td>
                                <td>{i.chassis}</td>
                                <td>{i.brandName}</td>
                                <td>{i.receiptNo || "—"}</td>
                                <td>
                                  <Tick sent={i.book} />
                                </td>
                                <td>
                                  <Tick sent={i.plate} />
                                  {/* ใบนี้ส่งเล่มอย่างเดียว ป้ายไปในใบอื่นทีหลัง - บอกไว้ให้รู้ว่าทำไมช่องนี้ว่าง (ผู้ใช้ 2026-09-27) */}
                                  {later && (
                                    <span className="muted" style={{ fontSize: 12, marginLeft: 6 }}>
                                      ป้ายส่งตามใน {slipNoText(later.slipNo)} {isoToDisplayDate(later.date)}
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                          {!s.cancelledAt && s.items.some((i) => i.cancelledAt) && (
                            <tr>
                              <td colSpan={6} className="muted" style={{ fontSize: 13 }}>
                                {s.items
                                  .filter((i) => i.cancelledAt)
                                  .map((i) => `ยกเลิก ${i.chassis}: ${i.cancelReason}${i.cancelledBy ? ` (${i.cancelledBy})` : ""}`)
                                  .join(" · ")}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
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
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {platePending.map((r) => (
                      <tr key={r.id}>
                        <td>{labelOf(r.customerId, r.customerName)}</td>
                        <td>{r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : "—"}</td>
                        <td>{r.chassis}</td>
                        <td>
                          {r.deliveredDate ? isoToDisplayDate(r.deliveredDate) : "—"}
                          {r.bookSlip && <span className="muted"> · {slipNoText(r.bookSlip.slipNo)}</span>}
                        </td>
                        <td>
                          {r.kind === "PLATE_ONLY" ? <span className="badge warn">ป้ายมาแล้ว รอส่ง</span> : <span className="badge">รอป้ายออก</span>}
                        </td>
                        <td>
                          {/* ป้ายมาแล้ว: ส่งป้ายตามที่หน้า Delivery หรือถ้าป้ายไปพร้อมเล่มจริงแต่แนบรูปช้า ติ๊กในใบเดิม (ผู้ใช้ 2026-09-27) */}
                          {r.kind === "PLATE_ONLY" && (
                            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                              {inScope(r, deliverScope) && (
                                <Link href={focusHref(DELIVERY_PAGE, r.chassis)} className="text-button">
                                  บันทึกส่งป้าย →
                                </Link>
                              )}
                              {canAddPlate(r) && (
                                <button className="text-button" onClick={() => setPlateDialog(r)}>
                                  ป้ายไปพร้อมเล่มแล้ว
                                </button>
                              )}
                            </span>
                          )}
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
          onRefused={reloadQuietly}
        />
      )}
      {dialog?.kind === "cancel" && (
        <DeliverySlipCancelDialog
          slip={dialog.slip}
          editable={(i) => inScope(i, editScope)}
          onClose={() => setDialog(null)}
          onCancelled={(updated) => replaceSlip(updated, `ยกเลิกการส่งใน ${slipNoText(updated.slipNo)} แล้ว - รถกลับเข้าคิว Delivery ให้บันทึกส่งใหม่`)}
          onRefused={reloadQuietly}
        />
      )}
      {plateDialog?.bookSlip && (
        <DeliveryAddPlateDialog
          vehicle={{
            id: plateDialog.id,
            source: plateDialog.source,
            chassis: plateDialog.chassis,
            plateText: plateDialog.plateCategory && plateDialog.plateNumber ? `${plateDialog.plateCategory} ${plateDialog.plateNumber}` : "",
            customerName: labelOf(plateDialog.customerId, plateDialog.customerName),
          }}
          slip={plateDialog.bookSlip}
          onClose={() => setPlateDialog(null)}
          onSaved={(updated) =>
            replaceSlip(updated, `บันทึกแล้ว: ป้ายของรถ ${plateDialog.chassis} ไปพร้อมเล่มใน ${slipNoText(updated.slipNo)} (${isoToDisplayDate(updated.date)})`)
          }
          onRefused={reloadQuietly}
        />
      )}
    </section>
  );
}
