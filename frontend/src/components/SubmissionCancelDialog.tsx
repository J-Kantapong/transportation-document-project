"use client";

import { useEffect, useRef, useState } from "react";
import { api, ApiError, type DocumentSubmission } from "@/lib/api";
import { isoToDisplayDate, todayIso } from "@/lib/date";

// ผลตรวจรถผ่านมีอายุ 90 วัน: ยื่นได้ถึงวันที่ตรวจผ่าน + 89 วัน (INSPECTION_VALID_DAYS ใน backend submission-eligibility.ts)
const INSPECTION_VALID_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function inspectionValidUntil(resultDate: string | null | undefined): string | null {
  const iso = resultDate?.slice(0, 10);
  if (!iso) return null;
  const time = Date.parse(`${iso}T00:00:00.000Z`);
  return Number.isNaN(time) ? null : new Date(time + (INSPECTION_VALID_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
}

// ยกเลิกรายการที่ยื่นแล้ว (ผู้ใช้ 2026-09-25): รถกลับไปอยู่ในคิวรอยื่นเอกสาร แล้วยื่นใหม่ได้ (ราคาคำนวณใหม่)
// ได้เฉพาะรายการที่ยังรอใบเสร็จ (รถยนต์และจักรยานยนต์) ต้องกรอกเหตุผล (เก็บในประวัติการแก้ไขของรถ)
// รูปใบเสร็จที่แนบไว้ถูกถอดกลับไปอยู่ในรายการรอจับคู่ (ไม่ถูกลบ)
// ผลตรวจหมดอายุแล้ว ณ วันนี้ = เตือนก่อนยืนยัน (พบ 2026-09-27): ยื่นใหม่ได้เฉพาะวันที่ยื่นไม่เกินวันสุดท้ายของผลตรวจ
// (ผู้ใช้ 2026-09-27: หน้ายื่นเอกสารตั้งวันที่ยื่นเดิมแล้วเลือกรถคันนี้ได้) ถ้ายื่นด้วยวันหลังจากนั้นต้องส่งตรวจรอบ 2
export function SubmissionCancelDialog({
  record,
  onClose,
  onCancelled,
  onStale,
}: {
  record: DocumentSubmission;
  onClose: () => void;
  onCancelled: (id: string) => void;
  onStale?: () => void; // รายการเปลี่ยนไปแล้ว (อีกคนบันทึกได้ใบเสร็จ/ยกเลิกไปก่อน) - ให้หน้าที่เปิดอยู่โหลดรายการใหม่
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const receiptCount = record.receipts?.length ?? 0;
  const validUntil = inspectionValidUntil(record.vehicle.inspectionResultDate);
  const inspectionExpired = validUntil !== null && validUntil < todayIso();

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
      const message = e instanceof Error ? e.message : "ยกเลิกไม่สำเร็จ";
      // 400/404 = รายการไม่ได้รอใบเสร็จแล้ว/ถูกยกเลิกไปแล้ว แต่ตารางยังแสดงสถานะเดิม - โหลดใหม่ให้เห็นสถานะจริง (พบ 2026-09-27)
      if (onStale && e instanceof ApiError && (e.status === 400 || e.status === 404)) {
        onStale();
        setError(`${message} - โหลดรายการใหม่แล้ว`);
      } else {
        setError(message);
      }
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
      {inspectionExpired && (
        <p className="customer-message error" role="alert">
          ผลตรวจหมดอายุแล้ว ณ วันนี้ (ยื่นได้ถึง {isoToDisplayDate(validUntil)}) - ยื่นใหม่ได้โดยตั้งวันที่ยื่นไม่เกินวันนั้น เช่น
          วันที่ยื่นเดิม {isoToDisplayDate(record.submitDate.slice(0, 10))} ที่หน้ายื่นเอกสาร ขั้นเลือกรถ ถ้ายื่นด้วยวันหลังจากนั้นต้องส่งตรวจรอบ 2
          {/* หลังยกเลิก รถคันนี้ขึ้นในคิวส่งตรวจรอบ 2 ของหน้าตรวจสภาพทันที ส่งตรวจรอบ 2 แล้วผลตรวจเดิมถูกล้าง ยื่นด้วยวันที่เดิมไม่ได้อีก (พบ 2026-09-27) */}
          {" "}· รถคันนี้จะขึ้นในคิวส่งตรวจรอบ 2 ของหน้าตรวจสภาพด้วย ถ้าจะยื่นใหม่ด้วยวันที่ยื่นเดิม ให้ยื่นก่อน หรือบอกฝ่ายตรวจสภาพอย่าเพิ่งส่งตรวจรอบ 2
          (ส่งแล้วผลตรวจเดิมถูกล้าง)
        </p>
      )}
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
