"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, type Invoice, type TaxInvoice, type TaxInvoicePreview, type WhtMethod } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";
import { formatMoney, round2 } from "@/lib/invoice";
import { buildTaxInvoiceHtml, draftTaxInvoice, printTaxInvoice } from "@/lib/tax-invoice-print";

// หน้าต่างของใบกำกับภาษี (ผู้ใช้ 2026-09-28): รับเงิน + ออกใบกำกับ, ยกเลิก / ใบแทน (เหตุผลบังคับ), แนบ 50 ทวิ

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
const digits = (text: string) => text.replace(/\D/g, "").slice(0, 8);

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

function Row({ label, value, strong, muted }: { label: string; value: string; strong?: boolean; muted?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "3px 0", fontWeight: strong ? 600 : 400, color: muted ? "#6b7588" : undefined }}>
      <span>{label}</span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}

// ---------- รับเงิน + ออกใบกำกับ ----------
// ยอดทุกช่องมาจากบิล (แก้ที่บิลก่อน) กรอกแค่วันที่รับเงิน + ยอดหัก ณ ที่จ่ายจริง (ค่าเริ่มต้น = ตามบิล, e-WHT อาจเป็น 1%)
// แนบ 50 ทวิ พร้อมกันได้ถ้าได้มาแล้ว (ไม่บังคับ) - ใบรวมหลายใบกำกับแนบทีหลังที่หน้าติดตาม 50 ทวิ
export function TaxInvoiceIssueDialog({
  invoice,
  onClose,
  onIssued,
  onRefused,
}: {
  invoice: Invoice;
  onClose: () => void;
  onIssued: (tv: TaxInvoice, notice: string) => void;
  onRefused: () => void;
}) {
  const dialogRef = useModal();
  const [preview, setPreview] = useState<TaxInvoicePreview | null>(null);
  const [loadError, setLoadError] = useState("");
  const [paidDateText, setPaidDateText] = useState(isoToDisplayDate(todayIso()));
  const [whtText, setWhtText] = useState(invoice.whtAmount > 0 ? String(invoice.whtAmount) : "0");
  const [whtMethod, setWhtMethod] = useState<WhtMethod>("PAPER");
  const [notRegistered, setNotRegistered] = useState(false);
  const [certNo, setCertNo] = useState("");
  const [certFile, setCertFile] = useState<File | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    billingApi
      .taxInvoicePreview(invoice.id)
      .then((p) => {
        setPreview(p);
        // ประเภท 50 ทวิ ตั้งต้นตามที่ตั้งไว้ที่ลูกค้า (แก้ในหน้าต่างได้)
        setWhtMethod(p.defaultWhtMethod === "EWHT" ? "EWHT" : "PAPER");
      })
      .catch((err) => setLoadError(errorText(err, "โหลดข้อมูลไม่สำเร็จ")));
  }, [invoice.id]);

  const wht = parseMoney(whtText);
  const grandTotal = round2(invoice.feeTotal + invoice.serviceTotal + invoice.goodsTotal + invoice.vatAmount);
  const received = wht === null ? null : round2(grandTotal - wht);
  const missing = preview ? (notRegistered ? preview.missingIfNotRegistered : preview.missing) : [];
  const onlyTaxIdMissing = !!preview && preview.missing.length > 0 && preview.missingIfNotRegistered.length === 0;
  const whtDiffers = wht !== null && wht !== invoice.whtAmount;

  // ตัวอย่างหน้าใบตามที่กรอกอยู่ตอนนี้ (วันที่ / ยอดหัก) - ยังไม่ออกเลขจริง
  const draftDate = displayDateToIso(digits(paidDateText)) || todayIso();
  const previewHtml =
    showPreview && preview
      ? buildTaxInvoiceHtml(draftTaxInvoice(invoice, preview, { paidDate: draftDate, whtAmount: wht ?? 0, whtMethod: wht ? whtMethod : "NONE", buyerNotVatRegistered: notRegistered }), "preview")
      : null;

  async function handleConfirm() {
    setError("");
    const paidDate = displayDateToIso(digits(paidDateText));
    if (!paidDate) return setError("วันที่รับเงินไม่ถูกต้อง");
    if (paidDate < invoice.issueDate) return setError(`วันที่รับเงินต้องไม่ก่อนวันที่ออกบิล (${isoToDisplayDate(invoice.issueDate)})`);
    if (paidDate > todayIso()) return setError("วันที่รับเงินต้องไม่เกินวันนี้");
    if (wht === null) return setError("ยอดหัก ณ ที่จ่ายไม่ถูกต้อง");
    setSaving(true);
    try {
      const { taxInvoice } = await billingApi.issueTaxInvoice(invoice.id, {
        paidDate,
        whtAmount: wht,
        whtMethod: wht > 0 ? whtMethod : "NONE",
        buyerNotVatRegistered: notRegistered,
        expectedUpdatedAt: invoice.updatedAt,
      });
      let notice = `ออกใบกำกับ ${taxInvoice.taxInvoiceNo} แล้ว`;
      // แนบ 50 ทวิ ต่อทันทีถ้าได้มาแล้ว - ไม่สำเร็จก็ไม่กระทบใบกำกับ (แนบใหม่ที่หน้าติดตามได้)
      const attachNow = wht > 0 && (whtMethod === "PAPER" ? !!certFile : certNo.trim() !== "");
      if (attachNow) {
        try {
          await billingApi.createWhtCertificate({
            method: whtMethod === "EWHT" ? "EWHT" : "PAPER",
            certificateNo: certNo.trim(),
            certificateDate: "",
            amount: wht,
            note: "",
            taxInvoiceIds: [taxInvoice.id],
            file: certFile,
          });
          notice += " · แนบ 50 ทวิ แล้ว";
        } catch (err) {
          notice += ` · แนบ 50 ทวิ ไม่สำเร็จ (${errorText(err, "ลองใหม่ที่หน้าติดตาม 50 ทวิ")})`;
        }
      } else if (wht > 0) {
        notice += " · รอ 50 ทวิ";
      }
      const fresh = attachNow ? (await billingApi.taxInvoice(taxInvoice.id)).taxInvoice : taxInvoice;
      printTaxInvoice(fresh, "original");
      onIssued(fresh, notice);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "ออกใบกำกับไม่สำเร็จ"));
      if (err instanceof ApiError && err.status === 409) onRefused();
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: showPreview ? "min(880px, 96vw)" : "min(560px, 94vw)", maxHeight: "92vh", overflowY: "auto" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>รับเงิน + ออกใบกำกับภาษี</h2>
      <p className="muted">
        บิล {invoice.invoiceNo} · ออกวันที่ {isoToDisplayDate(invoice.issueDate)}
      </p>
      {loadError && (
        <p className="customer-message error" role="alert">
          {loadError}
        </p>
      )}
      {!preview ? (
        !loadError && <p className="muted">กำลังโหลด...</p>
      ) : !preview.enabled ? (
        <p className="customer-message error" role="alert">
          ยังไม่ได้เปิดใช้ใบกำกับในระบบ - ADMIN ต้องตั้งเลขเริ่มที่หน้า &quot;ใบกำกับภาษี&quot; ก่อน
        </p>
      ) : (
        <>
          <div className="field-grid" style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: "8px 12px", alignItems: "center", margin: "12px 0" }}>
            <span>เลขที่ใบกำกับ</span>
            <span>
              <b>{preview.nextNo}</b> <span className="muted">(ระบบให้เลขถัดไป)</span>
            </span>
            <span>วันที่รับเงิน *</span>
            <DateInput
              value={paidDateText}
              onChange={(value) => setPaidDateText(formatDateDigitsCe(digits(value)))}
              style={{ width: 140 }}
              aria-label="วันที่รับเงิน"
            />
            <span>ลูกค้า</span>
            <span>
              {preview.buyer.name}
              <br />
              <span className="muted" style={{ fontSize: 13 }}>
                {preview.buyer.taxId ? `เลขผู้เสียภาษี ${preview.buyer.taxId} · สาขา ${preview.buyer.branch || "สำนักงานใหญ่"}` : "ไม่มีเลขผู้เสียภาษี"}
              </span>
              {/* ยังไม่บังคับ - เตรียมไว้ส่งใบกำกับอิเล็กทรอนิกส์ปี 2027 (ผู้ใช้ 2026-10-06) */}
              {!preview.buyer.email && (
                <>
                  <br />
                  <span style={{ fontSize: 12, color: "#b45309" }}>ลูกค้ายังไม่มีอีเมลในฐานข้อมูล - เก็บไว้ใช้ส่งใบกำกับอิเล็กทรอนิกส์ปีหน้า</span>
                </>
              )}
            </span>
          </div>
          {preview.lastIssued && (
            <p className="muted" style={{ fontSize: 12 }}>
              ใบล่าสุด {preview.lastIssued.taxInvoiceNo} วันที่ {isoToDisplayDate(preview.lastIssued.issueDate)} - วันที่ใบนี้ต้องไม่ก่อนหน้านั้น
            </p>
          )}
          {preview.replaces && (
            <p className="customer-message" style={{ fontSize: 13 }}>
              ใบนี้จะออกแทน {preview.replaces.taxInvoiceNo} ที่ยกเลิกไป{preview.replaces.cancelReason ? ` (${preview.replaces.cancelReason})` : ""}
              {preview.replaces.whtCertificateId ? " · 50 ทวิ ที่แนบไว้ย้ายมาใบนี้" : ""}
            </p>
          )}
          {missing.length > 0 && (
            <div className="customer-message error" role="alert" style={{ margin: "8px 0" }}>
              ออกใบกำกับไม่ได้: ข้อมูลลูกค้ายังขาด {missing.join(", ")} - แก้ที่หน้าฐานข้อมูลลูกค้าก่อน (ADMIN)
            </div>
          )}
          {onlyTaxIdMissing && (
            <label style={{ display: "flex", gap: 8, fontSize: 13, margin: "6px 0" }}>
              <input type="checkbox" checked={notRegistered} onChange={(e) => setNotRegistered(e.target.checked)} />
              ลูกค้าไม่ได้จดทะเบียน VAT (ไม่ต้องมีเลขผู้เสียภาษีบนใบกำกับ)
            </label>
          )}

          <div style={{ borderTop: "1px solid #e2e6ee", marginTop: 10, paddingTop: 8 }}>
            {invoice.feeTotal > 0 && <Row label="ค่าธรรมเนียมกรมฯ (ทดรองจ่าย ไม่มี VAT)" value={formatMoney(invoice.feeTotal)} />}
            <Row label="ค่าบริการ" value={formatMoney(invoice.serviceTotal)} />
            {invoice.goodsTotal > 0 && <Row label="ค่าสินค้า" value={formatMoney(invoice.goodsTotal)} />}
            <Row label={`VAT ${invoice.vatRate}%`} value={formatMoney(invoice.vatAmount)} />
            <div style={{ borderTop: "1px solid #e2e6ee", marginTop: 4 }}>
              <Row label="รวมเงินตามใบกำกับ" value={formatMoney(grandTotal)} strong />
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, padding: "4px 0" }}>
              <span>
                ลูกค้าหัก ณ ที่จ่ายจริง
                {invoice.whtAmount > 0 && <span className="muted" style={{ fontSize: 12 }}> (ตามบิล {formatMoney(invoice.whtAmount)})</span>}
              </span>
              <input type="text" inputMode="decimal" value={whtText} onChange={(e) => setWhtText(e.target.value)} style={{ width: 110, textAlign: "right" }} aria-label="ยอดหัก ณ ที่จ่ายจริง" />
            </div>
            {whtDiffers && <p className="muted" style={{ fontSize: 12, margin: 0 }}>ยอดหักไม่เท่าบิล - ใช้เมื่อลูกค้าหักอัตราอื่นจริง (เช่น e-WHT 1%)</p>}
            <Row label="เงินที่ต้องเข้าบัญชี" value={received === null ? "—" : formatMoney(received)} strong />
          </div>

          {wht !== null && wht > 0 && (
            <fieldset style={{ border: "1px solid #e2e6ee", borderRadius: 8, padding: "8px 12px", marginTop: 10 }}>
              <legend style={{ fontSize: 13 }}>หลักฐานหัก ณ ที่จ่าย</legend>
              <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
                <label style={{ display: "flex", gap: 6 }}>
                  <input type="radio" checked={whtMethod === "PAPER"} onChange={() => setWhtMethod("PAPER")} />
                  50 ทวิ กระดาษ
                </label>
                <label style={{ display: "flex", gap: 6 }}>
                  <input type="radio" checked={whtMethod === "EWHT"} onChange={() => setWhtMethod("EWHT")} />
                  e-WHT (หักผ่านธนาคาร)
                </label>
              </div>
              {whtMethod === "PAPER" ? (
                <label className="field" style={{ marginTop: 8, fontSize: 13 }}>
                  แนบรูป/PDF ของ 50 ทวิ (ถ้าได้มาแล้ว - ยังไม่ได้ก็เว้นไว้ แนบทีหลังได้)
                  <input type="file" accept="image/*,application/pdf" onChange={(e) => setCertFile(e.target.files?.[0] ?? null)} />
                </label>
              ) : (
                <label className="field" style={{ marginTop: 8, fontSize: 13 }}>
                  เลขอ้างอิง e-WHT (ถ้ามีแล้ว)
                  <input type="text" value={certNo} onChange={(e) => setCertNo(e.target.value)} />
                </label>
              )}
            </fieldset>
          )}

          <button type="button" className="text-button" onClick={() => setShowPreview((v) => !v)}>
            {showPreview ? "ซ่อนตัวอย่างใบกำกับ" : "ดูตัวอย่างใบกำกับ"}
          </button>
          {previewHtml && <iframe title="ตัวอย่างใบกำกับภาษี" srcDoc={previewHtml} style={{ width: "100%", height: 520, border: "1px solid #e2e6ee", background: "white", marginTop: 6 }} />}
          <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
            วันที่ใบกำกับ = วันที่รับเงิน · ออกแล้วแก้ไม่ได้ ถ้าผิดต้องยกเลิกแล้วออกใบใหม่ · กดยืนยันแล้วจะเปิดหน้าพิมพ์ต้นฉบับ + สำเนาให้ทันที
          </p>
        </>
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving || !preview?.enabled || missing.length > 0}>
          {saving ? "กำลังออกใบ..." : `ยืนยัน · ออก ${preview?.nextNo ?? ""}`}
        </button>
      </div>
    </dialog>
  );
}

