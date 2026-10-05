"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, type Customer } from "@/lib/api";
import {
  ACCOUNT_LABEL,
  billingApi,
  type AccountPeriod,
  type BillingAccount,
  type BillingTerms,
  type Invoice,
  type NextInvoiceNumbers,
} from "@/lib/billing-api";
import {
  displayDateToIso,
  formatDateDigitsCe,
  isoToDisplayDate,
  todayIso,
} from "@/lib/date";
import { computeTotals, effectiveWhtRate, formatMoney } from "@/lib/invoice";
import {
  emptyItemRow,
  InvoiceItemsEditor,
  itemRowsFromItems,
  itemRowsProblem,
  itemRowsProfit,
  itemRowsToItems,
  type ItemRow,
} from "@/components/InvoiceItemsEditor";
import {
  buildInvoiceHtml,
  printInvoice,
  type PrintableInvoice,
} from "@/lib/invoice-print";
import { quotationApi } from "@/lib/quotation-api";
import {
  isYamahaCustomer,
  thaiMonthLabel,
  yamahaBillRows,
  yamahaPriceOptions,
} from "@/lib/yamaha-billing";
import { DateInput } from "@/components/DateInput";
import {
  WhtRatePicker,
  whtOverrideOf,
  whtProblem,
} from "@/components/WhtRatePicker";

// บิลกำหนดเอง (ผู้ใช้ 2026-09-29): บรรทัดพิมพ์เอง ไม่ผูกกับรถ - งานเก่าที่ย้ายมาจากระบบเดิม (ไม่มีข้อมูลรถในระบบนี้) / ขายสินค้า
// แต่ละบรรทัดเลือกประเภทภาษี: ค่าธรรมเนียมราชการ (ไม่มี VAT ไม่หัก) · ค่าบริการ (VAT + หัก) · ขายสินค้า (VAT ไม่หัก)
// ต้นทุนไว้คิดกำไรภายใน ไม่พิมพ์บนบิล · ?edit=<invoiceId> = แก้บิลกำหนดเองที่ยังไม่รับเงิน (เลขเดิม ต้องมีเหตุผล)

// บัญชีของลูกค้า ณ วันที่ = ช่วงล่าสุดที่เริ่มไม่เกินวันนั้น (เหมือน accountOn ฝั่ง backend) ไม่มีช่วงเลย = บัญชีบริษัท
function accountOn(periods: AccountPeriod[], iso: string): BillingAccount {
  const started = periods
    .filter((p) => p.effectiveFrom <= iso)
    .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  return started.length ? started[started.length - 1].account : "COMPANY";
}

