"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, type Customer } from "@/lib/api";
import { billingApi, type AccountPeriod, type BillingAccount, type BillingTerms, type RateKind, type RateVehicleKind } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { computeTotals, formatMoney, round2 } from "@/lib/invoice";
import { buildQuotationHtml, printQuotation, RATE_KIND_LABEL, type PrintableQuotation } from "@/lib/quotation-print";
import {
  QUOTATION_KIND_LABEL,
  quotationApi,
  type Quotation,
  type QuotationInput,
  type QuotationItem,
  type QuotationKind,
  type QuotationRateInput,
  type YamahaCounts,
} from "@/lib/quotation-api";
import { DateInput } from "@/components/DateInput";
import { emptyItemRow, InvoiceItemsEditor, itemRowsFromItems, itemRowsProblem, itemRowsToItems, type ItemRow } from "@/components/InvoiceItemsEditor";

// ออกใบเสนอราคา / แก้ร่าง (ผู้ใช้ 2026-10-01) - ?edit=<id> = แก้ร่างที่ยังไม่ออกเลข
// ยอดงาน: บรรทัดเหมือนบิลกำหนดเอง (ค่าธรรมเนียม / ค่าบริการ / ขายสินค้า) ดึงยอดแจ้งย้ายยามาฮ่าของเดือนมาใส่ให้ได้
// ราคาต่อคัน: แถวราคาแบบเดียวกับตารางราคาลูกค้า - ลูกค้าอนุมัติแล้วกดตั้งเป็นราคาลูกค้าได้เลย
// ลูกค้าใหม่ที่ยังไม่อยู่ในระบบ: พิมพ์ชื่อ/ที่อยู่เอง ผูกกับลูกค้าในระบบทีหลังได้

const NEW_CUSTOMER = "__new";
// เงื่อนไขตั้งต้นของลูกค้าใหม่ = ค่าตั้งต้นของลูกค้าในระบบ (ตรงกับ DEFAULT_TERMS ฝั่ง backend)
const DEFAULT_TERMS: BillingTerms = { vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null };

interface RateRow {
  kind: RateKind;
  label: string;
  vehicleKind: RateVehicleKind;
  ccMinText: string;
  ccMaxText: string;
  chassisPrefixText: string;
  amountText: string;
  vatInclusive: boolean;
  includesReceipt: boolean;
}

const emptyRateRow = (): RateRow => ({ kind: "BASE", label: "", vehicleKind: "ANY", ccMinText: "", ccMaxText: "", chassisPrefixText: "", amountText: "", vatInclusive: false, includesReceipt: false });

// ว่าง = ไม่จำกัด (null) · พิมพ์ผิด = NaN
function parseCc(text: string): number | null {
  const s = text.replace(/,/g, "").trim();
  if (s === "") return null;
  return /^\d+(\.\d+)?$/.test(s) ? Number(s) : Number.NaN;
}
const parseAmount = (text: string) => {
  const s = text.replace(/,/g, "").trim();
  return /^\d+(\.\d+)?$/.test(s) ? round2(Number(s)) : Number.NaN;
};

function rateRowsProblem(rows: RateRow[]): string | null {
  for (const [i, r] of rows.entries()) {
    const at = `แถวราคาที่ ${i + 1}`;
    if (!r.label.trim()) return `${at}: ใส่ชื่อรายการ`;
    const amount = parseAmount(r.amountText);
    if (!Number.isFinite(amount) || amount <= 0) return `${at}: ใส่ราคามากกว่า 0`;
    const ccMin = parseCc(r.ccMinText);
    const ccMax = parseCc(r.ccMaxText);
    if (Number.isNaN(ccMin) || Number.isNaN(ccMax) || (ccMin !== null && ccMax !== null && ccMin >= ccMax)) return `${at}: ช่วง CC ไม่ถูกต้อง`;
  }
  return null;
}

const rateRowsToInput = (rows: RateRow[]): QuotationRateInput[] =>
  rows.map((r) => ({
    label: r.label.trim(),
    kind: r.kind,
    vehicleKind: r.vehicleKind,
    ccMin: parseCc(r.ccMinText),
    ccMax: parseCc(r.ccMaxText),
    chassisPrefix: r.chassisPrefixText.trim() || null,
    amount: parseAmount(r.amountText),
    vatInclusive: r.vatInclusive,
    includesReceipt: r.includesReceipt,
  }));

