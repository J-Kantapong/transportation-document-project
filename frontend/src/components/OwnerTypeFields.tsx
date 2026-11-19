"use client";

import { Req } from "@/components/ui";

// ประเภทเจ้าของรถ + ติดไฟแนนซ์ - ใช้ร่วมกันระหว่างฟอร์มต่อภาษีและฟอร์มรับงานรถเก่า (ย้ายออกจาก TaxRenewalPage 2026-11-19)
// ติดไฟแนนซ์ = เลือกประเภทผู้เช่าซื้อ (ตัวคูณนิติบุคคลคิดตามผู้เช่าซื้อ ไม่ใช่บริษัทไฟแนนซ์)
// "" = ยังไม่ได้เลือก - ไม่ตั้งค่าเริ่มต้นเป็นบุคคลธรรมดาให้เงียบๆ
export type OwnerTypeValue = "" | "INDIVIDUAL" | "JURISTIC";

export function OwnerTypeFields({
  ownerType,
  financed,
  hideFinanced = false,
  onOwnerTypeChange,
  onFinancedChange,
}: {
  ownerType: OwnerTypeValue;
  financed: boolean;
  hideFinanced?: boolean; // รถ ขส.: ไม่มีเรื่องเช่าซื้อ (ไม่คูณ 2 อยู่แล้ว) - ซ่อนติ๊กไฟแนนซ์
  onOwnerTypeChange: (v: OwnerTypeValue) => void;
  onFinancedChange: (v: boolean) => void;
}) {
  return (
    <>
      <label className="field">
        <span>{financed ? "ประเภทผู้ครอบครอง (ผู้เช่าซื้อ)" : "ประเภทเจ้าของรถ"} <Req /></span>
        <select value={ownerType} onChange={(e) => onOwnerTypeChange(e.target.value as OwnerTypeValue)} required>
          <option value="">{financed ? "เลือกประเภทผู้ครอบครอง" : "เลือกประเภทเจ้าของรถ"}</option>
          <option value="INDIVIDUAL">บุคคลธรรมดา</option>
          <option value="JURISTIC">นิติบุคคล</option>
        </select>
      </label>
      {hideFinanced ? null : (
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            style={{ width: 18, height: 18, minHeight: 0, padding: 0, margin: 0 }}
            checked={financed}
            onChange={(e) => onFinancedChange(e.target.checked)}
          />
          ติดไฟแนนซ์ (เช่าซื้อ)
        </label>
      </div>
      )}
    </>
  );
}
