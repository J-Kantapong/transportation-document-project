"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { getCachedUser } from "@/lib/auth";
import { billingApi, WHT_METHOD_LABEL, type TaxInvoice, type TaxInvoiceSeries } from "@/lib/billing-api";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatMoney, round2 } from "@/lib/invoice";
import { canPrintOriginal, printTaxInvoice } from "@/lib/tax-invoice-print";
import { TaxInvoiceRemarkDialog } from "@/components/TaxInvoiceDialogs";
import { TaxInvoiceTabs } from "@/components/TaxInvoiceTabs";

// หน้า "ใบกำกับภาษี" (ผู้ใช้ 2026-09-28): รายการใบกำกับรายเดือน (รวมใบที่ยกเลิก) + Excel รายงานภาษีขาย + พิมพ์/ใบแทน/ยกเลิก
// ADMIN ตั้งเลขล่าสุดจาก Google Sheet = เปิดใช้ใบกำกับในระบบ (ตั้งได้ก่อนออกใบแรกของปีนั้น)
const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export function TaxInvoicesPage() {
  const [month, setMonth] = useState(todayIso().slice(0, 7));
  const [rows, setRows] = useState<TaxInvoice[] | null>(null);
  const [series, setSeries] = useState<TaxInvoiceSeries | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [remark, setRemark] = useState<{ kind: "cancel" | "replacement"; tv: TaxInvoice } | null>(null);

  async function reload(m = month) {
    try {
      const [list, s] = await Promise.all([billingApi.taxInvoices(m), billingApi.taxInvoiceSeries()]);
      setRows(list.taxInvoices);
      setSeries(s);
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดใบกำกับไม่สำเร็จ"));
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setIsAdmin((getCachedUser()?.roles ?? []).includes("ADMIN"));
  }, []);

  useEffect(() => {
    // Standard fetch-on-mount / on month change; state is only set after the await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const active = (rows ?? []).filter((r) => r.status === "ISSUED");
  const sum = (f: (r: TaxInvoice) => number) => round2(active.reduce((s, r) => s + f(r), 0));

  async function exportExcel() {
    if (!rows) return;
    const XLSX = await import("xlsx");
    // รายงานภาษีขาย: มูลค่า = ค่าบริการ + ค่าสินค้า (ฐาน VAT) ไม่รวมค่าธรรมเนียมทดรองจ่าย · ใบที่ยกเลิกแสดงยอด 0
    const data = rows.map((r, i) => {
      const cancelled = r.status === "CANCELLED";
      return {
        ลำดับ: i + 1,
        "วัน เดือน ปี": isoToDisplayDate(r.issueDate),
        เลขที่: r.taxInvoiceNo,
        "ชื่อผู้ซื้อสินค้า/ผู้รับบริการ": r.customer.name,
        เลขประจำตัวผู้เสียภาษี: r.customer.taxId ?? "",
        สถานประกอบการ: r.customer.taxId ? r.customer.branch || "สำนักงานใหญ่" : "",
        "มูลค่าสินค้าหรือบริการ": cancelled ? 0 : round2(r.serviceTotal + r.goodsTotal),
        ภาษีมูลค่าเพิ่ม: cancelled ? 0 : r.vatAmount,
        หมายเหตุ: cancelled ? `ยกเลิก - ${r.cancelReason ?? ""}` : r.replacesNo ? `ออกแทน ${r.replacesNo}` : "",
      };
    });
    const sheet = XLSX.utils.json_to_sheet(data);
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, sheet, "ภาษีขาย");
    XLSX.writeFile(book, `รายงานภาษีขาย-${month}.xlsx`);
  }

  return (
    <section className="content">
      <h1 tabIndex={-1}>ใบกำกับภาษี</h1>
      <p>ใบกำกับภาษี/ใบเสร็จรับเงินที่ออกตอนรับเงิน (บัญชีบริษัท) รายเดือน รวมใบที่ยกเลิก - พิมพ์ซ้ำ ออกใบแทน ยกเลิก และโหลดรายงานภาษีขาย</p>
      <TaxInvoiceTabs />
      <Link href="/accounting/tax-invoices/new" className="text-button" style={{ marginTop: 8, display: "inline-block" }}>
        + ออกใบกำกับกำหนดเอง (งานนอกระบบ ไม่มีใบวางบิล)
      </Link>
      {series && !series.enabled && (
        <div className="customer-message error" role="alert" style={{ margin: "12px 0" }}>
          ยังไม่ได้เปิดใช้ใบกำกับในระบบ - ตอนนี้บิลยังบันทึกรับเงินแบบเดิม (พิมพ์เลข TV จาก Google Sheet) {isAdmin ? "ตั้งเลขล่าสุดด้านล่างเพื่อเริ่มใช้" : "ให้ ADMIN ตั้งเลขเริ่ม"}
        </div>
      )}
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
        <div className="panel-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>ใบกำกับภาษี</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="เดือน" />
            <button type="button" onClick={exportExcel} disabled={!rows?.length}>
              ⬇ Excel รายงานภาษีขาย
            </button>
          </div>
        </div>
        {rows && rows.length > 0 && (
          <p className="muted" style={{ padding: "0 23px" }}>
            ใช้อยู่ {active.length} ใบ · มูลค่า {formatMoney(sum((r) => r.serviceTotal + r.goodsTotal))} · VAT {formatMoney(sum((r) => r.vatAmount))} · ยกเลิก{" "}
            {rows.length - active.length} ใบ
          </p>
        )}
        {!rows ? (
          !error && <div className="empty-customers">กำลังโหลด...</div>
        ) : rows.length === 0 ? (
          <div className="empty-customers">ไม่มีใบกำกับในเดือนนี้</div>
        ) : (
          // รายการแบบแถวสั้นไม่มีตารางกว้าง (ผู้ใช้ไม่ชอบเลื่อนข้าง) - แถวละ 3 บรรทัด: เลข/วันที่/ลูกค้า, ยอด, ปุ่ม
          <div style={{ display: "grid" }}>
            {rows.map((r) => {
              const cancelled = r.status === "CANCELLED";
              return (
                <div key={r.id} style={{ padding: "10px 23px", borderTop: "1px solid #f0f2f6", color: cancelled ? "#8a94a6" : undefined }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
                    <span>
                      <b>{r.taxInvoiceNo}</b> · {isoToDisplayDate(r.issueDate)} · {r.customer.name}
                    </span>
                    {cancelled ? <span className="badge">ยกเลิก</span> : <span className="badge done">ปกติ</span>}
                  </div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {r.invoiceNo ? `บิล ${r.invoiceNo}` : "งานนอกระบบ"} · มูลค่า {formatMoney(r.serviceTotal + r.goodsTotal)} · VAT {formatMoney(r.vatAmount)} · รวม {formatMoney(r.grandTotal)}
                    {r.whtAmount > 0 && <> · หัก ณ ที่จ่าย {formatMoney(r.whtAmount)} </>}
                    {r.whtAmount > 0 &&
                      (r.whtCertificate ? (
                        <span className="badge done">{WHT_METHOD_LABEL[r.whtCertificate.method]} ✓</span>
                      ) : cancelled ? null : (
                        <span className="badge warn">รอ 50 ทวิ</span>
                      ))}
                  </div>
                  {(r.replacesNo || cancelled || r.replacementIssuedAt) && (
                    <div className="muted" style={{ fontSize: 13 }}>
                      {r.replacesNo && <>ออกแทน {r.replacesNo} </>}
                      {cancelled && <>ยกเลิก: {r.cancelReason}{r.replacedByNo ? ` · ออกใหม่ ${r.replacedByNo}` : ""} </>}
                      {r.replacementIssuedAt && <>ออกใบแทน {isoToDisplayDate(r.replacementIssuedAt.slice(0, 10))}</>}
                    </div>
                  )}
                  <div>
                    <button className="text-button" onClick={() => printTaxInvoice(r, canPrintOriginal(r, todayIso()) ? "original" : "copy")}>
                      {canPrintOriginal(r, todayIso()) ? "พิมพ์" : "พิมพ์สำเนา"}
                    </button>
                    {!cancelled && (
                      <>
                        <button className="text-button" onClick={() => setRemark({ kind: "replacement", tv: r })}>
                          ออกใบแทน
                        </button>
                        <button className="text-button danger" onClick={() => setRemark({ kind: "cancel", tv: r })}>
                          ยกเลิก
                        </button>
                      </>
                    )}
                    {cancelled && !r.invoiceId && !r.replacedByNo && (
                      <Link className="text-button" href={`/accounting/tax-invoices/new?replaces=${encodeURIComponent(r.id)}`}>
                        ออกใหม่แทน
                      </Link>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {isAdmin && series && <SeriesPanel series={series} onSaved={(s) => setSeries(s)} />}

      {remark && (
        <TaxInvoiceRemarkDialog
          kind={remark.kind}
          taxInvoice={remark.tv}
          onClose={() => setRemark(null)}
          onDone={(_tv, text) => {
            setNotice(text);
            reload();
          }}
        />
      )}
    </section>
  );
}

// ADMIN: ตั้งเลขล่าสุดที่ใช้ไปแล้วใน Google Sheet ให้ระบบออกเลขถัดไปต่อ (ปีที่ออกใบในระบบแล้วแก้ไม่ได้)
function SeriesPanel({ series, onSaved }: { series: TaxInvoiceSeries; onSaved: (s: TaxInvoiceSeries) => void }) {
  const [year, setYear] = useState(String(Number(todayIso().slice(0, 4))));
  const [lastNumber, setLastNumber] = useState("");
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const y = Number(year);
  const n = Number(lastNumber);
  const valid = Number.isInteger(y) && y >= 2020 && lastNumber.trim() !== "" && Number.isInteger(n) && n >= 0;
  const locked = series.series.find((s) => s.year === y && s.issuedInSystem > 0);

  async function save() {
    setError("");
    if (!valid) return setError("ใส่ปี ค.ศ. และเลขล่าสุดเป็นตัวเลข (ยังไม่เคยออก = 0)");
    if (!remark.trim()) return setError("ใส่ที่มาของเลข เช่น เลขล่าสุดใน Google Sheet");
    setSaving(true);
    try {
      onSaved(await billingApi.setTaxInvoiceSeries({ year: y, lastNumber: n, remark: remark.trim() }));
      setLastNumber("");
      setRemark("");
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel" style={{ marginTop: 20 }}>
      <div className="panel-head">
        <h2>เลขใบกำกับ (ADMIN)</h2>
        <span className="muted">{series.enabled ? "เปิดใช้ในระบบแล้ว" : "ยังไม่เปิดใช้"}</span>
      </div>
      <div style={{ padding: "0 23px 16px" }}>
        {series.series.length > 0 && (
          <ul style={{ margin: "0 0 12px", paddingLeft: 18 }}>
            {series.series.map((s) => (
              <li key={s.year}>
                ปี {s.year}: เลขล่าสุด {s.lastNumber} · ใบถัดไป <b>{s.nextNo}</b> · ออกในระบบแล้ว {s.issuedInSystem} ใบ
              </li>
            ))}
          </ul>
        )}
        <p className="muted" style={{ fontSize: 13 }}>
          ใส่เลขล่าสุดที่ออกไปแล้วใน Google Sheet (เช่น TV2026-157 → ใส่ 157) ระบบจะออก TV{year}-{String((valid ? n : 0) + 1).padStart(3, "0")} เป็นใบแรก ·
          หลังเริ่มออกในระบบ ห้ามออก TV จาก Google Sheet อีก (เลขจะชน) · ปีที่ออกใบในระบบแล้วแก้เลขไม่ได้
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }}>
          <label className="field">
            ปี ค.ศ.
            <input type="text" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} style={{ width: 80 }} />
          </label>
          <label className="field">
            เลขล่าสุดที่ใช้ไปแล้ว
            <input type="text" inputMode="numeric" value={lastNumber} onChange={(e) => setLastNumber(e.target.value.replace(/\D/g, "").slice(0, 5))} style={{ width: 110 }} />
          </label>
          <label className="field" style={{ flex: "1 1 220px" }}>
            ที่มา / เหตุผล *
            <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น เลขล่าสุดใน Google Sheet ณ 30/09/2026" />
          </label>
          <button type="button" className="primary" onClick={save} disabled={saving || !!locked}>
            {saving ? "กำลังบันทึก..." : "บันทึก"}
          </button>
        </div>
        {locked && <p className="muted" style={{ fontSize: 12 }}>ปี {y} ออกใบในระบบแล้ว แก้เลขไม่ได้</p>}
        {error && (
          <p className="customer-message error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
