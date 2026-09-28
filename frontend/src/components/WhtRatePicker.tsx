"use client";

import { useState } from "react";

// อัตราหัก ณ ที่จ่ายของบิลนี้ (ผู้ใช้ 2026-09-29: 1% / 3% / ตามงาน สำคัญมาก ต้องปรับได้และมีการตรวจ)
// value = null ใช้ตามเงื่อนไขลูกค้า · เลือกอัตราที่ไม่ตรงกับลูกค้า = ต้องติ๊กยืนยันก่อนออกบิล (whtNeedsCheck)
const PRESETS = [1, 3, 0];

// NaN = เลือก "อัตราอื่น" แต่ยังพิมพ์ไม่ถูกต้อง - ห้ามออกบิล (ไม่ถอยไปใช้อัตราของลูกค้าเงียบๆ)
const valid = (value: number | null) =>
  value !== null && Number.isNaN(value) ? null : value;
export const effectiveWht = (defaultRate: number, value: number | null) =>
  valid(value) ?? defaultRate;
export const whtNeedsCheck = (defaultRate: number, value: number | null) =>
  value !== null && value !== defaultRate;
// ข้อความผิดที่ต้องแก้ก่อนออกบิล (null = ผ่าน)
export function whtProblem(
  defaultRate: number,
  value: number | null,
  checked: boolean,
): string | null {
  if (value !== null && Number.isNaN(value))
    return "ใส่อัตราหัก ณ ที่จ่าย 0-100";
  if (whtNeedsCheck(defaultRate, value) && !checked)
    return "ติ๊กยืนยันอัตราหัก ณ ที่จ่ายของบิลนี้ก่อน (ไม่ตรงกับที่ตั้งไว้ของลูกค้า)";
  return null;
}
// ส่งให้ computeTotals / API: null = ตามลูกค้า
export const whtOverrideOf = (value: number | null) => valid(value);

export function WhtRatePicker({
  defaultRate,
  value,
  onChange,
  checked,
  onCheckedChange,
  defaultLabel = "ที่ตั้งไว้ของลูกค้า",
  defaultChip = "ตามลูกค้า",
}: {
  defaultRate: number;
  value: number | null;
  onChange: (value: number | null) => void;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  defaultLabel?: string; // ใช้ในหน้าแก้บิล: "บิลนี้เดิม"
  defaultChip?: string;
}) {
  const [otherText, setOtherText] = useState(
    value !== null && !PRESETS.includes(value) ? String(value) : "",
  );
  const [otherOpen, setOtherOpen] = useState(
    value !== null && !PRESETS.includes(value),
  );
  const rate = effectiveWht(defaultRate, value);
  const differs = whtNeedsCheck(defaultRate, value);

  function pick(next: number | null) {
    setOtherOpen(false);
    onCheckedChange(false);
    onChange(next);
  }

  function typeOther(text: string) {
    setOtherText(text);
    onCheckedChange(false);
    const n = Number(text.trim());
    onChange(
      text.trim() !== "" && Number.isFinite(n) && n >= 0 && n <= 100
        ? n
        : Number.NaN,
    );
  }
  const otherInvalid = value !== null && Number.isNaN(value);

  const chip = (label: string, selected: boolean, onClick: () => void) => (
    <button
      type="button"
      className={`filter-chip${selected ? " selected" : ""}`}
      onClick={onClick}
    >
      {label}
    </button>
  );

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ fontSize: 14 }}>
        หัก ณ ที่จ่ายบิลนี้{" "}
        <b style={{ fontWeight: 600 }}>
          {otherInvalid ? "—" : rate === 0 ? "ไม่หัก" : `${rate}%`}
        </b>
        <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>
          ({defaultLabel} {defaultRate === 0 ? "ไม่หัก" : `${defaultRate}%`})
        </span>
      </div>
      <div
        className="inspect-filter"
        style={{ padding: 0 }}
        role="group"
        aria-label="อัตราหัก ณ ที่จ่าย"
      >
        {chip(
          `${defaultChip} (${defaultRate}%)`,
          value === null && !otherOpen,
          () => pick(null),
        )}
        {chip("1%", value === 1 && !otherOpen, () => pick(1))}
        {chip("3%", value === 3 && !otherOpen, () => pick(3))}
        {chip("ไม่หัก", value === 0 && !otherOpen, () => pick(0))}
        {chip("อัตราอื่น", otherOpen, () => {
          setOtherOpen(true);
          typeOther(otherText);
        })}
        {otherOpen && (
          <input
            type="text"
            inputMode="decimal"
            value={otherText}
            onChange={(e) => typeOther(e.target.value)}
            placeholder="เช่น 2"
            aria-label="อัตราหัก ณ ที่จ่าย (%)"
            style={{ width: 80, textAlign: "right" }}
            autoFocus
          />
        )}
      </div>
      {otherInvalid && (
        <div className="customer-message error" style={{ margin: 0 }}>
          ใส่อัตราหัก ณ ที่จ่าย 0-100
        </div>
      )}
      {differs && !otherInvalid && (
        <label
          className="customer-message error"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            margin: 0,
          }}
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheckedChange(e.target.checked)}
            style={{ marginTop: 3 }}
          />
          <span>
            อัตรานี้ไม่ตรงกับ{defaultLabel} ({defaultRate}%) -
            ตรวจแล้วว่าบิลนี้ต้องหัก {rate === 0 ? "0% (ไม่หัก)" : `${rate}%`}
          </span>
        </label>
      )}
    </div>
  );
}
