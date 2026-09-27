"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type Invoice, type InvoiceList } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";
import { formatMoney } from "@/lib/invoice";
import { printInvoice } from "@/lib/invoice-print";

// บิลที่ออกแล้วของทุกลูกค้า: พิมพ์ซ้ำ, บันทึกรับเงิน (พร้อมเลขที่ใบกำกับภาษี TV ที่ออกจาก Google Sheet), หรือยกเลิกบิล (รถกลับเข้าคิวรอวางบิล)
// บิลรอรับเงินโหลดครบทุกใบเสมอ ประวัติ (รับเงินแล้ว / ยกเลิก) โหลดทีละ 200 ใบ ใหม่สุดก่อน และยอดรอรับเงินนับฝั่ง server
// จากบิลรอรับเงินทั้งหมด (พบ 2026-09-27: เดิมโหลดแค่ 200 ใบล่าสุดรวมทุกสถานะ บิลค้างเก่าหลุดจากหน้าจอ กดรับเงิน/ยกเลิกไม่ได้
// และยอดรอรับเงินต่ำกว่าหน้าภาพรวม)
const STATUS: Record<Invoice["status"], { text: string; className: string }> = {
  ISSUED: { text: "รอรับเงิน", className: "badge warn" },
  PAID: { text: "รับเงินแล้ว", className: "badge done" },
  VOID: { text: "ยกเลิก", className: "badge" },
};

const HISTORY_PAGE = 200; // ตรงกับ INVOICE_HISTORY_PAGE ใน backend/src/billing/billing.service.ts

type Filter = Invoice["status"] | "ALL";
const FILTERS: Array<[Filter, string]> = [
  ["ISSUED", "รอรับเงิน"],
  ["PAID", "รับเงินแล้ว"],
  ["VOID", "ยกเลิก"],
  ["ALL", "ทั้งหมด"],
];

type Action = { id: string; kind: "paid" | "void" } | null;

const byIssueDateDesc = (a: Invoice, b: Invoice) => b.issueDate.localeCompare(a.issueDate);

