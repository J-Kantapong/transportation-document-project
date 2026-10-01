"use client";

import { useEffect, useRef, useState } from "react";
import { api, type DocumentSubmission } from "@/lib/api";

// ยกเลิกหลายรายการที่ยื่นแล้วในครั้งเดียว (ผู้ใช้ 2026-10-01): เหตุผลเดียวใช้กับทุกคัน เรียก cancel ของ backend ทีละรายการ
// (กติกาเดิมทั้งหมด: เฉพาะที่รอใบเสร็จ, อยู่ในประเภทรถที่บันทึกได้, ถอดรูปใบเสร็จ, เก็บประวัติ + เหตุผลแยกตามรถ)
// คันที่ยกเลิกไม่สำเร็จแสดงเหตุผลไว้ให้ คันอื่นยกเลิกต่อไป - ตารางหลังปิดหน้าต่างจึงตรงกับความจริง
export function SubmissionBulkCancelDialog({
  title,
  records,
  onClose,
  onCancelled,
  onStale,
}: {
  title: string;
  records: DocumentSubmission[];
  onClose: () => void;
  onCancelled: (id: string) => void;
  onStale?: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [failed, setFailed] = useState<Array<{ chassis: string; error: string }>>([]);
  const receiptCount = records.reduce((sum, r) => sum + (r.receipts?.length ?? 0), 0);

  useEffect(() => {
    dialogRef.current?.showModal();
  }, []);

  async function handleConfirm() {
    setError("");
    setFailed([]);
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่ยกเลิก");
    setSaving(true);
    const errors: Array<{ chassis: string; error: string }> = [];
    for (const r of records) {
      try {
        await api.cancelDocumentSubmission(r.id, remark.trim());
        onCancelled(r.id);
      } catch (e) {
        errors.push({ chassis: r.vehicle.chassis, error: e instanceof Error ? e.message : "ยกเลิกไม่สำเร็จ" });
      }
    }
    setSaving(false);
    if (errors.length === 0) return dialogRef.current?.close();
    setFailed(errors);
    onStale?.();
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(560px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ยกเลิกการยื่นเอกสาร {records.length} คัน</h2>
      <p className="muted">{title}</p>
      <p style={{ marginTop: 12 }}>
        รายการที่เลือกจะถูกลบ และรถทุกคันจะกลับไปอยู่ในคิวรอยื่นเอกสาร เพื่อยื่นใหม่ด้วยวันที่/ตัวเลือกที่ถูกต้อง (ราคาคำนวณใหม่)
      </p>
      <p className="muted" style={{ maxHeight: 90, overflow: "auto" }}>
        {records.map((r) => r.vehicle.chassis).join(", ")}
      </p>
      {receiptCount > 0 && (
        <p className="customer-message error" role="alert">
          มีรูปใบเสร็จแนบอยู่ {receiptCount} รูป - จะถูกถอดไปอยู่ในรายการรอจับคู่ในหน้ารับใบเสร็จ ถ้ายื่นกับขนส่งไปแล้วจริง ระวังการยื่นซ้ำ
        </p>
      )}
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่ยกเลิก *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น ตั้งวันที่ยื่นผิด ต้องยื่นใหม่" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      {failed.length > 0 && (
        <div className="customer-message error" role="alert">
          ยกเลิกไม่สำเร็จ {failed.length} คัน (คันอื่นยกเลิกแล้ว):
          <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
            {failed.map((f) => (
              <li key={f.chassis}>
                {f.chassis}: {f.error}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          {failed.length > 0 ? "ปิด" : "ไม่ยกเลิก"}
        </button>
        {failed.length === 0 && (
          <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
            {saving ? "กำลังยกเลิก..." : `ยืนยันยกเลิก ${records.length} คัน`}
          </button>
        )}
      </div>
    </dialog>
  );
}
