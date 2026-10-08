"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type TaxRenewal } from "@/lib/api";
import { canEditSubmitSteps, getCachedUser, writeScopeFor, type UserRole } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatBaht } from "@/lib/plate-swap-fee";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { useCustomerOptions } from "@/components/TaxRenewalPage";
import { DateTextInput, dangerButton, errorText, openReceiptImage, ReasonDialog, textToIso } from "@/components/PlateSwapPages";

// หน้ารับใบเสร็จของงานต่อภาษี (ผู้ใช้ 2026-10-08, แบบเดียวกับหน้ารับใบเสร็จรถจดใหม่/ย้ายออก)
// แนบรูปใบเสร็จอย่างน้อย 1 รูป (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ แก้เองได้) แล้วยืนยันวันที่รับใบเสร็จ (receivedDate)
// งานต้องชำระภาษีแล้ว (มีวันที่ชำระ) จึงรับใบเสร็จได้ / หลังรับแล้ว แก้รูป-ข้อมูลใบเสร็จต้องระบุเหตุผล (เก็บประวัติ)

const moneyOnly = (text: string) => text.replace(/[^0-9.]/g, "");
const plateText = (r: TaxRenewal) => `${r.plateCategory} ${r.plateNumber}`;
const day = (iso: string | null | undefined) => (iso ? isoToDisplayDate(iso.slice(0, 10)) : "");

type Tab = "pending" | "received";

