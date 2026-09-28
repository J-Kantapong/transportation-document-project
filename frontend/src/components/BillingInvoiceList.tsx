"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import {
  billingApi,
  type BillingTerms,
  type Invoice,
  type InvoiceHistoryEntry,
  type InvoiceItem,
  type InvoiceLine,
  type InvoiceList,
  type InvoiceLiveLine,
  type UpdateInvoiceInput,
} from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, timestampToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";
import { computeTotals, effectiveWhtRate, formatMoney, round2, sortLinesByPlate, termsSummary, VAT_RATE } from "@/lib/invoice";
import { printInvoice } from "@/lib/invoice-print";
import Link from "next/link";
import { WhtRatePicker, whtOverrideOf, whtProblem } from "@/components/WhtRatePicker";
import { InvoiceItemsEditor, itemRowsFromItems, itemRowsProblem, itemRowsToItems, type ItemRow } from "@/components/InvoiceItemsEditor";

// บิลที่ออกแล้วของทุกลูกค้า: พิมพ์ซ้ำ, บันทึกรับเงิน (พร้อมเลขที่ใบกำกับภาษี TV ที่ออกจาก Google Sheet), หรือยกเลิกบิล (รถกลับเข้าคิวรอวางบิล)
// บิลรอรับเงินโหลดครบทุกใบเสมอ ประวัติ (รับเงินแล้ว / ยกเลิก) โหลดทีละ 200 ใบ ใหม่สุดก่อน และยอดรอรับเงินนับฝั่ง server
// จากบิลรอรับเงินทั้งหมด (พบ 2026-09-27: เดิมโหลดแค่ 200 ใบล่าสุดรวมทุกสถานะ บิลค้างเก่าหลุดจากหน้าจอ กดรับเงิน/ยกเลิกไม่ได้
// และยอดรอรับเงินต่ำกว่าหน้าภาพรวม)
// แก้ไขได้ (ผู้ใช้ 2026-09-27) ทุกครั้งต้องมีเหตุผลและเก็บประวัติ: บิลรอรับเงิน "แก้ไขบิล" ได้ในที่โดยใช้เลขที่เดิม
// บิลที่รับเงินแล้ว "ยกเลิกการรับเงิน" กลับเป็นรอรับเงินได้ (กดรับเงินผิดใบ / วันที่ / เลข TV ผิด) แล้วบันทึกรับเงินใหม่ แก้ หรือยกเลิกต่อได้
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

type Action = { id: string; kind: "paid" | "void" | "unpay" } | null;

const byIssueDateDesc = (a: Invoice, b: Invoice) => b.issueDate.localeCompare(a.issueDate);
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
// 409 = มีคนแก้ / รับเงิน / ยกเลิกบิลใบนี้ไปก่อน - รายการบนจอเก่าแล้ว ปิดช่องที่กรอกค้างไว้ บอกข้อความเหนือตาราง
const isConflict = (err: unknown) => err instanceof ApiError && err.status === 409;
// backend ตอบกลับมา (ไม่ใช่ติดต่อไม่ได้) = โหลดรายการใหม่เสมอ เหมือน refusedByServer ในหน้าวางบิล (พบ 2026-09-27:
// เดิมโหลดใหม่เฉพาะ 409 บิลที่อีกคนเพิ่งรับเงินยังแสดงรอรับเงินพร้อมปุ่มเดิม)
const refusedByServer = (err: unknown) => err instanceof ApiError && err.status !== undefined;