const rateRowsFromItems = (items: QuotationItem[]): RateRow[] =>
  items.map((it) => ({
    kind: it.rateKind ?? "BASE",
    label: it.description,
    vehicleKind: it.vehicleKind ?? "ANY",
    ccMinText: it.ccMin === null ? "" : it.ccMin.toLocaleString("en-US"),
    ccMaxText: it.ccMax === null ? "" : it.ccMax.toLocaleString("en-US"),
    chassisPrefixText: it.chassisPrefix ?? "",
    amountText: formatMoney(it.unitPrice),
    vatInclusive: it.vatInclusive,
    includesReceipt: it.includesReceipt,
  }));

function accountOn(periods: AccountPeriod[], iso: string): BillingAccount {
  const started = periods.filter((p) => p.effectiveFrom <= iso).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return started.length ? started[started.length - 1].account : "COMPANY";
}

const monthLabel = (month: string) => `${month.slice(5, 7)}/${month.slice(0, 4)}`;

export function QuotationFormPage() {
  const router = useRouter();
  const editId = useSearchParams().get("edit");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [editing, setEditing] = useState<Quotation | null>(null);
  const [kind, setKind] = useState<QuotationKind>("JOB");
  const [customerId, setCustomerId] = useState("");
  const [typed, setTyped] = useState({ name: "", branch: "", address: "", taxId: "" });
  const [terms, setTerms] = useState<BillingTerms | null>(null);
  const [periods, setPeriods] = useState<AccountPeriod[]>([]);
  const [issueDateText, setIssueDateText] = useState(isoToDisplayDate(todayIso()));
  const [validDaysText, setValidDaysText] = useState("30");
  const [title, setTitle] = useState("");
  const [conditions, setConditions] = useState("");
  const [rows, setRows] = useState<ItemRow[]>([emptyItemRow()]);
  const [rateRows, setRateRows] = useState<RateRow[]>([emptyRateRow()]);
  const [yamahaPick, setYamahaPick] = useState(todayIso().slice(0, 7));
  const [yamaha, setYamaha] = useState<{ month: string; counts: YamahaCounts } | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const c = await api.listCustomers();
        setCustomers(c.customers);
        if (editId) {
          const { quotation: q } = await quotationApi.get(editId);
          if (q.status !== "DRAFT") throw new Error("ใบเสนอราคานี้ออกเลขแล้ว แก้ไม่ได้ - ทำฉบับแก้ไขจากหน้ารายละเอียด");
          setEditing(q);
          setKind(q.kind);
          setCustomerId(q.customerId ?? NEW_CUSTOMER);
          if (!q.customerId) setTyped({ name: q.customer.name, branch: q.customer.branch ?? "", address: q.customer.address ?? "", taxId: q.customer.taxId ?? "" });
          setIssueDateText(isoToDisplayDate(q.issueDate));
          setValidDaysText(String(q.validDays));
          setTitle(q.title);
          setConditions(q.conditions ?? "");
          if (q.kind === "JOB") setRows(itemRowsFromItems(q.items));
          else setRateRows(rateRowsFromItems(q.items));
          if (q.yamahaMonth && q.yamahaCounts) setYamaha({ month: q.yamahaMonth, counts: q.yamahaCounts });
        }
      } catch (err) {
        setError(err instanceof ApiError || err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [editId]);

  useEffect(() => {
    if (!customerId || customerId === NEW_CUSTOMER) return;
    Promise.all([billingApi.customerTerms(customerId), billingApi.accountPeriods(customerId)])
      .then(([t, a]) => {
        setTerms(t.terms);
        setPeriods(a.periods);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "โหลดเงื่อนไขวางบิลของลูกค้าไม่สำเร็จ"));
  }, [customerId]);

  const isNew = customerId === NEW_CUSTOMER;
  const customer = customers.find((c) => c.id === customerId) ?? null;
  const issueIso = displayDateToIso(issueDateText.replace(/\D/g, ""));
  const issueForCalc = issueIso || todayIso();
  const validDays = /^\d{1,3}$/.test(validDaysText) ? Number(validDaysText) : Number.NaN;
  const account: BillingAccount = isNew ? "COMPANY" : accountOn(periods, issueForCalc);
  const baseTerms = isNew ? DEFAULT_TERMS : terms;
  const quoteTerms = baseTerms ? (account === "PERSONAL" ? { ...baseTerms, vat: false } : baseTerms) : null;
  const items = itemRowsToItems(rows);
  const totals = quoteTerms ? computeTotals([], [], quoteTerms, issueForCalc, kind === "JOB" ? items : []) : null;
  const grand = totals ? round2(totals.grossTotal) : 0;

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setTerms(null);
    setPeriods([]);
  }

  function problem(): string | null {
    if (!customerId) return "เลือกลูกค้า";
    if (isNew && !typed.name.trim()) return "ใส่ชื่อลูกค้าใหม่";
    if (isNew && typed.taxId.trim() && !/^\d{13}$/.test(typed.taxId.trim())) return "เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก (เว้นว่างได้)";
    if (!quoteTerms) return "กำลังโหลดเงื่อนไขของลูกค้า";
    if (!issueIso) return "วันที่ออกไม่ถูกต้อง (วว/ดด/ปปปป)";
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) return "ยืนราคาต้องเป็นจำนวนวัน 1-365";
    if (kind === "JOB") return rows.length === 0 ? "ต้องมีอย่างน้อย 1 บรรทัด" : itemRowsProblem(rows);
    return rateRows.length === 0 ? "ต้องมีอย่างน้อย 1 แถวราคา" : rateRowsProblem(rateRows);
  }

  function payload(): QuotationInput {
    return {
      ...(editing ? { expectedUpdatedAt: editing.updatedAt } : { kind }),
      ...(isNew
        ? { customerId: null, customer: { name: typed.name.trim(), branch: typed.branch.trim() || null, address: typed.address.trim() || null, taxId: typed.taxId.trim() || null } }
        : { customerId }),
      issueDate: issueIso,
      validDays,
      title: title.trim(),
      conditions: conditions.trim(),
      items: kind === "JOB" ? items.map(({ kind: k, description, quantity, unitPrice, cost }) => ({ kind: k, description, quantity, unitPrice, cost })) : rateRowsToInput(rateRows),
      yamahaMonth: kind === "JOB" ? (yamaha?.month ?? null) : null,
    };
  }

  // บันทึกร่าง แล้ว (ถ้าเลือก) ออกเลขและพิมพ์ - ออกเลขไม่ผ่าน (เช่น ยอดแจ้งย้ายเปลี่ยน) ร่างยังถูกบันทึกไว้ให้แก้ต่อ
  async function save(issue: boolean) {
    const p = problem();
    if (p) return setError(p);
    setSaving(true);
    setError("");
    try {
      const { quotation: draft } = editing ? await quotationApi.update(editing.id, payload()) : await quotationApi.create(payload());
      if (!issue) return router.push("/accounting/quotations?stage=DRAFT");
      try {
        const { quotation } = await quotationApi.issue(draft.id, draft.updatedAt);
        printQuotation(quotation);
        router.push(`/accounting/quotations/view?id=${encodeURIComponent(quotation.id)}`);
      } catch (err) {
        setEditing(draft);
        if (!editing) router.replace(`/accounting/quotations/new?edit=${encodeURIComponent(draft.id)}`);
        throw err;
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกใบเสนอราคาไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function pullYamaha() {
    if (!/^\d{4}-\d{2}$/.test(yamahaPick)) return setError("เลือกเดือนของงานแจ้งย้าย");
    setError("");
    try {
      const res = await quotationApi.yamahaMonth(yamahaPick);
      if (res.quotedBy && res.quotedBy.id !== editing?.id) {
        return setError(`งานแจ้งย้ายเดือน ${monthLabel(res.month)} มีใบเสนอราคา ${res.quotedBy.quotationNo ?? ""} อยู่แล้ว - เปิดใบนั้นทำฉบับแก้ไข หรือยกเลิกก่อน`);
      }
      if (res.counts.SMALL + res.counts.LARGE === 0) return setError(`เดือน ${monthLabel(res.month)} ยังไม่มีรายการแจ้งย้ายในระบบ`);
      setRows(itemRowsFromItems(res.items.map((it) => ({ ...it, amount: round2(it.quantity * it.unitPrice) }))));
      setYamaha({ month: res.month, counts: res.counts });
      if (!title.trim()) setTitle(`งานแจ้งย้ายยามาฮ่า เดือน ${monthLabel(res.month)}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "ดึงยอดแจ้งย้ายไม่สำเร็จ");
    }
  }

  const preview: PrintableQuotation | null =
    totals && (customer || isNew)
      ? {
          quotationNo: null,
          kind,
          status: "DRAFT",
          customer: isNew
            ? { name: typed.name.trim() || "—", branch: typed.branch.trim() || null, address: typed.address.trim() || null, taxId: typed.taxId.trim() || null }
            : { name: customer!.company || customer!.name, branch: customer!.branch, address: customer!.address, taxId: customer!.taxId },
          issueDate: issueForCalc,
          validUntil: new Date(Date.parse(`${issueForCalc}T00:00:00Z`) + (Number.isFinite(validDays) ? validDays : 30) * 86_400_000).toISOString().slice(0, 10),
          title: title.trim(),
          conditions: conditions.trim() || null,
          account,
          vatRate: totals.vatRate,
          whtRate: totals.whtRate,
          feeTotal: totals.feeTotal,
          serviceTotal: totals.serviceTotal,
          goodsTotal: totals.goodsTotal,
          vatAmount: totals.vatAmount,
          whtAmount: totals.whtAmount,
          items:
            kind === "JOB"
              ? items.map((it) => ({ ...it, rateKind: null, vehicleKind: null, ccMin: null, ccMax: null, chassisPrefix: null, vatInclusive: false, includesReceipt: false }))
              : rateRowsToInput(rateRows).map((r) => ({
                  kind: "SERVICE" as const,
                  description: r.label,
                  quantity: 1,
                  unitPrice: Number.isFinite(r.amount) ? r.amount : 0,
                  amount: Number.isFinite(r.amount) ? r.amount : 0,
                  cost: null,
                  rateKind: r.kind,
                  vehicleKind: r.vehicleKind,
                  ccMin: Number.isNaN(r.ccMin) ? null : r.ccMin,
                  ccMax: Number.isNaN(r.ccMax) ? null : r.ccMax,
                  chassisPrefix: r.chassisPrefix,
                  vatInclusive: r.vatInclusive,
                  includesReceipt: r.includesReceipt,
                })),
        }
      : null;

  const heading = editing ? (editing.replaces?.quotationNo ? `ร่างฉบับแก้ไขของ ${editing.replaces.quotationNo}` : "แก้ร่างใบเสนอราคา") : "ออกใบเสนอราคา";

  if (loading) {
    return (
      <section className="content">
        <h1 tabIndex={-1}>ออกใบเสนอราคา</h1>
        <div className="customer-message" role="status">
          กำลังโหลด...
        </div>
      </section>
    );
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>{heading}</h1>
      <p>
        {editing?.replaces?.quotationNo
          ? `ออกเลขแล้วจะได้เลขเดิมต่อท้าย -R และใบ ${editing.replaces.quotationNo} จะถูกแทนที่`
          : "บันทึกเป็นร่างไว้แก้ต่อได้ - ได้เลข QT ตอนกด “ออกเลขและพิมพ์” หลังจากนั้นแก้ไม่ได้ ต้องทำฉบับแก้ไข"}
      </p>
      <Link href="/accounting/quotations" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        ← กลับไปรายการใบเสนอราคา
      </Link>

      <section className="panel" style={{ marginTop: 16, padding: "18px 23px", overflow: "visible", display: "grid", gap: 14 }}>
        <div className="inspect-filter" style={{ padding: 0 }} role="group" aria-label="แบบใบเสนอราคา">
          {(["JOB", "RATE"] as const).map((k) => (
            <button key={k} type="button" className={`filter-chip${kind === k ? " selected" : ""}`} disabled={!!editing && kind !== k} onClick={() => setKind(k)}>
              {QUOTATION_KIND_LABEL[k]}
              {k === "JOB" ? " (อนุมัติแล้วออกใบวางบิลต่อ)" : " (อนุมัติแล้วตั้งเป็นราคาลูกค้า)"}
            </button>
          ))}
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          <label className="field">
            ลูกค้า *
            <select value={customerId} onChange={(e) => chooseCustomer(e.target.value)}>
              <option value="">— เลือกลูกค้า —</option>
              <option value={NEW_CUSTOMER}>+ ลูกค้าใหม่ (ยังไม่อยู่ในระบบ)</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company || c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            วันที่ออก *
            <DateInput value={issueDateText} onChange={(value) => setIssueDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
          </label>
          <label className="field">
            ยืนราคา (วัน) *
            <input type="text" inputMode="numeric" value={validDaysText} onChange={(e) => setValidDaysText(e.target.value.replace(/\D/g, "").slice(0, 3))} />
          </label>
        </div>

        {isNew && (
          <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", background: "#f5f7fb", borderRadius: 10, padding: "12px 14px" }}>
            <label className="field">
              ชื่อลูกค้า / บริษัท *
              <input type="text" value={typed.name} onChange={(e) => setTyped({ ...typed, name: e.target.value })} maxLength={200} />
            </label>
            <label className="field">
              สาขา
              <input type="text" value={typed.branch} onChange={(e) => setTyped({ ...typed, branch: e.target.value })} placeholder="เช่น สำนักงานใหญ่" />
            </label>
            <label className="field">
              เลขผู้เสียภาษี (13 หลัก)
              <input type="text" inputMode="numeric" value={typed.taxId} onChange={(e) => setTyped({ ...typed, taxId: e.target.value.replace(/\D/g, "").slice(0, 13) })} />
            </label>
            <label className="field" style={{ gridColumn: "1 / -1" }}>
              ที่อยู่
              <input type="text" value={typed.address} onChange={(e) => setTyped({ ...typed, address: e.target.value })} />
            </label>
            <span className="muted" style={{ fontSize: 12, gridColumn: "1 / -1" }}>
              ลูกค้าอนุมัติแล้ว ให้ ADMIN เพิ่มลูกค้าในหน้าลูกค้า แล้วผูกกับใบเสนอราคานี้ก่อนออกบิล / ตั้งราคา
            </span>
          </div>
        )}

        <label className="field">
          เรื่อง / ชื่องาน
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder={kind === "JOB" ? "เช่น งานแจ้งย้ายยามาฮ่า เดือน 10/2026" : "เช่น ค่าบริการจดทะเบียนรถจักรยานยนต์ใหม่"} />
          {kind === "JOB" && (
            <span className="muted" style={{ fontSize: 12 }}>
              ใช้เป็นชื่องานบนใบวางบิลที่ออกจากใบนี้ด้วย
            </span>
          )}
        </label>

        {kind === "JOB" ? (
          <>
            <div style={{ border: "1px dashed #c9d6f5", borderRadius: 10, padding: "10px 12px", display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", fontSize: 14 }}>
              <span>งานแจ้งย้ายยามาฮ่า:</span>
              <input type="month" value={yamahaPick} onChange={(e) => setYamahaPick(e.target.value)} aria-label="เดือนของงานแจ้งย้าย" style={{ border: "1px solid #dce2ec", borderRadius: 8, padding: "7px 10px" }} />
              <button type="button" className="text-button" onClick={pullYamaha}>
                ดึงยอดของเดือนนี้มาใส่
              </button>
              {yamaha && (
                <span className="badge">
                  ผูกกับยอดเดือน {monthLabel(yamaha.month)} · รถเล็ก {yamaha.counts.SMALL} · รถใหญ่ {yamaha.counts.LARGE}{" "}
                  <button type="button" className="text-button" onClick={() => setYamaha(null)} style={{ padding: 0, marginLeft: 6 }}>
                    เลิกผูก
                  </button>
                </span>
              )}
              {yamaha && (
                <span className="muted" style={{ fontSize: 12, flexBasis: "100%" }}>
                  ออกเลขแล้วรายการแจ้งย้ายของเดือนนี้จะถูกล็อก (เพิ่ม / แก้ / ยกเลิกไม่ได้) จนกว่าจะยกเลิกใบเสนอราคา
                </span>
              )}
            </div>
            <InvoiceItemsEditor rows={rows} onChange={setRows} minRows={1} />
          </>
        ) : (
          <RateRowsEditor rows={rateRows} onChange={setRateRows} />
        )}

        {kind === "JOB" && totals && (
          <div style={{ display: "grid", gap: 6, fontSize: 14, maxWidth: 420, justifySelf: "end", width: "100%" }}>
            {totals.feeTotal > 0 && <Sum label="ค่าธรรมเนียม" value={totals.feeTotal} />}
            <Sum label="ค่าบริการ" value={totals.serviceTotal} />
            {totals.goodsTotal > 0 && <Sum label="ค่าสินค้า" value={totals.goodsTotal} />}
            <Sum label={totals.vatRate ? `VAT ${totals.vatRate}%` : "VAT (ไม่มี)"} value={totals.vatAmount} />
            <div style={{ display: "flex", justifyContent: "space-between", background: "#edf2ff", color: "#2854d9", borderRadius: 10, padding: "10px 14px", fontWeight: 600 }}>
              <span>รวมทั้งสิ้น</span>
              <span style={{ fontSize: 20 }}>{formatMoney(grand)}</span>
            </div>
            {totals.whtRate > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                ตอนจ่าย ลูกค้าหัก ณ ที่จ่าย {totals.whtRate}% = {formatMoney(totals.whtAmount)} · รับจริง {formatMoney(totals.netTotal)}
              </span>
            )}
          </div>
        )}

        <label className="field">
          เงื่อนไข (พิมพ์ท้ายใบ)
          <textarea value={conditions} onChange={(e) => setConditions(e.target.value)} maxLength={1000} rows={2} placeholder="เช่น ชำระภายใน 30 วันหลังวางบิล" />
        </label>

        <button className="text-button" style={{ justifySelf: "start" }} onClick={() => setShowPreview((s) => !s)} disabled={!preview}>
          {showPreview ? "ซ่อนตัวอย่าง" : "ดูตัวอย่างใบเสนอราคา"}
        </button>
        {showPreview && preview && <iframe title="ตัวอย่างใบเสนอราคา" srcDoc={buildQuotationHtml(preview)} style={{ width: "100%", height: 560, border: "1px solid #f0f2f6", background: "white" }} />}

        {error && (
          <div className="customer-message error" role="alert">
            {error}
          </div>
        )}

        <div className="form-actions" style={{ marginTop: 0, justifyContent: "flex-end", flexWrap: "wrap" }}>
          <button type="button" onClick={() => save(false)} disabled={saving}>
            บันทึกร่าง
          </button>
          <button type="button" className="primary" onClick={() => save(true)} disabled={saving}>
            {saving ? "กำลังบันทึก…" : "ออกเลขและพิมพ์"}
          </button>
        </div>
      </section>
    </section>
  );
}

function Sum({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span>{label}</span>
      <span>{formatMoney(value)}</span>
    </div>
  );
}

const INPUT = { height: 46, boxSizing: "border-box", border: "1px solid #dce2ec", borderRadius: 8, background: "white", padding: "0 13px", color: "#18243c", font: "inherit", minWidth: 0 } as const;
const FIELD = { display: "grid", gap: 4, minWidth: 0 } as const;
const small = { fontSize: 12 } as const;

// แถวราคาต่อคัน - ช่องเดียวกับตารางราคาลูกค้า แต่จัดเป็นการ์ดห่อบรรทัดได้ ไม่ต้องเลื่อนซ้ายขวา
function RateRowsEditor({ rows, onChange }: { rows: RateRow[]; onChange: (rows: RateRow[]) => void }) {
  const patch = (i: number, p: Partial<RateRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...p } : r)));
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {rows.map((r, i) => {
        const n = i + 1;
        return (
          <div key={i} style={{ border: "1px solid #e3e8f2", borderRadius: 10, padding: "10px 12px", display: "grid", gap: 8, fontSize: 14 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span className="muted" style={small}>
                {n}.
              </span>
              <select value={r.kind} onChange={(e) => patch(i, { kind: e.target.value as RateKind })} aria-label={`ประเภท แถวที่ ${n}`} style={{ ...INPUT, paddingRight: 8 }}>
                {(Object.keys(RATE_KIND_LABEL) as RateKind[]).map((k) => (
                  <option key={k} value={k}>
                    {RATE_KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={r.label}
                onChange={(e) => patch(i, { label: e.target.value })}
                placeholder="ชื่อรายการที่พิมพ์ เช่น จดทะเบียนรถจักรยานยนต์ ต่ำกว่า 300 cc"
                style={{ ...INPUT, flex: "1 1 220px" }}
                aria-label={`ชื่อรายการ แถวที่ ${n}`}
              />
              <button type="button" className="text-button" onClick={() => onChange(rows.filter((_, x) => x !== i))} disabled={rows.length <= 1} aria-label={`ลบแถวที่ ${n}`}>
                ลบ
              </button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "8px 10px" }}>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  ชนิดรถ
                </span>
                <select value={r.vehicleKind} onChange={(e) => patch(i, { vehicleKind: e.target.value as RateVehicleKind })} style={{ ...INPUT, paddingRight: 8 }}>
                  <option value="ANY">ทุกชนิด</option>
                  <option value="CAR">รถยนต์</option>
                  <option value="MOTO">จักรยานยนต์</option>
                </select>
              </label>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  CC ตั้งแต่
                </span>
                <input type="text" inputMode="decimal" value={r.ccMinText} onChange={(e) => patch(i, { ccMinText: e.target.value })} placeholder="ไม่จำกัด" style={{ ...INPUT, textAlign: "right" }} />
              </label>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  CC น้อยกว่า
                </span>
                <input type="text" inputMode="decimal" value={r.ccMaxText} onChange={(e) => patch(i, { ccMaxText: e.target.value })} placeholder="ไม่จำกัด" style={{ ...INPUT, textAlign: "right" }} />
              </label>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  เลขตัวถังขึ้นต้น
                </span>
                <input type="text" value={r.chassisPrefixText} onChange={(e) => patch(i, { chassisPrefixText: e.target.value.toUpperCase() })} placeholder="ไม่จำกัด" style={INPUT} />
              </label>
              <label style={FIELD}>
                <span className="muted" style={small}>
                  ราคาต่อคัน (บาท)
                </span>
                <input type="text" inputMode="decimal" value={r.amountText} onChange={(e) => patch(i, { amountText: e.target.value })} style={{ ...INPUT, textAlign: "right", fontWeight: 600 }} aria-label={`ราคา แถวที่ ${n}`} />
              </label>
            </div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 13 }}>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={r.vatInclusive} onChange={(e) => patch(i, { vatInclusive: e.target.checked })} />
                ราคารวม VAT แล้ว
              </label>
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={r.includesReceipt} onChange={(e) => patch(i, { includesReceipt: e.target.checked })} />
                ราคารวมค่าใบเสร็จกรมขนส่งแล้ว
              </label>
            </div>
          </div>
        );
      })}
      <button type="button" className="text-button" style={{ justifySelf: "start" }} onClick={() => onChange([...rows, emptyRateRow()])}>
        + เพิ่มแถวราคา
      </button>
      <p className="muted" style={{ fontSize: 12, margin: 0 }}>
        ราคาหลัก = ราคาจดทะเบียนต่อคัน เลือกตามชนิดรถ / CC / เลขตัวถังขึ้นต้น · ค่าเพิ่ม = บวกเพิ่มเมื่อรถเข้าเงื่อนไขนั้น · ลูกค้าอนุมัติแล้วกด “ตั้งเป็นราคาลูกค้า”
        ระบบจะใช้แถวเหล่านี้เป็นตารางราคาของลูกค้าในหน้าวางบิล
      </p>
    </div>
  );
}