export function TaxRenewalReceiptPage() {
  const [roles, setRoles] = useState<UserRole[] | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);
  const canWrite = canEditSubmitSteps(roles ?? []);
  const scope = writeScopeFor(roles ?? []);
  const canWriteRow = (r: TaxRenewal) => canWrite && (scope === "ALL" || (scope !== "NONE" && isMotorcycleBody(r.vehicleType) === (scope === "MOTO")));

  const [tab, setTab] = useState<Tab>("pending");
  const [rows, setRows] = useState<TaxRenewal[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const receivedDate = useMemo(() => textToIso(dateText), [dateText]);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [undoRow, setUndoRow] = useState<TaxRenewal | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setListError("");
    try {
      setRows(await api.listTaxRenewals());
    } catch (err) {
      setListError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการตอนเปิดหน้า
    void load();
  }, [load]);

  const replace = (updated: TaxRenewal) =>
    setRows((prev) => prev.map((r) => (r.id === updated.id ? { ...r, ...updated, customer: updated.customer ?? r.customer } : r)));

  const pending = rows.filter((r) => r.paymentDate && !r.receivedDate);
  const received = rows.filter((r) => r.receivedDate);
  const unpaid = rows.filter((r) => !r.paymentDate).length;
  const shown = tab === "pending" ? pending : received;

  async function confirm(row: TaxRenewal) {
    if (!receivedDate) return setMessage({ text: "กรุณากรอกวันที่รับใบเสร็จให้ถูกต้อง", error: true });
    if (receivedDate > todayIso()) return setMessage({ text: "วันที่รับใบเสร็จต้องไม่เกินวันนี้", error: true });
    if (!window.confirm(`ยืนยันรับใบเสร็จ?\n\nวันที่รับ: ${isoToDisplayDate(receivedDate)}\nรถ: ทะเบียน ${plateText(row)}`)) return;
    try {
      await api.updateTaxRenewal(row.id, { receivedDate });
      await load();
      setMessage({ text: `รับใบเสร็จแล้ว: ${plateText(row)}` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  return (
    <section className="content">
      <Link href="/registration/tax-renewal" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ต่อภาษี
      </Link>
      <h1>รับใบเสร็จ (ต่อภาษี)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        ถ่ายหรือแนบรูปใบเสร็จอย่างน้อย 1 รูป (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ แก้เองได้) แล้วกดยืนยันรับใบเสร็จตามวันที่ที่ระบุ
        {unpaid > 0 ? ` · มี ${unpaid} งานที่ยังไม่ได้ชำระภาษี (กรอกวันที่ชำระที่หน้าต่อภาษีก่อน)` : ""}
      </p>

      <div className="panel">
        <div className="panel-head">
          <div className="inspect-filter" style={{ padding: 0 }}>
            <button type="button" className={`filter-chip${tab === "pending" ? " selected" : ""}`} onClick={() => setTab("pending")}>
              รอรับใบเสร็จ ({pending.length})
            </button>
            <button type="button" className={`filter-chip${tab === "received" ? " selected" : ""}`} onClick={() => setTab("received")}>
              รับแล้ว ({received.length})
            </button>
          </div>
          {tab === "pending" && canWrite && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              วันที่รับใบเสร็จ
              <DateTextInput value={dateText} onChange={setDateText} label="วันที่รับใบเสร็จ" />
            </label>
          )}
        </div>
        {message.text && (
          <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ padding: "0 23px 14px" }}>
            {message.text}
          </div>
        )}
        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : listError ? (
          <div className="empty-customers" role="alert">
            {listError}
          </div>
        ) : shown.length === 0 ? (
          <div className="empty-customers">{tab === "pending" ? "ไม่มีงานที่รอรับใบเสร็จ" : "ยังไม่มีงานที่รับใบเสร็จแล้ว"}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ชำระ</th>
                  <th>เจ้าของงาน</th>
                  <th>รถ</th>
                  <th>รูปใบเสร็จ</th>
                  <th>ข้อมูลใบเสร็จ</th>
                  <th>{tab === "pending" ? "" : "วันที่รับ"}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => (
                  <ReceiptRow
                    key={row.id}
                    row={row}
                    canWrite={canWriteRow(row)}
                    onChange={replace}
                    onConfirm={confirm}
                    onUndo={() => setUndoRow(row)}
                    onReload={load}
                    onMessage={(text, error) => setMessage({ text, error })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {undoRow && (
        <ReasonDialog
          title="ยกเลิกการรับใบเสร็จ"
          confirmLabel="ยืนยันยกเลิกรับใบเสร็จ"
          placeholder="เช่น กดรับผิดงาน"
          onClose={() => setUndoRow(null)}
          onConfirm={async (remark) => {
            await api.updateTaxRenewal(undoRow.id, { receivedDate: null, remark, expectedUpdatedAt: undoRow.updatedAt });
            await load();
            setMessage({ text: `ย้ายกลับไปรอรับใบเสร็จแล้ว: ${plateText(undoRow)}` });
          }}
        >
          <p>
            ทะเบียน {plateText(undoRow)} จะกลับไปอยู่แท็บ &quot;รอรับใบเสร็จ&quot; (ถ้าคืนลูกค้าไปแล้วต้องล้างวันที่คืนลูกค้าที่หน้าต่อภาษีก่อน)
          </p>
        </ReasonDialog>
      )}
    </section>
  );
}

// เลขที่ใบเสร็จ/วันที่/ยอดเงิน - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ แก้เองได้เสมอ / รับแล้วแก้ต้องมีเหตุผล
function ReceiptFieldsCell({ row, canWrite, onChange }: { row: TaxRenewal; canWrite: boolean; onChange: (row: TaxRenewal) => void }) {
  const [editing, setEditing] = useState(false);
  const [receiptNo, setReceiptNo] = useState(row.receiptNo ?? "");
  const [dateText, setDateText] = useState(() => day(row.receiptDate));
  const [amount, setAmount] = useState(row.receiptAmount ?? "");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsRemark = Boolean(row.receivedDate);

  useEffect(() => {
    if (editing) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ซิงก์ช่องกรอกกับค่าที่เพิ่งอ่านได้จากรูป
    setReceiptNo(row.receiptNo ?? "");
    setDateText(day(row.receiptDate));
    setAmount(row.receiptAmount ?? "");
  }, [editing, row.receiptNo, row.receiptDate, row.receiptAmount]);

  async function save() {
    setError("");
    const receiptDate = dateText.trim() ? textToIso(dateText) : "";
    if (dateText.trim() && !receiptDate) return setError("วันที่ใบเสร็จไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    if (needsRemark && !remark.trim()) return setError("งานนี้รับใบเสร็จแล้ว - กรุณาระบุเหตุผลที่แก้");
    setBusy(true);
    try {
      onChange(
        await api.updateTaxRenewalReceiptFields(
          row.id,
          { receiptNo: receiptNo.trim(), receiptDate, receiptAmount: amount.trim() },
          needsRemark ? remark.trim() : undefined,
        ),
      );
      setEditing(false);
      setRemark("");
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div>
        <div>{row.receiptNo || <span className="muted">ยังไม่มีเลขที่ใบเสร็จ</span>}</div>
        <div className="sub">
          {row.receiptDate ? `วันที่ ${day(row.receiptDate)}` : ""}
          {row.receiptAmount ? `${row.receiptDate ? " · " : ""}${formatBaht(Number(row.receiptAmount))} บาท` : ""}
        </div>
        {canWrite && (
          <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => setEditing(true)}>
            ✎ แก้
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4, minWidth: 160 }}>
      <input value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} placeholder="เลขที่ใบเสร็จ" aria-label="เลขที่ใบเสร็จ" className="inspect-input" />
      <DateTextInput value={dateText} onChange={setDateText} label="วันที่ใบเสร็จ" />
      <input
        value={amount}
        onChange={(e) => setAmount(moneyOnly(e.target.value))}
        placeholder="ยอดเงิน"
        aria-label="ยอดเงินตามใบเสร็จ"
        inputMode="decimal"
        className="inspect-input"
      />
      {needsRemark && (
        <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เหตุผลที่แก้ *" aria-label="เหตุผลที่แก้ข้อมูลใบเสร็จ" className="inspect-input" />
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="text-button" disabled={busy} onClick={save}>
          บันทึก
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setRemark("");
            setError("");
            setEditing(false);
          }}
        >
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

function ReceiptRow({
  row,
  canWrite,
  onChange,
  onConfirm,
  onUndo,
  onReload,
  onMessage,
}: {
  row: TaxRenewal;
  canWrite: boolean;
  onChange: (row: TaxRenewal) => void;
  onConfirm: (row: TaxRenewal) => void;
  onUndo: () => void;
  onReload: () => Promise<void>;
  onMessage: (text: string, error?: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const customerOptions = useCustomerOptions();
  const [busy, setBusy] = useState(false);
  const received = Boolean(row.receivedDate);
  const receipts = row.receipts ?? [];
  // รับแล้ว: รูปใบเสร็จเป็นหลักฐาน แก้ได้แต่ต้องกด "แก้รูปใบเสร็จ" และใส่เหตุผลก่อน
  const [editingReceipts, setEditingReceipts] = useState(false);
  const [receiptRemark, setReceiptRemark] = useState("");
  const receiptWritable = canWrite && (!received || editingReceipts);
  const remarkMissing = received && !receiptRemark.trim();

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    onMessage("");
    try {
      for (const file of Array.from(files)) {
        const image = await compressReceiptImage(file);
        onChange(await api.addTaxRenewalReceipt(row.id, image, compressedFileName(file), received ? receiptRemark.trim() : undefined));
      }
    } catch (err) {
      onMessage(errorText(err, "แนบรูปไม่สำเร็จ"), true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  // เจ้าของงาน (ผู้ใช้ 2026-10-08): เติมจากว่างได้เลย / เปลี่ยนคนเดิมต้องมีเหตุผล (เก็บประวัติ)
  async function changeCustomer(customerId: string) {
    if (!customerId || customerId === row.customerId) return;
    let remark: string | undefined;
    if (row.customerId) {
      const answer = window.prompt("เปลี่ยนเจ้าของงาน - กรุณาระบุเหตุผล");
      if (!answer?.trim()) return;
      remark = answer.trim();
    }
    try {
      await api.updateTaxRenewal(row.id, { customerId, ...(remark ? { remark } : {}), expectedUpdatedAt: row.updatedAt });
      await onReload();
      onMessage(`เปลี่ยนเจ้าของงานแล้ว: ${plateText(row)}`);
    } catch (err) {
      onMessage(errorText(err, "เปลี่ยนเจ้าของงานไม่สำเร็จ"), true);
    }
  }

  async function removeReceipt(receiptId: string) {
    if (!window.confirm("ลบรูปใบเสร็จนี้?")) return;
    try {
      onChange(await api.removeTaxRenewalReceipt(row.id, receiptId, received ? receiptRemark.trim() : undefined));
    } catch (err) {
      onMessage(errorText(err, "ลบรูปไม่สำเร็จ"), true);
    }
  }

  return (
    <tr>
      <td>{day(row.paymentDate)}</td>
      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
        {canWrite ? (
          <select value={row.customerId ?? ""} onChange={(e) => void changeCustomer(e.target.value)} aria-label="เจ้าของงาน">
            <option value="">ยังไม่ระบุ - เลือกลูกค้า</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        ) : row.customer ? (
          row.customer.company || row.customer.name
        ) : (
          <span className="muted">ยังไม่ระบุ</span>
        )}
      </td>
      <td>
        <div className="job">{plateText(row)}</div>
        <div className="sub">
          {row.vehicleType} · ตัวถัง {row.chassis}
        </div>
      </td>
      <td>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {receipts.length === 0 && <span className="muted">ยังไม่มีรูป</span>}
          {receipts.map((r, i) => (
            <span key={r.id} style={{ display: "inline-flex", alignItems: "center" }}>
              <button type="button" className="text-button" onClick={() => openReceiptImage(r.id)}>
                🧾 รูป {i + 1}
              </button>
              {receiptWritable && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`ลบรูปใบเสร็จที่ ${i + 1}`}
                  style={dangerButton}
                  disabled={remarkMissing}
                  title={remarkMissing ? "ใส่เหตุผลก่อน" : undefined}
                  onClick={() => removeReceipt(r.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {canWrite && received && !editingReceipts && (
          <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => setEditingReceipts(true)}>
            แก้รูปใบเสร็จ
          </button>
        )}
        {receiptWritable && (
          <>
            {received && (
              <input
                value={receiptRemark}
                onChange={(e) => setReceiptRemark(e.target.value)}
                placeholder="เหตุผลที่แก้รูป *"
                aria-label="เหตุผลที่แก้รูปใบเสร็จ"
                className="inspect-input"
                style={{ width: 170, marginTop: 4 }}
              />
            )}
            <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
            <div>
              <button
                type="button"
                className="text-button"
                style={{ paddingLeft: 0 }}
                disabled={busy || remarkMissing}
                title={remarkMissing ? "ใส่เหตุผลก่อน" : undefined}
                onClick={() => inputRef.current?.click()}
              >
                {busy ? "กำลังอัปโหลด…" : "📷 ถ่าย/แนบใบเสร็จ"}
              </button>
              {received && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setEditingReceipts(false);
                    setReceiptRemark("");
                  }}
                >
                  เสร็จ
                </button>
              )}
            </div>
          </>
        )}
      </td>
      <td>
        <ReceiptFieldsCell row={row} canWrite={canWrite} onChange={onChange} />
      </td>
      <td>
        {received ? (
          <div>
            <div>{day(row.receivedDate)}</div>
            {canWrite && (
              <button type="button" className="text-button" style={{ ...dangerButton, paddingLeft: 0 }} onClick={onUndo}>
                ยกเลิกรับ
              </button>
            )}
          </div>
        ) : canWrite ? (
          <button
            type="button"
            className="primary"
            style={{ padding: "8px 14px", fontSize: 13 }}
            disabled={busy || receipts.length === 0}
            title={receipts.length === 0 ? "แนบรูปใบเสร็จก่อน" : undefined}
            onClick={() => onConfirm(row)}
          >
            ยืนยันรับใบเสร็จ
          </button>
        ) : null}
      </td>
    </tr>
  );
}
