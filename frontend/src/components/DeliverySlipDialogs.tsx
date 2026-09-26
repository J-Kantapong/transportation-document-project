"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { billingApi, slipNoText, type DeliverySlip } from "@/lib/billing-api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

// แก้ / ยกเลิกใบส่งงานที่คีย์ผิด (ผู้ใช้ 2026-09-26) - ต้องมีเหตุผลเสมอ (เก็บในประวัติการแก้ไขของรถ)
// ยกเลิกแล้วรถกลับเข้าคิว Delivery ให้บันทึกใหม่ได้ ส่วนใบ/รายการที่ยกเลิกยังอยู่ในรายงานพร้อมเหตุผล (ไม่ลบ)

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);

function useModal() {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return ref;
}

export function DeliverySlipEditDialog({
  slip,
  onClose,
  onSaved,
}: {
  slip: DeliverySlip;
  onClose: () => void;
  onSaved: (slip: DeliverySlip) => void;
}) {
  const dialogRef = useModal();
  const [recipient, setRecipient] = useState(slip.recipient);
  const [dateText, setDateText] = useState(isoToDisplayDate(slip.date));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const billed = slip.items.filter((i) => !i.cancelledAt && i.invoiceNo);

  async function handleSave() {
    setError("");
    const date = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!recipient.trim()) return setError("ต้องใส่ชื่อผู้รับงาน");
    if (!date) return setError("วันที่ไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่แก้");
    setSaving(true);
    try {
      const saved = await billingApi.updateDeliverySlip(slip.id, { recipient: recipient.trim(), date, remark: remark.trim() });
      onSaved(saved);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "แก้ใบส่งงานไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แก้ใบส่งงาน {slipNoText(slip.slipNo)}</h2>
      <p className="muted">
        {slip.customer.displayName} · {slip.items.filter((i) => !i.cancelledAt).length} คัน
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        ผู้รับงาน *
        <input type="text" value={recipient} onChange={(e) => setRecipient(e.target.value)} />
      </label>
      <label className="field" style={{ marginTop: 12 }}>
        วันที่ส่ง *
        <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))} />
      </label>
      {billed.length > 0 && (
        <p className="muted" style={{ marginTop: 8 }}>
          มีรถวางบิลแล้ว {billed.length} คัน ({billed.map((i) => i.invoiceNo).join(", ")}) - เปลี่ยนวันที่ส่งไม่ได้ แก้ได้เฉพาะชื่อผู้รับ
        </p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น พิมพ์ชื่อผู้รับผิด" />
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

export function DeliverySlipCancelDialog({
  slip,
  onClose,
  onCancelled,
}: {
  slip: DeliverySlip;
  onClose: () => void;
  onCancelled: (slip: DeliverySlip) => void;
}) {
  const dialogRef = useModal();
  const items = slip.items.filter((i) => !i.cancelledAt);
  const [picked, setPicked] = useState(() => new Set(items.filter((i) => !i.invoiceNo).map((i) => i.vehicleId)));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const allBilled = items.every((i) => i.invoiceNo);

  function toggle(vehicleId: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(vehicleId)) next.delete(vehicleId);
      else next.add(vehicleId);
      return next;
    });
  }

  async function handleConfirm() {
    setError("");
    if (picked.size === 0) return setError("เลือกรถที่จะยกเลิกอย่างน้อย 1 คัน");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่ยกเลิก");
    setSaving(true);
    try {
      const saved = await billingApi.cancelDeliverySlip(slip.id, { vehicleIds: [...picked], remark: remark.trim() });
      onCancelled(saved);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "ยกเลิกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(560px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ยกเลิกการส่งงาน {slipNoText(slip.slipNo)}</h2>
      <p className="muted">
        {isoToDisplayDate(slip.date)} · {slip.customer.displayName} · ผู้รับ {slip.recipient}
      </p>
      {allBilled ? (
        <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
          รถในใบนี้วางบิลแล้วทุกคัน ต้องยกเลิกบิลก่อนจึงจะยกเลิกการส่งได้
        </p>
      ) : (
        <>
          <p style={{ marginTop: 12 }}>เลือกคันที่จะยกเลิก รถจะกลับเข้าคิว Delivery เพื่อบันทึกส่งใหม่ ใบนี้ยังเก็บไว้พร้อมเหตุผล</p>
          <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
            {items.map((i) => (
              <label key={i.vehicleId} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={picked.has(i.vehicleId)} disabled={!!i.invoiceNo} onChange={() => toggle(i.vehicleId)} />
                <span>
                  {i.plateText || "—"} · {i.chassis}
                  {i.receipt ? "" : " (ใบส่งป้าย)"}
                  {i.invoiceNo ? <span className="muted"> · วางบิลแล้ว {i.invoiceNo} ยกเลิกไม่ได้</span> : null}
                </span>
              </label>
            ))}
          </div>
          <label className="field" style={{ marginTop: 12 }}>
            เหตุผลที่ยกเลิก *
            <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ติ๊กผิดคัน" />
          </label>
        </>
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ไม่ยกเลิก
        </button>
        {!allBilled && (
          <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
            {saving ? "กำลังยกเลิก..." : `ยืนยันยกเลิก ${picked.size} คัน`}
          </button>
        )}
      </div>
    </dialog>
  );
}
