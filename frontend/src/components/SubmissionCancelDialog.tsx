"use client";

import { useEffect, useRef, useState } from "react";
import { api, type DocumentSubmission } from "@/lib/api";

// ยกเลิกรายการที่ยื่นแล้ว (ผู้ใช้ 2026-09-25): รถกลับไปอยู่ในคิวรอยื่นเอกสาร แล้วยื่นใหม่ได้ (ราคาคำนวณใหม่)
// ได้เฉพาะรายการที่ยังรอใบเสร็จ (รถยนต์และจักรยานยนต์) ต้องกรอกเหตุผล (เก็บในประวัติการแก้ไขของรถ)
// รูปใบเสร็จที่แนบไว้ถูกถอดกลับไปอยู่ในรายการรอจับคู่ (ไม่ถูกลบ)
export function SubmissionCancelDialog({
  record,
  onClose,
  onCancelled,
}: {
  record: DocumentSubmission;
  onClose: () => void;
  onCancelled: (id: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const receiptCount = record.receipts?.length ?? 0;

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleConfirm() {
    setError("");
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่ยกเลิก");
    setSaving(true);
    try {
      await api.cancelDocumentSubmission(record.id, remark.trim());
      onCancelled(record.id);
      dialogRef.current?.close();
    } catch (e) {
      setError(e instanceof Error ? e.message : "ยกเลิกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ยกเลิกการยื่นเอกสาร</h2>
      <p className="muted">
        {record.vehicle.chassis} · {record.vehicle.body || "ไม่ระบุประเภทรถ"} · {record.vehicle.customer.name}
      </p>
      <p style={{ marginTop: 12 }}>รายการนี้จะถูกลบ และรถคันนี้จะกลับไปอยู่ในคิวรอยื่นเอกสาร เพื่อยื่นใหม่ได้</p>
      {receiptCount > 0 && (
        <p className="customer-message error" role="alert">
          รายการนี้มีรูปใบเสร็จแนบอยู่ {receiptCount} รูป - รูปจะถูกถอดออกไปอยู่ในรายการรอจับคู่ในหน้ารับใบเสร็จ
          ถ้ายื่นกับขนส่งไปแล้วจริง ระวังการยื่นซ้ำ
        </p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่ยกเลิก *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น เลือกตัวเลือกผิด ต้องยื่นใหม่" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ไม่ยกเลิก
        </button>
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังยกเลิก..." : "ยืนยันยกเลิก"}
        </button>
      </div>
    </dialog>
  );
}
