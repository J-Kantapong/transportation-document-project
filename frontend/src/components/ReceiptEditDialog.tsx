"use client";

import { useRef, useState } from "react";
import { ApiError, api, receiptImageUrl, type DocumentSubmission, type ReceiptFieldsFix, type ReceiptFieldsFixResult, type ReceiptSummary } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { DateInput } from "@/components/DateInput";

// Popup แก้ข้อมูลที่ AI กรอกให้ในหน้ารับใบเสร็จ: รูปใบเสร็จขนาดใหญ่อยู่ข้างช่องกรอก ให้พนักงานเทียบทีละช่อง
// ช่องที่ AI ไม่แน่ใจ/อ่านไม่ออก/ตรวจอัตโนมัติไม่ผ่าน ขึ้นสีเหลืองพร้อมเหตุผล - กดยืนยันแล้วถือว่าคนตรวจแล้ว (ReceiptCheckPage เลิก highlight)
// ยังไม่บันทึกลงฐานข้อมูล - แค่แก้ค่าในแถว แล้วค่อยกด "บันทึกใบยื่นนี้" ตามปกติ

export interface EditValues {
  plateCategory: string;
  plateNumber: string;
  receiptNo: string;
  receiptDate: string; // วันที่ในใบเสร็จ วว/ดด/ปปปป
  amountText: string;
}

export type FieldFlags = Record<"plate" | "receiptNo" | "total" | "chassis" | "date", string | null>; // null = ไม่ต้องเช็ก, ข้อความ = เหตุผล

interface Props {
  submission: DocumentSubmission;
  receipts: ReceiptSummary[];
  imageId: string | null; // รูปที่ AI อ่าน (หรือรูปล่าสุด)
  values: EditValues;
  flags: FieldFlags;
  aiChassis: string | null;
  aiDate: string | null;
  highlight: boolean; // true = ยังไม่มีคนยืนยัน
  onSave: (values: EditValues) => void;
}

const FLAG_STYLE = { border: "2px solid #e0a31a", background: "#fff8e6" };

function Flag({ text }: { text: string | null }) {
  if (!text) return null;
  return <div style={{ fontSize: 12, color: "#b5651d", marginTop: 4 }}>⚠ {text}</div>;
}

