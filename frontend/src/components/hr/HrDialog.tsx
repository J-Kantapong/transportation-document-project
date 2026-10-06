"use client";

import { useEffect, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import { ApiError } from "@/lib/api";
import { DateInput } from "@/components/DateInput";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import type { HistoryEntry } from "@/lib/hr-api";

export const errorText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
export const digits = (text: string) => text.replace(/\D/g, "").slice(0, 8);

// ช่องจำนวนเงินที่พิมพ์เป็นข้อความ: ว่าง = null, อ่านไม่ได้ = NaN (จุลภาคหลักพันได้)
export function moneyOf(text: string): number | null {
  const s = text.replace(/,/g, "").trim();
  if (s === "") return null;
  return /^\d+(\.\d{1,2})?$/.test(s) ? Number(s) : Number.NaN;
}

// dialog กลางของหน้าฝ่ายบุคคล: เปิดทันทีที่ปรากฏ ปิดแล้วเรียก onClose (ผู้เรียกเอา component ออกจากหน้า)
// closeRef: ให้ผู้เรียกสั่งปิดเองได้หลังบันทึกสำเร็จ (closeRef.current())
export function HrDialog({
  title,
  onClose,
  width = 560,
  closeRef,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number;
  closeRef?: MutableRefObject<() => void>;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    if (closeRef) closeRef.current = () => ref.current?.close();
  }, [closeRef]);
  return (
    <dialog ref={ref} onClose={onClose} style={{ width: `min(${width}px, 94vw)` }}>
      <button className="close" type="button" aria-label="ปิด" onClick={() => ref.current?.close()}>
        ×
      </button>
      <h2>{title}</h2>
      {children}
    </dialog>
  );
}

// ยืนยันการทำสิ่งที่ย้อนยาก: เหตุผลบังคับ (+ ช่องวันที่ถ้าต้องใช้ เช่น วันที่ลาออก / วันที่จ่ายเงินเดือน)
export function ReasonDialog({
  title,
  description,
  confirmLabel,
  danger,
  withDate,
  defaultDateIso,
  noReason,
  onConfirm,
  onClose,
}: {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  withDate?: { label: string };
  defaultDateIso?: string; // วันที่เริ่มต้นของช่องวันที่ (ค.ศ. YYYY-MM-DD) - ไม่ระบุ = วันนี้
  noReason?: boolean; // ไม่ต้องกรอกเหตุผล (เช่น บันทึกการจ่าย - มีแต่วันที่)
  onConfirm: (remark: string, dateIso: string) => Promise<void>;
  onClose: () => void;
}) {
  const [remark, setRemark] = useState("");
  const [dateText, setDateText] = useState(isoToDisplayDate(defaultDateIso || todayIso()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const closeRef = useRef<() => void>(() => {});

  async function submit() {
    setError("");
    if (!noReason && !remark.trim()) return setError("กรุณาระบุเหตุผล");
    const dateIso = withDate ? displayDateToIso(digits(dateText)) : "";
    if (withDate && !dateIso) return setError(`${withDate.label}ไม่ถูกต้อง`);
    setBusy(true);
    try {
      await onConfirm(remark.trim(), dateIso);
      closeRef.current();
    } catch (err) {
      setError(errorText(err, "ทำรายการไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <HrDialog title={title} onClose={onClose} width={500} closeRef={closeRef}>
      {description && <div style={{ marginBottom: 12 }}>{description}</div>}
      {withDate && (
        <label className="field" style={{ marginBottom: 12 }}>
          {withDate.label}
          <DateInput value={dateText} onChange={(v) => setDateText(formatDateDigitsCe(digits(v)))} />
        </label>
      )}
      {!noReason && (
        <label className="field">
          เหตุผล *
          <textarea value={remark} onChange={(e) => setRemark(e.target.value)} rows={3} maxLength={500} />
        </label>
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions" style={{ marginTop: 14 }}>
        <button type="button" className={`primary${danger ? " danger" : ""}`} disabled={busy} onClick={submit}>
          {busy ? "กำลังทำรายการ…" : confirmLabel}
        </button>
      </div>
    </HrDialog>
  );
}

const ACTION_LABEL: Record<string, string> = {
  update: "แก้ไขข้อมูล",
  resign: "ลาออก",
  reinstate: "รับกลับเข้าทำงาน",
  create: "สร้างรอบ",
  recalculate: "คำนวณใหม่",
  approve: "อนุมัติ",
  unapprove: "ยกเลิกการอนุมัติ",
  pay: "บันทึกการจ่าย",
  unpay: "ยกเลิกการจ่าย",
  cancel: "ยกเลิกรอบ",
};

const FIELD_LABEL: Record<string, string> = {
  code: "รหัส",
  prefix: "คำนำหน้า",
  firstName: "ชื่อ",
  lastName: "นามสกุล",
  position: "ตำแหน่ง",
  idType: "ประเภทเลขประจำตัว",
  idNumber: "เลขประจำตัว",
  birthDate: "วันเกิด",
  startDate: "วันเริ่มงาน",
  baseSalary: "เงินเดือน",
  socialSecurity: "ประกันสังคม",
  withholdTax: "หักภาษี",
  otherAllowance: "ค่าลดหย่อนอื่นๆ",
  userId: "ผู้ใช้ที่ผูก",
  note: "หมายเหตุ",
  status: "สถานะ",
  resignedDate: "วันที่ลาออก",
};

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "ว่าง" : typeof v === "boolean" ? (v ? "ใช่" : "ไม่") : String(v));

// ประวัติการแก้ไข/เปลี่ยนสถานะ (AuditLog) - ใหม่สุดก่อน
export function HistoryDialog({ title, load, onClose }: { title: string; load: () => Promise<{ history: HistoryEntry[] }>; onClose: () => void }) {
  const [state, setState] = useState<{ rows: HistoryEntry[] } | { error: string } | null>(null);
  useEffect(() => {
    let alive = true;
    load()
      .then((r) => alive && setState({ rows: r.history }))
      .catch((err) => alive && setState({ error: errorText(err, "โหลดประวัติไม่สำเร็จ") }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <HrDialog title={title} onClose={onClose} width={640}>
      {state === null && <p className="muted">กำลังโหลด…</p>}
      {state && "error" in state && <p className="customer-message error">{state.error}</p>}
      {state && "rows" in state && state.rows.length === 0 && <p className="muted">ยังไม่มีประวัติ</p>}
      {state && "rows" in state && (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 12, maxHeight: "60vh", overflow: "auto" }}>
          {state.rows.map((h) => (
            <li key={h.id} style={{ borderBottom: "1px solid #eef1f6", paddingBottom: 10 }}>
              <div style={{ fontSize: 14 }}>
                <b>{ACTION_LABEL[h.action] ?? h.action}</b> · {new Date(h.at).toLocaleString("th-TH")}
                {h.by ? ` · ${h.by}` : ""}
              </div>
              <div className="muted" style={{ fontSize: 13 }}>
                เหตุผล: {h.remark}
              </div>
              {h.changes && h.action === "update" && (
                <ul style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13 }}>
                  {Object.entries(h.changes).map(([field, c]) => (
                    <li key={field}>
                      {FIELD_LABEL[field] ?? field}: {show(c.from)} → {show(c.to)}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </HrDialog>
  );
}
