"use client";

import { useEffect, useState } from "react";
import { ApiError, fetchAuthedBlob } from "@/lib/api";
import { billingApi, WHT_METHOD_LABEL, whtCertificateFilePath, type WhtCertificate, type WhtPendingRow } from "@/lib/billing-api";
import { isoToDisplayDate, timestampToDisplayDate } from "@/lib/date";
import { formatMoney, isoToThaiDate, round2 } from "@/lib/invoice";
import { WhtCertificateDialog } from "@/components/TaxInvoiceDialogs";
import { TaxInvoiceTabs } from "@/components/TaxInvoiceTabs";

// ติดตาม 50 ทวิ (ผู้ใช้ 2026-09-28): ใบกำกับที่ลูกค้าหัก ณ ที่จ่ายแต่เรายังไม่ได้หนังสือรับรอง จัดกลุ่มตามลูกค้า เก่าสุดก่อน
// ค้างเกิน 1 เดือน = แดง · ติ๊กหลายใบแล้วแนบ 50 ทวิ ใบเดียว (ลูกค้าที่ส่งรวม) · คัดลอกข้อความทวงไปวางใน LINE/อีเมล
// ภาษีที่ถูกหักเป็นเงินของบริษัท - ไม่มี 50 ทวิ เอาไปหักภาษีตอนยื่น ภ.ง.ด.50 ไม่ได้
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

type Group = { customerId: string; customerName: string; rows: WhtPendingRow[]; total: number; oldest: number };

function groupsOf(rows: WhtPendingRow[]): Group[] {
  const map = new Map<string, Group>();
  for (const r of rows) {
    const g = map.get(r.customerId) ?? { customerId: r.customerId, customerName: r.customerName, rows: [], total: 0, oldest: 0 };
    g.rows.push(r);
    g.total = round2(g.total + r.whtAmount);
    g.oldest = Math.max(g.oldest, r.daysWaiting);
    map.set(r.customerId, g);
  }
  return [...map.values()].sort((a, b) => b.oldest - a.oldest);
}

function reminderText(g: Group, rows: WhtPendingRow[]): string {
  const lines = rows.map((r) => `- ${r.taxInvoiceNo} ลงวันที่ ${isoToThaiDate(r.issueDate)} ภาษีหัก ณ ที่จ่าย ${formatMoney(r.whtAmount)} บาท`);
  const total = round2(rows.reduce((s, r) => s + r.whtAmount, 0));
  return [
    `เรียน ${g.customerName}`,
    `รบกวนส่งหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) ของรายการต่อไปนี้ให้บริษัท เทรดอินเตอร์ จำกัด ด้วยครับ`,
    ...lines,
    `รวม ${rows.length} รายการ ${formatMoney(total)} บาท`,
    `ขอบคุณครับ`,
  ].join("\n");
}

