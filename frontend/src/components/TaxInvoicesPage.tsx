"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ApiError } from "@/lib/api";
import { getCachedUser } from "@/lib/auth";
import { billingApi, WHT_METHOD_LABEL, type Invoice, type TaxInvoice, type TaxInvoiceSeries } from "@/lib/billing-api";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatMoney, round2 } from "@/lib/invoice";
import { canPrintOriginal, printTaxInvoice } from "@/lib/tax-invoice-print";
import { buildAccountingPackage, buildSalesTaxExcel } from "@/lib/accounting-bundle";
import { downloadBlob } from "@/lib/pdf-export";
import { TaxInvoiceIssueDialog, TaxInvoiceRemarkDialog } from "@/components/TaxInvoiceDialogs";
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
  // บิลรอรับเงินที่ออกใบกำกับได้ (บัญชีบริษัท + มี VAT) - เลือกจากรายการแล้วออกใบกำกับจากบิลนั้นตรง ๆ (ผู้ใช้ 2026-10-06)
  const [waiting, setWaiting] = useState<Invoice[] | null>(null);
  const [issuing, setIssuing] = useState<Invoice | null>(null);
  const [packing, setPacking] = useState(""); // ข้อความความคืบหน้าตอนสร้างชุดส่งบัญชี (ว่าง = ไม่ได้ทำ)

  async function reload(m = month) {
    try {
      const [list, s, bills] = await Promise.all([billingApi.taxInvoices(m), billingApi.taxInvoiceSeries(), billingApi.listInvoices({ limit: 1 })]);
      setRows(list.taxInvoices);
      setSeries(s);
      setWaiting(bills.invoices.filter((i) => i.status === "ISSUED" && i.account !== "PERSONAL" && i.vatRate > 0));
      setError("");
    } catch (err) {
      setError(errorText(err, "โหลดใบกำกับไม่สำเร็จ"));
    }
  }

  // ?issue=<id> = มาจากหน้าออกใบกำกับกำหนดเอง - เปิดหน้าต่างรับเงิน + ออกใบกำกับของบิลนั้นให้ทันทีที่โหลดรายการเสร็จ
  const [wantedBill, setWantedBill] = useState<string | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน URL หลัง mount (ไม่ใช้ useSearchParams จะได้ไม่ต้องมี Suspense)
    setWantedBill(new URLSearchParams(window.location.search).get("issue"));
  }, []);
  useEffect(() => {
    if (!wantedBill || !waiting) return;
    const bill = waiting.find((b) => b.id === wantedBill);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (bill) setIssuing(bill);
    else setError("ไม่พบบิลรอรับเงินที่เลือก (อาจออกใบกำกับหรือยกเลิกไปแล้ว)");
    setWantedBill(null);
  }, [wantedBill, waiting]);

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

  // Excel รายงานภาษีขาย (ชุดเดียวกับในชุดส่งบัญชี: + ค่าธรรมเนียมทดรองจ่าย ยอดหัก ณ ที่จ่าย แถวรวม และชีท 50 ทวิ)
  async function exportExcel() {
    if (!rows) return;
    const bytes = await buildSalesTaxExcel(rows);
    downloadBlob(new Blob([bytes as BlobPart], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), `รายงานภาษีขาย-${month}.xlsx`);
  }

  // ชุดส่งบัญชีรายเดือน (ผู้ใช้ 2026-10-06): ZIP = Excel + PDF สำเนาทุกใบ + ไฟล์ 50 ทวิ + สรุป - ดาวน์โหลดแล้วแนบอีเมลส่งบัญชีเอง
  async function exportPackage() {
    if (!rows?.length || packing) return;
    setPacking("เริ่มสร้างชุดส่งบัญชี...");
    setError("");
    setNotice("");
    try {
      const pkg = await buildAccountingPackage(month, rows, setPacking);
      downloadBlob(pkg.blob, pkg.fileName);
      const mb = (pkg.sizeBytes / 1024 / 1024).toFixed(1);
      setNotice(
        `สร้างชุดส่งบัญชี ${month} แล้ว: ใบกำกับ ${pkg.taxInvoices} ใบ (ยกเลิก ${pkg.cancelled}) · ไฟล์ 50 ทวิ ${pkg.certificateFiles} ไฟล์ · ขนาด ${mb} MB` +
          (pkg.tooBigForEmail ? " - ไฟล์ใหญ่เกิน 20 MB อีเมลบางเจ้าอาจไม่รับ ให้แบ่งส่ง หรือส่งผ่าน Drive" : " - แนบอีเมลส่งบัญชีได้เลย") +
          (pkg.warnings.length ? ` · มี ${pkg.warnings.length} ข้อควรตรวจ (ดูใน summary.txt): ${pkg.warnings.join(" / ")}` : ""),
      );
    } catch (err) {
      setError(errorText(err, "สร้างชุดส่งบัญชีไม่สำเร็จ - ลองใหม่ หรือใช้ปุ่ม Excel กับพิมพ์สำเนาทีละใบแทน"));
    } finally {
      setPacking("");
    }
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
      {packing && (
        <div className="customer-message" role="status" style={{ margin: "12px 0" }}>
          {packing}
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

      {series?.enabled && waiting && waiting.length > 0 && (
        <section className="panel" style={{ marginTop: 12 }}>
          <div className="panel-head">
            <h2>บิลรอรับเงิน - ออกใบกำกับได้</h2>
            <span className="muted">
              {waiting.length} ใบ · {formatMoney(round2(waiting.reduce((s, i) => s + i.netTotal, 0)))} บาท
            </span>
          </div>
          <div style={{ display: "grid" }}>
            {waiting.map((i) => (
              <div key={i.id} style={{ padding: "10px 23px", borderTop: "1px solid #f0f2f6", display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <span>
                  <b>{i.invoiceNo}</b> · {isoToDisplayDate(i.issueDate)} · {i.customer.name}
                  <span className="muted" style={{ display: "block", fontSize: 13 }}>
                    {i.lines.length ? `${i.lines.length} คัน` : "บิลกำหนดเอง"} · ยอดสุทธิ {formatMoney(i.netTotal)} บาท{i.dueDate ? ` · ครบกำหนด ${isoToDisplayDate(i.dueDate)}` : ""}
                  </span>
                </span>
                <button type="button" className="primary" onClick={() => { setNotice(""); setIssuing(i); }}>
                  รับเงิน + ออกใบกำกับ
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head" style={{ flexWrap: "wrap", gap: 8 }}>
          <h2>ใบกำกับภาษี</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="เดือน" />
            <button type="button" onClick={exportExcel} disabled={!rows?.length || !!packing}>
              ⬇ Excel รายงานภาษีขาย
            </button>
            <button type="button" className="primary" onClick={exportPackage} disabled={!rows?.length || !!packing}>
              {packing ? "กำลังสร้าง..." : "📦 ชุดส่งบัญชี (ZIP)"}
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

      {issuing && (
        <TaxInvoiceIssueDialog
          invoice={issuing}
          onClose={() => setIssuing(null)}
          onIssued={(_tv, text) => {
            setNotice(text);
            reload();
          }}
          onRefused={() => reload()}
        />
      )}

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