// reloadKey เปลี่ยน = โหลดรายการใหม่ (หน้าวางบิลเพิ่มค่าหลังออกบิล)
// onQueueChanged = รถกลับเข้าคิวรอวางบิล (ยกเลิกบิล / เอารถออกจากบิลตอนแก้) ให้หน้าวางบิลโหลดคิวใหม่
export function BillingInvoiceList({ reloadKey, onQueueChanged }: { reloadKey: number; onQueueChanged: () => void }) {
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
  const [notice, setNotice] = useState("");
  // ข้อความที่ต้องเห็นแม้ช่องกรอก/หน้าแก้ถูกปิดไปแล้ว (บิลเปลี่ยนสถานะจากอีกหน้าจอ = 409)
  const [staleError, setStaleError] = useState("");
  const [editing, setEditing] = useState<Invoice | null>(null);
  const [historyOf, setHistoryOf] = useState<Invoice | null>(null);

  async function reload() {
    try {
      const next = await billingApi.listInvoices({ limit: Math.max(HISTORY_PAGE, historyLoaded.current) });
      historyLoaded.current = next.invoices.filter((i) => i.status !== "ISSUED").length;
      setList(next);
      setLoadError("");
    } catch (err) {
      setLoadError(errorText(err, "โหลดรายการบิลไม่สำเร็จ"));
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
      setLoadError(errorText(err, "โหลดรายการบิลไม่สำเร็จ"));
    } finally {
      setLoadingMore(false);
    }
  }

  function open(next: Action) {
    setAction(next);
    setError("");
    setNotice("");
    setStaleError("");
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
      } else if (kind === "void") {
        if (!reason.trim()) return setError("ใส่เหตุผลที่ยกเลิก");
        setSaving(true);
        await billingApi.voidInvoice(invoice.id, reason);
      } else {
        if (!reason.trim()) return setError("ใส่เหตุผลที่ยกเลิกการรับเงิน");
        setSaving(true);
        await billingApi.unpayInvoice(invoice.id, reason.trim());
        setNotice(`ยกเลิกการรับเงิน ${invoice.invoiceNo} แล้ว - บิลกลับเป็นรอรับเงิน บันทึกรับเงินใหม่ แก้ไข หรือยกเลิกบิลได้ตามปกติ`);
        if (filter === "PAID") setFilter("ISSUED"); // ให้เห็นบิลใบนั้นต่อในสถานะใหม่
      }
      setAction(null);
      await reload();
      if (kind === "void") onQueueChanged();
    } catch (err) {
      const text = errorText(err, "บันทึกไม่สำเร็จ");
      if (isConflict(err)) {
        // บิลเปลี่ยนสถานะไปแล้ว - ช่องกรอกนี้ใช้ไม่ได้แล้ว (แถวอาจหายจากตัวกรองหลังโหลดใหม่) ปิดแล้วบอกเหนือตาราง
        // อีกหน้าจออาจยกเลิกบิล / เอารถออกจากบิล = รถกลับเข้าคิว ให้หน้าวางบิลโหลดคิวใหม่ด้วย (ไม่ล้างที่กรอกค้างไว้)
        setAction(null);
        setStaleError(`${invoice.invoiceNo}: ${text} (มีคนเปลี่ยนบิลนี้จากอีกหน้าจอ - รายการด้านล่างโหลดใหม่แล้ว)`);
        onQueueChanged();
      } else {
        setError(text);
      }
      if (refusedByServer(err)) reload();
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
      {notice && (
        <div className="customer-message success" role="status" style={{ padding: "0 23px 12px" }}>
          {notice}
        </div>
      )}
      {staleError && (
        <div className="customer-message error" role="alert" style={{ padding: "0 23px 12px" }}>
          {staleError}
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
                  <td>{i.lines.length ? i.lines.length : <span className="muted">บิลกำหนดเอง</span>}</td>
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
                        ) : action.kind === "void" ? (
                          <>
                            <input type="text" placeholder="เหตุผลที่ยกเลิก" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 220 }} aria-label="เหตุผลที่ยกเลิก" />
                            {/* เลขที่บิลที่ยกเลิกแล้วใช้ซ้ำไม่ได้ (unique) - คีย์ผิดให้แก้ในที่แทน (ผู้ใช้ 2026-09-27) */}
                            <div className="muted" style={{ flexBasis: "100%", fontSize: 12 }}>
                              เลขที่ {i.invoiceNo} จะใช้ซ้ำไม่ได้ - ถ้าแค่คีย์ผิดใช้ &quot;แก้ไขบิล&quot; แทน
                            </div>
                          </>
                        ) : (
                          <>
                            <input
                              type="text"
                              placeholder="เหตุผลที่ยกเลิกการรับเงิน"
                              value={reason}
                              onChange={(e) => setReason(e.target.value)}
                              style={{ width: 240 }}
                              aria-label="เหตุผลที่ยกเลิกการรับเงิน"
                            />
                            <div className="muted" style={{ flexBasis: "100%", fontSize: 12 }}>
                              บิลกลับเป็นรอรับเงิน ล้างวันที่รับเงินและเลข TV (ค่าเดิมเก็บในประวัติ)
                            </div>
                          </>
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
                            {i.lines.length === 0 ? (
                              // บิลกำหนดเอง (ไม่มีรถ) แก้ในฟอร์มเดียวกับตอนออกบิล
                              <Link className="text-button" href={`/accounting/billing/custom?edit=${encodeURIComponent(i.id)}`}>
                                แก้ไขบิล
                              </Link>
                            ) : (
                              <button
                                className="text-button"
                                onClick={() => {
                                  setAction(null);
                                  setNotice("");
                                  setStaleError("");
                                  setEditing(i);
                                }}
                              >
                                แก้ไขบิล
                              </button>
                            )}
                            <button className="text-button" onClick={() => open({ id: i.id, kind: "void" })}>
                              ยกเลิกบิล
                            </button>
                          </>
                        )}
                        {i.status === "PAID" && (
                          <button className="text-button" onClick={() => open({ id: i.id, kind: "unpay" })}>
                            ยกเลิกการรับเงิน
                          </button>
                        )}
                        {!!i.historyCount && (
                          <button className="text-button" onClick={() => setHistoryOf(i)}>
                            ประวัติ ({i.historyCount})
                          </button>
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

      {editing && (
        <InvoiceEditDialog
          invoice={editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, removedVehicles) => {
            setNotice(`แก้ไข ${saved.invoiceNo} แล้ว ยอดสุทธิ ${formatMoney(saved.netTotal)} บาท - กด "พิมพ์" เพื่อพิมพ์บิลที่แก้แล้วให้ลูกค้าแทนใบเดิม`);
            reload();
            if (removedVehicles) onQueueChanged();
          }}
          onRefused={(staleMessage) => {
            // 409: หน้าแก้ปิดเองแล้ว (ถือ updatedAt เก่า ลองใหม่ก็ 409 ซ้ำ) - บอกเหนือตารางให้เปิด "แก้ไขบิล" ใหม่จากรายการที่โหลดใหม่
            if (staleMessage) {
              setStaleError(`${editing.invoiceNo}: ${staleMessage}`);
              onQueueChanged(); // อีกหน้าจออาจยกเลิกบิล / เอารถออก = รถกลับเข้าคิว
            }
            reload();
          }}
        />
      )}
      {historyOf && <InvoiceHistoryDialog invoice={historyOf} onClose={() => setHistoryOf(null)} />}
    </section>
  );
}

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return ref;
}

