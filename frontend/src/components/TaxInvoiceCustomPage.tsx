"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, type Customer } from "@/lib/api";
import { billingApi, ACCOUNT_LABEL, WHT_METHOD_LABEL, type Invoice, type TaxInvoice, type TaxInvoicePreview, type WhtMethod } from "@/lib/billing-api";
import { DateInput } from "@/components/DateInput";
import { emptyItemRow, InvoiceItemsEditor, itemRowsFromItems, itemRowsProblem, itemRowsToItems, type ItemRow } from "@/components/InvoiceItemsEditor";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { computeTotals, formatMoney, round2 } from "@/lib/invoice";
import { buildTaxInvoiceHtml, printTaxInvoice } from "@/lib/tax-invoice-print";

// ใบกำกับภาษี/ใบเสร็จรับเงินกำหนดเอง (ผู้ใช้ 2026-10-05): งานนอกระบบที่ไม่มีใบวางบิล - พิมพ์บรรทัดเอง ออกตอนรับเงิน
// เลขชุดเดียวกับใบที่ออกจากใบวางบิล (TV{ปี}-{3 หลัก}) · VAT 7% เสมอ · ค่าธรรมเนียมราชการไม่มี VAT · ลูกค้าบัญชีบริษัทเท่านั้น
// ?replaces=<id> = ออกใหม่แทนใบกำหนดเองที่ยกเลิกไปแล้ว (ดึงลูกค้า/บรรทัด/ยอดหักมาใส่ให้ แก้ได้)

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);
const digits = (text: string) => text.replace(/\D/g, "").slice(0, 8);
const VAT_TERMS = { vat: true, whtRate: 0, whtSpecialRate: null, whtSpecialUntil: null };