export function BillingCustomInvoicePage() {
  const router = useRouter();
  const editId = useSearchParams().get("edit");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [numbers, setNumbers] = useState<NextInvoiceNumbers | null>(null);
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [customerId, setCustomerId] = useState("");
  const [terms, setTerms] = useState<BillingTerms | null>(null);
  const [periods, setPeriods] = useState<AccountPeriod[]>([]);
  const [invoiceNoEdit, setInvoiceNoEdit] = useState<string | null>(null);
  const [issueDateText, setIssueDateText] = useState(
    isoToDisplayDate(todayIso()),
  );
  const [rows, setRows] = useState<ItemRow[]>([emptyItemRow()]);
  const [yamahaMonthPick, setYamahaMonthPick] = useState<string | null>(null);
  const [yamahaBusy, setYamahaBusy] = useState(false);
  const [yamahaNote, setYamahaNote] = useState("");
  const [whtValue, setWhtValue] = useState<number | null>(null);
  const [whtChecked, setWhtChecked] = useState(false);
  const [remark, setRemark] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const [c, n] = await Promise.all([
          api.listCustomers(),
          billingApi.nextInvoiceNumbers(),
        ]);
        setCustomers(c.customers);
        setNumbers(n);
        if (editId) {
          const { invoice } = await billingApi.getInvoice(editId);
          if (invoice.lines.length > 0)
            throw new Error("บิลนี้มีรถ - แก้จากรายการบิลในหน้าวางบิล");
          if (invoice.status !== "ISSUED")
            throw new Error("แก้ไขได้เฉพาะบิลที่ยังไม่รับเงิน");
          setEditing(invoice);
          setCustomerId(invoice.customerId);
          setIssueDateText(isoToDisplayDate(invoice.issueDate));
          setRows(itemRowsFromItems(invoice.items));
          setWhtValue(invoice.whtRate);
        }
      } catch (err) {
        setError(
          err instanceof ApiError || err instanceof Error
            ? err.message
            : "โหลดข้อมูลไม่สำเร็จ",
        );
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [editId]);

  useEffect(() => {
    if (!customerId) return;
    Promise.all([
      billingApi.customerTerms(customerId),
      billingApi.accountPeriods(customerId),
    ])
      .then(([t, a]) => {
        setTerms(t.terms);
        setPeriods(a.periods);
      })
      .catch((err) =>
        setError(
          err instanceof ApiError
            ? err.message
            : "โหลดเงื่อนไขวางบิลของลูกค้าไม่สำเร็จ",
        ),
      );
  }, [customerId]);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const issueIso = displayDateToIso(issueDateText.replace(/\D/g, ""));
  const issueForCalc = issueIso || todayIso();
  const account: BillingAccount =
    editing?.account ?? accountOn(periods, issueForCalc);
  const billTerms = terms
    ? account === "PERSONAL"
      ? { ...terms, vat: false }
      : terms
    : null;
  // หน้าแก้: อัตราตั้งต้นเทียบกับอัตราเดิมของบิล · หน้าออกใหม่: เทียบกับเงื่อนไขลูกค้า ณ วันออกบิล
  const defaultWht = editing
    ? editing.whtRate
    : terms
      ? effectiveWhtRate(terms, issueForCalc)
      : 0;
  const suggestedNo = numbers
    ? account === "PERSONAL"
      ? numbers.suggestedPersonalInvoiceNo
      : numbers.suggestedInvoiceNo
    : "";
  const lastNo = numbers
    ? account === "PERSONAL"
      ? numbers.lastPersonalInvoiceNo
      : numbers.lastInvoiceNo
    : null;
  const invoiceNo = editing
    ? editing.invoiceNo
    : (invoiceNoEdit ?? suggestedNo);

  const items = itemRowsToItems(rows);
  const invoiceTerms: BillingTerms | null = editing
    ? {
        vat: editing.vatRate > 0,
        whtRate: editing.whtRate,
        whtSpecialRate: null,
        whtSpecialUntil: null,
      }
    : billTerms;
  const totals = invoiceTerms
    ? computeTotals(
        [],
        [],
        invoiceTerms,
        issueForCalc,
        items,
        whtOverrideOf(whtValue),
      )
    : null;

  const { known: knownProfit, unknown: unknownProfit } = itemRowsProfit(rows);

  // เดือนของงานยามาฮ่า: ค่าตั้งต้น = เดือนของวันที่ออกบิล แก้ได้
  const yamahaMonth = yamahaMonthPick || issueForCalc.slice(0, 7);

  function addYamahaRow(id: string) {
    const option = yamahaPriceOptions(yamahaMonth).find((o) => o.id === id);
    if (!option) return;
    // บรรทัดว่างที่ยังไม่ได้กรอกอะไรเลย (บรรทัดตั้งต้นของหน้า) ให้ถูกแทนที่ ไม่เหลือบรรทัดว่างค้าง
    const untouched = (r: ItemRow) =>
      r.description.trim() === "" && r.unitPriceText.trim() === "";
    setRows((cur) => [...cur.filter((r) => !untouched(r)), option.row]);
    setConfirming(false);
  }

  // ปุ่มเดือน: 6 เดือนล่าสุดนับถึงเดือนของวันที่ออกบิล (ใหม่สุดก่อน) เดือนอื่นเลือกจากช่องเดือน
  const recentMonths = Array.from({ length: 6 }, (_, i) => {
    const y = Number(issueForCalc.slice(0, 4));
    const m = Number(issueForCalc.slice(5, 7)) - 1 - i;
    const d = new Date(Date.UTC(y, m, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });

  // ดึงยอดแจ้งย้ายของเดือนจากระบบ แล้วเติมบิลทั้งชุด (รถเล็ก 3 บรรทัด + รถใหญ่ 2 บรรทัด) พร้อมจำนวนรถ
  async function pullYamaha(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return;
    const hasContent = rows.some(
      (r) => r.description.trim() !== "" || r.unitPriceText.trim() !== "",
    );
    if (
      hasContent &&
      !window.confirm("บรรทัดที่กรอกไว้จะถูกแทนที่ด้วยยอดของเดือนนี้ ดำเนินการต่อ?")
    )
      return;
    setYamahaMonthPick(month);
    setYamahaBusy(true);
    setYamahaNote("");
    setError("");
    try {
      const res = await quotationApi.yamahaMonth(month);
      const label = thaiMonthLabel(month);
      if (res.counts.SMALL + res.counts.LARGE === 0) {
        setYamahaNote(`เดือน ${label} ยังไม่มีรายการแจ้งย้ายในระบบ`);
        return;
      }
      setRows(yamahaBillRows(month, res.counts));
      setConfirming(false);
      setYamahaNote(
        `ดึงยอดเดือน ${label} แล้ว: รถเล็ก ${res.counts.SMALL} คัน · รถใหญ่ ${res.counts.LARGE} คัน` +
          (res.quotedBy
            ? ` · เดือนนี้มีใบเสนอราคา ${res.quotedBy.quotationNo ?? ""} อยู่แล้ว`
            : ""),
      );
    } catch (err) {
      setError(
        err instanceof ApiError ? err.message : "ดึงยอดแจ้งย้ายไม่สำเร็จ",
      );
    } finally {
      setYamahaBusy(false);
    }
  }

  function chooseCustomer(id: string) {
    setYamahaMonthPick(null);
    setYamahaNote("");
    setCustomerId(id);
    setTerms(null);
    setPeriods([]);
    setWhtValue(null);
    setWhtChecked(false);
    setInvoiceNoEdit(null);
    setConfirming(false);
  }

  function problem(): string | null {
    if (!customer) return "เลือกลูกค้า";
    if (!totals) return "กำลังโหลดเงื่อนไขวางบิลของลูกค้า";
    if (!invoiceNo.trim()) return "ใส่เลขที่บิล";
    if (!issueIso) return "วันที่ออกบิลไม่ถูกต้อง (วว/ดด/ปปปป)";
    if (rows.length === 0) return "ต้องมีอย่างน้อย 1 บรรทัด";
    const itemError = itemRowsProblem(rows);
    if (itemError) return itemError;
    const wht = whtProblem(defaultWht, whtValue, whtChecked);
    if (wht) return wht;
    if (editing && !remark.trim()) return "ใส่เหตุผลที่แก้บิล";
    return null;
  }

  function openConfirm() {
    const p = problem();
    if (p) return setError(p);
    setError("");
    setConfirming(true);
  }

  async function handleSave() {
    const p = problem();
    if (p) return setError(p);
    setSaving(true);
    setError("");
    try {
      const whtRate = whtOverrideOf(whtValue) ?? undefined;
      const { invoice } = editing
        ? await billingApi.updateInvoice(editing.id, {
            issueDate: issueIso,
            items,
            whtRate,
            remark: remark.trim(),
            expectedUpdatedAt: editing.updatedAt,
          })
        : await billingApi.createCustomInvoice({
            customerId,
            invoiceNo: invoiceNo.trim(),
            issueDate: issueIso,
            jobLabel: "",
            items,
            whtRate,
          });
      printInvoice(invoice);
      router.push("/accounting/billing");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกบิลไม่สำเร็จ");
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  const preview: PrintableInvoice | null =
    customer && totals
      ? {
          invoiceNo,
          account,
          issueDate: issueForCalc,
          customer: editing?.customer ?? {
            name: customer.company || customer.name,
            branch: customer.branch,
            address: customer.address,
            taxId: customer.taxId,
          },
          jobLabel: "",
          extras: [],
          vatRate: totals.vatRate,
          whtRate: totals.whtRate,
          feeTotal: totals.feeTotal,
          serviceTotal: totals.serviceTotal,
          goodsTotal: totals.goodsTotal,
          vatAmount: totals.vatAmount,
          whtAmount: totals.whtAmount,
          netTotal: totals.netTotal,
          lines: [],
          items,
        }
      : null;

  if (loading) {
    return (
      <section className="content">
        <h1 tabIndex={-1}>บิลกำหนดเอง</h1>
        <div className="customer-message" role="status">
          กำลังโหลด...
        </div>
      </section>
    );
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>
        {editing ? `แก้ไขบิล ${editing.invoiceNo}` : "บิลกำหนดเอง"}
      </h1>
      <p>
        ออกบิลที่ไม่มีรถในระบบ เช่น งานเก่าที่ย้ายมาจากระบบเดิม หรือขายสินค้า
        (ขายรถออกจากบริษัท) - พิมพ์รายการเองทีละบรรทัด แล้วเลือกประเภทให้ถูก
        เพราะ VAT และหัก ณ ที่จ่ายคิดต่างกัน
      </p>
      <Link
        href="/accounting/billing"
        className="text-button"
        style={{ marginTop: 8, display: "inline-block" }}
      >
        ← กลับไปหน้าวางบิล
      </Link>

      <section
        className="panel"
        style={{
          marginTop: 16,
          padding: "18px 23px",
          overflow: "visible",
          display: "grid",
          gap: 14,
        }}
      >
        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))",
          }}
        >
          <label className="field">
            ลูกค้า *
            <select
              value={customerId}
              disabled={!!editing}
              onChange={(e) => chooseCustomer(e.target.value)}
            >
              <option value="">— เลือกลูกค้า —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company || c.name}
                </option>
              ))}
            </select>
            {customer && terms && (
              <span className="muted" style={{ fontSize: 12 }}>
                {ACCOUNT_LABEL[account]}
                {account === "PERSONAL" ? " (ไม่มี VAT)" : ""}
              </span>
            )}
          </label>
          <label className="field">
            {account === "PERSONAL"
              ? "เลขที่บิล (บัญชีบุคคล) *"
              : "เลขที่ IV *"}
            <input
              type="text"
              value={invoiceNo}
              disabled={!!editing}
              onChange={(e) => setInvoiceNoEdit(e.target.value)}
            />
            {!editing && (
              <span className="muted" style={{ fontSize: 12 }}>
                {lastNo
                  ? `เลขล่าสุดในระบบ: ${lastNo} · ระบบใส่เลขถัดไปให้แล้ว แก้ได้`
                  : "ยังไม่เคยออกบิลบัญชีนี้ในระบบ - ใส่เลขเอง"}
              </span>
            )}
          </label>
          <label className="field">
            วันที่ออกบิล *
            <DateInput
              value={issueDateText}
              onChange={(value) =>
                setIssueDateText(
                  formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)),
                )
              }
            />
          </label>
        </div>

        {/* ลูกค้าที่ต้องเสนอราคาก่อนวางบิล (ผู้ใช้ 2026-10-01, YM) - ออกบิลจากใบเสนอราคาที่อนุมัติแล้วเท่านั้น */}
        {!editing && terms?.requiresQuotation && (
          <div
            className="customer-message"
            role="alert"
            style={{
              background: "#fff6e7",
              color: "#8a6412",
              borderRadius: 10,
              padding: "10px 14px",
            }}
          >
            ลูกค้ารายนี้ต้องมีใบเสนอราคาที่อนุมัติแล้วก่อนวางบิล -
            ออกใบวางบิลจากหน้าใบเสนอราคา{" "}
            <Link
              href="/accounting/quotations?stage=APPROVED"
              className="text-button"
            >
              ไปหน้าใบเสนอราคา →
            </Link>
          </div>
        )}

        {/* ราคายามาฮ่า (ผู้ใช้ 2026-10-05): เลือกลูกค้ายามาฮ่าแล้วมีตัวเลือกราคาให้เลือกเติมบรรทัดได้เลย */}
        {customer && isYamahaCustomer(customer) && (
          <div
            style={{
              border: "1px solid #c9d6f5",
              background: "#f6f9ff",
              borderRadius: 10,
              padding: "10px 14px",
              display: "flex",
              gap: 10,
              alignItems: "center",
              flexWrap: "wrap",
              fontSize: 14,
            }}
          >
            <b style={{ fontWeight: 600, flexBasis: "100%" }}>
              งานแจ้งย้ายยามาฮ่า - ดึงยอดของเดือนมาใส่ทั้งชุด
            </b>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                alignItems: "center",
                flexBasis: "100%",
              }}
            >
              {recentMonths.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={yamahaMonth === m ? "primary" : undefined}
                  disabled={yamahaBusy}
                  onClick={() => pullYamaha(m)}
                >
                  {thaiMonthLabel(m)}
                </button>
              ))}
              <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <span className="muted">เดือนอื่น</span>
                <input
                  type="month"
                  value={yamahaMonth}
                  disabled={yamahaBusy}
                  onChange={(e) => void pullYamaha(e.target.value)}
                  style={{
                    border: "1px solid #dce2ec",
                    borderRadius: 8,
                    padding: "7px 10px",
                  }}
                />
              </label>
            </div>
            {yamahaNote && (
              <span style={{ fontSize: 13, flexBasis: "100%" }}>
                {yamahaNote}
              </span>
            )}
            <span className="muted" style={{ flex: "0 0 auto" }}>
              หรือเพิ่มทีละบรรทัด
            </span>
            <select
              value=""
              onChange={(e) => addYamahaRow(e.target.value)}
              aria-label="เลือกราคายามาฮ่าเพื่อเพิ่มบรรทัด"
              style={{
                border: "1px solid #dce2ec",
                borderRadius: 8,
                padding: "8px 10px",
                background: "white",
                flex: "1 1 300px",
                minWidth: 0,
                font: "inherit",
              }}
            >
              <option value="">— เลือกราคาเพื่อเพิ่มบรรทัด —</option>
              {yamahaPriceOptions(yamahaMonth).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <span className="muted" style={{ fontSize: 12, flexBasis: "100%" }}>
              ปุ่มเดือนดึงจำนวนรถจากงานแจ้งย้ายที่บันทึกไว้ (ไม่นับที่ยกเลิก)
              รถเล็กราคาเปลี่ยนตามปีของเดือนงาน · เพิ่มทีละบรรทัดจะใส่จำนวน 1
              แก้เป็นจำนวนรถได้
            </span>
          </div>
        )}

        <InvoiceItemsEditor
          rows={rows}
          onChange={(next) => (setRows(next), setConfirming(false))}
          minRows={1}
        />

        {customer && terms && (
          <WhtRatePicker
            defaultRate={defaultWht}
            value={whtValue}
            onChange={(v) => (setWhtValue(v), setConfirming(false))}
            checked={whtChecked}
            onCheckedChange={setWhtChecked}
            {...(editing
              ? { defaultLabel: "อัตราเดิมของบิล", defaultChip: "คงเดิม" }
              : {})}
          />
        )}

        {totals && (
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))",
            }}
          >
            <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
              <Sum label="ค่าธรรมเนียม" value={totals.feeTotal} />
              <Sum label="ค่าบริการ" value={totals.serviceTotal} />
              {totals.goodsTotal > 0 && (
                <Sum label="ค่าสินค้า" value={totals.goodsTotal} />
              )}
              <Sum
                label={
                  totals.vatRate ? `VAT ${totals.vatRate}%` : "VAT (ไม่มี)"
                }
                value={totals.vatAmount}
              />
              <Sum
                label={
                  totals.whtRate
                    ? `หัก ณ ที่จ่าย ${totals.whtRate}% (จากค่าบริการ ${formatMoney(totals.serviceTotal)})`
                    : "หัก ณ ที่จ่าย (ไม่หัก)"
                }
                value={-totals.whtAmount}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  background: "#edf2ff",
                  color: "#2854d9",
                  borderRadius: 10,
                  padding: "10px 14px",
                  fontWeight: 600,
                }}
              >
                <span>จำนวนเงินทั้งสิ้น</span>
                <span style={{ fontSize: 20 }}>
                  {formatMoney(totals.netTotal)}
                </span>
              </div>
            </div>
            <div
              style={{
                background: "#f5f7fb",
                borderRadius: 10,
                padding: "12px 14px",
                fontSize: 14,
                alignSelf: "start",
              }}
            >
              <div className="muted" style={{ fontSize: 12 }}>
                กำไรบิลนี้ (ก่อน VAT · ภายใน ไม่พิมพ์)
              </div>
              <div style={{ fontSize: 20, fontWeight: 600 }}>
                {formatMoney(knownProfit)}
              </div>
              <div
                className="muted"
                style={{
                  fontSize: 12,
                  color: unknownProfit ? "#bb8527" : undefined,
                }}
              >
                {unknownProfit
                  ? `ยังไม่รวม ${unknownProfit} บรรทัดที่ไม่ทราบต้นทุน`
                  : "ครบทุกบรรทัด"}
              </div>
            </div>
          </div>
        )}

        {editing && (
          <label className="field">
            เหตุผลที่แก้ *
            <input
              type="text"
              value={remark}
              onChange={(e) => setRemark(e.target.value)}
              placeholder="เช่น ยอดขายคีย์ผิด"
            />
          </label>
        )}

        <button
          className="text-button"
          style={{ justifySelf: "start" }}
          onClick={() => setShowPreview((s) => !s)}
          disabled={!preview}
        >
          {showPreview ? "ซ่อนตัวอย่างบิล" : "ดูตัวอย่างบิล"}
        </button>
        {showPreview && preview && (
          <iframe
            title="ตัวอย่างใบวางบิล"
            srcDoc={buildInvoiceHtml(preview)}
            style={{
              width: "100%",
              height: 560,
              border: "1px solid #f0f2f6",
              background: "white",
            }}
          />
        )}

        {error && (
          <div className="customer-message error" role="alert">
            {error}
          </div>
        )}

        {confirming && totals && customer ? (
          // ตรวจก่อนออกบิล (ผู้ใช้ 2026-09-29): อัตราหัก ณ ที่จ่ายต้องเห็นชัดทุกครั้ง
          <div
            style={{
              border: "1px solid #c9d6f5",
              background: "#f6f9ff",
              borderRadius: 10,
              padding: "14px 16px",
              display: "grid",
              gap: 8,
            }}
          >
            <b style={{ fontWeight: 600 }}>
              ตรวจก่อน{editing ? "บันทึก" : "ออกบิล"}
            </b>
            <div style={{ fontSize: 14 }}>
              {invoiceNo} · {customer.company || customer.name} ·{" "}
              {ACCOUNT_LABEL[account]} · {issueDateText}
            </div>
            <div style={{ fontSize: 14 }}>
              {rows.length} บรรทัด · VAT{" "}
              {totals.vatRate ? `${totals.vatRate}%` : "ไม่มี"} ·{" "}
              <b
                style={{
                  fontWeight: 600,
                  color: totals.whtRate !== defaultWht ? "#c0392b" : undefined,
                }}
              >
                หัก ณ ที่จ่าย{" "}
                {totals.whtRate
                  ? `${totals.whtRate}% = ${formatMoney(totals.whtAmount)}`
                  : "ไม่หัก"}
              </b>{" "}
              · ยอดสุทธิ{" "}
              <b style={{ fontWeight: 600 }}>{formatMoney(totals.netTotal)}</b>{" "}
              บาท
            </div>
            <div className="form-actions" style={{ marginTop: 0 }}>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                disabled={saving}
              >
                กลับไปแก้
              </button>
              <button
                type="button"
                className="primary"
                onClick={handleSave}
                disabled={saving}
              >
                {saving
                  ? "กำลังบันทึก…"
                  : editing
                    ? "ยืนยันบันทึกและพิมพ์"
                    : "ยืนยันออกบิลและพิมพ์"}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="primary"
            style={{ justifySelf: "end" }}
            onClick={openConfirm}
            disabled={saving}
          >
            {editing ? "บันทึกการแก้ไข" : "ออกบิล"}
          </button>
        )}
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
