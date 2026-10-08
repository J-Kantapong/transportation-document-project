"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, type Customer } from "@/lib/api";
import {
  ACCOUNT_LABEL,
  billingApi,
  JOB_LABEL,
  JOB_TYPES,
  type AccountPeriod,
  type BillingAccount,
  type JobFeeRate,
  type JobType,
  type OtherJob,
  type OtherJobsQueue,
} from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { computeTotals, effectiveWhtRate, formatMoney, round2 } from "@/lib/invoice";
import { printInvoice } from "@/lib/invoice-print";
import { DateInput } from "@/components/DateInput";
import { WhtRatePicker, whtOverrideOf, whtProblem } from "@/components/WhtRatePicker";

// วางบิลงานอื่นๆ (ผู้ใช้ 2026-10-07: "ดึงงานทุกประเภทมาในการวางบิล"): งานโอน / ยกเลิกการใช้รถ / คัดแผ่นป้าย / ย้ายออก / ต่อภาษี
// ที่รับใบเสร็จกลับแล้ว (ต่อภาษี = คืนเอกสารให้ลูกค้าแล้ว) มารอที่นี่ - เลือกงาน ตรวจค่าบริการ แล้วออกบิล
// ค่าธรรมเนียมราชการอ่านจากใบเสร็จของงานเอง (เงินทดรองจ่าย ไม่มี VAT) ค่าบริการมาจากตารางราคาของลูกค้าแต่ละราย (แก้ได้ก่อนออกบิล)
// งานหนึ่งอยู่ในบิลที่ยังไม่ยกเลิกได้ใบเดียว - ยกเลิกบิลแล้วงานกลับเข้าคิวเอง

const keyOf = (j: Pick<OtherJob, "type" | "id">) => `${j.type}:${j.id}`;

function parseMoney(text: string): number | null {
  const t = text.replace(/,/g, "").trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? round2(n) : null;
}

// บัญชีของลูกค้า ณ วันที่ = ช่วงล่าสุดที่เริ่มไม่เกินวันนั้น (เหมือน accountOn ฝั่ง backend) ไม่มีช่วงเลย = บัญชีบริษัท
function accountOn(periods: AccountPeriod[], iso: string): BillingAccount {
  const started = periods.filter((p) => p.effectiveFrom <= iso).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return started.length ? started[started.length - 1].account : "COMPANY";
}

const CLASS_LABEL = { CAR: "รถยนต์", MOTO: "มอเตอร์ไซค์", ANY: "ทุกชนิด" } as const;
const VARIANT_LABEL = { OWNER: "โอนตามผู้ถือกรรมสิทธิ์", INSPECTION: "โอนตรวจรถ" } as const;
const FEE_SOURCE_LABEL = { RECEIPT: "ตามใบเสร็จ", ESTIMATE: "ยอดที่ระบบคิด (ยังไม่มียอดใบเสร็จ)", TAX: "ภาษีที่ชำระ" } as const;

interface RateRow {
  jobType: JobType;
  vehicleClass: "CAR" | "MOTO" | "ANY";
  variant: "OWNER" | "INSPECTION" | null;
  label: string;
  amountText: string;
}

const rateRowOf = (r: JobFeeRate): RateRow => ({
  jobType: r.jobType,
  vehicleClass: r.vehicleClass,
  variant: r.variant,
  label: r.label,
  amountText: formatMoney(r.amount),
});