export function ReceiptEditButton(props: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<EditValues>(props.values);
  const [imageId, setImageId] = useState<string | null>(props.imageId);
  const flagCount = Object.values(props.flags).filter(Boolean).length;
  const warn = props.highlight && flagCount > 0;

  function open() {
    setDraft(props.values);
    setImageId(props.imageId);
    dialogRef.current?.showModal();
  }

  function save() {
    props.onSave({
      plateCategory: draft.plateCategory.trim(),
      plateNumber: draft.plateNumber.trim(),
      receiptNo: draft.receiptNo.trim(),
      receiptDate: draft.receiptDate.trim(),
      amountText: draft.amountText.trim(),
    });
    dialogRef.current?.close();
  }

  const s = props.submission;
  const hl = (flag: string | null) => (props.highlight && flag ? FLAG_STYLE : {});

  return (
    <>
      <button
        type="button"
        onClick={open}
        style={{
          marginTop: 6,
          padding: "5px 10px",
          borderRadius: 6,
          fontSize: 12,
          cursor: "pointer",
          border: warn ? "1px solid #e0a31a" : "1px solid #dce2ec",
          background: warn ? "#fff3d6" : "#fff",
          color: warn ? "#8a5a00" : "#2854d9",
          fontWeight: warn ? 600 : 400,
        }}
      >
        ✎ {warn ? `แก้ไข · ต้องเช็ก ${flagCount} ช่อง` : "แก้ไข / เทียบกับรูป"}
      </button>
      <dialog
        ref={dialogRef}
        style={{ width: "min(1040px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>แก้ไขข้อมูลใบเสร็จ</h2>
        <div style={{ fontSize: 13, color: "#576781", marginBottom: 12 }}>
          {s.vehicle.chassis} · {s.vehicle.brand.name} · {s.vehicle.customer.name}
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            {imageId ? (
              <AuthedImage
                src={receiptImageUrl(imageId)}
                alt="ใบเสร็จ"
                style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", border: "1px solid #e4e9f1", borderRadius: 8, background: "#f7f8fb" }}
                linkTitle="เปิดรูปเต็มในแท็บใหม่"
              />
            ) : (
              <div className="empty-customers">ยังไม่มีรูปใบเสร็จ</div>
            )}
            {props.receipts.length > 1 && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {props.receipts.map((r, i) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setImageId(r.id)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: r.id === imageId ? "2px solid #2854d9" : "1px solid #dce2ec", background: "#fff" }}
                  >
                    รูปที่ {i + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div style={{ flex: "0 1 320px", display: "flex", flexDirection: "column", gap: 14 }}>
            <label className="field">
              เลขทะเบียน (หมวด / เลข)
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="text"
                  maxLength={3}
                  value={draft.plateCategory}
                  onChange={(e) => setDraft({ ...draft, plateCategory: e.target.value.slice(0, 3) })}
                  aria-label="หมวดทะเบียน"
                  style={{ width: 80, ...hl(props.flags.plate) }}
                />
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={4}
                  value={draft.plateNumber}
                  onChange={(e) => setDraft({ ...draft, plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                  aria-label="เลขทะเบียน"
                  style={{ width: 90, ...hl(props.flags.plate) }}
                />
              </div>
              {props.highlight && <Flag text={props.flags.plate} />}
            </label>
            <label className="field">
              เลขที่ใบเสร็จ
              <input
                type="text"
                inputMode="numeric"
                maxLength={30}
                placeholder="69/0035358"
                value={draft.receiptNo}
                onChange={(e) => setDraft({ ...draft, receiptNo: e.target.value.replace(/[^\d/]/g, "") })}
                style={{ width: 180, ...hl(props.flags.receiptNo) }}
              />
              {props.highlight && <Flag text={props.flags.receiptNo} />}
            </label>
            <label className="field">
              วันที่ในใบเสร็จ
              <DateInput
                value={draft.receiptDate}
                onChange={(value) => setDraft({ ...draft, receiptDate: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)) })}
                style={{ width: 180, ...hl(props.flags.date) }}
              />
              {props.highlight && <Flag text={props.flags.date} />}
            </label>
            <label className="field">
              ยอดใบเสร็จ (รวมเป็นเงินทั้งสิ้น)
              <input
                type="text"
                inputMode="decimal"
                value={draft.amountText}
                onChange={(e) => setDraft({ ...draft, amountText: e.target.value })}
                style={{ width: 180, ...hl(props.flags.total) }}
              />
              {props.highlight && <Flag text={props.flags.total} />}
            </label>
            <div style={{ fontSize: 13, color: "#576781", lineHeight: 1.8 }}>
              <div style={props.highlight && props.flags.chassis ? { ...FLAG_STYLE, padding: "4px 8px", borderRadius: 6 } : undefined}>
                เลขตัวถังในใบเสร็จ: <span style={{ fontFamily: "monospace" }}>{props.aiChassis ?? "?"}</span>
                {/* ไม่สนตัวพิมพ์ - รถที่คีย์เลขตัวถังตัวเล็กไว้ไม่ขึ้นเตือนผิดๆ (พบ 2026-09-27) */}
                {props.aiChassis && props.aiChassis.toUpperCase() !== s.vehicle.chassis.toUpperCase() && (
                  <div style={{ color: "#b43434" }}>ไม่ตรงกับรถคันนี้ ({s.vehicle.chassis})</div>
                )}
                {props.highlight && <Flag text={props.flags.chassis} />}
              </div>
              <div>
                AI อ่านวันที่ได้: {props.aiDate ? isoToDisplayDate(props.aiDate) : "?"} · วันที่ยื่น {isoToDisplayDate(s.submitDate.slice(0, 10))}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              <button type="button" className="primary" onClick={save}>
                ยืนยันว่าตรงกับรูป
              </button>
              <button type="button" className="text-button" onClick={() => dialogRef.current?.close()}>
                ยกเลิก
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#8a94a6" }}>ยังไม่บันทึกลงระบบ - กด &quot;บันทึกใบยื่นนี้&quot; ด้านล่างตารางอีกครั้ง</div>
          </div>
        </div>
      </dialog>
    </>
  );
}

// ✎ แก้ ในตาราง "ได้ใบเสร็จแล้ว" (ผู้ใช้ 2026-09-27 เลือกแบบ ก): แก้ทะเบียน / เลขที่ / ยอด / วันที่ในใบเสร็จ / วันที่รับใบเสร็จ
// ของรายการที่บันทึกไปแล้ว ต้องใส่เหตุผลทุกครั้ง (เก็บประวัติ) และไม่เปลี่ยนสถานะ - บันทึกลงระบบทันที ต่างจาก popup ด้านบน
// ใบส่งงาน/บิลที่ออกไปแล้วยังพิมพ์ค่าเดิม ระบบไม่แก้ตาม - บอกเลขใบให้หลังบันทึก
interface FixDraft {
  plateCategory: string;
  plateNumber: string;
  receiptNo: string;
  amountText: string;
  receiptDate: string; // วว/ดด/ปปปป
  receivedDate: string; // วว/ดด/ปปปป
  remark: string;
}

const toIso = (display: string) => displayDateToIso(display.replace(/\D/g, ""));

// ช่องวันที่: ว่างได้เฉพาะแถวเก่าที่ไม่เคยมีค่า (iso null = ไม่ส่ง) · ข้อความ = error
function dateField(text: string, before: string | null, label: string): { iso: string | null } | string {
  if (!text.trim()) return before ? `ใส่${label}` : { iso: null };
  const iso = toIso(text);
  return iso ? { iso } : `${label}ไม่ถูกต้อง - ใส่เป็น DD/MM/YYYY เช่น 23/09/2026`;
}

export function ReceivedReceiptFixButton({
  submission: s,
  receipts,
  onSaved,
}: {
  submission: DocumentSubmission;
  receipts: ReceiptSummary[];
  onSaved: (result: ReceiptFieldsFixResult) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initial = (): FixDraft => ({
    plateCategory: s.vehicle.plateCategory ?? "",
    plateNumber: s.vehicle.plateNumber ?? "",
    receiptNo: s.receiptNo ?? "",
    amountText: s.receiptAmount === null ? "" : String(Number(s.receiptAmount)),
    receiptDate: s.receiptDate ? isoToDisplayDate(s.receiptDate.slice(0, 10)) : "",
    receivedDate: s.receiptReceivedDate ? isoToDisplayDate(s.receiptReceivedDate.slice(0, 10)) : "",
    remark: "",
  });
  const [draft, setDraft] = useState<FixDraft>(initial);
  const [imageId, setImageId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [stale, setStale] = useState<string[] | null>(null); // บันทึกแล้ว แต่มีใบส่งงาน/บิลที่ยังพิมพ์ค่าเดิม

  function open() {
    setDraft(initial());
    setImageId(receipts[receipts.length - 1]?.id ?? null);
    setError("");
    setStale(null);
    dialogRef.current?.showModal();
  }

  // ส่งเฉพาะช่องที่เปลี่ยน - backend ตรวจซ้ำทุกข้อ (ช่วงวันที่: วันที่ยื่น <= วันที่ในใบเสร็จ <= วันที่รับใบเสร็จ <= วันนี้)
  function buildFix(): ReceiptFieldsFix | string {
    const fix: ReceiptFieldsFix = { remark: draft.remark.trim() };
    const plateCategory = draft.plateCategory.trim();
    const plateNumber = draft.plateNumber.trim();
    if (!plateCategory || !plateNumber) return "กรอกหมวดและเลขทะเบียนตามใบเสร็จ";
    if (!/^\d{1,4}$/.test(plateNumber)) return "เลขทะเบียนต้องเป็นตัวเลข 1-4 หลัก";
    if (plateCategory !== (s.vehicle.plateCategory ?? "") || plateNumber !== (s.vehicle.plateNumber ?? "")) {
      fix.plateCategory = plateCategory;
      fix.plateNumber = plateNumber;
    }
    const receiptNo = draft.receiptNo.trim();
    if (receiptNo !== (s.receiptNo ?? "")) fix.receiptNo = receiptNo;
    const amount = draft.amountText.trim();
    if (amount && !/^\d+(\.\d{1,2})?$/.test(amount)) return "ยอดใบเสร็จต้องเป็นตัวเลข ทศนิยมไม่เกิน 2 ตำแหน่ง";
    if ((amount ? Number(amount) : null) !== (s.receiptAmount === null ? null : Number(s.receiptAmount))) fix.receiptAmount = amount;

    const submitted = s.submitDate.slice(0, 10);
    const receiptBefore = s.receiptDate?.slice(0, 10) ?? null;
    const receivedBefore = s.receiptReceivedDate?.slice(0, 10) ?? null;
    const receipt = dateField(draft.receiptDate, receiptBefore, "วันที่ในใบเสร็จ");
    if (typeof receipt === "string") return receipt;
    const received = dateField(draft.receivedDate, receivedBefore, "วันที่รับใบเสร็จ");
    if (typeof received === "string") return received;
    if (received.iso && received.iso !== receivedBefore) {
      if (received.iso < submitted) return `วันที่รับใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (${isoToDisplayDate(submitted)})`;
      if (received.iso > todayIso()) return "วันที่รับใบเสร็จต้องไม่เกินวันนี้";
      fix.receiptReceivedDate = received.iso;
    }
    if (receipt.iso && (receipt.iso !== receiptBefore || received.iso !== receivedBefore)) {
      if (receipt.iso < submitted) return `วันที่ในใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (${isoToDisplayDate(submitted)})`;
      if (received.iso && receipt.iso > received.iso) return `วันที่ในใบเสร็จต้องไม่หลังวันที่รับใบเสร็จ (${isoToDisplayDate(received.iso)})`;
      if (receipt.iso !== receiptBefore) fix.receiptDate = receipt.iso;
    }
    if (Object.keys(fix).length === 1) return "ข้อมูลไม่ได้เปลี่ยน";
    if (!fix.remark) return "ระบุเหตุผลที่แก้ เช่น AI อ่านพยัญชนะทะเบียนผิด";
    return fix;
  }

  async function save() {
    const fix = buildFix();
    if (typeof fix === "string") return setError(fix);
    setSaving(true);
    setError("");
    try {
      const result = await api.updateReceiptFields(s.id, fix);
      onSaved(result);
      const printed = [...result.liveSlips.map((no) => `ใบส่งงาน ${no}`), ...result.liveInvoices.map((no) => `บิล ${no}`)];
      if (printed.length > 0) setStale(printed);
      else dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const set = (patch: Partial<FixDraft>) => setDraft((prev) => ({ ...prev, ...patch }));

  return (
    <>
      <button type="button" className="text-button" style={{ fontSize: 12, padding: 0, whiteSpace: "nowrap" }} onClick={open}>
        ✎ แก้
      </button>
      <dialog
        ref={dialogRef}
        style={{ width: "min(1040px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !saving) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>แก้ข้อมูลใบเสร็จที่บันทึกแล้ว</h2>
        <div style={{ fontSize: 13, color: "#576781", marginBottom: 12 }}>
          {s.vehicle.chassis} · {s.vehicle.brand.name} · {s.vehicle.customer.name} · ยื่น {isoToDisplayDate(s.submitDate.slice(0, 10))}
        </div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "1 1 420px", minWidth: 0 }}>
            {imageId ? (
              <AuthedImage
                src={receiptImageUrl(imageId)}
                alt="ใบเสร็จ"
                style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", border: "1px solid #e4e9f1", borderRadius: 8, background: "#f7f8fb" }}
                linkTitle="เปิดรูปเต็มในแท็บใหม่"
              />
            ) : (
              <div className="empty-customers">ไม่มีรูปใบเสร็จ</div>
            )}
            {receipts.length > 1 && (
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                {receipts.map((r, i) => (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => setImageId(r.id)}
                    style={{ padding: "4px 10px", borderRadius: 6, border: r.id === imageId ? "2px solid #2854d9" : "1px solid #dce2ec", background: "#fff" }}
                  >
                    รูปที่ {i + 1}
                  </button>
                ))}
              </div>
            )}
          </div>

          {stale ? (
            <div style={{ flex: "0 1 320px", display: "flex", flexDirection: "column", gap: 12 }}>
              <div className="customer-message success" role="status">
                บันทึกการแก้ไขแล้ว
              </div>
              <div className="customer-message error" role="alert">
                เอกสารที่ออกไปแล้วยังพิมพ์ทะเบียน/เลขที่ใบเสร็จ/ยอดเดิม (ระบบไม่แก้ตาม): {stale.join(", ")} - ถ้าต้องให้ตรง ให้ยกเลิกใบส่งงาน/บิลนั้นแล้วออกใหม่
              </div>
              <div>
                <button type="button" className="primary" onClick={() => dialogRef.current?.close()}>
                  ปิด
                </button>
              </div>
            </div>
          ) : (
            <div style={{ flex: "0 1 320px", display: "flex", flexDirection: "column", gap: 14 }}>
              <label className="field">
                เลขทะเบียน (หมวด / เลข)
                <div style={{ display: "flex", gap: 6 }}>
                  <input
                    type="text"
                    maxLength={3}
                    value={draft.plateCategory}
                    onChange={(e) => set({ plateCategory: e.target.value.slice(0, 3) })}
                    aria-label="หมวดทะเบียน"
                    style={{ width: 80 }}
                  />
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={draft.plateNumber}
                    onChange={(e) => set({ plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
                    aria-label="เลขทะเบียน"
                    style={{ width: 90 }}
                  />
                </div>
              </label>
              <label className="field">
                เลขที่ใบเสร็จ
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={30}
                  placeholder="69/0035358"
                  value={draft.receiptNo}
                  onChange={(e) => set({ receiptNo: e.target.value.replace(/[^\d/]/g, "") })}
                  style={{ width: 180 }}
                />
              </label>
              <label className="field">
                ยอดใบเสร็จ (รวมเป็นเงินทั้งสิ้น)
                <input type="text" inputMode="decimal" value={draft.amountText} onChange={(e) => set({ amountText: e.target.value })} style={{ width: 180 }} />
              </label>
              <label className="field">
                วันที่ในใบเสร็จ
                <DateInput
                  value={draft.receiptDate}
                  onChange={(value) => set({ receiptDate: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)) })}
                  style={{ width: 180 }}
                />
              </label>
              <label className="field">
                วันที่รับใบเสร็จ
                <DateInput
                  value={draft.receivedDate}
                  onChange={(value) => set({ receivedDate: formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)) })}
                  style={{ width: 180 }}
                />
              </label>
              <div style={{ fontSize: 12, color: "#8a94a6" }}>
                วันที่ยื่น {isoToDisplayDate(s.submitDate.slice(0, 10))} ≤ วันที่ในใบเสร็จ ≤ วันที่รับใบเสร็จ ≤ วันนี้ · พิมพ์ปี พ.ศ. ได้
              </div>
              <label className="field">
                เหตุผลที่แก้ (บังคับ)
                <input
                  type="text"
                  value={draft.remark}
                  onChange={(e) => set({ remark: e.target.value })}
                  placeholder="เช่น AI อ่านพยัญชนะทะเบียนผิด"
                  maxLength={200}
                  style={{ width: "100%" }}
                />
              </label>
              {error && (
                <div className="customer-message error" role="alert" style={{ fontSize: 12 }}>
                  {error}
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="primary" disabled={saving} onClick={save}>
                  {saving ? "กำลังบันทึก…" : "บันทึกการแก้ไข"}
                </button>
                <button type="button" className="text-button" disabled={saving} onClick={() => dialogRef.current?.close()}>
                  ยกเลิก
                </button>
              </div>
              <div style={{ fontSize: 12, color: "#8a94a6" }}>
                บันทึกลงระบบทันทีและเก็บประวัติการแก้ - สถานะยังเป็นได้ใบเสร็จแล้ว · ใบส่งงาน/บิลที่ออกไปแล้วไม่เปลี่ยนตาม
              </div>
            </div>
          )}
        </div>
      </dialog>
    </>
  );
}
