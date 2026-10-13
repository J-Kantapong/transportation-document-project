"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { VIN_LENGTH, modelPrefix, normalizeChassis, oddChassisChars, type KnownModel } from "@/lib/vehicle-data-check";

// ตัวช่วยกันคีย์ข้อมูลรถผิดในหน้าคีย์รถ (ผู้ใช้ 2026-10-13) - กฎอยู่ที่ backend/src/vehicles/vehicle-data-check.ts
// ทุกอย่างในไฟล์นี้เป็นคำเตือน ไม่ห้ามบันทึก: backend ตอบ 409 needsConfirm แล้วพนักงานตรวจกับเอกสารและยืนยันเอง

const WARN = "#b5651d";
const OK = "#2e7d4f";

// นับหลักเลขตัวถังให้เห็นตอนพิมพ์ - ไม่ครบ 17 หรือมีตัว I O Q เป็นสีส้ม
export function ChassisCounter({ chassis }: { chassis: string }) {
  const value = normalizeChassis(chassis);
  if (!value) return null;
  const odd = oddChassisChars(value);
  const bad = value.length !== VIN_LENGTH || odd.length > 0;
  return (
    <span style={{ fontSize: 12, fontWeight: 400, color: bad ? WARN : OK }}>
      {value.length}/{VIN_LENGTH} หลัก{odd.length ? ` · มีตัว ${odd.join(" ")} (ปกติไม่ใช้ในเลขตัวถัง)` : ""}
    </span>
  );
}

function useKnownModel(chassis: string, excludeId?: string): KnownModel | null {
  const prefix = modelPrefix(chassis);
  // เก็บผลพร้อมรุ่นที่ถาม - เลขตัวถังเปลี่ยนรุ่นแล้วผลเก่าไม่ถูกแสดงจนกว่าคำตอบของรุ่นใหม่จะมา
  const key = prefix ? `${prefix}:${excludeId ?? ""}` : "";
  const [result, setResult] = useState<{ key: string; model: KnownModel | null }>({ key: "", model: null });
  useEffect(() => {
    if (!key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .knownModel(prefix, excludeId)
        .then((r) => {
          if (!cancelled) setResult({ key, model: r.model });
        })
        .catch(() => {
          if (!cancelled) setResult({ key, model: null });
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, prefix, excludeId]);
  return key && result.key === key ? result.model : null;
}

// "รุ่นนี้เคยคีย์": ยี่ห้อ / CC / ประเภทรถ ของรถในระบบที่เลขตัวถังขึ้นต้นเหมือนกัน + ปุ่มเติมค่าให้ + บอกช่องที่คีย์ไม่ตรง
export function KnownModelHint({
  chassis,
  excludeId,
  brandId,
  cc,
  body,
  onApply,
}: {
  chassis: string;
  excludeId?: string;
  brandId: string;
  cc: string;
  body: string;
  onApply: (values: { brandId?: string; cc?: string; body?: string }) => void;
}) {
  const model = useKnownModel(chassis, excludeId);
  if (!model) return null;

  const ccNumber = cc.trim() === "" ? null : Number(cc);
  const fields = [
    model.brand && { label: "ยี่ห้อ", known: model.brand.name, filled: brandId !== "", same: brandId === model.brand.id },
    model.cc !== null && { label: "CC", known: String(model.cc), filled: ccNumber !== null, same: ccNumber === model.cc },
    model.body && { label: "ประเภทรถ", known: model.body, filled: body !== "", same: body === model.body },
  ].filter((f): f is { label: string; known: string; filled: boolean; same: boolean } => Boolean(f));
  const different = fields.filter((f) => f.filled && !f.same);
  const allSame = fields.every((f) => f.same);

  return (
    <div
      role="status"
      style={{
        gridColumn: "1 / -1",
        padding: "10px 14px",
        border: `1px solid ${different.length ? "#f0d9ae" : "#d5e3f5"}`,
        background: different.length ? "#fffaf0" : "#f5f9ff",
        borderRadius: 8,
        fontSize: 13,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px 14px",
      }}
    >
      <span>
        รุ่นนี้เคยคีย์ {model.count} คัน (เลขตัวถังขึ้นต้น {model.prefix}): <strong>{fields.map((f) => f.known).join(" · ")}</strong>
      </span>
      {allSame ? (
        <span style={{ color: OK }}>✓ ตรงกับที่เคยคีย์</span>
      ) : (
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onApply({
              ...(model.brand ? { brandId: model.brand.id } : {}),
              ...(model.cc !== null ? { cc: String(model.cc) } : {}),
              ...(model.body ? { body: model.body } : {}),
            })
          }
        >
          ใช้ค่านี้
        </button>
      )}
      {different.length > 0 && (
        <span style={{ color: WARN, flexBasis: "100%" }}>
          ⚠ ที่คีย์ไว้ไม่ตรงกับรุ่นนี้: {different.map((f) => `${f.label} (ปกติ ${f.known})`).join(" · ")} - ตรวจกับเอกสารอีกครั้ง
        </span>
      )}
    </div>
  );
}

// กล่องคำเตือนก่อนบันทึก: ต้องติ๊กว่าตรวจกับเอกสารแล้วจึงกดยืนยันได้ (ระบบเก็บว่าใครยืนยันข้ามคำเตือน)
// ใส่ key จากคำเตือนที่แสดง เพื่อให้ช่องติ๊กถูกล้างเมื่อคำเตือนเปลี่ยน
export function DataWarningBox({
  messages,
  saving,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  messages: string[];
  saving: boolean;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [checked, setChecked] = useState(false);
  return (
    <div role="alert" style={{ marginTop: 16, padding: "12px 16px", border: "1px solid #f0d9ae", background: "#fffaf0", borderRadius: 8, fontSize: 13 }}>
      <strong style={{ color: "#bb8527" }}>ข้อมูลน่าจะคีย์ผิด - ยังไม่ได้บันทึก</strong>
      <ul style={{ margin: "8px 0", paddingLeft: 20, display: "grid", gap: 4 }}>
        {messages.map((message) => (
          <li key={message}>{message}</li>
        ))}
      </ul>
      <DataWarningCheck checked={checked} onChange={setChecked} />
      <div className="form-actions" style={{ marginTop: 12 }}>
        <button type="button" className="primary" disabled={saving || !checked} onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button type="button" className="text-button" disabled={saving} onClick={onCancel}>
          กลับไปแก้ข้อมูล
        </button>
      </div>
    </div>
  );
}

export function DataWarningCheck({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", fontWeight: 600 }}>
      <input
        type="checkbox"
        style={{ width: 18, height: 18, minHeight: 0, padding: 0, margin: 0 }}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      ตรวจกับเอกสารแล้ว ข้อมูลที่คีย์ถูกต้อง
    </label>
  );
}
