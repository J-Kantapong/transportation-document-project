"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  ApiError,
  type TaxRenewal,
  type TaxRenewalInput,
  type TaxRenewalPreview,
  type TaxRenewalVehicleHit,
} from "@/lib/api";
import { canEditSubmitSteps, getCachedUser, writeScopeFor, type UserRole, type VehicleScope } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import { isMotorcycleBody } from "@/lib/vehicle-kind";
import { FUEL_TYPES, VEHICLE_TYPES } from "@/lib/vehicle-reference-data";
import { DateInput } from "@/components/DateInput";

type Source = "VEHICLE" | "MANUAL";

interface FormState {
  customerId: string; // เจ้าของงาน - บังคับเมื่อกรอกรถเอง (รถจากระบบใช้ลูกค้าของรถ)
  submitDate: string; // วันที่ยื่นงาน - ตั้งต้นเป็นวันที่ทำรายการ
  source: Source;
  vehicleId: string;
  chassis: string;
  engine: string;
  plateCategory: string;
  plateNumber: string;
  vehicleType: string;
  fuel: string;
  cc: string;
  weight: string;
  firstRegistrationDate: string;
  // "" = ยังไม่ได้เลือก - ประเภทเจ้าของรถบังคับกรอกเสมอ จึงไม่ตั้งค่าเริ่มต้นเป็นบุคคลธรรมดาให้เงียบๆ
  ownerType: "" | "INDIVIDUAL" | "JURISTIC";
  // ติดไฟแนนซ์ (เช่าซื้อ) - ติ๊กแล้ว ownerType คือประเภทผู้ครอบครอง (ผู้เช่าซื้อ) แบบเดียวกับหน้าเพิ่มข้อมูลรถ
  // ใช้เฉพาะรถที่กรอกเอง/รถในระบบที่ยังไม่มีเจ้าของ - รถที่มีเจ้าของแล้ว backend อ่านเรื่องไฟแนนซ์จากรถเอง
  financed: boolean;
  ownerName: string;
  taxExpiryDate: string;
  paymentDate: string;
  inspectionConfirmed: boolean;
  insuranceConfirmed: boolean;
  skipContribution: boolean;
}

const EMPTY: FormState = {
  customerId: "",
  submitDate: "",
  source: "VEHICLE",
  vehicleId: "",
  chassis: "",
  engine: "",
  plateCategory: "",
  plateNumber: "",
  vehicleType: "",
  fuel: "",
  cc: "",
  weight: "",
  firstRegistrationDate: "",
  ownerType: "",
  financed: false,
  ownerName: "",
  taxExpiryDate: "",
  paymentDate: "",
  inspectionConfirmed: false,
  insuranceConfirmed: false,
  skipContribution: false,
};

// ฟอร์มเปล่าพร้อมใช้ - วันที่ยื่นงานตั้งต้นเป็นวันที่ทำรายการ (อ่านตอนเปิดฟอร์ม ไม่ใช่ตอน import
// ไม่งั้นแท็บที่เปิดค้างข้ามวันจะยังได้วันเก่า)
const freshForm = (): FormState => ({ ...EMPTY, submitDate: isoToDisplayDate(todayIso()) });