const parseMoney = (text: string): number | null => {
  const n = Number.parseFloat(text.replace(/,/g, ""));
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

function Sum({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, fontWeight: strong ? 600 : 400 }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

export function TaxInvoiceCustomPage() {
  const router = useRouter();
  const replacesId = useSearchParams().get("replaces");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [paidDateText, setPaidDateText] = useState(isoToDisplayDate(todayIso()));
  const [rows, setRows] = useState<ItemRow[]>([emptyItemRow()]);
  const [whtText, setWhtText] = useState<string | null>(null); // null = ใช้ยอดตามอัตราของลูกค้า
  const [whtMethod, setWhtMethod] = useState<WhtMethod>("PAPER");
  const [notRegistered, setNotRegistered] = useState(false);
  const [preview, setPreview] = useState<TaxInvoicePreview | null>(null);
  const [replaced, setReplaced] = useState<TaxInvoice | null>(null);
  // บิลรอรับเงินในระบบ (บัญชีบริษัท + มี VAT) - ถ้าลูกค้ารายนี้มี ให้ออกใบกำกับจากบิลโดยตรง ผูกกันและปิดบิลให้ (ผู้ใช้ 2026-10-06)
  const [waitingBills, setWaitingBills] = useState<Invoice[]>([]);
  const [showPreview, setShowPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        const c = await api.listCustomers();
        setCustomers(c.customers);
        try {
          const bills = await billingApi.listInvoices({ limit: 1 });
          setWaitingBills(bills.invoices.filter((i) => i.status === "ISSUED" && i.account !== "PERSONAL" && i.vatRate > 0));
        } catch {
          setWaitingBills([]); // ไม่มีรายการบิลก็ออกใบกำหนดเองต่อได้
        }
        if (replacesId) {
          const { taxInvoice: old } = await billingApi.taxInvoice(replacesId);
          if (old.status !== "CANCELLED" || old.invoiceId !== null) throw new Error("ออกแทนได้เฉพาะใบกำกับกำหนดเองที่ยกเลิกแล้ว");
          if (old.replacedByNo) throw new Error(`ใบนี้มีใบใหม่ ${old.replacedByNo} ออกแทนไปแล้ว`);
          setReplaced(old);
          setCustomerId(old.customerId);
          setRows(itemRowsFromItems(old.items));
          setWhtText(String(old.whtAmount));
          if (old.whtAmount > 0) setWhtMethod(old.whtMethod === "EWHT" ? "EWHT" : "PAPER");
          setNotRegistered(old.buyerNotVatRegistered);
        }
      } catch (err) {
        setError(errorText(err, "โหลดข้อมูลไม่สำเร็จ"));
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [replacesId]);

  const paidIso = displayDateToIso(digits(paidDateText));

  useEffect(() => {
    if (!customerId || !paidIso) return;
    let stale = false;
    billingApi
      .customTaxInvoicePreview(customerId, paidIso)
      .then((p) => {
        if (!stale) setPreview(p);
      })
      .catch((err) => {
        if (!stale) setError(errorText(err, "โหลดข้อมูลลูกค้าไม่สำเร็จ"));
      });
    return () => {
      stale = true;
    };
  }, [customerId, paidIso]);

  const customer = customers.find((c) => c.id === customerId) ?? null;
  const items = itemRowsToItems(rows);
  const totals = computeTotals([], [], VAT_TERMS, paidIso || todayIso(), items, null);
  const suggestedWht = preview?.whtRate ? round2((totals.serviceTotal * preview.whtRate) / 100) : 0;
  const whtValue = whtText ?? String(suggestedWht);
  const wht = parseMoney(whtValue);
  const received = wht === null ? null : round2(totals.grossTotal - wht);
  const missing = preview ? (notRegistered ? preview.missingIfNotRegistered : preview.missing) : [];
  const onlyTaxIdMissing = !!preview && preview.missing.length > 0 && preview.missingIfNotRegistered.length === 0;

  function chooseCustomer(id: string) {
    setCustomerId(id);
    setPreview(null);
    setWhtText(null);
    setNotRegistered(false);
    setConfirming(false);
    setError("");
  }

  function problem(): string | null {
    if (!customer) return "เลือกลูกค้า";
    if (!preview) return "กำลังโหลดข้อมูลลูกค้า";
    if (!preview.enabled) return 'ยังไม่ได้เปิดใช้ใบกำกับในระบบ - ADMIN ต้องตั้งเลขเริ่มที่หน้า "ใบกำกับภาษี" ก่อน';
    if (preview.account && preview.account !== "COMPANY") return `ลูกค้ารายนี้ใช้${ACCOUNT_LABEL[preview.account]} ณ วันที่นี้ ไม่มีใบกำกับภาษี`;
    if (!paidIso) return "วันที่รับเงินไม่ถูกต้อง (วว/ดด/ปปปป)";
    if (paidIso > todayIso()) return "วันที่รับเงินต้องไม่เกินวันนี้";
    if (preview.lastIssued && paidIso < preview.lastIssued.issueDate) {
      return `วันที่ต้องไม่ก่อนใบกำกับล่าสุด ${preview.lastIssued.taxInvoiceNo} (${isoToDisplayDate(preview.lastIssued.issueDate)}) - เลขใบกำกับต้องเรียงตามวันที่`;
    }
    if (missing.length) return `ข้อมูลลูกค้ายังไม่ครบ: ${missing.join(", ")} - แก้ที่หน้าฐานข้อมูลลูกค้าก่อน (ADMIN)`;
    if (rows.length === 0) return "ต้องมีอย่างน้อย 1 บรรทัด";
    const itemError = itemRowsProblem(rows);
    if (itemError) return itemError;
    if (wht === null) return "ยอดหัก ณ ที่จ่ายไม่ถูกต้อง";
    if (wht > round2(totals.serviceTotal + totals.goodsTotal)) return "ภาษีหัก ณ ที่จ่ายมากกว่ามูลค่าค่าบริการ - ตรวจยอดอีกครั้ง";
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
    if (p || wht === null) return setError(p ?? "ยอดหัก ณ ที่จ่ายไม่ถูกต้อง");
    setSaving(true);
    setError("");
    try {
      const { taxInvoice } = await billingApi.issueCustomTaxInvoice({
        customerId,
        issueDate: paidIso,
        items: items.map(({ kind, description, quantity, unitPrice }) => ({ kind, description, quantity, unitPrice })),
        whtAmount: wht,
        whtMethod: wht > 0 ? whtMethod : "NONE",
        buyerNotVatRegistered: notRegistered,
        replacesId: replaced?.id,
      });
      printTaxInvoice(taxInvoice, "original");
      router.push("/accounting/tax-invoices");
    } catch (err) {
      setError(errorText(err, "ออกใบกำกับไม่สำเร็จ"));
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  const draft: TaxInvoice | null =
    customer && preview && paidIso
      ? {
          id: "",
          taxInvoiceNo: preview.nextNo ?? "TV—",
          invoiceId: null,
          invoiceNo: null,
          invoiceIssueDate: null,
          customerId,
          customer: preview.buyer,
          buyerNotVatRegistered: notRegistered,
          issueDate: paidIso,
          createdAt: new Date().toISOString(),
          vatRate: totals.vatRate,
          feeTotal: totals.feeTotal,
          serviceTotal: totals.serviceTotal,
          goodsTotal: totals.goodsTotal,
          vatAmount: totals.vatAmount,
          grandTotal: totals.grossTotal,
          whtAmount: wht ?? 0,
          receivedAmount: received ?? totals.grossTotal,
          whtMethod: wht && wht > 0 ? whtMethod : "NONE",
          whtCertificate: null,
          whtRemindedAt: null,
          replacesNo: replaced?.taxInvoiceNo ?? null,
          replacedByNo: null,
          replacementIssuedAt: null,
          replacementReason: null,
          status: "ISSUED",
          cancelledAt: null,
          cancelReason: null,
          jobLabel: "",
          extras: [],
          whtRate: 0,
          lines: [],
          items,
          lineCount: 0,
        }
      : null;

  if (loading) {
    return (
      <section className="content">
        <h1 tabIndex={-1}>ใบกำกับภาษีกำหนดเอง</h1>
        <div className="customer-message" role="status">
          กำลังโหลด...
        </div>
      </section>
    );
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>{replaced ? `ออกใบกำกับใหม่แทน ${replaced.taxInvoiceNo}` : "ใบกำกับภาษีกำหนดเอง"}</h1>
      <p>
        ออกใบกำกับภาษี/ใบเสร็จรับเงินสำหรับงานที่ไม่อยู่ในระบบ (ไม่มีใบวางบิล) - พิมพ์รายการเอง แล้วเลือกประเภทให้ถูกเพราะ VAT และหัก ณ ที่จ่ายคิดต่างกัน ออกตอนรับเงินแล้ว
      </p>
      <Link href="/accounting/tax-invoices" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        ← กลับไปหน้าใบกำกับภาษี
      </Link>

      <section className="panel" style={{ marginTop: 16, padding: "18px 23px", overflow: "visible", display: "grid", gap: 14 }}>
        {replaced && (
          <div className="customer-message" style={{ fontSize: 13 }}>
            ใบนี้จะออกแทน {replaced.taxInvoiceNo} ที่ยกเลิกไป{replaced.cancelReason ? ` (${replaced.cancelReason})` : ""}
            {replaced.whtCertificate ? " · 50 ทวิ ที่แนบไว้ย้ายมาใบนี้ (ถ้าเป็นลูกค้าคนเดิมและยังมียอดหัก)" : ""}
          </div>
        )}

        {customerId && waitingBills.some((b) => b.customerId === customerId) && (
          <div className="customer-message" style={{ fontSize: 13 }}>
            ลูกค้ารายนี้มีบิลรอรับเงินในระบบ - ถ้าเป็นงานเดียวกัน ให้ออกใบกำกับจากบิลโดยตรง (ดึงยอดและรายการจากบิล ผูกกับบิล และปิดบิลเป็นรับเงินแล้วให้เอง ไม่ต้องพิมพ์รายการซ้ำ):
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {waitingBills
                .filter((b) => b.customerId === customerId)
                .map((b) => (
                  <li key={b.id}>
                    <Link href={`/accounting/tax-invoices?issue=${encodeURIComponent(b.id)}`} className="text-button">
                      {b.invoiceNo}
                    </Link>{" "}
                    · {isoToDisplayDate(b.issueDate)} · ยอดสุทธิ {formatMoney(b.netTotal)} บาท
                  </li>
                ))}
            </ul>
          </div>
        )}

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
          <label className="field">
            ลูกค้า *
            <select value={customerId} onChange={(e) => chooseCustomer(e.target.value)}>
              <option value="">— เลือกลูกค้า —</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.company || c.name}
                </option>
              ))}
            </select>
            {preview && customer && (
              <span className="muted" style={{ fontSize: 12 }}>
                {preview.buyer.taxId ? `เลขผู้เสียภาษี ${preview.buyer.taxId} · สาขา ${preview.buyer.branch || "สำนักงานใหญ่"}` : "ไม่มีเลขผู้เสียภาษี"}
              </span>
            )}
          </label>
          <div className="field">
            เลขที่ใบกำกับ
            <div style={{ display: "flex", alignItems: "center", minHeight: 46 }}>
              <b>{preview?.nextNo ?? "—"}</b>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>
              {preview?.lastIssued
                ? `ใบล่าสุด ${preview.lastIssued.taxInvoiceNo} วันที่ ${isoToDisplayDate(preview.lastIssued.issueDate)} · ระบบให้เลขถัดไป`
                : "ระบบให้เลขถัดไปเอง"}
            </span>
          </div>
          <label className="field">
            วันที่รับเงิน *
            <DateInput
              value={paidDateText}
              onChange={(value) => (setPaidDateText(formatDateDigitsCe(digits(value))), setConfirming(false))}
              aria-label="วันที่รับเงิน"
            />
          </label>
        </div>

        {preview && !preview.enabled && (
          <div className="customer-message error" role="alert">
            ยังไม่ได้เปิดใช้ใบกำกับในระบบ - ADMIN ต้องตั้งเลขเริ่มที่หน้า &quot;ใบกำกับภาษี&quot; ก่อน
          </div>
        )}
        {preview && preview.account && preview.account !== "COMPANY" && (
          <div className="customer-message error" role="alert">
            ลูกค้ารายนี้ใช้{ACCOUNT_LABEL[preview.account]} ณ วันที่นี้ ไม่มีใบกำกับภาษี
          </div>
        )}
        {missing.length > 0 && (
          <div className="customer-message error" role="alert">
            ข้อมูลลูกค้ายังขาด {missing.join(", ")} - แก้ที่หน้าฐานข้อมูลลูกค้าก่อน (ADMIN)
          </div>
        )}
        {onlyTaxIdMissing && (
          <label style={{ display: "flex", gap: 8, fontSize: 13 }}>
            <input type="checkbox" checked={notRegistered} onChange={(e) => setNotRegistered(e.target.checked)} />
            ลูกค้าไม่ได้จดทะเบียน VAT (ไม่ต้องมีเลขผู้เสียภาษีบนใบกำกับ)
          </label>
        )}

        <InvoiceItemsEditor rows={rows} onChange={(next) => (setRows(next), setConfirming(false))} minRows={1} hideCost />

        <div style={{ display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))" }}>
          <div style={{ display: "grid", gap: 6, fontSize: 14 }}>
            {totals.feeTotal > 0 && <Sum label="ค่าธรรมเนียม (ทดรองจ่าย ไม่มี VAT)" value={formatMoney(totals.feeTotal)} />}
            <Sum label="ค่าบริการ" value={formatMoney(totals.serviceTotal)} />
            {totals.goodsTotal > 0 && <Sum label="ค่าสินค้า" value={formatMoney(totals.goodsTotal)} />}
            <Sum label={`VAT ${totals.vatRate}%`} value={formatMoney(totals.vatAmount)} />
            <div style={{ borderTop: "1px solid #e2e6ee", paddingTop: 6 }}>
              <Sum label="รวมเงินตามใบกำกับ" value={formatMoney(totals.grossTotal)} strong />
            </div>
          </div>
          <div style={{ display: "grid", gap: 8, fontSize: 14, alignContent: "start" }}>
            <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span>
                ลูกค้าหัก ณ ที่จ่ายจริง
                {preview?.whtRate ? <span className="muted" style={{ fontSize: 12 }}> (อัตราลูกค้า {preview.whtRate}% = {formatMoney(suggestedWht)})</span> : null}
              </span>
              <input
                type="text"
                inputMode="decimal"
                value={whtValue}
                onChange={(e) => (setWhtText(e.target.value), setConfirming(false))}
                style={{ width: 120, textAlign: "right" }}
                aria-label="ยอดหัก ณ ที่จ่ายจริง"
              />
            </label>
            {wht !== null && wht > 0 && (
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                {(["PAPER", "EWHT"] as const).map((m) => (
                  <label key={m} style={{ display: "flex", gap: 6 }}>
                    <input type="radio" checked={whtMethod === m} onChange={() => setWhtMethod(m)} />
                    {m === "PAPER" ? "50 ทวิ กระดาษ" : "e-WHT (หักผ่านธนาคาร)"}
                  </label>
                ))}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "space-between", background: "#edf2ff", color: "#2854d9", borderRadius: 10, padding: "10px 14px", fontWeight: 600 }}>
              <span>เงินที่ต้องเข้าบัญชี</span>
              <span style={{ fontSize: 20 }}>{received === null ? "—" : formatMoney(received)}</span>
            </div>
            {wht !== null && wht > 0 && <span className="muted" style={{ fontSize: 12 }}>แนบ 50 ทวิ ได้ที่หน้า &quot;ติดตาม 50 ทวิ&quot; เมื่อได้รับ</span>}
          </div>
        </div>

        <button className="text-button" style={{ justifySelf: "start" }} onClick={() => setShowPreview((s) => !s)} disabled={!draft}>
          {showPreview ? "ซ่อนตัวอย่างใบกำกับ" : "ดูตัวอย่างใบกำกับ"}
        </button>
        {showPreview && draft && (
          <iframe title="ตัวอย่างใบกำกับภาษี" srcDoc={buildTaxInvoiceHtml(draft, "original")} style={{ width: "100%", height: 560, border: "1px solid #f0f2f6", background: "white" }} />
        )}

        {error && (
          <div className="customer-message error" role="alert">
            {error}
          </div>
        )}

        {confirming && customer ? (
          <div style={{ border: "1px solid #c9d6f5", background: "#f6f9ff", borderRadius: 10, padding: "14px 16px", display: "grid", gap: 8 }}>
            <b style={{ fontWeight: 600 }}>ตรวจก่อนออกใบกำกับ</b>
            <div style={{ fontSize: 14 }}>
              {preview?.nextNo} · {customer.company || customer.name} · วันที่รับเงิน {paidDateText}
            </div>
            <div style={{ fontSize: 14 }}>
              {rows.length} บรรทัด · VAT {formatMoney(totals.vatAmount)} · รวมเงินตามใบกำกับ <b style={{ fontWeight: 600 }}>{formatMoney(totals.grossTotal)}</b> ·{" "}
              {wht && wht > 0 ? `หัก ณ ที่จ่าย ${formatMoney(wht)} (${WHT_METHOD_LABEL[whtMethod]})` : "ไม่หัก ณ ที่จ่าย"} · เข้าบัญชี{" "}
              <b style={{ fontWeight: 600 }}>{received === null ? "—" : formatMoney(received)}</b> บาท
            </div>
            <p className="muted" style={{ fontSize: 12, margin: 0 }}>ออกแล้วแก้ไม่ได้ - ผิดต้องยกเลิกแล้วออกใหม่ (เลขเดิมไม่ใช้ซ้ำ)</p>
            <div className="form-actions" style={{ marginTop: 0 }}>
              <button type="button" onClick={() => setConfirming(false)} disabled={saving}>
                กลับไปแก้
              </button>
              <button type="button" className="primary" onClick={handleSave} disabled={saving}>
                {saving ? "กำลังบันทึก…" : "ยืนยันออกใบกำกับและพิมพ์"}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="primary" style={{ justifySelf: "end" }} onClick={openConfirm} disabled={saving}>
            ออกใบกำกับ
          </button>
        )}
      </section>
    </section>
  );
}
