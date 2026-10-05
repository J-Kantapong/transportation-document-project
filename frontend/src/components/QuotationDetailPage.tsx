"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiError, fetchAuthedBlob, type Customer } from "@/lib/api";
import { billingApi, ITEM_KIND_LABEL, type NextInvoiceNumbers } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, timestampToDisplayDate, todayIso } from "@/lib/date";
import { formatMoney, round2 } from "@/lib/invoice";
import { printInvoice } from "@/lib/invoice-print";
import { printQuotation, rateConditionText } from "@/lib/quotation-print";
import { QUOTATION_KIND_LABEL, quotationApi, quotationFilePath, quotationGrandTotal, type Quotation, type QuotationHistoryEntry } from "@/lib/quotation-api";
import { DateInput } from "@/components/DateInput";
import { stageBadgeClass, stageText } from "@/components/QuotationsPage";

// รายละเอียดใบเสนอราคา 1 ใบ (ผู้ใช้ 2026-10-01): ดูขั้นของใบ บันทึกคำตอบของลูกค้า (อนุมัติ + PO / ไม่อนุมัติ)
// แล้วออกใบวางบิลจากใบนี้ (ยอดงาน) หรือตั้งเป็นราคาลูกค้า (ราคาต่อคัน) · ทำฉบับแก้ไข / ยกเลิก / ถอนอนุมัติ ต้องมีเหตุผล
type Action = "approve" | "reject" | "cancel" | "unapprove" | "invoice" | "rates" | "link" | null;