const parseMoney = (text: string): number | null => {
  const n = Number.parseFloat(text.replace(/,/g, ""));
  return text.trim() !== "" && Number.isFinite(n) && n >= 0 ? round2(n) : null;
};

interface EditRow {
  receiptText: string;
  serviceText: string; // ค่าดำเนินการก่อนหัก (= serviceFee + deduction ที่เก็บในบิล)
  deductText: string;
  deductNote: string;
  label: string;
  remove: boolean;
  refresh: boolean; // ใช้ข้อมูลรถล่าสุด (ทะเบียน / เลขที่ใบเสร็จ ...) แทนที่บิลเก็บไว้
}

// ข้อมูลรถที่บิลเก็บไว้ตอนออกบิล - เทียบกับข้อมูลรถตอนนี้ (live-lines) ช่องที่ต่างแสดงให้ติ๊กดึงล่าสุดได้
const SNAPSHOT_TEXT: Array<[keyof InvoiceLiveLine & keyof InvoiceLine, string]> = [
  ["plateText", "ทะเบียน"],
  ["receiptNo", "เลขที่ใบเสร็จ"],
  ["chassis", "เลขตัวถัง"],
  ["brandName", "ยี่ห้อ"],
  ["body", "ประเภทรถ"],
  ["deliveredDate", "วันที่ส่งงาน"],
];

function snapshotDiff(line: InvoiceLine, now: InvoiceLiveLine | undefined): Array<{ label: string; from: string; to: string }> {
  if (!now) return [];
  const show = (key: string, v: string | number | null) => (v === null || v === "" ? "—" : key === "deliveredDate" ? isoToDisplayDate(String(v)) : String(v));
  return SNAPSHOT_TEXT.flatMap(([key, label]) => {
    const to = now[key];
    if (key === "deliveredDate" && to === null) return []; // รถไม่มีวันที่ส่งงานแล้ว - backend เก็บวันที่เดิมของบิลไว้
    const from = line[key];
    return (from ?? "") === (to ?? "") ? [] : [{ label, from: show(key, from), to: show(key, to) }];
  });
}

interface ExtraRow {
  label: string;
  amountText: string;
}

type LineValues = { receiptAmount: number; serviceFee: number; serviceLabel: string | null; deduction: number; deductionNote: string | null };

