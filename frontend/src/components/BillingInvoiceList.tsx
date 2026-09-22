"use client";

import { useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type Invoice } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { formatMoney } from "@/lib/invoice";
import { printInvoice } from "@/lib/invoice-print";

// บิลที่ออกแล้วของทุกลูกค้า: พิมพ์ซ้ำ, บันทึกรับเงิน (พร้อมเลขที่ใบกำกับภาษี TV ที่ออกจาก Google Sheet), หรือยกเลิกบิล (รถกลับเข้าคิวรอวางบิล)
const STATUS: Record<Invoice["status"], { text: string; className: string }> = {
  ISSUED: { text: "รอรับเงิน", className: "badge warn" },
  PAID: { text: "รับเงินแล้ว", className: "badge done" },
  VOID: { text: "ยกเลิก", className: "badge" },
};

type Action = { id: string; kind: "paid" | "void" } | null;

export function BillingInvoiceList({ invoices, onChanged }: { invoices: Invoice[]; onChanged: () => void }) {
  const [action, setAction] = useState<Action>(null);
  const [paidDateText, setPaidDateText] = useState(isoToDisplayDate(todayIso()));
  const [taxInvoiceNo, setTaxInvoiceNo] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const outstanding = invoices.filter((i) => i.status === "ISSUED");

  function open(next: Action) {
    setAction(next);
    setError("");
    setTaxInvoiceNo("");
    setReason("");
    setPaidDateText(isoToDisplayDate(todayIso()));
  }

  async function handleConfirm(invoice: Invoice) {
    if (!action) return;
    setError("");
    try {
      if (action.kind === "paid") {
        const paidDate = displayDateToIso(paidDateText.replace(/\D/g, ""));
        if (!paidDate) return setError("วันที่รับเงินไม่ถูกต้อง");
        setSaving(true);
        await billingApi.markInvoicePaid(invoice.id, { paidDate, taxInvoiceNo });
      } else {
        if (!reason.trim()) return setError("ใส่เหตุผลที่ยกเลิก");
        setSaving(true);
        await billingApi.voidInvoice(invoice.id, reason);
      }
      setAction(null);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>บิลที่ออกแล้ว ({invoices.length})</h2>
        <span className="muted">
          รอรับเงิน {outstanding.length} ใบ · {formatMoney(outstanding.reduce((s, i) => s + i.netTotal, 0))} บาท
        </span>
      </div>
      {invoices.length === 0 ? (
        <div className="empty-customers">ยังไม่มีบิลที่ออกจากระบบนี้</div>
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
              {invoices.map((i) => (
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
                            <input
                              type="text"
                              inputMode="numeric"
                              placeholder="วันที่รับเงิน"
                              value={paidDateText}
                              onChange={(e) => setPaidDateText(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
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
    </section>
  );
}