export function OtherJobsBillingPage() {
  const [queue, setQueue] = useState<OtherJobsQueue | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [periods, setPeriods] = useState<AccountPeriod[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // ค่าบริการที่บัญชีพิมพ์แก้เอง (key = ประเภท:id) - ไม่มี = ใช้ราคาจากตารางของลูกค้า
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [invoiceNoEdit, setInvoiceNoEdit] = useState<string | null>(null);
  const [issueDateText, setIssueDateText] = useState(isoToDisplayDate(todayIso()));
  const [whtValue, setWhtValue] = useState<number | null>(null);
  const [whtChecked, setWhtChecked] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>({ text: "", error: false });

  // ตารางราคาของลูกค้า
  const [ratesOpen, setRatesOpen] = useState(false);
  const [rateRows, setRateRows] = useState<RateRow[]>([]);
  const [rateRemark, setRateRemark] = useState("");
  const [ratesSaving, setRatesSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const [q, c] = await Promise.all([billingApi.otherJobsQueue(), api.listCustomers()]);
      setQueue(q);
      setCustomers(c.customers);
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "โหลดงานรอวางบิลไม่สำเร็จ", error: true });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([billingApi.otherJobsQueue(), api.listCustomers()])
      .then(([q, c]) => {
        if (!alive) return;
        setQueue(q);
        setCustomers(c.customers);
      })
      .catch((err) => alive && setMessage({ text: err instanceof ApiError ? err.message : "โหลดงานรอวางบิลไม่สำเร็จ", error: true }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // กลับมาที่หน้านี้ (เช่น หลังไปแก้ใบเสร็จของงาน) = โหลดคิวใหม่
  useEffect(() => {
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  const queueCustomer = queue?.customers.find((c) => c.id === customerId) ?? null;
  const jobs = useMemo(() => queueCustomer?.jobs ?? [], [queueCustomer]);

  useEffect(() => {
    if (!customerId) return;
    billingApi
      .accountPeriods(customerId)
      .then((a) => setPeriods(a.periods))
      .catch(() => setPeriods([]));
    billingApi
      .getJobRates(customerId)
      .then((r) => setRateRows(r.rates.map(rateRowOf)))
      .catch((err) => setMessage({ text: err instanceof ApiError ? err.message : "โหลดตารางราคาไม่สำเร็จ", error: true }));
  }, [customerId]);

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setPicked(new Set());
    setPrices({});
    setWhtValue(null);
    setWhtChecked(false);
    setConfirming(false);
    setRatesOpen(false);
    setRateRows([]);
    setMessage({ text: "", error: false });
  }

  const priceText = (j: OtherJob) => prices[keyOf(j)] ?? (j.suggestedServiceFee === null ? "" : formatMoney(j.suggestedServiceFee));
  const servicePrice = (j: OtherJob) => parseMoney(priceText(j));

  // งานที่ติ๊กไม่ได้: ไม่มียอดให้วางบิลเลย (ไม่มีค่าธรรมเนียมและไม่คิดค่าบริการ)
  const blockedReason = (j: OtherJob): string | null => {
    const s = servicePrice(j);
    if (priceText(j).trim() !== "" && s === null) return "ค่าบริการต้องเป็นตัวเลข";
    if (j.fee <= 0 && (s ?? 0) <= 0) return "ไม่มียอดให้วางบิล";
    return null;
  };

  const selected = jobs.filter((j) => picked.has(keyOf(j)));
  const issueIso = displayDateToIso(issueDateText.replace(/\D/g, ""));
  const issueForCalc = issueIso || todayIso();
  const account: BillingAccount = customerId ? accountOn(periods, issueForCalc) : "COMPANY";
  const terms = queueCustomer ? (account === "PERSONAL" ? { ...queueCustomer.terms, vat: false } : queueCustomer.terms) : null;
  const defaultWht = terms ? effectiveWhtRate(terms, issueForCalc) : 0;
  const suggestedNo = queue ? (account === "PERSONAL" ? queue.suggestedPersonalInvoiceNo : queue.suggestedInvoiceNo) : "";
  const lastNo = queue ? (account === "PERSONAL" ? queue.lastPersonalInvoiceNo : queue.lastInvoiceNo) : null;
  const invoiceNo = invoiceNoEdit ?? suggestedNo;

  const totals = terms
    ? computeTotals(
        [],
        [],
        terms,
        issueForCalc,
        selected.flatMap((j) => [
          { kind: "FEE" as const, amount: j.fee },
          { kind: "SERVICE" as const, amount: servicePrice(j) ?? 0 },
        ]),
        whtOverrideOf(whtValue),
      )
    : null;

  function toggle(j: OtherJob) {
    setConfirming(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(keyOf(j))) next.delete(keyOf(j));
      else next.add(keyOf(j));
      return next;
    });
  }

  function toggleAll() {
    setConfirming(false);
    const ok = jobs.filter((j) => !blockedReason(j));
    setPicked(selected.length === ok.length ? new Set() : new Set(ok.map(keyOf)));
  }

  function problem(): string | null {
    if (!queueCustomer || !totals) return "เลือกลูกค้า";
    if (selected.length === 0) return "เลือกงานอย่างน้อย 1 งาน";
    for (const j of selected) {
      const target = j.plateText || j.chassis;
      if (priceText(j).trim() === "") return `${j.typeLabel} ${target}: ใส่ค่าบริการ (ใส่ 0 ถ้าไม่คิดค่าบริการ)`;
      const b = blockedReason(j);
      if (b) return `${j.typeLabel} ${target}: ${b}`;
    }
    if (!invoiceNo.trim()) return "ใส่เลขที่บิล";
    if (!issueIso) return "วันที่ออกบิลไม่ถูกต้อง (วว/ดด/ปปปป)";
    return whtProblem(defaultWht, whtValue, whtChecked);
  }

  function openConfirm() {
    const p = problem();
    if (p) return setMessage({ text: p, error: true });
    setMessage({ text: "", error: false });
    setConfirming(true);
  }

  async function handleIssue() {
    const p = problem();
    if (p) return setMessage({ text: p, error: true });
    setSaving(true);
    try {
      const { invoice } = await billingApi.createJobInvoice({
        customerId,
        invoiceNo: invoiceNo.trim(),
        issueDate: issueIso!,
        whtRate: whtOverrideOf(whtValue) ?? undefined,
        jobs: selected.map((j) => ({ type: j.type, id: j.id, serviceFee: servicePrice(j) ?? 0, serviceLabel: j.suggestedServiceLabel })),
      });
      printInvoice(invoice);
      setPicked(new Set());
      setPrices({});
      setInvoiceNoEdit(null);
      setWhtValue(null);
      setWhtChecked(false);
      setConfirming(false);
      setMessage({ text: `ออกบิล ${invoice.invoiceNo} แล้ว (${selected.length} งาน)`, error: false });
      await load();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "ออกบิลไม่สำเร็จ", error: true });
      setConfirming(false);
      // 409 / งานเปลี่ยนไปแล้ว - โหลดคิวใหม่ให้เห็นตรงกับระบบ
      void load();
    } finally {
      setSaving(false);
    }
  }

  function patchRate(i: number, patch: Partial<RateRow>) {
    setRateRows((prev) => prev.map((r, n) => (n === i ? { ...r, ...patch, ...(patch.jobType && patch.jobType !== "TRANSFER" ? { variant: null } : {}) } : r)));
  }

  async function saveRates() {
    if (!customerId) return;
    for (const [i, r] of rateRows.entries()) {
      const a = parseMoney(r.amountText);
      if (a === null || a <= 0) return setMessage({ text: `ตารางราคา แถวที่ ${i + 1}: ราคาต้องมากกว่า 0`, error: true });
    }
    if (!rateRemark.trim()) return setMessage({ text: "ใส่เหตุผลที่แก้ตารางราคา", error: true });
    setRatesSaving(true);
    try {
      const saved = await billingApi.replaceJobRates(
        customerId,
        rateRows.map((r) => ({ jobType: r.jobType, vehicleClass: r.vehicleClass, variant: r.variant, label: r.label.trim(), amount: parseMoney(r.amountText) ?? 0 })),
        rateRemark.trim(),
      );
      setRateRows(saved.rates.map(rateRowOf));
      setRateRemark("");
      setPrices({});
      setMessage({ text: "บันทึกตารางราคาแล้ว - ค่าบริการของงานที่รออยู่คิดใหม่ตามตาราง", error: false });
      await load();
    } catch (err) {
      setMessage({ text: err instanceof ApiError ? err.message : "บันทึกตารางราคาไม่สำเร็จ", error: true });
    } finally {
      setRatesSaving(false);
    }
  }

  const countByCustomer = new Map((queue?.customers ?? []).map((c) => [c.id, c.jobs.length]));

  return (
    <section className="content">
      <h1 tabIndex={-1}>วางบิลงานอื่นๆ</h1>
      <p>
        งานโอน ยกเลิกการใช้รถ คัดแผ่นป้ายทะเบียน ย้ายออก (ที่รับใบเสร็จกลับแล้ว) และต่อภาษี (ที่คืนเอกสารให้ลูกค้าแล้ว) มารอที่นี่ - เลือกลูกค้า เลือกงาน ตรวจค่าบริการ แล้วออกบิล
        ค่าธรรมเนียมราชการอ่านจากใบเสร็จของงาน ค่าบริการมาจากตารางราคาของลูกค้าแต่ละราย
      </p>
      <Link href="/accounting/billing" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        ← กลับไปหน้าวางบิล
      </Link>

      {loading ? (
        <div className="customer-message" role="status" style={{ marginTop: 20 }}>
          กำลังโหลด...
        </div>
      ) : (
        <section className="panel" style={{ marginTop: 16, padding: "18px 23px", overflow: "visible", display: "grid", gap: 14 }}>
          <label className="field" style={{ maxWidth: 420 }}>
            ลูกค้า *
            <select value={customerId} onChange={(e) => chooseCustomer(e.target.value)}>
              <option value="">ทุกลูกค้า (ดูงานค้างทั้งหมด)</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company || c.name}
                  {countByCustomer.get(c.id) ? ` (${countByCustomer.get(c.id)} งานรอวางบิล)` : ""}
                </option>
              ))}
            </select>
            {queueCustomer && (
              <span className="muted" style={{ fontSize: 12 }}>
                {ACCOUNT_LABEL[account]}
                {account === "PERSONAL" ? " (ไม่มี VAT)" : ""}
              </span>
            )}
          </label>

          {/* ยังไม่เลือกลูกค้า = โชว์งานค้างของทุกคนรวมกัน กันลืมวางบิล (ผู้ใช้ 2026-10-08) */}
          {!customerId && queue && (
            <div style={{ display: "grid", gap: 14 }}>
              {queue.customers.filter((c) => c.jobs.length > 0).length === 0 && <div className="empty-customers">ไม่มีงานรอวางบิล</div>}
              {queue.customers
                .filter((c) => c.jobs.length > 0)
                .map((c) => (
                  <div key={c.id} style={{ border: "1px solid #e3e8f0", borderRadius: 10, padding: "10px 14px", display: "grid", gap: 8 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <b>
                        {c.company || c.name} <span className="muted">({c.jobs.length} งานรอวางบิล)</span>
                      </b>
                      <button type="button" className="primary-button" onClick={() => chooseCustomer(c.id)}>
                        วางบิลลูกค้านี้ →
                      </button>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <tbody>
                          {c.jobs.map((j) => (
                            <tr key={keyOf(j)}>
                              <td>{isoToDisplayDate(j.doneDate)}</td>
                              <td>{j.typeLabel}</td>
                              <td>
                                {j.plateText || "—"} <span className="muted">{j.chassis}</span>
                              </td>
                              <td>{j.ownerName || "—"}</td>
                              <td style={{ textAlign: "right" }}>{formatMoney(j.fee)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
            </div>
          )}

          {message.text && (
            <div className={`customer-message${message.error ? " error" : " success"}`} role="status">
              {message.text}
            </div>
          )}

          {customerId && (
            <div style={{ display: "grid", gap: 8 }}>
              <button type="button" className="text-button" style={{ justifySelf: "start" }} onClick={() => setRatesOpen((v) => !v)}>
                {ratesOpen ? "▾" : "▸"} ตารางราคาค่าบริการของลูกค้ารายนี้ ({rateRows.length} แถว)
              </button>
              {ratesOpen && (
                <div style={{ display: "grid", gap: 8 }}>
                  <p className="muted" style={{ fontSize: 12, margin: 0 }}>
                    ราคาก่อน VAT ต่อ 1 งาน · ระบบใช้แถวแรกที่ตรงประเภทงาน ชนิดรถ และแบบงาน (งานโอนแยกแบบได้) · ไม่มีแถวที่ตรง = ต้องกรอกค่าบริการเองก่อนออกบิล · เปลี่ยนราคาไม่กระทบบิลที่ออกไปแล้ว
                  </p>
                  {rateRows.map((r, i) => (
                    <div key={i} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                      <select value={r.jobType} onChange={(e) => patchRate(i, { jobType: e.target.value as JobType })} aria-label="ประเภทงาน">
                        {JOB_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {JOB_LABEL[t]}
                          </option>
                        ))}
                      </select>
                      <select value={r.vehicleClass} onChange={(e) => patchRate(i, { vehicleClass: e.target.value as RateRow["vehicleClass"] })} aria-label="ชนิดรถ">
                        {(["ANY", "CAR", "MOTO"] as const).map((c) => (
                          <option key={c} value={c}>
                            {CLASS_LABEL[c]}
                          </option>
                        ))}
                      </select>
                      {r.jobType === "TRANSFER" && (
                        <select value={r.variant ?? ""} onChange={(e) => patchRate(i, { variant: (e.target.value || null) as RateRow["variant"] })} aria-label="แบบงานโอน">
                          <option value="">ทุกแบบ</option>
                          <option value="OWNER">{VARIANT_LABEL.OWNER}</option>
                          <option value="INSPECTION">{VARIANT_LABEL.INSPECTION}</option>
                        </select>
                      )}
                      <input
                        type="text"
                        value={r.label}
                        placeholder="ข้อความต่อท้ายบนบิล (ไม่บังคับ)"
                        onChange={(e) => patchRate(i, { label: e.target.value })}
                        style={{ minWidth: 200 }}
                      />
                      <input
                        type="text"
                        inputMode="decimal"
                        value={r.amountText}
                        placeholder="ราคา"
                        onChange={(e) => patchRate(i, { amountText: e.target.value })}
                        style={{ width: 110, textAlign: "right" }}
                        aria-label="ราคาก่อน VAT"
                      />
                      <button type="button" className="text-button" onClick={() => setRateRows((prev) => prev.filter((_, n) => n !== i))}>
                        ลบ
                      </button>
                    </div>
                  ))}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setRateRows((prev) => [...prev, { jobType: "TRANSFER", vehicleClass: "ANY", variant: null, label: "", amountText: "" }])}
                    >
                      + เพิ่มแถวราคา
                    </button>
                    <input
                      type="text"
                      value={rateRemark}
                      placeholder="เหตุผลที่แก้ตารางราคา *"
                      onChange={(e) => setRateRemark(e.target.value)}
                      style={{ minWidth: 240 }}
                    />
                    <button type="button" className="primary" onClick={saveRates} disabled={ratesSaving}>
                      {ratesSaving ? "กำลังบันทึก…" : "บันทึกตารางราคา"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {customerId && jobs.length === 0 && <div className="empty-customers">ลูกค้ารายนี้ไม่มีงานรอวางบิล</div>}

          {jobs.length > 0 && (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>
                        <input type="checkbox" checked={selected.length > 0 && selected.length === jobs.filter((j) => !blockedReason(j)).length} onChange={toggleAll} aria-label="เลือกทุกงาน" />
                      </th>
                      <th>เสร็จเมื่อ</th>
                      <th>งาน</th>
                      <th>ทะเบียน / เลขตัวถัง</th>
                      <th>เจ้าของรถ</th>
                      <th style={{ textAlign: "right" }}>ค่าธรรมเนียม</th>
                      <th style={{ textAlign: "right" }}>ค่าบริการ (ก่อน VAT)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {jobs.map((j) => {
                      const blocked = blockedReason(j);
                      return (
                        <tr key={keyOf(j)}>
                          <td>
                            <input type="checkbox" checked={picked.has(keyOf(j))} disabled={!!blocked} onChange={() => toggle(j)} aria-label={`เลือก ${j.typeLabel} ${j.plateText || j.chassis}`} />
                          </td>
                          <td>{isoToDisplayDate(j.doneDate)}</td>
                          <td>
                            {j.typeLabel}
                            <div className="muted">
                              {CLASS_LABEL[j.vehicleClass]}
                              {j.variant && j.variant in VARIANT_LABEL ? ` · ${VARIANT_LABEL[j.variant as keyof typeof VARIANT_LABEL]}` : ""}
                            </div>
                          </td>
                          <td>
                            {j.plateText || "—"}
                            <div className="muted">{j.chassis}</div>
                          </td>
                          <td>{j.ownerName || "—"}</td>
                          <td style={{ textAlign: "right" }}>
                            {formatMoney(j.fee)}
                            <div className="muted" style={{ fontSize: 12 }}>
                              {FEE_SOURCE_LABEL[j.feeSource]}
                              {j.receiptNo ? ` · ${j.receiptNo}` : ""}
                            </div>
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <input
                              type="text"
                              inputMode="decimal"
                              value={priceText(j)}
                              placeholder="ใส่ค่าบริการ"
                              onChange={(e) => (setPrices((prev) => ({ ...prev, [keyOf(j)]: e.target.value })), setConfirming(false))}
                              style={{ width: 110, textAlign: "right" }}
                              aria-label={`ค่าบริการ ${j.plateText || j.chassis}`}
                            />
                            {j.warnings.map((w) => (
                              <div key={w} style={{ fontSize: 12, color: "#bb8527", textAlign: "right" }}>
                                ⚠ {w}
                              </div>
                            ))}
                            {blocked && <div style={{ fontSize: 12, color: "#c0392b", textAlign: "right" }}>{blocked}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
                <label className="field">
                  {account === "PERSONAL" ? "เลขที่บิล (บัญชีบุคคล) *" : "เลขที่ IV *"}
                  <input type="text" value={invoiceNo} onChange={(e) => (setInvoiceNoEdit(e.target.value), setConfirming(false))} />
                  <span className="muted" style={{ fontSize: 12 }}>
                    {lastNo ? `เลขล่าสุดในระบบ: ${lastNo} · ระบบใส่เลขถัดไปให้แล้ว แก้ได้` : "ยังไม่เคยออกบิลบัญชีนี้ในระบบ - ใส่เลขเอง"}
                  </span>
                </label>
                <label className="field">
                  วันที่ออกบิล *
                  <DateInput
                    value={issueDateText}
                    onChange={(value) => (setIssueDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8))), setConfirming(false))}
                  />
                </label>
              </div>

              {queueCustomer?.terms.requiresQuotation && (
                <div className="customer-message error" role="alert">
                  ลูกค้ารายนี้ต้องมีใบเสนอราคาที่อนุมัติแล้วก่อนวางบิล - ออกบิลจากหน้าใบเสนอราคา
                </div>
              )}

              {terms && (
                <WhtRatePicker
                  defaultRate={defaultWht}
                  value={whtValue}
                  onChange={(v) => (setWhtValue(v), setConfirming(false))}
                  checked={whtChecked}
                  onCheckedChange={setWhtChecked}
                />
              )}

              {totals && selected.length > 0 && (
                <div style={{ display: "grid", gap: 6, fontSize: 14, maxWidth: 360 }}>
                  <Sum label="ค่าธรรมเนียม (เงินทดรองจ่าย)" value={totals.feeTotal} />
                  <Sum label="ค่าบริการ" value={totals.serviceTotal} />
                  {totals.vatRate > 0 && <Sum label={`VAT ${totals.vatRate}%`} value={totals.vatAmount} />}
                  {totals.whtRate > 0 && <Sum label={`หัก ณ ที่จ่าย ${totals.whtRate}%`} value={-totals.whtAmount} />}
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontWeight: 600, borderTop: "1px solid #e3e8f2", paddingTop: 6 }}>
                    <span>จำนวนเงินทั้งสิ้น</span>
                    <span>{formatMoney(totals.netTotal)}</span>
                  </div>
                </div>
              )}

              {confirming && totals ? (
                <div style={{ display: "grid", gap: 8, border: "1px solid #dce2ec", borderRadius: 10, padding: "12px 14px" }}>
                  <b style={{ fontWeight: 600 }}>ตรวจก่อนออกบิล</b>
                  <div style={{ fontSize: 14 }}>
                    {invoiceNo} · {queueCustomer?.company || queueCustomer?.name} · {ACCOUNT_LABEL[account]} · {issueDateText}
                  </div>
                  <div style={{ fontSize: 14 }}>
                    {selected.length} งาน · VAT {totals.vatRate ? `${totals.vatRate}%` : "ไม่มี"} ·{" "}
                    <b style={{ fontWeight: 600, color: totals.whtRate !== defaultWht ? "#c0392b" : undefined }}>
                      หัก ณ ที่จ่าย {totals.whtRate ? `${totals.whtRate}% = ${formatMoney(totals.whtAmount)}` : "ไม่หัก"}
                    </b>{" "}
                    · ยอดสุทธิ <b style={{ fontWeight: 600 }}>{formatMoney(totals.netTotal)}</b> บาท
                  </div>
                  <div className="form-actions" style={{ marginTop: 0 }}>
                    <button type="button" onClick={() => setConfirming(false)} disabled={saving}>
                      กลับไปแก้
                    </button>
                    <button type="button" className="primary" onClick={handleIssue} disabled={saving}>
                      {saving ? "กำลังออกบิล…" : "ยืนยันออกบิลและพิมพ์"}
                    </button>
                  </div>
                </div>
              ) : (
                <button type="button" className="primary" style={{ justifySelf: "end" }} onClick={openConfirm} disabled={saving || selected.length === 0}>
                  ออกบิล ({selected.length} งาน)
                </button>
              )}
            </>
          )}
        </section>
      )}
    </section>
  );
}

function Sum({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span>{label}</span>
      <span>{value < 0 ? `-${formatMoney(-value)}` : formatMoney(value)}</span>
    </div>
  );
}