// แก้บิลที่ยังไม่รับเงิน (ผู้ใช้ 2026-09-27): เลขที่บิลและข้อมูลลูกค้าบนบิลเดิม แก้วันที่ ชื่องาน ยอดรายคัน ค่าใช้จ่ายอื่นๆ
// และเอารถออกจากบิลได้ (รถกลับเข้าคิวรอวางบิล) - เพิ่มรถเข้าบิลเดิมไม่ได้ ให้ออกบิลใหม่แทน
// คันที่ข้อมูลรถเปลี่ยนหลังออกบิล (เช่น แก้ทะเบียน / เลขที่ใบเสร็จที่ AI อ่านผิด) ติ๊ก "ใช้ข้อมูลรถล่าสุด" ได้รายคัน
// บิลพิมพ์ตามข้อมูลปัจจุบันโดยไม่ต้องยกเลิกบิลแล้วออกเลขใหม่
// ยอดบนจอคิดสดด้วยสูตรเดียวกับ backend แต่ backend คำนวณซ้ำและเป็นตัวจริง - VAT / หัก ณ ที่จ่ายใช้อัตราเดิมของบิล
// เว้นแต่ติ๊กใช้เงื่อนไขปัจจุบันของลูกค้า (เช่น เปลี่ยนวันที่ออกบิลข้ามวันสิ้นสุดอัตราพิเศษ)
// onRefused(ข้อความ) = 409 หน้าแก้ปิดตัวเองแล้ว, onRefused() = backend ปฏิเสธอย่างอื่น (หน้าแก้ยังเปิดอยู่) - ทั้งคู่ให้รายการโหลดใหม่
function InvoiceEditDialog({
  invoice,
  onClose,
  onSaved,
  onRefused,
}: {
  invoice: Invoice;
  onClose: () => void;
  onSaved: (invoice: Invoice, removedVehicles: boolean) => void;
  onRefused: (staleMessage?: string) => void;
}) {
  const dialogRef = useModal();
  const lines = sortLinesByPlate(invoice.lines);
  const [issueDateText, setIssueDateText] = useState(isoToDisplayDate(invoice.issueDate));
  const [jobLabel, setJobLabel] = useState(invoice.jobLabel);
  const [rows, setRows] = useState<Record<string, EditRow>>(() =>
    Object.fromEntries(
      invoice.lines.map((l) => [
        l.id,
        {
          receiptText: formatMoney(l.receiptAmount),
          serviceText: formatMoney(round2(l.serviceFee + l.deduction)),
          deductText: l.deduction ? formatMoney(l.deduction) : "",
          deductNote: l.deductionNote ?? "",
          label: l.serviceLabel ?? "",
          remove: false,
          refresh: false,
        },
      ]),
    ),
  );
  // ข้อมูลรถตอนนี้ของแต่ละคัน (key = InvoiceLine.id) - โหลดไม่ได้ก็แก้ส่วนอื่นได้ตามปกติ แค่ไม่มีตัวเลือกดึงข้อมูลล่าสุด
  const [live, setLive] = useState<Record<string, InvoiceLiveLine> | null>(null);
  const [extras, setExtras] = useState<ExtraRow[]>(() => invoice.extras.map((e) => ({ label: e.label, amountText: formatMoney(e.amount) })));
  const [currentTerms, setCurrentTerms] = useState<BillingTerms | null>(null);
  const [applyCurrent, setApplyCurrent] = useState(false);
  // เปลี่ยนอัตราหัก ณ ที่จ่ายของบิลนี้ (ผู้ใช้ 2026-09-29) null = คงอัตราเดิมของบิล
  const [whtValue, setWhtValue] = useState<number | null>(null);
  const [whtChecked, setWhtChecked] = useState(false);
  // บรรทัดกำหนดเองของบิล (ผู้ใช้ 2026-09-29) แก้ได้ทั้งชุดเหมือนตอนออกบิล
  const [itemRows, setItemRows] = useState<ItemRow[]>(() => itemRowsFromItems(invoice.items));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    // เงื่อนไขวางบิลปัจจุบันของลูกค้า ไว้เทียบกับอัตราที่บิลออกไป - โหลดไม่ได้ก็แก้บิลได้ด้วยอัตราเดิม
    billingApi
      .customerTerms(invoice.customerId)
      // บิลบัญชีบุคคลไม่มี VAT เสมอ (เหมือน backend termsFor) - เทียบเฉพาะหัก ณ ที่จ่าย
      .then((r) => setCurrentTerms(invoice.account === "PERSONAL" ? { ...r.terms, vat: false } : r.terms))
      .catch(() => setCurrentTerms(null));
  }, [invoice.customerId, invoice.account]);

  useEffect(() => {
    billingApi
      .invoiceLiveLines(invoice.id)
      .then((r) => setLive(Object.fromEntries(r.lines.map((l) => [l.id, l]))))
      .catch(() => setLive(null));
  }, [invoice.id]);

  const diffsOf = (l: InvoiceLine) => snapshotDiff(l, live?.[l.id]);
  const changedCount = invoice.lines.filter((l) => diffsOf(l).length > 0).length;

  const issueIso = displayDateToIso(issueDateText.replace(/\D/g, ""));
  const issueForTotals = issueIso || invoice.issueDate;
  const invoiceTerms: BillingTerms = { vat: invoice.vatRate > 0, whtRate: invoice.whtRate, whtSpecialRate: null, whtSpecialUntil: null };
  const termsDiffer =
    !!currentTerms && ((currentTerms.vat ? VAT_RATE : 0) !== invoice.vatRate || effectiveWhtRate(currentTerms, issueForTotals) !== invoice.whtRate);
  const useCurrent = applyCurrent && termsDiffer;

  const nameOf = (id: string) => {
    const l = invoice.lines.find((x) => x.id === id)!;
    return l.plateText || l.chassis;
  };

  // ค่าที่กรอกของแต่ละคัน -> ยอดที่จะบันทึก หรือข้อความผิดพลาด
  function valuesOf(id: string): LineValues | string {
    const row = rows[id];
    const receiptAmount = parseMoney(row.receiptText);
    if (receiptAmount === null) return `ใส่ค่าใบเสร็จของ ${nameOf(id)}`;
    const base = parseMoney(row.serviceText);
    if (base === null) return `ค่าดำเนินการของ ${nameOf(id)} ไม่ถูกต้อง`;
    const deduction = row.deductText.trim() === "" ? 0 : parseMoney(row.deductText);
    if (deduction === null) return `ยอดหักของ ${nameOf(id)} ไม่ถูกต้อง`;
    if (deduction > base) return `ยอดหักของ ${nameOf(id)} มากกว่าค่าดำเนินการ`;
    return {
      receiptAmount,
      serviceFee: round2(base - deduction),
      serviceLabel: row.label.trim() || null,
      deduction,
      deductionNote: deduction > 0 ? row.deductNote.trim() || null : null,
    };
  }

  const kept = invoice.lines.filter((l) => !rows[l.id].remove);
  const keptValues = kept.map((l) => valuesOf(l.id));
  const extraValues = extras.map((e) => ({ label: e.label.trim(), amount: parseMoney(e.amountText) }));
  const totals = computeTotals(
    keptValues.map((v) => (typeof v === "string" ? { receiptAmount: 0, serviceFee: 0 } : v)),
    extraValues.map((e) => ({ amount: e.amount ?? 0 })),
    useCurrent && currentTerms ? currentTerms : invoiceTerms,
    issueForTotals,
    itemRowsToItems(itemRows),
    whtOverrideOf(whtValue),
  );

  function patchRow(id: string, patch: Partial<EditRow>) {
    setRows((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function handleSave() {
    setError("");
    const fail = (text: string) => setError(text);
    if (!issueIso) return fail("วันที่ออกบิลไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (!jobLabel.trim()) return fail("ใส่ชื่องานที่จะแสดงบนบิล");
    if (kept.length === 0) return fail('บิลต้องเหลือรถอย่างน้อย 1 คัน - ถ้าจะเอาออกทั้งหมดให้ใช้ "ยกเลิกบิล"');

    const changedLines: NonNullable<UpdateInvoiceInput["lines"]> = [];
    for (const l of kept) {
      const v = valuesOf(l.id);
      if (typeof v === "string") return fail(v);
      const changed =
        v.receiptAmount !== l.receiptAmount ||
        v.serviceFee !== l.serviceFee ||
        v.deduction !== l.deduction ||
        v.deductionNote !== (l.deduction > 0 ? l.deductionNote : null) ||
        v.serviceLabel !== (l.serviceLabel || null);
      if (changed) changedLines.push({ id: l.id, ...v });
    }
    for (const e of extraValues) {
      if (!e.label) return fail("ค่าใช้จ่ายอื่นๆ ต้องมีชื่อรายการ");
      if (e.amount === null) return fail(`ใส่จำนวนเงินของ "${e.label}"`);
    }
    const nextExtras = extraValues.map((e) => ({ label: e.label, amount: e.amount! }));
    const removeLineIds = invoice.lines.filter((l) => rows[l.id].remove).map((l) => l.id);
    // backend อ่านข้อมูลรถใหม่ตอนบันทึกและเก็บค่าก่อน/หลังลงประวัติ
    const refreshLineIds = kept.filter((l) => rows[l.id].refresh && diffsOf(l).length > 0).map((l) => l.id);

    // ส่งเฉพาะช่องที่แก้จริง (backend ถือว่าช่องที่ไม่ส่ง = ไม่แก้)
    const edits: Omit<UpdateInvoiceInput, "remark" | "expectedUpdatedAt"> = {};
    if (issueIso !== invoice.issueDate) edits.issueDate = issueIso;
    if (jobLabel.trim() !== invoice.jobLabel) edits.jobLabel = jobLabel.trim();
    if (JSON.stringify(nextExtras) !== JSON.stringify(invoice.extras.map((e) => ({ label: e.label, amount: e.amount })))) edits.extras = nextExtras;
    if (changedLines.length) edits.lines = changedLines;
    if (removeLineIds.length) edits.removeLineIds = removeLineIds;
    if (refreshLineIds.length) edits.refreshLineIds = refreshLineIds;
    if (useCurrent) edits.applyCurrentTerms = true;
    const itemError = itemRowsProblem(itemRows);
    if (itemError) return fail(itemError);
    const nextItems = itemRowsToItems(itemRows);
    const itemKey = (items: InvoiceItem[]) => JSON.stringify(items.map((it) => [it.kind, it.description, it.quantity, it.unitPrice, it.cost]));
    if (itemKey(nextItems) !== itemKey(invoice.items)) edits.items = nextItems;
    const whtError = whtProblem(invoice.whtRate, whtValue, whtChecked);
    if (whtError) return fail(whtError);
    const whtOverride = whtOverrideOf(whtValue);
    if (whtOverride !== null && whtOverride !== invoice.whtRate) edits.whtRate = whtOverride;
    if (Object.keys(edits).length === 0) return fail("ยังไม่ได้แก้อะไร");
    if (!remark.trim()) return fail("ต้องใส่เหตุผลที่แก้บิล");
    const payload: UpdateInvoiceInput = { ...edits, remark: remark.trim(), expectedUpdatedAt: invoice.updatedAt };

    setSaving(true);
    try {
      const { invoice: saved } = await billingApi.updateInvoice(invoice.id, payload);
      onSaved(saved, removeLineIds.length > 0);
      dialogRef.current?.close();
    } catch (err) {
      const text = errorText(err, "แก้ไขบิลไม่สำเร็จ");
      if (isConflict(err)) {
        // หน้านี้ถือ updatedAt เก่า กดบันทึกซ้ำก็ 409 ซ้ำ - ปิดแล้วให้เปิด "แก้ไขบิล" ใหม่จากรายการที่โหลดใหม่ (พบ 2026-09-27)
        onRefused(text);
        dialogRef.current?.close();
      } else {
        fail(text);
        if (refusedByServer(err)) onRefused();
      }
    } finally {
      setSaving(false);
    }
  }

  const netChanged = round2(totals.netTotal) !== round2(invoice.netTotal);

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(1100px, 96vw)", maxHeight: "92vh", overflow: "auto" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แก้ไขบิล {invoice.invoiceNo}</h2>
      <p className="muted">
        {invoice.customer.name} · เลขที่บิลเดิม ข้อมูลลูกค้าบนบิลไม่เปลี่ยน · แก้แล้วพิมพ์บิลใหม่ให้ลูกค้าแทนใบเดิม
      </p>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 12 }}>
        <label className="field" style={{ flex: "0 1 200px" }}>
          วันที่ออกบิล *
          <DateInput value={issueDateText} onChange={(value) => setIssueDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
        </label>
        <label className="field" style={{ flex: "1 1 260px" }}>
          ชื่องานบนบิล *
          <input type="text" value={jobLabel} onChange={(e) => setJobLabel(e.target.value)} />
        </label>
      </div>

      {changedCount > 0 && (
        <p className="customer-message" style={{ marginTop: 12, color: "#bb8527" }}>
          รถ {changedCount} คันมีข้อมูลเปลี่ยนหลังออกบิล (เช่น ทะเบียน / เลขที่ใบเสร็จ) - ติ๊ก &quot;ใช้ข้อมูลรถล่าสุด&quot; ในแถวนั้น
          บิลจะพิมพ์ตามข้อมูลปัจจุบันโดยใช้เลขที่บิลเดิม
        </p>
      )}
      <div className="table-wrap" style={{ marginTop: 14 }}>
        <table>
          <thead>
            <tr>
              <th>ทะเบียน / เลขตัวถัง</th>
              <th>ค่าใบเสร็จ</th>
              <th>ค่าบริการ</th>
              <th>ยอดหัก</th>
              <th>ข้อความต่อท้ายบนบิล</th>
              <th>เอาออกจากบิล</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const row = rows[l.id];
              const v = valuesOf(l.id);
              const off = row.remove;
              const diffs = diffsOf(l);
              // ยอดใบเสร็จที่พนักงานกรอกไว้ในระบบตอนนี้ ต่างจากที่บิลเก็บไว้ = แสดงเป็นคำแนะนำ (ยอดในบิลยังแก้เองเสมอ)
              const liveReceipt = live?.[l.id]?.receiptAmount ?? null;
              return (
                <tr key={l.id} style={off ? { color: "#8a94a6", textDecoration: "line-through" } : undefined}>
                  <td>
                    {l.plateText || "—"}
                    <div className="muted">
                      {l.chassis} · {l.brandName}
                    </div>
                    {diffs.length > 0 && (
                      <div style={{ fontSize: 12, marginTop: 4, maxWidth: 260, color: "#bb8527" }}>
                        ข้อมูลรถตอนนี้: {diffs.map((d) => `${d.label} ${d.from} → ${d.to}`).join(" · ")}
                        <label style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 2, color: "#34415a" }}>
                          <input
                            type="checkbox"
                            checked={row.refresh}
                            disabled={off}
                            onChange={(e) => patchRow(l.id, { refresh: e.target.checked })}
                            aria-label={`ใช้ข้อมูลรถล่าสุด ${l.plateText || l.chassis}`}
                          />
                          ใช้ข้อมูลรถล่าสุด
                        </label>
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.receiptText}
                      disabled={off}
                      onChange={(e) => patchRow(l.id, { receiptText: e.target.value })}
                      style={{ width: 100, textAlign: "right" }}
                      aria-label={`ค่าใบเสร็จ ${l.plateText || l.chassis}`}
                    />
                    {liveReceipt !== null && liveReceipt !== l.receiptAmount && !off && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        ใบเสร็จในระบบ {formatMoney(liveReceipt)}{" "}
                        <button type="button" className="text-button" onClick={() => patchRow(l.id, { receiptText: formatMoney(liveReceipt) })}>
                          ใช้ยอดนี้
                        </button>
                      </div>
                    )}
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.serviceText}
                      disabled={off}
                      onChange={(e) => patchRow(l.id, { serviceText: e.target.value })}
                      style={{ width: 100, textAlign: "right" }}
                      aria-label={`ค่าดำเนินการ ${l.plateText || l.chassis}`}
                    />
                    {typeof v !== "string" && v.deduction > 0 && <div className="muted">สุทธิ {formatMoney(v.serviceFee)}</div>}
                  </td>
                  <td>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={row.deductText}
                      disabled={off}
                      placeholder="0"
                      onChange={(e) => patchRow(l.id, { deductText: e.target.value })}
                      style={{ width: 80, textAlign: "right" }}
                      aria-label={`ยอดหัก ${l.plateText || l.chassis}`}
                    />
                    {typeof v !== "string" && v.deduction > 0 && (
                      <input
                        type="text"
                        value={row.deductNote}
                        disabled={off}
                        placeholder="เหตุผลที่หัก"
                        onChange={(e) => patchRow(l.id, { deductNote: e.target.value })}
                        style={{ width: 170, display: "block", marginTop: 4 }}
                        aria-label={`เหตุผลที่หัก ${l.plateText || l.chassis}`}
                      />
                    )}
                  </td>
                  <td>
                    <input
                      type="text"
                      value={row.label}
                      disabled={off}
                      onChange={(e) => patchRow(l.id, { label: e.target.value })}
                      placeholder="เช่น (ขอใช้ต่างภูมิลำเนา)"
                      style={{ width: 180 }}
                      aria-label={`ข้อความต่อท้ายบนบิล ${l.plateText || l.chassis}`}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={off}
                      onChange={(e) => patchRow(l.id, { remove: e.target.checked })}
                      aria-label={`เอา ${l.plateText || l.chassis} ออกจากบิล`}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {invoice.lines.some((l) => rows[l.id].remove) && (
        <p className="muted" style={{ fontSize: 12 }}>
          รถที่เอาออกกลับเข้าคิวรอวางบิล ลงบิลใบอื่นได้ - เพิ่มรถเข้าบิลนี้ไม่ได้ ถ้าต้องการให้ออกบิลใหม่
        </p>
      )}

      <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        <b style={{ fontWeight: 600 }}>บรรทัดอื่นในบิลนี้ (งานเก่า / ขายสินค้า / ค่าใช้จ่ายอื่น)</b>
        <InvoiceItemsEditor rows={itemRows} onChange={setItemRows} />
      </div>

      {/* ช่องแบบเดิม (ก่อน 2026-09-29) แสดงเฉพาะบิลเก่าที่มีอยู่แล้ว บิลใหม่ใช้บรรทัดด้านบน */}
      {invoice.extras.length > 0 && <div style={{ display: "grid", gap: 8, marginTop: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <b style={{ fontWeight: 600 }}>ค่าใช้จ่ายอื่นๆ ของบิลนี้ (แบบเดิม)</b>
          <button className="text-button" onClick={() => setExtras((prev) => [...prev, { label: "", amountText: "" }])}>
            + เพิ่มรายการ
          </button>
        </div>
        {extras.map((e, i) => (
          <div key={i} style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={e.label}
              placeholder="ชื่อรายการ"
              onChange={(ev) => setExtras((prev) => prev.map((x, n) => (n === i ? { ...x, label: ev.target.value } : x)))}
              style={{ flex: 1, minWidth: 0 }}
              aria-label="ชื่อรายการ"
            />
            <input
              type="text"
              inputMode="decimal"
              value={e.amountText}
              placeholder="จำนวนเงิน"
              onChange={(ev) => setExtras((prev) => prev.map((x, n) => (n === i ? { ...x, amountText: ev.target.value } : x)))}
              style={{ width: 120, textAlign: "right" }}
              aria-label="จำนวนเงิน"
            />
            <button className="text-button" onClick={() => setExtras((prev) => prev.filter((_, n) => n !== i))} aria-label="ลบรายการ">
              ลบ
            </button>
          </div>
        ))}
      </div>}

      <div style={{ display: "grid", gap: 6, fontSize: 14, marginTop: 14, maxWidth: 420, marginLeft: "auto" }}>
        <div className="muted" style={{ fontSize: 12 }}>
          บิลนี้ออกด้วย {invoice.vatRate ? `VAT ${invoice.vatRate}%` : "ไม่มี VAT"} · {invoice.whtRate ? `หัก ณ ที่จ่าย ${invoice.whtRate}%` : "ไม่หัก ณ ที่จ่าย"}
        </div>
        {termsDiffer && currentTerms && (
          <label style={{ display: "flex", gap: 6, alignItems: "flex-start", fontSize: 12 }}>
            <input type="checkbox" checked={applyCurrent} onChange={(e) => setApplyCurrent(e.target.checked)} />
            <span>ใช้เงื่อนไขปัจจุบันของลูกค้าแทน ({termsSummary(currentTerms, issueForTotals)})</span>
          </label>
        )}
        <WhtRatePicker
          defaultRate={invoice.whtRate}
          value={whtValue}
          onChange={setWhtValue}
          checked={whtChecked}
          onCheckedChange={setWhtChecked}
          defaultLabel="อัตราเดิมของบิล"
          defaultChip="คงเดิม"
        />
        <SumLine label="ค่าธรรมเนียม (ตามใบเสร็จ)" value={totals.feeTotal} />
        <SumLine label="ค่าบริการ" value={totals.serviceTotal} />
        {totals.goodsTotal > 0 && <SumLine label="ค่าสินค้า" value={totals.goodsTotal} />}
        <SumLine label={totals.vatRate ? `VAT ${totals.vatRate}%` : "VAT (ไม่มี)"} value={totals.vatAmount} />
        <SumLine label={totals.whtRate ? `หัก ณ ที่จ่าย ${totals.whtRate}%` : "หัก ณ ที่จ่าย (ไม่มี)"} value={-totals.whtAmount} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", background: "#edf2ff", color: "#2854d9", borderRadius: 10, padding: "10px 14px", fontWeight: 600 }}>
          <span>จำนวนเงินทั้งสิ้น</span>
          <span style={{ fontSize: 20 }}>{formatMoney(totals.netTotal)}</span>
        </div>
        {netChanged && <div className="muted" style={{ fontSize: 12, textAlign: "right" }}>เดิม {formatMoney(invoice.netTotal)}</div>}
      </div>

      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ค่าดำเนินการคีย์ผิด" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={handleSave} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "บันทึกการแก้"}
        </button>
      </div>
    </dialog>
  );
}

function SumLine({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, color: value < 0 ? "#b43434" : undefined }}>
      <span style={{ color: value < 0 ? undefined : "#576781" }}>{label}</span>
      <span>{formatMoney(value || 0)}</span>
    </div>
  );
}

