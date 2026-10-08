"use client";

import { useRef, useState } from "react";
import { ApiError, type DocumentSubmission, type FeeItem } from "@/lib/api";
import { supplierRatesApi } from "@/lib/supplier-rates-api";
import { SUPPLIER_FEE_FIELDS, type SupplierFeeKey } from "@/lib/supplier-route";

// ค่าจ้างซับของรายการที่ส่งซับจดต่างจังหวัด (ผู้ใช้ 2026-10-08) - แสดงในหน้ารับใบเสร็จ
// ซับคิดตามตารางราคาเสมอ ระบบจึงใส่ให้ตั้งแต่ตอนส่งงาน แต่ถ้ายอดจริงต่างจากตาราง (ซับขึ้นราคา) พนักงานแก้รายคันได้ ต้องมีเหตุผล
// noBillItems ของรายการแบบนี้ = 3 บรรทัดตาม SUPPLIER_FEE_FIELDS

const money = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
type Draft = Record<SupplierFeeKey, string> & { remark: string };

function amountOf(items: FeeItem[], label: string): number {
  return Number(items.find((i) => i.label === label)?.amount ?? 0);
}

export function SupplierFeeLine({
  submission: s,
  canEdit,
  onSaved,
}: {
  submission: DocumentSubmission;
  canEdit: boolean;
  onSaved: (submission: DocumentSubmission) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const initial = (): Draft => ({
    serviceFee: String(amountOf(s.noBillItems, SUPPLIER_FEE_FIELDS[0].label)),
    channelFee: String(amountOf(s.noBillItems, SUPPLIER_FEE_FIELDS[1].label)),
    inspectionFee: String(amountOf(s.noBillItems, SUPPLIER_FEE_FIELDS[2].label)),
    remark: "",
  });
  const [draft, setDraft] = useState<Draft>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function open() {
    setDraft(initial());
    setError("");
    dialogRef.current?.showModal();
  }

  async function save() {
    for (const field of SUPPLIER_FEE_FIELDS) {
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(draft[field.key].trim())) return setError(`${field.label}ต้องเป็นตัวเลขตั้งแต่ 0`);
    }
    if (!draft.remark.trim()) return setError("ระบุเหตุผลที่แก้ เช่น ซับขึ้นราคา");
    setSaving(true);
    setError("");
    try {
      const { submission } = await supplierRatesApi.updateSubmissionFee(s.id, {
        serviceFee: draft.serviceFee.trim(),
        channelFee: draft.channelFee.trim(),
        inspectionFee: draft.inspectionFee.trim(),
        remark: draft.remark.trim(),
      });
      onSaved(submission);
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  const total = SUPPLIER_FEE_FIELDS.reduce((sum, f) => sum + (Number(draft[f.key]) || 0), 0);
  const receipt = s.receiptAmount === null ? null : Number(s.receiptAmount);

  return (
    <div>
      <div>
        {money(Number(s.noBillTotal))}{" "}
        {canEdit && (
          <button type="button" className="text-button" style={{ fontSize: 12, padding: 0, whiteSpace: "nowrap" }} onClick={open}>
            ✎ แก้
          </button>
        )}
      </div>
      <div style={{ fontSize: 11, color: "#8a94a6" }}>{s.noBillItems.map((i) => `${i.label} ${money(Number(i.amount))}`).join(" + ")}</div>
      {receipt !== null && (
        <div style={{ fontSize: 11, color: "#8a94a6" }}>จ่ายซับรวม {money(receipt + Number(s.noBillTotal))} (ใบเสร็จ + ค่าจ้างซับ)</div>
      )}
      <dialog
        ref={dialogRef}
        style={{ width: "min(460px, 95vw)" }}
        onClick={(event) => {
          if (event.target === event.currentTarget && !saving) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        <h2>แก้ค่าจ้างซับ</h2>
        <div style={{ fontSize: 13, color: "#576781", marginBottom: 12 }}>
          {s.vehicle.chassis} · {s.vehicle.brand.name} · {s.vehicle.customer.name}
        </div>
        <p className="muted" style={{ fontSize: 13, marginBottom: 12 }}>
          ระบบใส่ราคาตามตารางราคาซับของจังหวัดที่จด ณ วันที่ส่งงาน แก้ตรงนี้เมื่อซับเรียกเก็บต่างจากตาราง
          แล้วแจ้งผู้ดูแลระบบให้แก้ตารางราคาด้วย
        </p>
        <div style={{ display: "grid", gap: 10 }}>
          {SUPPLIER_FEE_FIELDS.map((f) => (
            <label key={f.key} className="field">
              {f.label} (บาท)
              <input
                type="text"
                inputMode="decimal"
                value={draft[f.key]}
                onChange={(e) => setDraft((prev) => ({ ...prev, [f.key]: e.target.value.replace(/[^\d.]/g, "") }))}
              />
            </label>
          ))}
          <div style={{ fontSize: 13 }}>
            รวมค่าจ้างซับ <b>{money(total)}</b> บาท
          </div>
          <label className="field">
            เหตุผลที่แก้ *
            <input
              type="text"
              maxLength={200}
              value={draft.remark}
              onChange={(e) => setDraft((prev) => ({ ...prev, remark: e.target.value }))}
              placeholder="เช่น ซับขึ้นค่าดำเนินการ"
            />
          </label>
        </div>
        {error && (
          <p className="customer-message error" role="alert" style={{ marginTop: 12 }}>
            {error}
          </p>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button type="button" className="primary" disabled={saving} onClick={save}>
            {saving ? "กำลังบันทึก…" : "บันทึก"}
          </button>
          <button type="button" className="text-button" disabled={saving} onClick={() => dialogRef.current?.close()}>
            ยกเลิก
          </button>
        </div>
      </dialog>
    </div>
  );
}