const ACTION_LABEL: Record<string, string> = {
  approve: "ลูกค้าอนุมัติ",
  unapprove: "ถอนการอนุมัติ",
  reject: "ลูกค้าไม่อนุมัติ",
  cancel: "ยกเลิก",
  invoice: "ออกใบวางบิล",
  "apply-rates": "ตั้งเป็นราคาลูกค้า",
  "link-customer": "ผูกลูกค้า",
};

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function QuotationDetailPage() {
  const router = useRouter();
  const id = useSearchParams().get("id") ?? "";

  const [q, setQ] = useState<Quotation | null>(null);
  const [history, setHistory] = useState<QuotationHistoryEntry[]>([]);
  const [action, setAction] = useState<Action>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // ช่องของฟอร์มย่อยแต่ละการกระทำ
  const [remark, setRemark] = useState("");
  const [dateText, setDateText] = useState(isoToDisplayDate(todayIso()));
  const [poNumber, setPoNumber] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [invoiceNo, setInvoiceNo] = useState("");
  const [numbers, setNumbers] = useState<NextInvoiceNumbers | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [linkId, setLinkId] = useState("");

  async function reload() {
    try {
      const [one, h] = await Promise.all([quotationApi.get(id), quotationApi.history(id)]);
      setQ(one.quotation);
      setHistory(h.entries);
    } catch (err) {
      setError(errorText(err, "โหลดใบเสนอราคาไม่สำเร็จ"));
    }
  }

  useEffect(() => {
    if (!id) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดครั้งแรกตาม id ใน URL
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function open(next: Action) {
    setAction(next);
    setError("");
    setRemark("");
    setDateText(isoToDisplayDate(todayIso()));
    if (next === "invoice" && q) {
      billingApi
        .nextInvoiceNumbers()
        .then((n) => {
          setNumbers(n);
          setInvoiceNo(q.account === "PERSONAL" ? n.suggestedPersonalInvoiceNo : n.suggestedInvoiceNo);
        })
        .catch((err) => setError(errorText(err, "โหลดเลขบิลถัดไปไม่สำเร็จ")));
    }
    if (next === "link" && customers.length === 0) {
      api
        .listCustomers()
        .then((c) => setCustomers(c.customers))
        .catch((err) => setError(errorText(err, "โหลดรายชื่อลูกค้าไม่สำเร็จ")));
    }
  }

  // รันการกระทำ 1 อย่าง: สำเร็จ = ปิดฟอร์มย่อย + โหลดใหม่ · ถูกปฏิเสธ (เช่น 409 มีคนทำไปก่อน) = แสดงเหตุผลแล้วโหลดใหม่ให้เห็นของจริง
  async function run(fn: () => Promise<string | void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const text = await fn();
      if (text) setNotice(text);
      setAction(null);
    } catch (err) {
      setError(errorText(err, "ดำเนินการไม่สำเร็จ"));
    } finally {
      setBusy(false);
      await reload();
    }
  }

  const dateIso = displayDateToIso(dateText.replace(/\D/g, ""));

  async function openFile() {
    try {
      const blob = await fetchAuthedBlob(quotationFilePath(id));
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch (err) {
      setError(errorText(err, "เปิดไฟล์ไม่สำเร็จ"));
    }
  }

  if (!q) {
    return (
      <section className="content">
        <h1 tabIndex={-1}>ใบเสนอราคา</h1>
        <div className={`customer-message${error ? " error" : ""}`} role="status">
          {error || (id ? "กำลังโหลด..." : "ไม่ได้ระบุใบเสนอราคา")}
        </div>
        <Link href="/accounting/quotations" className="text-button">
          ← กลับไปรายการใบเสนอราคา
        </Link>
      </section>
    );
  }

  const grand = quotationGrandTotal(q);
  const waiting = q.stage === "WAITING" || q.stage === "EXPIRED";
  const approved = q.status === "APPROVED";
  const canRevise = ["ISSUED", "APPROVED", "REJECTED"].includes(q.status) && !q.invoice && !q.ratesAppliedAt;
  const canCancel = ["ISSUED", "APPROVED", "REJECTED"].includes(q.status) && !q.invoice;
  const steps: Array<{ label: string; done: boolean; sub?: string }> = [
    { label: "ออกใบเสนอราคา", done: q.status !== "DRAFT", sub: q.status !== "DRAFT" ? isoToDisplayDate(q.issueDate) : undefined },
    { label: "ลูกค้าอนุมัติ", done: approved, sub: q.approvedDate ? isoToDisplayDate(q.approvedDate) : undefined },
    q.kind === "JOB"
      ? { label: "ออกใบวางบิล", done: !!q.invoice, sub: q.invoice?.invoiceNo }
      : { label: "ตั้งเป็นราคาลูกค้า", done: !!q.ratesAppliedAt, sub: q.ratesAppliedAt ? timestampToDisplayDate(q.ratesAppliedAt) : undefined },
  ];

  return (
    <section className="content">
      <div className="heading">
        <div>
          <h1 tabIndex={-1}>{q.quotationNo ?? "ร่างใบเสนอราคา"}</h1>
          <p>
            {q.customer.name}
            {q.title ? ` · ${q.title}` : ""} · {QUOTATION_KIND_LABEL[q.kind]}
          </p>
        </div>
        <span className={stageBadgeClass(q.stage)} style={{ fontSize: 14, padding: "7px 12px" }}>
          {stageText(q)}
        </span>
      </div>
      <Link href="/accounting/quotations" className="text-button" style={{ display: "inline-block", marginBottom: 12 }}>
        ← กลับไปรายการใบเสนอราคา
      </Link>

      {notice && (
        <div className="customer-message success" role="status" style={{ margin: "0 0 12px" }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="customer-message error" role="alert" style={{ margin: "0 0 12px" }}>
          {error}
        </div>
      )}

      <section className="panel" style={{ padding: "18px 23px", display: "grid", gap: 14, overflow: "visible" }}>
        {/* ขั้นของใบ */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {steps.map((s, i) => (
            <div key={s.label} style={{ flex: "1 1 150px", borderTop: `3px solid ${s.done ? "#278f6b" : "#dce2ec"}`, paddingTop: 8, fontSize: 13 }}>
              <b style={{ fontWeight: 600, color: s.done ? "#278f6b" : "#8a94a6" }}>
                {i + 1}. {s.label} {s.done ? "✓" : ""}
              </b>
              {s.sub && <div className="muted">{s.sub}</div>}
            </div>
          ))}
        </div>

        {(q.stage === "REJECTED" || q.stage === "CANCELLED" || q.stage === "SUPERSEDED" || q.stage === "EXPIRED") && (
          <div className="customer-message" style={{ background: "#fff6e7", color: "#8a6412", borderRadius: 10, padding: "10px 14px" }}>
            {q.stage === "REJECTED" && <>ลูกค้าไม่อนุมัติ: {q.rejectReason} - ทำฉบับแก้ไขเพื่อเสนอใหม่ได้</>}
            {q.stage === "CANCELLED" && <>ยกเลิกแล้ว: {q.cancelReason}</>}
            {q.stage === "SUPERSEDED" && (
              <>
                มีฉบับแก้ไขออกแทนแล้ว{" "}
                {q.replacedBy && (
                  <Link href={`/accounting/quotations/view?id=${encodeURIComponent(q.replacedBy.id)}`} className="text-button">
                    เปิด {q.replacedBy.quotationNo}
                  </Link>
                )}
              </>
            )}
            {q.stage === "EXPIRED" && <>เลยวันยืนราคา ({isoToDisplayDate(q.validUntil)}) แล้ว ลูกค้ายังไม่ตอบ - ยังบันทึกอนุมัติได้ หรือทำฉบับแก้ไขเพื่อเสนอใหม่</>}
          </div>
        )}
        {q.replacedBy && q.replacedBy.status === "DRAFT" && (
          <div className="customer-message">
            มีร่างฉบับแก้ไขของใบนี้ค้างอยู่{" "}
            <Link href={`/accounting/quotations/new?edit=${encodeURIComponent(q.replacedBy.id)}`} className="text-button">
              เปิดร่าง
            </Link>
          </div>
        )}

        {/* ข้อมูลหัวใบ */}
        <div style={{ display: "grid", gap: "6px 20px", gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))", fontSize: 14 }}>
          <Info label="ลูกค้า" value={`${q.customer.name}${q.customerId ? "" : " (ยังไม่อยู่ในระบบ)"}`} />
          <Info label="วันที่ออก" value={isoToDisplayDate(q.issueDate)} />
          <Info label="ยืนราคาถึง" value={`${isoToDisplayDate(q.validUntil)} (${q.validDays} วัน)`} />
          {q.replaces?.quotationNo && <Info label="ฉบับแก้ไขของ" value={q.replaces.quotationNo} />}
          {q.yamahaMonth && q.yamahaCounts && (
            <Info label="ยอดแจ้งย้ายยามาฮ่า" value={`เดือน ${q.yamahaMonth.slice(5, 7)}/${q.yamahaMonth.slice(0, 4)} · ${q.yamahaSize === "SMALL" ? `รถเล็ก ${q.yamahaCounts.SMALL} คัน` : q.yamahaSize === "LARGE" ? `รถใหญ่ ${q.yamahaCounts.LARGE} คัน` : `รถเล็ก ${q.yamahaCounts.SMALL} · รถใหญ่ ${q.yamahaCounts.LARGE}`}`} />
          )}
          {q.approvedDate && <Info label="ลูกค้าอนุมัติ" value={isoToDisplayDate(q.approvedDate)} />}
          {q.poNumber && <Info label="เลข PO" value={q.poNumber} />}
        </div>
        {q.hasFile && (
          <button type="button" className="text-button" style={{ justifySelf: "start" }} onClick={openFile}>
            📎 เปิดไฟล์ PO / หลักฐานการอนุมัติ
          </button>
        )}

        {/* รายการ */}
        <div style={{ display: "grid" }}>
          {q.items.map((it, i) => (
            <div key={it.id ?? i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "8px 0", borderTop: "1px solid #f0f2f6", fontSize: 14, flexWrap: "wrap" }}>
              <span style={{ flex: "1 1 260px", minWidth: 0 }}>
                {i + 1}. {it.description}
                <div className="muted" style={{ fontSize: 12 }}>
                  {q.kind === "JOB"
                    ? `${ITEM_KIND_LABEL[it.kind]} · ${it.quantity.toLocaleString("en-US")} × ${formatMoney(it.unitPrice)}`
                    : [rateConditionText(it) || "ราคาหลัก", it.vatInclusive ? "รวม VAT แล้ว" : "", it.includesReceipt ? "รวมค่าใบเสร็จแล้ว" : ""].filter(Boolean).join(" · ")}
                </div>
              </span>
              <b style={{ fontWeight: 600 }}>{formatMoney(q.kind === "JOB" ? it.amount : it.unitPrice)}</b>
            </div>
          ))}
        </div>
        {q.kind === "JOB" && (
          <div style={{ display: "grid", gap: 4, fontSize: 14, maxWidth: 380, justifySelf: "end", width: "100%" }}>
            {q.feeTotal > 0 && <Row label="ค่าธรรมเนียม" value={q.feeTotal} />}
            <Row label="ค่าบริการ" value={q.serviceTotal} />
            {q.goodsTotal > 0 && <Row label="ค่าสินค้า" value={q.goodsTotal} />}
            {q.vatRate > 0 && <Row label={`VAT ${q.vatRate}%`} value={q.vatAmount} />}
            <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, borderTop: "1px solid #e3e8f1", paddingTop: 6, fontSize: 16 }}>
              <span>รวมทั้งสิ้น</span>
              <span>{formatMoney(grand)}</span>
            </div>
            {q.whtRate > 0 && (
              <span className="muted" style={{ fontSize: 12 }}>
                หัก ณ ที่จ่าย {q.whtRate}% = {formatMoney(q.whtAmount)} · รับจริง {formatMoney(round2(grand - q.whtAmount))}
              </span>
            )}
          </div>
        )}
        {q.conditions && (
          <div style={{ fontSize: 14 }}>
            <span className="muted">เงื่อนไข: </span>
            {q.conditions}
          </div>
        )}

        {/* ปุ่มตามขั้น */}
        <div className="form-actions" style={{ marginTop: 0, flexWrap: "wrap", borderTop: "1px solid #f0f2f6", paddingTop: 14 }}>
          <button type="button" onClick={() => printQuotation(q)}>
            🖨 พิมพ์
          </button>
          {q.status === "DRAFT" && (
            <Link href={`/accounting/quotations/new?edit=${encodeURIComponent(q.id)}`} className="primary" style={{ textDecoration: "none" }}>
              แก้ร่าง / ออกเลข
            </Link>
          )}
          {waiting && (
            <button type="button" className="primary" onClick={() => open("approve")}>
              บันทึกว่าลูกค้าอนุมัติ
            </button>
          )}
          {approved && !q.customerId && (
            <button type="button" className="primary" onClick={() => open("link")}>
              ผูกกับลูกค้าในระบบ
            </button>
          )}
          {approved && q.kind === "JOB" && !q.invoice && q.customerId && (
            <button type="button" className="primary" onClick={() => open("invoice")}>
              ออกใบวางบิลจากใบนี้ →
            </button>
          )}
          {approved && q.kind === "RATE" && !q.ratesAppliedAt && q.customerId && (
            <button type="button" className="primary" onClick={() => open("rates")}>
              ตั้งเป็นราคาลูกค้า →
            </button>
          )}
          {q.invoice && (
            <Link href="/accounting/billing" className="text-button">
              ดูใบวางบิล {q.invoice.invoiceNo}
            </Link>
          )}
          {q.ratesAppliedAt && q.customerId && (
            <Link href="/accounting/billing/customers" className="text-button">
              ดูตารางราคาลูกค้า
            </Link>
          )}
          {waiting && (
            <button type="button" className="text-button" onClick={() => open("reject")}>
              ลูกค้าไม่อนุมัติ
            </button>
          )}
          {canRevise && !q.replacedBy && (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const { quotation } = await quotationApi.revise(q.id);
                  router.push(`/accounting/quotations/new?edit=${encodeURIComponent(quotation.id)}`);
                })
              }
            >
              ทำฉบับแก้ไข
            </button>
          )}
          {approved && !q.invoice && !q.ratesAppliedAt && (
            <button type="button" className="text-button" onClick={() => open("unapprove")}>
              ถอนการอนุมัติ
            </button>
          )}
          {canCancel && (
            <button type="button" className="text-button danger" onClick={() => open("cancel")}>
              ยกเลิกใบเสนอราคา
            </button>
          )}
        </div>

        {/* ฟอร์มย่อยของการกระทำที่เลือก */}
        {action && (
          <div style={{ border: "1px solid #c9d6f5", background: "#f6f9ff", borderRadius: 10, padding: "14px 16px", display: "grid", gap: 12 }}>
            {action === "approve" && (
              <>
                <b style={{ fontWeight: 600 }}>บันทึกว่าลูกค้าอนุมัติ {q.quotationNo}</b>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
                  <label className="field">
                    วันที่อนุมัติ *
                    <DateInput value={dateText} onChange={(v) => setDateText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} />
                  </label>
                  <label className="field">
                    เลข PO ของลูกค้า
                    <input type="text" value={poNumber} onChange={(e) => setPoNumber(e.target.value)} maxLength={100} placeholder="เช่น 4500123456" />
                  </label>
                  <label className="field">
                    ไฟล์ PO / หลักฐาน (PDF หรือรูป)
                    <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  </label>
                </div>
                <span className="muted" style={{ fontSize: 12 }}>
                  ต้องมีเลข PO หรือไฟล์อย่างน้อยหนึ่งอย่าง · เลข PO จะพิมพ์บนใบวางบิลที่ออกจากใบนี้
                </span>
              </>
            )}
            {action === "invoice" && (
              <>
                <b style={{ fontWeight: 600 }}>
                  ออกใบวางบิลจาก {q.quotationNo} · {formatMoney(grand)} บาท
                </b>
                <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))" }}>
                  <label className="field">
                    {q.account === "PERSONAL" ? "เลขที่บิล (บัญชีบุคคล) *" : "เลขที่ IV *"}
                    <input type="text" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
                    {numbers && (
                      <span className="muted" style={{ fontSize: 12 }}>
                        เลขล่าสุดในระบบ: {(q.account === "PERSONAL" ? numbers.lastPersonalInvoiceNo : numbers.lastInvoiceNo) ?? "ยังไม่มี"}
                      </span>
                    )}
                  </label>
                  <label className="field">
                    วันที่ออกบิล *
                    <DateInput value={dateText} onChange={(v) => setDateText(formatDateDigitsCe(v.replace(/\D/g, "").slice(0, 8)))} />
                  </label>
                </div>
                <span className="muted" style={{ fontSize: 12 }}>
                  รายการและราคาคัดลอกจากใบเสนอราคาทั้งใบ แก้ตัวเลขไม่ได้ · บิลจะอ้างเลข {q.quotationNo}
                  {q.poNumber ? ` และ PO ${q.poNumber}` : ""}
                </span>
              </>
            )}
            {action === "rates" && (
              <>
                <b style={{ fontWeight: 600 }}>ตั้งราคาใน {q.quotationNo} เป็นตารางราคาของ {q.customer.name}</b>
                <span style={{ fontSize: 14 }}>
                  ตารางราคาเดิมของลูกค้ารายนี้ (ถ้ามี) จะถูก<b>แทนที่ทั้งชุด</b>ด้วย {q.items.length} แถวในใบเสนอราคานี้ - ของเดิมเก็บไว้ในประวัติลูกค้า
                </span>
              </>
            )}
            {action === "link" && (
              <>
                <b style={{ fontWeight: 600 }}>ผูก {q.customer.name} กับลูกค้าในระบบ</b>
                <label className="field" style={{ maxWidth: 420 }}>
                  ลูกค้า *
                  <select value={linkId} onChange={(e) => setLinkId(e.target.value)}>
                    <option value="">— เลือกลูกค้า —</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.company || c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="muted" style={{ fontSize: 12 }}>
                  ยังไม่มีในรายการ = ให้ ADMIN เพิ่มลูกค้าในหน้าลูกค้าก่อน · ชื่อและที่อยู่บนใบเสนอราคาที่ออกไปแล้วไม่เปลี่ยน
                </span>
              </>
            )}
            {(action === "reject" || action === "cancel" || action === "unapprove") && (
              <label className="field">
                {action === "reject" ? "เหตุผลที่ลูกค้าไม่อนุมัติ *" : action === "cancel" ? `เหตุผลที่ยกเลิก ${q.quotationNo} *` : "เหตุผลที่ถอนการอนุมัติ *"}
                <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} maxLength={500} />
                {action === "unapprove" && (
                  <span className="muted" style={{ fontSize: 12 }}>
                    ใบจะกลับเป็นรอลูกค้าตอบ เลข PO และไฟล์ที่แนบจะถูกลบ
                  </span>
                )}
              </label>
            )}
            <div className="form-actions" style={{ marginTop: 0 }}>
              <button type="button" onClick={() => setAction(null)} disabled={busy}>
                ปิด
              </button>
              <button
                type="button"
                className={`primary${action === "cancel" ? " danger" : ""}`}
                disabled={busy}
                onClick={() => {
                  if (action === "approve") {
                    if (!dateIso) return setError("วันที่อนุมัติไม่ถูกต้อง (วว/ดด/ปปปป)");
                    if (!poNumber.trim() && !file) return setError("ใส่เลข PO หรือแนบไฟล์อย่างน้อยหนึ่งอย่าง");
                    return run(async () => {
                      await quotationApi.approve(q.id, { approvedDate: dateIso, poNumber: poNumber.trim(), file, expectedUpdatedAt: q.updatedAt });
                      setFile(null);
                      setPoNumber("");
                      return "บันทึกการอนุมัติแล้ว";
                    });
                  }
                  if (action === "invoice") {
                    if (!invoiceNo.trim()) return setError("ใส่เลขที่บิล");
                    if (!dateIso) return setError("วันที่ออกบิลไม่ถูกต้อง (วว/ดด/ปปปป)");
                    return run(async () => {
                      const { invoice } = await quotationApi.createInvoice(q.id, { invoiceNo: invoiceNo.trim(), issueDate: dateIso });
                      printInvoice(invoice);
                      return `ออกใบวางบิล ${invoice.invoiceNo} แล้ว`;
                    });
                  }
                  if (action === "rates") return run(async () => (await quotationApi.applyRates(q.id), "ตั้งเป็นราคาลูกค้าแล้ว"));
                  if (action === "link") {
                    if (!linkId) return setError("เลือกลูกค้า");
                    return run(async () => (await quotationApi.linkCustomer(q.id, linkId), "ผูกกับลูกค้าในระบบแล้ว"));
                  }
                  if (!remark.trim()) return setError("ใส่เหตุผล");
                  if (action === "reject") return run(async () => (await quotationApi.reject(q.id, remark.trim()), "บันทึกว่าลูกค้าไม่อนุมัติแล้ว"));
                  if (action === "unapprove") return run(async () => (await quotationApi.unapprove(q.id, remark.trim()), "ถอนการอนุมัติแล้ว"));
                  return run(async () => (await quotationApi.cancel(q.id, remark.trim()), "ยกเลิกใบเสนอราคาแล้ว"));
                }}
              >
                {busy
                  ? "กำลังบันทึก…"
                  : action === "approve"
                    ? "บันทึกอนุมัติ"
                    : action === "invoice"
                      ? "ยืนยันออกบิลและพิมพ์"
                      : action === "rates"
                        ? "ยืนยันตั้งราคา"
                        : action === "link"
                          ? "ผูกลูกค้า"
                          : "ยืนยัน"}
              </button>
            </div>
          </div>
        )}
      </section>

      {history.length > 0 && (
        <section className="panel" style={{ marginTop: 16, padding: "14px 23px" }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>ประวัติ</h2>
          {history.map((h) => (
            <div key={h.id} style={{ fontSize: 13, padding: "6px 0", borderTop: "1px solid #f0f2f6" }}>
              <b style={{ fontWeight: 600 }}>{ACTION_LABEL[h.action] ?? h.action}</b> · {h.remark}
              <span className="muted">
                {" "}
                · {h.editedBy ?? "ระบบ"} · {timestampToDisplayDate(h.createdAt)}
              </span>
            </div>
          ))}
        </section>
      )}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="muted" style={{ fontSize: 12 }}>
        {label}
      </span>
      <div>{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
      <span>{label}</span>
      <span>{formatMoney(value)}</span>
    </div>
  );
}