// ---------- ประวัติของบิล (AuditLog) ----------
const ACTION_TEXT: Record<string, string> = { update: "แก้ไขบิล", unpay: "ยกเลิกการรับเงิน", void: "ยกเลิกบิล" };
const FIELD_TEXT: Record<string, string> = {
  status: "สถานะ",
  issueDate: "วันที่ออกบิล",
  jobLabel: "ชื่องาน",
  extras: "ค่าใช้จ่ายอื่นๆ",
  paidDate: "วันที่รับเงิน",
  taxInvoiceNo: "เลขที่ TV",
  vatRate: "อัตรา VAT",
  whtRate: "อัตราหัก ณ ที่จ่าย",
  feeTotal: "ค่าธรรมเนียม",
  serviceTotal: "ค่าดำเนินการรวม",
  vatAmount: "VAT",
  whtAmount: "หัก ณ ที่จ่าย",
  netTotal: "ยอดสุทธิ",
  receiptAmount: "ค่าใบเสร็จ",
  serviceFee: "ค่าดำเนินการ",
  serviceLabel: "ข้อความต่อท้าย",
  deduction: "ยอดหัก",
  deductionNote: "เหตุผลที่หัก",
  chassis: "เลขตัวถัง",
  // ข้อมูลรถที่ดึงล่าสุดลงบิล (refreshLineIds, ผู้ใช้ 2026-09-27)
  plateText: "ทะเบียน",
  receiptNo: "เลขที่ใบเสร็จ",
  brandName: "ยี่ห้อ",
  body: "ประเภทรถ",
  deliveredDate: "วันที่ส่งงาน",
};
const MONEY_FIELDS = new Set(["feeTotal", "serviceTotal", "vatAmount", "whtAmount", "netTotal", "receiptAmount", "serviceFee", "deduction", "amount"]);
const RATE_FIELDS = new Set(["vatRate", "whtRate"]);