// reloadKey เปลี่ยน = โหลดรายการใหม่ (หน้าวางบิลเพิ่มค่าหลังออกบิล), onVoided = ยกเลิกบิลแล้ว รถกลับเข้าคิว ให้หน้าวางบิลโหลดคิวใหม่
export function BillingInvoiceList({ reloadKey, onVoided }: { reloadKey: number; onVoided: () => void }) {
  const [list, setList] = useState<InvoiceList | null>(null);
  const [filter, setFilter] = useState<Filter>("ISSUED");
  const [loadError, setLoadError] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  // ประวัติที่โหลดไว้แล้วกี่ใบ - โหลดใหม่หลังรับเงิน/ยกเลิก/ออกบิลให้ได้เท่าที่เปิดดูอยู่ ไม่หดกลับเหลือหน้าแรก
  const historyLoaded = useRef(0);
  const [action, setAction] = useState<Action>(null);
  const [paidDateText, setPaidDateText] = useState(isoToDisplayDate(todayIso()));
  const [taxInvoiceNo, setTaxInvoiceNo] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function reload() {
    try {
      const next = await billingApi.listInvoices({ limit: Math.max(HISTORY_PAGE, historyLoaded.current) });
      historyLoaded.current = next.invoices.filter((i) => i.status !== "ISSUED").length;
      setList(next);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "โหลดรายการบิลไม่สำเร็จ");
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount / on reloadKey change; state is only set after the await.
    reload();
  }, [reloadKey]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const next = await billingApi.listInvoices({ offset: historyLoaded.current });
      historyLoaded.current += next.invoices.length;
      setList((prev) => {
        if (!prev) return next;
        const known = new Set(prev.invoices.map((i) => i.id));
        const invoices = [...prev.invoices, ...next.invoices.filter((i) => !known.has(i.id))].sort(byIssueDateDesc);
        return { invoices, hasMore: next.hasMore, outstanding: next.outstanding };
      });
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "โหลดรายการบิลไม่สำเร็จ");
    } finally {
      setLoadingMore(false);
    }
  }

  function open(next: Action) {
    setAction(next);
    setError("");
    setTaxInvoiceNo("");
    setReason("");
    setPaidDateText(isoToDisplayDate(todayIso()));
  }

  async function handleConfirm(invoice: Invoice) {
    if (!action) return;
    const kind = action.kind;
    setError("");
    try {
      if (kind === "paid") {
        const paidDate = displayDateToIso(paidDateText.replace(/\D/g, ""));
        if (!paidDate) return setError("วันที่รับเงินไม่ถูกต้อง");
        // ตรวจซ้ำที่ backend (markPaid) - ตรวจที่นี่ก่อนให้รู้ทันทีโดยไม่ต้องรอ
        if (paidDate < invoice.issueDate) return setError(`วันที่รับเงินต้องไม่ก่อนวันที่ออกบิล (${isoToDisplayDate(invoice.issueDate)})`);
        if (paidDate > todayIso()) return setError("วันที่รับเงินต้องไม่เกินวันนี้");
        setSaving(true);
        await billingApi.markInvoicePaid(invoice.id, { paidDate, taxInvoiceNo });
      } else {
        if (!reason.trim()) return setError("ใส่เหตุผลที่ยกเลิก");
        setSaving(true);
        await billingApi.voidInvoice(invoice.id, reason);
      }
      setAction(null);
      await reload();
      if (kind === "void") onVoided();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const invoices = list?.invoices ?? [];
  const outstanding = list?.outstanding ?? { count: 0, total: 0 };
  const visible = filter === "ALL" ? invoices : invoices.filter((i) => i.status === filter);
  const historyCount = invoices.length - invoices.filter((i) => i.status === "ISSUED").length;
  const showMore = filter !== "ISSUED" && !!list?.hasMore;

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>บิลที่ออกแล้ว</h2>
        <span className="muted">
          รอรับเงิน {outstanding.count} ใบ · {formatMoney(outstanding.total)} บาท
        </span>
      </div>
      <div className="inspect-filter">
        {FILTERS.map(([key, text]) => (
          <button key={key} className={`filter-chip${filter === key ? " selected" : ""}`} onClick={() => setFilter(key)}>
            {text}
            {key === "ISSUED" ? ` (${outstanding.count})` : ""}
          </button>
        ))}
      </div>
      {loadError && (
        <div className="customer-message error" role="alert" style={{ padding: "0 23px 12px" }}>
          {loadError}
        </div>
      )}
      {!list ? (
        !loadError && <div className="empty-customers">กำลังโหลด...</div>
      ) : visible.length === 0 ? (
        <div className="empty-customers">
          {invoices.length === 0 && !list.hasMore ? "ยังไม่มีบิลที่ออกจากระบบนี้" : filter === "ISSUED" ? "ไม่มีบิลรอรับเงิน" : "ไม่มีบิลในสถานะนี้"}
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่</th>
                <th>วันที่ออก</th>
                <th>ลูกค้า</th>
                <th>จำนวนรถ</th>
                <th>ยอดสุทธิ</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => (
                <tr key={i.id} style={i.status === "VOID" ? { color: "#8a94a6" } : undefined}>
                  <td>{i.invoiceNo}</td>
                  <td>{isoToDisplayDate(i.issueDate)}</td>
                  <td>{i.customer.name}</td>
                  <td>{i.lines.length}</td>
                  <td style={{ textAlign: "right" }}>{formatMoney(i.netTotal)}</td>
                  <td>
                    <span className={STATUS[i.status].className}>{STATUS[i.status].text}</span>
                    {i.status === "PAID" && (
                      <div className="muted">
                        {i.paidDate ? isoToDisplayDate(i.paidDate) : ""}
                        {i.taxInvoiceNo ? ` · ${i.taxInvoiceNo}` : ""}
                      </div>
                    )}
                    {i.status === "VOID" && i.voidReason && <div className="muted">{i.voidReason}</div>}
                  </td>
                  <td>
                    {action?.id === i.id ? (
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        {action.kind === "paid" ? (
                          <>
                            <DateInput
                              placeholder="วันที่รับเงิน"
                              value={paidDateText}
                              onChange={(value) => setPaidDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
                              style={{ width: 110 }}
                              aria-label="วันที่รับเงิน"
                            />
                            <input type="text" placeholder="เลขที่ TV (ถ้ามี)" value={taxInvoiceNo} onChange={(e) => setTaxInvoiceNo(e.target.value)} style={{ width: 130 }} aria-label="เลขที่ใบกำกับภาษี" />
                          </>
                        ) : (
                          <input type="text" placeholder="เหตุผลที่ยกเลิก" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 220 }} aria-label="เหตุผลที่ยกเลิก" />
                        )}
                        <button className="text-button" disabled={saving} onClick={() => handleConfirm(i)}>
                          ยืนยัน
                        </button>
                        <button className="text-button" onClick={() => setAction(null)}>
                          ปิด
                        </button>
                        {error && (
                          <div className="customer-message error" style={{ fontSize: 11 }} role="alert">
                            {error}
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        {/* บิลที่ยกเลิกแล้วพิมพ์ออกมามีลายน้ำ "ยกเลิก" (lib/invoice-print.ts) */}
                        <button className="text-button" onClick={() => printInvoice(i)}>
                          พิมพ์
                        </button>
                        {i.status === "ISSUED" && (
                          <>
                            <button className="text-button" onClick={() => open({ id: i.id, kind: "paid" })}>
                              รับเงินแล้ว
                            </button>
                            <button className="text-button" onClick={() => open({ id: i.id, kind: "void" })}>
                              ยกเลิกบิล
                            </button>
                          </>
                        )}
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {showMore && (
        <div className="inspect-pagination">
          <span className="muted">แสดงประวัติ {historyCount} ใบล่าสุด</span>
          <button className="text-button" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "กำลังโหลด..." : `โหลดเพิ่มอีก ${HISTORY_PAGE} ใบ`}
          </button>
        </div>
      )}
    </section>
  );
}