// ---------- ยกเลิกใบกำกับ / ออกใบแทน (เหตุผลบังคับ) ----------
export function TaxInvoiceRemarkDialog({
  kind,
  taxInvoice,
  onClose,
  onDone,
}: {
  kind: "cancel" | "replacement";
  taxInvoice: { id: string; taxInvoiceNo: string; invoiceNo?: string | null };
  onClose: () => void;
  onDone: (tv: TaxInvoice, notice: string) => void;
}) {
  const dialogRef = useModal();
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleConfirm() {
    setError("");
    if (!remark.trim()) return setError("ต้องใส่เหตุผล");
    setSaving(true);
    try {
      if (kind === "cancel") {
        const { taxInvoice: tv } = await billingApi.cancelTaxInvoice(taxInvoice.id, remark.trim());
        onDone(
          tv,
          tv.invoiceNo
            ? `ยกเลิก ${tv.taxInvoiceNo} แล้ว - บิล ${tv.invoiceNo} กลับเป็นรอรับเงิน แก้บิลแล้วกด "รับเงิน + ออกใบกำกับ" เพื่อออกใบใหม่`
            : `ยกเลิก ${tv.taxInvoiceNo} แล้ว - ถ้าต้องออกใหม่ กด "ออกใหม่แทน" ที่รายการนี้`,
        );
      } else {
        const { taxInvoice: tv } = await billingApi.replacementTaxInvoice(taxInvoice.id, remark.trim());
        printTaxInvoice(tv, "replacement");
        onDone(tv, `ออกใบแทน ${tv.taxInvoiceNo} แล้ว`);
      }
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>{kind === "cancel" ? `ยกเลิกใบกำกับ ${taxInvoice.taxInvoiceNo}` : `ออกใบแทน ${taxInvoice.taxInvoiceNo}`}</h2>
      {kind === "cancel" ? (
        <p className="customer-message" style={{ fontSize: 13 }}>
          {taxInvoice.taxInvoiceNo} จะเป็น &quot;ยกเลิก&quot; ถาวร (ยังอยู่ในรายงานภาษีขาย เลขนี้ไม่ใช้ซ้ำ) {taxInvoice.invoiceNo ? ` และบิล ${taxInvoice.invoiceNo} กลับเป็นรอรับเงิน` : " (ใบกำกับกำหนดเองไม่มีบิลให้ย้อนสถานะ)"}
          <br />
          ถ้าลูกค้าได้ต้นฉบับไปแล้ว ให้ขอคืนมาเก็บคู่กับสำเนา
        </p>
      ) : (
        <p className="muted" style={{ fontSize: 13 }}>
          ใช้เมื่อลูกค้าทำต้นฉบับหาย - พิมพ์เลขเดิม เขียนว่า &quot;ใบแทน&quot; พร้อมวันที่และเหตุผล (ไม่ใช่ใบใหม่)
        </p>
      )}
      <label className="field" style={{ marginTop: 10 }}>
        เหตุผล *
        <input
          type="text"
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          placeholder={kind === "cancel" ? "เช่น ชื่อลูกค้าผิด ต้องออกใหม่" : "เช่น ลูกค้าทำต้นฉบับหาย"}
        />
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
        <button type="button" className={kind === "cancel" ? "primary danger" : "primary"} onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : kind === "cancel" ? "ยกเลิกใบกำกับ" : "ออกใบแทน + พิมพ์"}
        </button>
      </div>
    </dialog>
  );
}