// คีย์รายคันเป็น "รถ กก 7733 · serviceFee" (backend billing.service.ts updateInvoice)
function fieldText(key: string): string {
  const cut = key.lastIndexOf(" · ");
  if (cut < 0) return FIELD_TEXT[key] ?? key;
  const field = key.slice(cut + 3);
  return `${key.slice(0, cut)} · ${FIELD_TEXT[field] ?? field}`;
}

function valueText(key: string, value: unknown): string {
  const cut = key.lastIndexOf(" · ");
  const field = cut < 0 ? key : key.slice(cut + 3);
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    if (value.length === 0) return "ไม่มี";
    return value
      .map((e) => (e && typeof e === "object" ? `${String((e as { label?: unknown }).label ?? "")} ${formatMoney(Number((e as { amount?: unknown }).amount ?? 0))}` : String(e)))
      .join(", ");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== null && v !== "" && v !== 0)
      .map(([k, v]) => `${FIELD_TEXT[k] ?? k} ${valueText(k, v)}`)
      .join(" · ");
  }
  if (field === "status" && typeof value === "string" && value in STATUS) return STATUS[value as Invoice["status"]].text;
  if (MONEY_FIELDS.has(field)) return formatMoney(Number(value));
  if (RATE_FIELDS.has(field)) return `${value}%`;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return isoToDisplayDate(value);
  return String(value);
}

function InvoiceHistoryDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const dialogRef = useModal();
  const [entries, setEntries] = useState<InvoiceHistoryEntry[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    billingApi
      .invoiceHistory(invoice.id)
      .then((r) => setEntries(r.entries))
      .catch((err) => setError(errorText(err, "โหลดประวัติไม่สำเร็จ")));
  }, [invoice.id]);

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(760px, 96vw)", maxHeight: "90vh", overflow: "auto" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ประวัติบิล {invoice.invoiceNo}</h2>
      <p className="muted">{invoice.customer.name} · ใหม่สุดก่อน</p>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      {!entries ? (
        !error && <p className="muted">กำลังโหลด...</p>
      ) : entries.length === 0 ? (
        <p className="muted">ยังไม่มีประวัติการแก้ไข</p>
      ) : (
        <div style={{ display: "grid", gap: 14, marginTop: 12 }}>
          {entries.map((e) => (
            <div key={e.id} style={{ borderTop: "1px solid #f0f2f6", paddingTop: 10 }}>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "baseline" }}>
                <b style={{ fontWeight: 600 }}>{ACTION_TEXT[e.action] ?? e.action}</b>
                <span className="muted">
                  {timestampToDisplayDate(e.createdAt)} {new Date(e.createdAt).toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" })} ·{" "}
                  {e.editedBy || "ไม่ทราบผู้ทำ"}
                </span>
              </div>
              <div style={{ marginTop: 4 }}>เหตุผล: {e.remark}</div>
              {Object.keys(e.changes ?? {}).length > 0 && (
                <table style={{ marginTop: 6, fontSize: 13 }}>
                  <tbody>
                    {Object.entries(e.changes).map(([key, change]) => (
                      <tr key={key}>
                        <td style={{ color: "#576781" }}>{fieldText(key)}</td>
                        <td>{valueText(key, change?.from)}</td>
                        <td>→</td>
                        <td>{valueText(key, change?.to)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()}>
          ปิด
        </button>
      </div>
    </dialog>
  );
}
