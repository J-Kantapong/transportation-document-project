"use client";

import { useRef, useState } from "react";
import { receiptImageUrl, type DocumentSubmission, type ReceiptSummary } from "@/lib/api";
import { AuthedImage } from "@/components/AuthedImage";
import { formatDateDigitsCe, isoToDisplayDate } from "@/lib/date";
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
                {props.aiChassis && props.aiChassis !== s.vehicle.chassis && <div style={{ color: "#b43434" }}>ไม่ตรงกับรถคันนี้ ({s.vehicle.chassis})</div>}
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