// ---------- แนบ 50 ทวิ (ใบเดียวครอบคลุมได้หลายใบกำกับของลูกค้าเดียวกัน) ----------
export function WhtCertificateDialog({
  customerName,
  taxInvoices,
  onClose,
  onSaved,
}: {
  customerName: string;
  taxInvoices: Array<{ id: string; taxInvoiceNo: string; whtAmount: number; whtMethod: WhtMethod }>;
  onClose: () => void;
  onSaved: (notice: string) => void;
}) {
  const dialogRef = useModal();
  const expected = round2(taxInvoices.reduce((s, t) => s + t.whtAmount, 0));
  const [method, setMethod] = useState<"PAPER" | "EWHT">(taxInvoices.every((t) => t.whtMethod === "EWHT") ? "EWHT" : "PAPER");
  const [certNo, setCertNo] = useState("");
  const [dateText, setDateText] = useState("");
  const [amountText, setAmountText] = useState(String(expected));
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmMismatch, setConfirmMismatch] = useState(false);

  const amount = parseMoney(amountText);
  const mismatch = amount !== null && amount !== expected;

  async function handleSave() {
    setError("");
    if (amount === null || amount <= 0) return setError("ยอดภาษีตามหนังสือรับรองไม่ถูกต้อง");
    if (method === "PAPER" && !file) return setError("50 ทวิ กระดาษต้องแนบรูปหรือ PDF");
    if (method === "EWHT" && !certNo.trim()) return setError("e-WHT ต้องใส่เลขอ้างอิง");
    let certificateDate = "";
    if (dateText.trim()) {
      const d = displayDateToIso(digits(dateText));
      if (!d) return setError("วันที่ในหนังสือรับรองไม่ถูกต้อง");
      certificateDate = d;
    }
    if (mismatch && !confirmMismatch) return setError("ยอดไม่ตรงกับยอดหักของใบกำกับที่เลือก - ติ๊กยืนยันถ้าถูกต้องแล้ว");
    setSaving(true);
    try {
      await billingApi.createWhtCertificate({ method, certificateNo: certNo.trim(), certificateDate, amount, note: note.trim(), taxInvoiceIds: taxInvoices.map((t) => t.id), file });
      onSaved(`แนบ 50 ทวิ ให้ ${taxInvoices.map((t) => t.taxInvoiceNo).join(", ")} แล้ว`);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "แนบไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(560px, 94vw)", maxHeight: "92vh", overflowY: "auto" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แนบ 50 ทวิ</h2>
      <p className="muted">
        {customerName} · {taxInvoices.length} ใบกำกับ · ยอดหักรวม {formatMoney(expected)} บาท
      </p>
      <p style={{ fontSize: 13 }}>{taxInvoices.map((t) => `${t.taxInvoiceNo} (${formatMoney(t.whtAmount)})`).join(", ")}</p>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", margin: "8px 0" }}>
        <label style={{ display: "flex", gap: 6 }}>
          <input type="radio" checked={method === "PAPER"} onChange={() => setMethod("PAPER")} />
          50 ทวิ กระดาษ
        </label>
        <label style={{ display: "flex", gap: 6 }}>
          <input type="radio" checked={method === "EWHT"} onChange={() => setMethod("EWHT")} />
          e-WHT
        </label>
      </div>
      <label className="field">
        {method === "PAPER" ? "ไฟล์รูป/PDF *" : "ไฟล์จากเว็บกรมสรรพากร (ไม่บังคับ)"}
        <input type="file" accept="image/*,application/pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </label>
      <label className="field">
        {method === "PAPER" ? "เลขที่หนังสือรับรอง (ถ้ามี)" : "เลขอ้างอิง e-WHT *"}
        <input type="text" value={certNo} onChange={(e) => setCertNo(e.target.value)} />
      </label>
      <label className="field">
        วันที่ในหนังสือรับรอง (ถ้ามี)
        <DateInput value={dateText} onChange={(v) => setDateText(formatDateDigitsCe(digits(v)))} style={{ width: 140 }} aria-label="วันที่ในหนังสือรับรอง" />
      </label>
      <label className="field">
        ยอดภาษีที่หักตามหนังสือรับรอง *
        <input type="text" inputMode="decimal" value={amountText} onChange={(e) => setAmountText(e.target.value)} style={{ width: 140 }} />
      </label>
      {mismatch && (
        <label className="customer-message error" style={{ display: "flex", gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={confirmMismatch} onChange={(e) => setConfirmMismatch(e.target.checked)} />
          ยอด {formatMoney(amount!)} ไม่ตรงกับยอดหักรวม {formatMoney(expected)} ของใบกำกับที่เลือก - ยืนยันว่าถูกต้อง
        </label>
      )}
      <label className="field">
        หมายเหตุ
        <input type="text" value={note} onChange={(e) => setNote(e.target.value)} />
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
          {saving ? "กำลังบันทึก..." : "บันทึก"}
        </button>
      </div>
    </dialog>
  );
}