export function WhtFollowUpPage() {
  const [pending, setPending] = useState<WhtPendingRow[] | null>(null);
  const [overdueDays, setOverdueDays] = useState(30);
  const [certificates, setCertificates] = useState<WhtCertificate[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [attaching, setAttaching] = useState<Group | null>(null);
  const [cancelling, setCancelling] = useState<WhtCertificate | null>(null);
  const [cancelRemark, setCancelRemark] = useState("");

  async function reload() {
    try {
      const [p, c] = await Promise.all([billingApi.whtPending(), billingApi.whtCertificates()]);
      setPending(p.pending);
      setOverdueDays(p.overdueDays);
      setCertificates(c.certificates);
      setSelected((prev) => new Set([...prev].filter((id) => p.pending.some((r) => r.id === id))));
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดรายการไม่สำเร็จ"));
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; state is only set after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();
  }, []);

  const groups = groupsOf(pending ?? []);
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const selectedOf = (g: Group) => g.rows.filter((r) => selected.has(r.id));

  async function copyReminder(g: Group) {
    const rows = selectedOf(g).length ? selectedOf(g) : g.rows;
    try {
      await navigator.clipboard.writeText(reminderText(g, rows));
      await billingApi.whtRemind(rows.map((r) => r.id));
      setNotice(`คัดลอกข้อความทวง ${g.customerName} (${rows.length} รายการ) แล้ว - วางใน LINE หรืออีเมลได้เลย`);
      reload();
    } catch (err) {
      setError(errorText(err, "คัดลอกไม่สำเร็จ"));
    }
  }

  async function openFile(cert: WhtCertificate) {
    try {
      const blob = await fetchAuthedBlob(whtCertificateFilePath(cert.id));
      window.open(URL.createObjectURL(blob), "_blank", "noopener");
    } catch (err) {
      setError(errorText(err, "เปิดไฟล์ไม่สำเร็จ"));
    }
  }

  async function confirmCancel() {
    if (!cancelling) return;
    if (!cancelRemark.trim()) return setError("ใส่เหตุผลที่ยกเลิก");
    try {
      await billingApi.cancelWhtCertificate(cancelling.id, cancelRemark.trim());
      setNotice(`ยกเลิก 50 ทวิ ของ ${cancelling.customerName} แล้ว - ใบกำกับกลับเป็นรอ 50 ทวิ`);
      setCancelling(null);
      setCancelRemark("");
      reload();
    } catch (err) {
      setError(errorText(err, "ยกเลิกไม่สำเร็จ"));
    }
  }

  const totalPending = round2((pending ?? []).reduce((s, r) => s + r.whtAmount, 0));

  return (
    <section className="content">
      <h1 tabIndex={-1}>ใบกำกับภาษี</h1>
      <p>ตามหนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) จากลูกค้า - ภาษีที่ถูกหักใช้หักภาษีตอนยื่น ภ.ง.ด.50 ได้เฉพาะรายการที่มีหลักฐาน</p>
      <TaxInvoiceTabs />
      {notice && (
        <div className="customer-message success" role="status" style={{ margin: "12px 0" }}>
          {notice}
        </div>
      )}
      {error && (
        <div className="customer-message error" role="alert" style={{ margin: "12px 0" }}>
          {error}
        </div>
      )}
      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h2>รอ 50 ทวิ</h2>
          <span className="muted">
            {pending?.length ?? 0} ใบกำกับ · ภาษีที่ถูกหัก {formatMoney(totalPending)} บาท
          </span>
        </div>
        {!pending ? (
          !error && <div className="empty-customers">กำลังโหลด...</div>
        ) : groups.length === 0 ? (
          <div className="empty-customers">ได้ 50 ทวิ ครบทุกใบแล้ว</div>
        ) : (
          <div style={{ padding: "0 16px 16px", display: "grid", gap: 10 }}>
            {groups.map((g) => {
              const late = g.oldest > overdueDays;
              const isOpen = open.has(g.customerId);
              const picked = selectedOf(g);
              return (
                <div key={g.customerId} style={{ border: `1px solid ${late ? "#e8a0a0" : "#e2e6ee"}`, borderRadius: 10, background: late ? "#fff6f6" : undefined }}>
                  <button
                    type="button"
                    onClick={() => setOpen((s) => toggle(s, g.customerId))}
                    style={{ all: "unset", cursor: "pointer", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", width: "100%", padding: "10px 14px", boxSizing: "border-box" }}
                  >
                    <span>
                      {isOpen ? "▾" : "▸"} <b>{g.customerName}</b>
                    </span>
                    <span className="muted">
                      {g.rows.length} ใบ · {formatMoney(g.total)} บาท ·{" "}
                      <span style={{ color: late ? "#b43434" : undefined, fontWeight: late ? 600 : 400 }}>ค้างนานสุด {g.oldest} วัน</span>
                    </span>
                  </button>
                  {isOpen && (
                    <div style={{ padding: "0 14px 12px" }}>
                      <div className="table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>
                                <input
                                  type="checkbox"
                                  aria-label="เลือกทั้งหมด"
                                  checked={picked.length === g.rows.length}
                                  onChange={(e) =>
                                    setSelected((s) => {
                                      const next = new Set(s);
                                      for (const r of g.rows) {
                                        if (e.target.checked) next.add(r.id);
                                        else next.delete(r.id);
                                      }
                                      return next;
                                    })
                                  }
                                />
                              </th>
                              <th>ใบกำกับ</th>
                              <th>วันที่รับเงิน</th>
                              <th style={{ textAlign: "right" }}>ภาษีที่หัก</th>
                              <th>แบบ</th>
                              <th>ค้าง</th>
                              <th>ทวงล่าสุด</th>
                            </tr>
                          </thead>
                          <tbody>
                            {g.rows.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  <input type="checkbox" aria-label={`เลือก ${r.taxInvoiceNo}`} checked={selected.has(r.id)} onChange={() => setSelected((s) => toggle(s, r.id))} />
                                </td>
                                <td>
                                  {r.taxInvoiceNo}
                                  <div className="muted">{r.invoiceNo ? `บิล ${r.invoiceNo}` : "งานนอกระบบ"}</div>
                                </td>
                                <td>{isoToDisplayDate(r.issueDate)}</td>
                                <td style={{ textAlign: "right" }}>{formatMoney(r.whtAmount)}</td>
                                <td>{WHT_METHOD_LABEL[r.whtMethod]}</td>
                                <td style={{ color: r.daysWaiting > overdueDays ? "#b43434" : undefined }}>{r.daysWaiting} วัน</td>
                                <td>{r.remindedAt ? timestampToDisplayDate(r.remindedAt) : <span className="muted">—</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
                        <button type="button" className="primary" disabled={picked.length === 0} onClick={() => setAttaching({ ...g, rows: picked })}>
                          แนบ 50 ทวิ ({picked.length} ใบที่เลือก)
                        </button>
                        <button type="button" onClick={() => copyReminder(g)}>
                          📋 คัดลอกข้อความทวง{picked.length ? ` (${picked.length} ใบ)` : " (ทุกใบ)"}
                        </button>
                      </div>
                      <p className="muted" style={{ fontSize: 12, margin: "6px 0 0" }}>ลูกค้าส่ง 50 ทวิ ใบเดียวรวมหลายรายการ = ติ๊กทุกใบที่ใบนั้นครอบคลุมแล้วแนบครั้งเดียว</p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel" style={{ marginTop: 20 }}>
        <div className="panel-head">
          <h2>50 ทวิ ที่แนบแล้ว</h2>
          <span className="muted">ล่าสุด {certificates.length} รายการ</span>
        </div>
        {certificates.length === 0 ? (
          <div className="empty-customers">ยังไม่มี</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ลูกค้า</th>
                  <th>แบบ / เลขที่</th>
                  <th style={{ textAlign: "right" }}>ยอด</th>
                  <th>ใบกำกับ</th>
                  <th>แนบเมื่อ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {certificates.map((c) => (
                  <tr key={c.id} style={c.cancelledAt ? { color: "#8a94a6" } : undefined}>
                    <td>{c.customerName}</td>
                    <td>
                      {WHT_METHOD_LABEL[c.method]}
                      {c.certificateNo && <div className="muted">{c.certificateNo}</div>}
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {formatMoney(c.amount)}
                      {!c.cancelledAt && c.amount !== c.taxInvoiceWhtTotal && <div style={{ color: "#b43434", fontSize: 12 }}>ใบกำกับรวม {formatMoney(c.taxInvoiceWhtTotal)}</div>}
                    </td>
                    <td>{c.cancelledAt ? <span className="muted">ยกเลิก: {c.cancelReason}</span> : c.taxInvoices.map((t) => t.taxInvoiceNo).join(", ")}</td>
                    <td>{timestampToDisplayDate(c.createdAt)}</td>
                    <td>
                      {c.hasFile && (
                        <button className="text-button" onClick={() => openFile(c)}>
                          ดูไฟล์
                        </button>
                      )}
                      {!c.cancelledAt && (
                        <button className="text-button danger" onClick={() => setCancelling(c)}>
                          ยกเลิก
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {cancelling && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", padding: "12px 23px" }}>
            <span>ยกเลิก 50 ทวิ ของ {cancelling.customerName}:</span>
            <input type="text" placeholder="เหตุผล เช่น แนบผิดใบ" value={cancelRemark} onChange={(e) => setCancelRemark(e.target.value)} style={{ width: 240 }} />
            <button className="text-button danger" onClick={confirmCancel}>
              ยืนยัน
            </button>
            <button className="text-button" onClick={() => setCancelling(null)}>
              ปิด
            </button>
          </div>
        )}
      </section>

      {attaching && (
        <WhtCertificateDialog
          customerName={attaching.customerName}
          taxInvoices={attaching.rows}
          onClose={() => setAttaching(null)}
          onSaved={(text) => {
            setNotice(text);
            setSelected(new Set());
            reload();
          }}
        />
      )}
    </section>
  );
}