const baht =(n: number | string | null | undefined) =>
  n === null || n === undefined ? "-" : Number(n).toLocaleString("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ช่องวันที่เก็บเป็นข้อความ วว/ดด/ปปปป ตามทั้งระบบ (ดู lib/date.ts) - แปลงเป็น ISO ตอนส่ง backend
const toIso = (text: string) => displayDateToIso(text.replace(/\D/g, ""));

function toInput(form: FormState): TaxRenewalInput {
  const shared = {
    submitDate: toIso(form.submitDate),
    taxExpiryDate: toIso(form.taxExpiryDate),
    paymentDate: toIso(form.paymentDate) || null,
    inspectionConfirmed: form.inspectionConfirmed,
    insuranceConfirmed: form.insuranceConfirmed,
    skipContribution: form.skipContribution,
  };
  // รถที่ยังไม่ถึงขั้นที่ 4 อาจยังไม่มีวันจดทะเบียน/เชื้อเพลิง/เจ้าของ - ส่งค่าที่กรอกเสริมไปด้วย
  // backend ใช้ข้อมูลของ Vehicle ก่อนเสมอ ค่าพวกนี้ถูกใช้เฉพาะช่องที่รถยังว่าง
  if (form.source === "VEHICLE")
    return {
      ...shared,
      vehicleId: form.vehicleId,
      customerId: form.customerId || undefined,
      firstRegistrationDate: toIso(form.firstRegistrationDate),
      fuel: form.fuel || undefined,
      cc: form.cc || null,
      weight: form.weight || null,
      ownerType: form.ownerType || undefined,
      financed: form.financed,
      // รถที่ยังไม่ได้รับป้ายไม่มีทะเบียนในระบบ - ส่งค่าที่กรอกเสริมไป (backend ใช้ของ Vehicle ก่อนเสมอ)
      plateCategory: form.plateCategory || undefined,
      plateNumber: form.plateNumber || undefined,
    };
  return {
    ...shared,
    customerId: form.customerId || null,
    chassis: form.chassis,
    engine: form.engine || null,
    plateCategory: form.plateCategory,
    plateNumber: form.plateNumber,
    vehicleType: form.vehicleType,
    fuel: form.fuel,
    cc: form.cc || null,
    weight: form.weight || null,
    firstRegistrationDate: toIso(form.firstRegistrationDate),
    ownerType: form.ownerType || undefined,
    financed: form.financed,
    ownerName: form.ownerName || null,
  };
}

// ช่องที่รถในฐานข้อมูลยังไม่มี และจำเป็นต่อการคำนวณภาษี - ต้องให้พนักงานกรอกเสริม
// cc ใช้กับ รย.1 ที่ไม่ใช่ไฟฟ้า, น้ำหนักใช้กับ รย.1 ไฟฟ้า/รย.2/รย.3, รย.12 เหมาจ่ายไม่ต้องใช้ทั้งคู่
function missingVehicleFields(v: TaxRenewalVehicleHit | null): Array<keyof FormState> {
  if (!v) return [];
  const missing: Array<keyof FormState> = [];
  // หมวด/เลขทะเบียนบังคับเสมอ รถที่ยังไม่ได้รับป้ายจึงต้องกรอกเองก่อนบันทึก (เลขตัวถังรถในระบบมีเสมอ)
  if (!v.plateCategory) missing.push("plateCategory");
  if (!v.plateNumber) missing.push("plateNumber");
  if (!v.firstRegistrationDate) missing.push("firstRegistrationDate");
  if (!v.fuel) missing.push("fuel");
  if (!v.ownerType) missing.push("ownerType");
  const fuel = v.fuel ?? "";
  const isMoto = isMotorcycleBody(v.body);
  const isRy1 = v.body?.startsWith("รย.1-") ?? false;
  const needsCc = isRy1 && fuel !== "ไฟฟ้า (BEV)";
  // cc/น้ำหนัก 0 = ยังไม่รู้ค่าจริง ต้องเปิดช่องให้กรอกเหมือนค่าว่าง (พบ 2026-09-27)
  if (!isMoto) {
    if (needsCc && !v.cc) missing.push("cc");
    if (!needsCc && !v.weight) missing.push("weight");
  }
  return missing;
}

// ช่องวันที่ที่พิมพ์แล้วแต่แปลงเป็นวันที่ไม่ได้ (พิมพ์ไม่ครบ 8 หลัก หรือวันที่ไม่มีจริง เช่น 31/02) - เดิมส่งไปเป็นค่าว่างเงียบๆ
// วันที่ชำระจึงถูกบันทึกเป็นยังไม่ชำระ และวันที่บังคับขึ้นว่า "กรุณาระบุ…" ทั้งที่กรอกแล้ว (พบ 2026-09-27)
function invalidDateMessage(form: FormState, missing: Array<keyof FormState>): string | null {
  const fields: Array<[keyof FormState, string]> = [
    ["submitDate", "วันที่ยื่นงาน"],
    ["taxExpiryDate", "วันครบกำหนดภาษี"],
    ["paymentDate", "วันที่ชำระภาษี"],
  ];
  // วันจดทะเบียนครั้งแรกมีช่องเฉพาะรถที่กรอกเอง หรือรถในระบบที่ยังไม่มีวันนี้
  if (form.source === "MANUAL" || missing.includes("firstRegistrationDate")) {
    fields.push(["firstRegistrationDate", "วันจดทะเบียนครั้งแรก"]);
  }
  for (const [key, label] of fields) {
    const text = String(form[key]);
    if (text.replace(/\D/g, "") && !toIso(text)) return `${label}ไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป`;
  }
  return null;
}

// บันทึก/แก้ได้เฉพาะประเภทรถในขอบเขตของผู้ใช้ (STAFF_CAR = รถยนต์, STAFF_MOTO = จักรยานยนต์) - backend กันอีกชั้น
function inWriteScope(scope: VehicleScope, vehicleType: string | null): boolean {
  if (scope === "ALL") return true;
  if (scope === "NONE") return false;
  return isMotorcycleBody(vehicleType) === (scope === "MOTO");
}

// ครบพอที่จะคิดยอดได้หรือยัง - กัน preview ยิงรัวตอนพิมพ์วันที่ยังไม่ครบ 8 หลัก
function readyForPreview(form: FormState, selected: TaxRenewalVehicleHit | null): boolean {
  if (!toIso(form.taxExpiryDate)) return false;
  if (form.paymentDate.replace(/\D/g, "") && !toIso(form.paymentDate)) return false;
  if (form.source === "VEHICLE") {
    if (!form.vehicleId) return false;
    return missingVehicleFields(selected).every((f) =>
      f === "firstRegistrationDate" ? Boolean(toIso(form.firstRegistrationDate)) : Boolean(form[f]),
    );
  }
  return Boolean(
    form.chassis &&
      form.plateCategory &&
      form.plateNumber &&
      form.vehicleType &&
      form.fuel &&
      form.ownerType &&
      toIso(form.firstRegistrationDate),
  );
}

// เจ้าของงาน = ลูกค้าที่ส่งงานมา (ผู้ใช้ 2026-10-08) - dropdown จากฐานข้อมูลลูกค้า
export function useCustomerOptions() {
  const [options, setOptions] = useState<Array<{ id: string; label: string }>>([]);
  useEffect(() => {
    api
      .listCustomers()
      .then((data) => setOptions(data.customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") }))))
      .catch(() => undefined);
  }, []);
  return options;
}

export function TaxRenewalPage() {
  const customerOptions = useCustomerOptions();
  const [form, setForm] = useState<FormState>(freshForm);
  const [selectedVehicle, setSelectedVehicle] = useState<TaxRenewalVehicleHit | null>(null);
  const [rows, setRows] = useState<TaxRenewal[]>([]);
  const [preview, setPreview] = useState<TaxRenewalPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  // ✎ แก้ / ยกเลิกงานที่บันทึกผิด (ผู้ใช้ 2026-09-27) - ต้องมีเหตุผลเสมอ
  const [dialog, setDialog] = useState<{ kind: "edit" | "cancel"; row: TaxRenewal } | null>(null);
  // บันทึก/แก้ได้เฉพาะ ADMIN / STAFF_CAR / STAFF_MOTO (backend: POST/PATCH /api/tax-renewals = SUBMIT)
  // ACCOUNTANT เปิดหน้าได้แต่อ่านอย่างเดียว - ซ่อนฟอร์มและแสดงตารางเป็นข้อความ (พบ 2026-09-27)
  // localStorage อ่านได้เฉพาะฝั่ง browser จึงตั้งค่าใน effect (null = ยังไม่รู้ ไม่ขึ้น "ดูอย่างเดียว" แวบให้คนที่บันทึกได้)
  const [roles, setRoles] = useState<UserRole[] | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRoles(getCachedUser()?.roles ?? []);
  }, []);
  const canWrite = canEditSubmitSteps(roles ?? []);
  const readOnly = roles !== null && !canWrite;
  const writeScope = writeScopeFor(roles ?? []);
  const canWriteRow = (vehicleType: string) => canWrite && inWriteScope(writeScope, vehicleType);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const missing = missingVehicleFields(form.source === "VEHICLE" ? selectedVehicle : null);
  const ready = readyForPreview(form, selectedVehicle);

  const reload = useCallback(async () => {
    try {
      setRows(await api.listTaxRenewals());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "โหลดรายการไม่สำเร็จ");
    }
  }, []);

  useEffect(() => {
    // โหลดรายการครั้งแรกตอนเปิดหน้า - setState อยู่หลัง await ของ reload()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void reload();
  }, [reload]);

  // คิดยอดสดจาก backend (ตารางอัตราภาษีอยู่ในฐานข้อมูล คิดเองฝั่งเบราว์เซอร์ไม่ได้)
  // ฟอร์มที่ยังกรอกไม่ครบไม่ต้องล้าง state ที่นี่ - ตอน render เลือกแสดงจาก ready เอา
  useEffect(() => {
    if (!readyForPreview(form, selectedVehicle)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .previewTaxRenewal(toInput(form))
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError("");
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(e instanceof ApiError ? e.message : "คิดยอดไม่สำเร็จ");
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form, selectedVehicle]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMessage("");
    const dateError = invalidDateMessage(form, missing);
    if (dateError) {
      setError(dateError);
      return;
    }
    if (form.source === "MANUAL" && !form.customerId) {
      setError("กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)");
      return;
    }
    setSaving(true);
    try {
      await api.createTaxRenewal(toInput(form));
      setForm(freshForm());
      setSelectedVehicle(null);
      setPreview(null);
      setMessage("บันทึกงานต่อภาษีแล้ว");
      await reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  async function patch(id: string, data: Parameters<typeof api.updateTaxRenewal>[1]): Promise<boolean> {
    setError("");
    try {
      await api.updateTaxRenewal(id, data);
      await reload();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
      return false;
    }
  }

  return (
    <>
      {canWrite && (
        <div className="panel">
          <div className="panel-head">
            <h2>เพิ่มงานต่อภาษี</h2>
          </div>
          <form onSubmit={submit} style={{ padding: "0 23px 24px" }}>
            {/* วันที่ยื่นงาน - ข้อมูลของงาน ไม่ใช่ของรถ จึงอยู่เหนือแท็บเลือกรถ */}
            <div className="vehicle-fields" style={{ marginBottom: 18 }}>
              <label className="field">
                <span>วันที่ยื่นงาน *</span>
                <DateTextInput value={form.submitDate} onChange={(v) => set("submitDate", v)} required />
              </label>
            </div>
            <div className="vehicle-tabs" style={{ marginBottom: 22 }}>
              {(["VEHICLE", "MANUAL"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`vehicle-tab${form.source === s ? " active" : ""}`}
                  onClick={() => set("source", s)}
                >
                  {s === "VEHICLE" ? "เลือกรถจากระบบ" : "กรอกข้อมูลรถเอง"}
                </button>
              ))}
            </div>

            <div className="vehicle-fields">
              {form.source === "VEHICLE" ? (
                <div className="field wide">
                  <span>ค้นหารถในฐานข้อมูล</span>
                  <VehicleSearch
                    selected={selectedVehicle}
                    onSelect={(v) => {
                      setSelectedVehicle(v);
                      set("vehicleId", v?.id ?? "");
                      set("customerId", v?.customerId ?? "");
                    }}
                  />
                  {selectedVehicle && (
                    <label className="field" style={{ marginTop: 12, maxWidth: 420 }}>
                      <span>เจ้าของงาน (ลูกค้าที่ส่งงานมา)</span>
                      <select value={form.customerId} onChange={(e) => set("customerId", e.target.value)}>
                        <option value="">ไม่ระบุ</option>
                        {customerOptions.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {missing.length > 0 && (
                    <p className="sub" style={{ marginTop: 10 }}>
                      รถคันนี้ยังไม่มีข้อมูลที่ต้องใช้คำนวณภาษี กรุณากรอกเพิ่ม
                    </p>
                  )}
                </div>
              ) : (
                <>
                  <label className="field wide">
                    <span>เจ้าของงาน * (ลูกค้าที่ส่งงานมา)</span>
                    <select value={form.customerId} onChange={(e) => set("customerId", e.target.value)} required>
                      <option value="">เลือกลูกค้า</option>
                      {customerOptions.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>เลขตัวถัง *</span>
                    <input value={form.chassis} onChange={(e) => set("chassis", e.target.value)} required />
                  </label>
                  <label className="field">
                    <span>เลขเครื่อง</span>
                    <input value={form.engine} onChange={(e) => set("engine", e.target.value)} />
                  </label>
                  <label className="field">
                    <span>หมวดทะเบียน *</span>
                    <input
                      value={form.plateCategory}
                      onChange={(e) => set("plateCategory", e.target.value)}
                      placeholder="4กข"
                      required
                    />
                  </label>
                  <label className="field">
                    <span>เลขทะเบียน *</span>
                    <input
                      value={form.plateNumber}
                      onChange={(e) => set("plateNumber", e.target.value)}
                      placeholder="4444"
                      required
                    />
                  </label>
                  <label className="field wide">
                    <span>ชื่อเจ้าของรถ</span>
                    <input value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} />
                  </label>
                  <label className="field">
                    <span>ประเภทรถ</span>
                    <select value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)} required>
                      <option value="">เลือกประเภทรถ</option>
                      {VEHICLE_TYPES.filter((t) => inWriteScope(writeScope, t)).map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>ประเภทเชื้อเพลิง</span>
                    <select value={form.fuel} onChange={(e) => set("fuel", e.target.value)} required>
                      <option value="">เลือกเชื้อเพลิง</option>
                      {FUEL_TYPES.map((f) => (
                        <option key={f} value={f}>
                          {f}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>ขนาด CC</span>
                    <input value={form.cc} onChange={(e) => set("cc", e.target.value)} inputMode="decimal" />
                  </label>
                  <label className="field">
                    <span>น้ำหนักรถ (กก.)</span>
                    <input value={form.weight} onChange={(e) => set("weight", e.target.value)} inputMode="decimal" />
                  </label>
                  <label className="field">
                    <span>วันจดทะเบียนครั้งแรก</span>
                    <DateTextInput
                      value={form.firstRegistrationDate}
                      onChange={(v) => set("firstRegistrationDate", v)}
                      required
                    />
                  </label>
                  <OwnerTypeFields
                    ownerType={form.ownerType}
                    financed={form.financed}
                    onOwnerTypeChange={(v) => set("ownerType", v)}
                    onFinancedChange={(v) => set("financed", v)}
                  />
                </>
              )}

              {missing.includes("plateCategory") && (
                <label className="field">
                  <span>หมวดทะเบียน *</span>
                  <input
                    value={form.plateCategory}
                    onChange={(e) => set("plateCategory", e.target.value)}
                    placeholder="4กข"
                    required
                  />
                </label>
              )}
              {missing.includes("plateNumber") && (
                <label className="field">
                  <span>เลขทะเบียน *</span>
                  <input
                    value={form.plateNumber}
                    onChange={(e) => set("plateNumber", e.target.value)}
                    placeholder="4444"
                    required
                  />
                </label>
              )}
              {missing.includes("firstRegistrationDate") && (
                <label className="field">
                  <span>วันจดทะเบียนครั้งแรก</span>
                  <DateTextInput
                    value={form.firstRegistrationDate}
                    onChange={(v) => set("firstRegistrationDate", v)}
                    required
                  />
                </label>
              )}
              {missing.includes("fuel") && (
                <label className="field">
                  <span>ประเภทเชื้อเพลิง</span>
                  <select value={form.fuel} onChange={(e) => set("fuel", e.target.value)} required>
                    <option value="">เลือกเชื้อเพลิง</option>
                    {FUEL_TYPES.map((f) => (
                      <option key={f} value={f}>
                        {f}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {missing.includes("cc") && (
                <label className="field">
                  <span>ขนาด CC</span>
                  <input value={form.cc} onChange={(e) => set("cc", e.target.value)} inputMode="decimal" required />
                </label>
              )}
              {missing.includes("weight") && (
                <label className="field">
                  <span>น้ำหนักรถ (กก.)</span>
                  <input
                    value={form.weight}
                    onChange={(e) => set("weight", e.target.value)}
                    inputMode="decimal"
                    required
                  />
                </label>
              )}
              {missing.includes("ownerType") && (
                <OwnerTypeFields
                  ownerType={form.ownerType}
                  financed={form.financed}
                  onOwnerTypeChange={(v) => set("ownerType", v)}
                  onFinancedChange={(v) => set("financed", v)}
                />
              )}

              <label className="field">
                <span>วันครบกำหนดภาษี</span>
                <DateTextInput value={form.taxExpiryDate} onChange={(v) => set("taxExpiryDate", v)} required />
              </label>
              <label className="field">
                <span>วันที่ชำระภาษี (เว้นว่างได้ กรอกทีหลังในตาราง)</span>
                <DateTextInput value={form.paymentDate} onChange={(v) => set("paymentDate", v)} />
              </label>
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 20, marginTop: 22 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={form.inspectionConfirmed}
                  onChange={(e) => set("inspectionConfirmed", e.target.checked)}
                />
                มีใบตรวจ ตรอ. แล้ว
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={form.insuranceConfirmed}
                  onChange={(e) => set("insuranceConfirmed", e.target.checked)}
                />
                มี พ.ร.บ. แล้ว
              </label>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14 }}>
                <input
                  type="checkbox"
                  checked={form.skipContribution}
                  onChange={(e) => set("skipContribution", e.target.checked)}
                />
                ไม่มีค่าลงขัน
              </label>
            </div>

            {ready && previewError && <p className="customer-message error">{previewError}</p>}
            {ready && preview && <PreviewSummary preview={preview} />}

            <div className="form-actions">
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "กำลังบันทึก..." : "บันทึกงานต่อภาษี"}
              </button>
              {message && <span className="customer-message success">{message}</span>}
              {error && <span className="customer-message error">{error}</span>}
            </div>
          </form>
        </div>
      )}

      <div className="panel customer-list">
        <div className="panel-head">
          <h2>รายการงานต่อภาษี</h2>
          <Link href="/registration/tax-renewal/receipt" className="text-button">
            รับใบเสร็จ →
          </Link>
          {readOnly && <span className="muted">ดูอย่างเดียว</span>}
        </div>
        {/* error โหลดรายการ - ปกติแสดงใต้ฟอร์มด้านบน แต่ผู้ใช้ที่ดูอย่างเดียวไม่มีฟอร์ม */}
        {!canWrite && error && (
          <p className="customer-message error" style={{ padding: "0 23px" }}>
            {error}
          </p>
        )}
        {rows.length === 0 ? (
          <p className="empty-customers">ยังไม่มีงานต่อภาษี</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ทะเบียน</th>
                  <th>ประเภทรถ</th>
                  <th>ครบกำหนด</th>
                  <th>ตรอ.</th>
                  <th>พ.ร.บ.</th>
                  <th>ยอด Bill</th>
                  <th>ลงขัน</th>
                  <th>วันที่ชำระ</th>
                  <th>รับป้ายภาษี</th>
                  <th>คืนลูกค้า</th>
                  {canWrite && <th />}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  // ดูอย่างเดียว (ACCOUNTANT / รถนอกขอบเขตของผู้ใช้): ช่องติ๊ก disabled และวันที่เป็นข้อความ
                  const editable = canWriteRow(row.vehicleType);
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="job">
                          {row.plateCategory} {row.plateNumber}
                        </div>
                        {row.customer && <div className="sub">{row.customer.company || row.customer.name}</div>}
                      </td>
                      <td>{row.vehicleType}</td>
                      <td>{isoToDisplayDate(row.taxExpiryDate.slice(0, 10))}</td>
                      <td>
                        {row.inspectionRequired ? (
                          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
                            <input
                              type="checkbox"
                              checked={row.inspectionConfirmed}
                              disabled={!editable}
                              onChange={(e) => void patch(row.id, { inspectionConfirmed: e.target.checked })}
                            />
                            <span className={row.inspectionConfirmed ? "badge" : "badge warn"}>
                              {row.inspectionConfirmed ? "มีใบตรวจ" : "ต้องตรวจ"}
                            </span>
                          </label>
                        ) : (
                          <span className="muted">ไม่ต้องตรวจ</span>
                        )}
                      </td>
                      <td>
                        <input
                          type="checkbox"
                          checked={row.insuranceConfirmed}
                          disabled={!editable}
                          onChange={(e) => void patch(row.id, { insuranceConfirmed: e.target.checked })}
                        />
                      </td>
                      <td>{baht(row.billTotal)}</td>
                      <td>{baht(row.noBillTotal)}</td>
                      {/* key มีวันที่ที่บันทึกไว้ด้วย: ล้างวันที่ผ่าน ✎ แก้แล้วช่องต้องเริ่มใหม่ ไม่ค้างวันที่เดิมที่พิมพ์ไว้ในช่อง (พบ 2026-09-27) */}
                      <td>
                        <DateCell
                          key={`payment:${row.paymentDate ?? ""}`}
                          value={row.paymentDate}
                          readOnly={!editable}
                          onSave={(v) => patch(row.id, { paymentDate: v })}
                        />
                      </td>
                      <td>
                        <DateCell
                          key={`received:${row.receivedDate ?? ""}`}
                          value={row.receivedDate}
                          readOnly={!editable}
                          onSave={(v) => patch(row.id, { receivedDate: v })}
                        />
                      </td>
                      <td>
                        {/* คืนลูกค้าผ่านใบส่งงาน DL (หน้า Delivery, ผู้ใช้ 2026-10-08) - แก้วันที่ที่ใบ DL เท่านั้น / แถวเก่าที่กรอกมือยังแก้ได้ */}
                        <DateCell
                          key={`delivered:${row.deliveredDate ?? ""}`}
                          value={row.deliveredDate}
                          readOnly={!editable || !!row.deliveryRecipient}
                          onSave={(v) => patch(row.id, { deliveredDate: v })}
                        />
                        {row.deliveryRecipient && (
                          <div className="muted" title="บันทึกจากหน้า Delivery - แก้วันที่หรือยกเลิกที่รายงานส่งงาน">
                            ใบ DL · ผู้รับ {row.deliveryRecipient}
                          </div>
                        )}
                      </td>
                      {canWrite && (
                        <td>
                          {editable && (
                            <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
                              <button type="button" className="text-button" onClick={() => setDialog({ kind: "edit", row })}>
                                ✎ แก้
                              </button>
                              <button
                                type="button"
                                className="text-button"
                                style={{ color: "#b43434" }}
                                onClick={() => setDialog({ kind: "cancel", row })}
                              >
                                ยกเลิก
                              </button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.kind === "edit" && (
        <EditRenewalDialog
          row={dialog.row}
          writeScope={writeScope}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setMessage("แก้งานต่อภาษีแล้ว");
            void reload();
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelRenewalDialog
          row={dialog.row}
          onClose={() => setDialog(null)}
          onCancelled={() => {
            setMessage("ยกเลิกงานต่อภาษีแล้ว");
            void reload();
          }}
        />
      )}
    </>
  );
}

const ownerSelectValue = (row: TaxRenewal): FormState["ownerType"] => (row.financed ? (row.hirerType ?? "") : row.ownerType);
const isoOrNull = (text: string) => (text.replace(/\D/g, "") ? toIso(text) : null);

// ✎ แก้งานต่อภาษีที่บันทึกผิด (ผู้ใช้ 2026-09-27): ข้อมูลรถ/ภาษี วันที่ต่างๆ และลงขัน - ต้องมีเหตุผล (เก็บประวัติ)
// ยอดเงินคิดใหม่ที่ backend ตามข้อมูลที่แก้ (ถ้าชำระแล้ว) / ล้างวันที่ชำระ = ล้างยอดเงิน
// เลือกรถผิดคัน = ยกเลิกงานแล้วบันทึกใหม่ (รถจากระบบแก้เลขตัวถัง/เลขเครื่องไม่ได้) / เจ้าของที่มาจากข้อมูลรถแก้ที่ข้อมูลรถ
function EditRenewalDialog({
  row,
  writeScope,
  onClose,
  onSaved,
}: {
  row: TaxRenewal;
  writeScope: VehicleScope;
  onClose: () => void;
  onSaved: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const customerOptions = useCustomerOptions();
  const dateText = (iso: string | null) => isoToDisplayDate((iso ?? "").slice(0, 10));
  const [form, setForm] = useState({
    customerId: row.customerId ?? "",
    submitDate: dateText(row.submitDate),
    taxExpiryDate: dateText(row.taxExpiryDate),
    paymentDate: dateText(row.paymentDate),
    receivedDate: dateText(row.receivedDate),
    deliveredDate: dateText(row.deliveredDate),
    chassis: row.chassis,
    engine: row.engine ?? "",
    plateCategory: row.plateCategory,
    plateNumber: row.plateNumber,
    vehicleType: row.vehicleType,
    fuel: row.fuel,
    cc: row.cc ? String(Number(row.cc)) : "",
    weight: row.weight ? String(Number(row.weight)) : "",
    firstRegistrationDate: dateText(row.firstRegistrationDate),
    ownerType: ownerSelectValue(row),
    financed: row.financed,
    ownerName: row.ownerName ?? "",
    skipContribution: row.skipContribution,
  });
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const manual = !row.vehicleId;
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((prev) => ({ ...prev, [key]: value }));

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  async function save() {
    setError("");
    const required: Array<[keyof typeof form, string]> = [
      ["submitDate", "วันที่ยื่นงาน"],
      ["taxExpiryDate", "วันครบกำหนดภาษี"],
      ["firstRegistrationDate", "วันจดทะเบียนครั้งแรก"],
    ];
    for (const [key, label] of required) {
      if (!toIso(String(form[key]))) return setError(`${label}ไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป`);
    }
    const optional: Array<[keyof typeof form, string]> = [
      ["paymentDate", "วันที่ชำระภาษี"],
      ["receivedDate", "วันที่รับป้ายภาษี"],
      ["deliveredDate", "วันที่คืนลูกค้า"],
    ];
    for (const [key, label] of optional) {
      const text = String(form[key]);
      if (text.replace(/\D/g, "") && !toIso(text)) return setError(`${label}ไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป หรือเว้นว่าง`);
    }
    if (!row.ownerFromVehicle && !form.ownerType) return setError("กรุณาเลือกประเภทเจ้าของรถ");
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้");
    setSaving(true);
    try {
      await api.updateTaxRenewal(row.id, {
        // ส่งเฉพาะเมื่อเลือกเจ้าของงานที่ต่างจากเดิม
        ...(form.customerId && form.customerId !== (row.customerId ?? "") ? { customerId: form.customerId } : {}),
        submitDate: toIso(form.submitDate),
        taxExpiryDate: toIso(form.taxExpiryDate),
        paymentDate: isoOrNull(form.paymentDate),
        receivedDate: isoOrNull(form.receivedDate),
        deliveredDate: isoOrNull(form.deliveredDate),
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        // ส่งเฉพาะเมื่อเปลี่ยน - ค่าเดิมจากข้อมูลรถบางคันอาจไม่อยู่ในรายการตัวเลือก (backend ตรวจรายการเฉพาะค่าที่ส่งมา)
        ...(form.vehicleType !== row.vehicleType ? { vehicleType: form.vehicleType } : {}),
        ...(form.fuel !== row.fuel ? { fuel: form.fuel } : {}),
        cc: form.cc || null,
        weight: form.weight || null,
        firstRegistrationDate: toIso(form.firstRegistrationDate),
        ownerName: form.ownerName || null,
        skipContribution: form.skipContribution,
        // รถจากระบบ: เลขตัวถัง/เลขเครื่องมาจากข้อมูลรถ / เจ้าของที่มาจากข้อมูลรถแก้ที่นี่ไม่ได้ - ไม่ส่งไป
        ...(manual ? { chassis: form.chassis, engine: form.engine || null } : {}),
        ...(!row.ownerFromVehicle && form.ownerType ? { ownerType: form.ownerType, financed: form.financed } : {}),
        remark: remark.trim(),
        // ฟอร์มส่งทุกช่องจากตอนเปิด - มีคนแก้/ติ๊กไปก่อนระหว่างที่เปิดค้างไว้ backend ตอบ 409 ไม่ทับของเขา (พบ 2026-09-27)
        expectedUpdatedAt: row.updatedAt,
      });
      onSaved();
      dialogRef.current?.close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "บันทึกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(760px, 96vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แก้งานต่อภาษี</h2>
      <p className="muted">
        {row.plateCategory} {row.plateNumber} · ตัวถัง {row.chassis}
        {row.customer ? ` · ${row.customer.company || row.customer.name}` : ""}
        {manual ? " · กรอกข้อมูลรถเอง" : " · รถจากระบบ (เลือกผิดคันให้ยกเลิกงานแล้วบันทึกใหม่)"}
      </p>
      <div className="vehicle-fields" style={{ marginTop: 12 }}>
        <label className="field wide">
          <span>เจ้าของงาน (ลูกค้าที่ส่งงานมา)</span>
          <select value={form.customerId} onChange={(e) => set("customerId", e.target.value)}>
            <option value="">{row.customer ? "(ไม่เปลี่ยน)" : "ยังไม่ระบุ - เลือกลูกค้า"}</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>วันที่ยื่นงาน *</span>
          <DateTextInput value={form.submitDate} onChange={(v) => set("submitDate", v)} required />
        </label>
        <label className="field">
          <span>วันครบกำหนดภาษี *</span>
          <DateTextInput value={form.taxExpiryDate} onChange={(v) => set("taxExpiryDate", v)} required />
        </label>
        <label className="field">
          <span>วันที่ชำระภาษี (ลบให้ว่าง = ยังไม่ชำระ)</span>
          <DateTextInput value={form.paymentDate} onChange={(v) => set("paymentDate", v)} />
        </label>
        <label className="field">
          <span>วันที่รับป้ายภาษี</span>
          <DateTextInput value={form.receivedDate} onChange={(v) => set("receivedDate", v)} />
        </label>
        <label className="field">
          <span>วันที่คืนลูกค้า</span>
          <DateTextInput value={form.deliveredDate} onChange={(v) => set("deliveredDate", v)} />
        </label>
        {manual && (
          <>
            <label className="field">
              <span>เลขตัวถัง *</span>
              <input value={form.chassis} onChange={(e) => set("chassis", e.target.value)} />
            </label>
            <label className="field">
              <span>เลขเครื่อง</span>
              <input value={form.engine} onChange={(e) => set("engine", e.target.value)} />
            </label>
          </>
        )}
        <label className="field">
          <span>หมวดทะเบียน *</span>
          <input value={form.plateCategory} onChange={(e) => set("plateCategory", e.target.value)} />
        </label>
        <label className="field">
          <span>เลขทะเบียน *</span>
          <input value={form.plateNumber} onChange={(e) => set("plateNumber", e.target.value)} />
        </label>
        <label className="field">
          <span>ประเภทรถ</span>
          <select value={form.vehicleType} onChange={(e) => set("vehicleType", e.target.value)}>
            {Array.from(new Set([row.vehicleType, ...VEHICLE_TYPES.filter((t) => inWriteScope(writeScope, t))])).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ประเภทเชื้อเพลิง</span>
          <select value={form.fuel} onChange={(e) => set("fuel", e.target.value)}>
            {Array.from(new Set([row.fuel, ...FUEL_TYPES])).map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ขนาด CC</span>
          <input value={form.cc} onChange={(e) => set("cc", e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          <span>น้ำหนักรถ (กก.)</span>
          <input value={form.weight} onChange={(e) => set("weight", e.target.value)} inputMode="decimal" />
        </label>
        <label className="field">
          <span>วันจดทะเบียนครั้งแรก *</span>
          <DateTextInput value={form.firstRegistrationDate} onChange={(v) => set("firstRegistrationDate", v)} required />
        </label>
        {row.ownerFromVehicle ? (
          <div className="field">
            <span>ประเภทเจ้าของรถ</span>
            <span className="sub">อ่านจากข้อมูลรถ - แก้ที่หน้าเพิ่มข้อมูลรถจดใหม่</span>
          </div>
        ) : (
          <OwnerTypeFields
            ownerType={form.ownerType}
            financed={form.financed}
            onOwnerTypeChange={(v) => set("ownerType", v)}
            onFinancedChange={(v) => set("financed", v)}
          />
        )}
        <label className="field wide">
          <span>ชื่อเจ้าของรถ</span>
          <input value={form.ownerName} onChange={(e) => set("ownerName", e.target.value)} />
        </label>
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 14, marginTop: 14 }}>
        <input type="checkbox" checked={form.skipContribution} onChange={(e) => set("skipContribution", e.target.checked)} />
        ไม่มีค่าลงขัน
      </label>
      <p className="sub" style={{ marginTop: 8 }}>
        งานที่ชำระแล้ว: ยอดภาษี/เงินเพิ่ม/ลงขันคิดใหม่ตามข้อมูลที่แก้ (ยอดเดิม Bill {baht(row.billTotal)} · ลงขัน {baht(row.noBillTotal)})
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        <span>เหตุผลที่แก้ *</span>
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น พิมพ์วันครบกำหนดภาษีผิด" />
      </label>
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={() => dialogRef.current?.close()} disabled={saving}>
          ปิด
        </button>
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "กำลังบันทึก..." : "บันทึกการแก้ไข"}
        </button>
      </div>
    </dialog>
  );
}

// ยกเลิกงานต่อภาษี (ผู้ใช้ 2026-09-27): ไม่ลบแถว หายจากรายการ ยอดรวม และภาพรวม - ต้องมีเหตุผล (เก็บประวัติ)
function CancelRenewalDialog({ row, onClose, onCancelled }: { row: TaxRenewal; onClose: () => void; onCancelled: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  async function confirm() {
    setError("");
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่ยกเลิก");
    setSaving(true);
    try {
      await api.cancelTaxRenewal(row.id, remark.trim());
      onCancelled();
      dialogRef.current?.close();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "ยกเลิกไม่สำเร็จ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>ยกเลิกงานต่อภาษี</h2>
      <p className="muted">
        {row.plateCategory} {row.plateNumber} · {row.vehicleType} · ครบกำหนด {isoToDisplayDate(row.taxExpiryDate.slice(0, 10))}
      </p>
      <p style={{ marginTop: 12 }}>
        งานนี้จะหายจากรายการ ยอดรวม และภาพรวม (ยังเก็บไว้ในประวัติพร้อมเหตุผล)
        {row.paymentDate ? ` - งานนี้บันทึกวันที่ชำระแล้ว (${isoToDisplayDate(row.paymentDate.slice(0, 10))}) ยอดเงินจะไม่ถูกนับอีก` : ""}
      </p>
      <label className="field" style={{ marginTop: 12 }}>
        <span>เหตุผลที่ยกเลิก *</span>
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น บันทึกซ้ำ / เลือกรถผิดคัน" />
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
        <button type="button" className="primary" onClick={confirm} disabled={saving}>
          {saving ? "กำลังยกเลิก..." : "ยืนยันยกเลิก"}
        </button>
      </div>
    </dialog>
  );
}

const plateOf = (v: { plateCategory: string | null; plateNumber: string | null }) =>
  [v.plateCategory, v.plateNumber].filter(Boolean).join(" ") || "ยังไม่มีทะเบียน";

// ชื่อเจ้าของรถในช่องค้นหา - โชว์ทั้งผู้ถือกรรมสิทธิ์ (ติดไฟแนนซ์ = ชื่อไฟแนนซ์) และผู้ครอบครอง
// รถที่ยังไม่ได้บันทึกเจ้าของ (ยังไม่ถึงขั้นที่ 4) ไม่มีทั้งคู่ จึงไม่แสดงบรรทัดนี้เลย
function OwnerLine({ v }: { v: TaxRenewalVehicleHit }) {
  const parts = [
    v.ownerName && `ผู้ถือกรรมสิทธิ์ ${v.ownerName}`,
    v.hirerName && `ผู้ครอบครอง ${v.hirerName}`,
  ].filter(Boolean);
  if (!parts.length) return null;
  return <div className="sub">{parts.join(" · ")}</div>;
}

// ค้นรถจาก เลขตัวถัง / เลขเครื่อง / เลขทะเบียน / ชื่อลูกค้า / ผู้ถือกรรมสิทธิ์ / ผู้ครอบครอง
// ฐานข้อมูลรถจะโตขึ้นเรื่อยๆ จึงไม่โหลดมาทั้งหมด
function VehicleSearch({
  selected,
  onSelect,
}: {
  selected: TaxRenewalVehicleHit | null;
  onSelect: (v: TaxRenewalVehicleHit | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TaxRenewalVehicleHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setSearching(true);
      api
        .searchTaxRenewalVehicles(q)
        .then((r) => {
          if (cancelled) return;
          setHits(r.vehicles);
          setSearched(true);
        })
        .catch(() => {
          if (!cancelled) setHits([]);
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  if (selected) {
    return (
      <div
        style={{
          border: "1px solid #dce2ec",
          borderRadius: 8,
          padding: "12px 14px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 12,
          background: "white",
        }}
      >
        <div>
          <div className="job">{plateOf(selected)}</div>
          <div className="sub">
            ตัวถัง {selected.chassis}
            {selected.engine && ` · เครื่อง ${selected.engine}`}
            {selected.customerName && ` · ${selected.customerName}`}
          </div>
          <OwnerLine v={selected} />
        </div>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            onSelect(null);
            setQuery("");
            setHits([]);
            setSearched(false);
          }}
        >
          เปลี่ยนรถ
        </button>
      </div>
    );
  }

  const q = query.trim();
  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="พิมพ์เลขตัวถัง เลขเครื่อง เลขทะเบียน ชื่อลูกค้า ผู้ถือกรรมสิทธิ์ หรือผู้ครอบครอง"
      />
      {q.length >= 2 && (
        <div style={{ marginTop: 8, border: "1px solid #e3e8f1", borderRadius: 8, overflow: "hidden" }}>
          {searching && <div className="sub" style={{ padding: "12px 14px" }}>กำลังค้นหา...</div>}
          {!searching && searched && hits.length === 0 && (
            <div className="sub" style={{ padding: "12px 14px" }}>ไม่พบรถที่ตรงกับคำค้น</div>
          )}
          {!searching &&
            hits.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => onSelect(v)}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  border: 0,
                  borderBottom: "1px solid #f0f2f6",
                  background: "white",
                  padding: "12px 14px",
                  font: "inherit",
                }}
              >
                <div className="job">{plateOf(v)}</div>
                <div className="sub">
                  ตัวถัง {v.chassis}
                  {v.engine && ` · เครื่อง ${v.engine}`}
                  {v.customerName && ` · ${v.customerName}`}
                </div>
                <OwnerLine v={v} />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

function DateTextInput({
  value,
  onChange,
  required,
  className,
  label,
}: {
  value: string;
  onChange: (text: string) => void;
  required?: boolean;
  className?: string;
  label?: string;
}) {
  return (
    <DateInput
      aria-label={label}
      className={className}
      required={required}
      value={value}
      // ป้ายภาษี/ใบเสร็จพิมพ์ปี พ.ศ. - พิมพ์ 2569 ครบ 8 หลักแล้วแปลงเป็น ค.ศ. ให้ทันที (เดิมกลายเป็นค่าว่างเงียบๆ - พบ 2026-09-27)
      onChange={(value) => onChange(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
    />
  );
}

// ช่องวันที่ในตาราง - บันทึกเมื่อพิมพ์ครบ 8 หลัก ถ้า backend ปฏิเสธให้ดึงค่าเดิมกลับมาแสดง
// ครบ 8 หลักแต่ไม่ใช่วันที่จริง (เช่น 31/02) ขึ้นเตือนใต้ช่อง - เดิมค้างข้อความไว้เหมือนบันทึกแล้วทั้งที่ไม่ได้ส่ง (พบ 2026-09-27)
// วันที่ที่กรอกแล้วแสดงเป็นข้อความ - แก้/ล้างต้องผ่านปุ่ม ✎ แก้ พร้อมเหตุผล (ผู้ใช้ 2026-09-27)
function DateCell({
  value,
  readOnly,
  onSave,
}: {
  value: string | null;
  readOnly?: boolean;
  onSave: (v: string | null) => Promise<boolean>;
}) {
  const saved = isoToDisplayDate((value ?? "").slice(0, 10));
  const [text, setText] = useState(saved);
  const [invalid, setInvalid] = useState(false);

  if (readOnly || value) return <span>{saved || "-"}</span>;

  async function handleChange(next: string) {
    setText(next);
    const digits = next.replace(/\D/g, "");
    if (digits.length === 0) {
      setInvalid(false);
      if (!(await onSave(null))) setText(saved);
      return;
    }
    const iso = displayDateToIso(digits);
    setInvalid(digits.length === 8 && !iso);
    if (iso && !(await onSave(iso))) setText(saved);
  }

  return (
    <>
      <DateTextInput value={text} onChange={handleChange} className="inspect-input inspect-input--date" />
      {invalid && <div className="field-error">วันที่ไม่ถูกต้อง</div>}
    </>
  );
}

// ประเภทเจ้าของรถ + ติ๊กไฟแนนซ์ แบบเดียวกับหน้าเพิ่มข้อมูลรถ (ติ๊กแล้วประเภทที่เลือกคือผู้ครอบครอง/ผู้เช่าซื้อ)
// รถติดไฟแนนซ์ที่ผู้เช่าซื้อเป็นบุคคลธรรมดาไม่คูณสองแบบนิติบุคคล (รย.1) - เดิมไม่มีช่องนี้จึงคิดภาษีสองเท่า (พบ 2026-09-27)
function OwnerTypeFields({
  ownerType,
  financed,
  onOwnerTypeChange,
  onFinancedChange,
}: {
  ownerType: FormState["ownerType"];
  financed: boolean;
  onOwnerTypeChange: (v: FormState["ownerType"]) => void;
  onFinancedChange: (v: boolean) => void;
}) {
  return (
    <>
      <label className="field">
        <span>{financed ? "ประเภทผู้ครอบครอง (ผู้เช่าซื้อ) *" : "ประเภทเจ้าของรถ *"}</span>
        <select value={ownerType} onChange={(e) => onOwnerTypeChange(e.target.value as FormState["ownerType"])} required>
          <option value="">{financed ? "เลือกประเภทผู้ครอบครอง" : "เลือกประเภทเจ้าของรถ"}</option>
          <option value="INDIVIDUAL">บุคคลธรรมดา</option>
          <option value="JURISTIC">นิติบุคคล</option>
        </select>
      </label>
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
    </>
  );
}

function PreviewSummary({ preview }: { preview: TaxRenewalPreview }) {
  const { tax, fees } = preview;
  return (
    <div
      style={{
        marginTop: 22,
        border: "1px solid #e3e8f1",
        borderRadius: 12,
        padding: 20,
        background: "#fafbfd",
        fontSize: 14,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 12 }}>
        <strong>ยอดที่ต้องชำระ</strong>
        <strong>{baht(fees.total)} บาท</strong>
      </div>
      {[...fees.billItems, ...fees.noBillItems].map((item) => (
        <div key={item.label} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0" }}>
          <span>{item.label}</span>
          <span>{baht(item.amount)}</span>
        </div>
      ))}
      <div className="sub" style={{ marginTop: 10 }}>
        {tax.registrationCode} · ปีที่ {tax.vehicleYear} · อายุรถ {tax.vehicleAgeYears} ปี
        {tax.taxCycleCount > 1 && ` · ค้าง ${tax.taxCycleCount} รอบปี`}
        {tax.lateMonths > 0 && ` · ล่าช้า ${tax.lateMonths} เดือน`}
      </div>
      {/* ถ้ายังไม่ได้ติ๊กว่ามีใบตรวจ จะมี warning เรื่อง ตรอ. อยู่แล้ว ไม่ต้องขึ้นซ้ำสองบรรทัด */}
      {tax.inspectionRequired && !tax.warnings.some((w) => w.includes("ตรอ.")) && (
        <p className="customer-message" style={{ marginTop: 8 }}>
          รถคันนี้ต้องมีใบตรวจสภาพ (ตรอ.) ก่อนต่อภาษี - ติ๊กยืนยันแล้ว
        </p>
      )}
      {tax.warnings.map((w) => (
        <p key={w} className="customer-message error" style={{ marginTop: 6 }}>
          {w}
        </p>
      ))}
    </div>
  );
}
