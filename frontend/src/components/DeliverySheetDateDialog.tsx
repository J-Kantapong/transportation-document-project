"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
import { SHEET_SOURCE_LABEL, updateSheetRowDate, type SheetRow } from "@/lib/delivery-sheet";
import { DateInput } from "@/components/DateInput";

// แก้วันที่ผิดของงานในใบส่งงานรวม (ผู้ใช้ 2026-10-05) - ใช้กับงานที่ไม่ใช่ใบ DL (ใบ DL ใช้ DeliverySlipEditDialog เดิม)
// ต้องมีเหตุผลเสมอ backend บันทึกประวัติ (AuditLog) และตรวจช่วงวันที่/สิทธิ์/เดือนที่ล็อกของยามาฮ่าเอง
export function DeliverySheetDateDialog({
  row,
  ownerLabel,
  onClose,
  onSaved,
  onRefused,
}: {
  row: SheetRow;
  ownerLabel: string;
  onClose: () => void;
  onSaved: (message: string) => void;
  onRefused?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [dateText, setDateText] = useState(isoToDisplayDate(row.date));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleSave() {
    setError("");
    const date = displayDateToIso(dateText.replace(/\D/g, ""));
    if (!date) return setError("วันที่ไม่ถูกต้อง (วว/ดด/ปปปป)");
    if (date === row.date) return setError("ไม่มีอะไรเปลี่ยน");
    if (!remark.trim()) return setError("ต้องใส่เหตุผลที่แก้");
    setSaving(true);
    try {
      await updateSheetRowDate(row, date, remark.trim());
      onSaved(`แก้${row.dateLabel} (${SHEET_SOURCE_LABEL[row.source]}) เป็น ${isoToDisplayDate(date)} แล้ว`);
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : "แก้วันที่ไม่สำเร็จ");
      // ถูกปฏิเสธ (มีคนแก้/ยกเลิกไปก่อน ฯลฯ) = รายการในหน้าอาจเก่า โหลดใหม่เบื้องหลัง
      if (err instanceof ApiError && err.status !== undefined) onRefused?.();
    } finally {
      setSaving(false);
    }
  }

  const what = [row.plateText, row.chassis].filter(Boolean).join(" · ") || row.detail;
  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แก้{row.dateLabel}</h2>
      <p className="muted">
        {SHEET_SOURCE_LABEL[row.source]} · {ownerLabel} · {what}
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        {row.dateLabel} *
        <DateInput value={dateText} onChange={(value) => setDateText(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))} />
      </label>
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ลงวันที่ผิด" />
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
