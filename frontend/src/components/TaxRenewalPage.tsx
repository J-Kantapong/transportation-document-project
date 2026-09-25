"use client";

import { useCallback, useEffect, useState } from "react";
import {
  api,
  ApiError,
  type TaxRenewal,
  type TaxRenewalInput,
  type TaxRenewalPreview,
  type TaxRenewalVehicleHit,
} from "@/lib/api";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { FUEL_TYPES, VEHICLE_TYPES } from "@/lib/vehicle-reference-data";
import { DateInput } from "@/components/DateInput";

type Source = "VEHICLE" | "MANUAL";

interface FormState {
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
  ownerName: string;
  taxExpiryDate: string;
  paymentDate: string;
  inspectionConfirmed: boolean;
  insuranceConfirmed: boolean;
  skipContribution: boolean;
}

const EMPTY: FormState = {
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
      firstRegistrationDate: toIso(form.firstRegistrationDate),
      fuel: form.fuel || undefined,
      cc: form.cc || null,
      weight: form.weight || null,
      ownerType: form.ownerType || undefined,
      // รถที่ยังไม่ได้รับป้ายไม่มีทะเบียนในระบบ - ส่งค่าที่กรอกเสริมไป (backend ใช้ของ Vehicle ก่อนเสมอ)
      plateCategory: form.plateCategory || undefined,
      plateNumber: form.plateNumber || undefined,
    };
  return {
    ...shared,
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
  const isMoto = v.body?.startsWith("รย.12-") ?? false;
  const isRy1 = v.body?.startsWith("รย.1-") ?? false;
  const needsCc = isRy1 && fuel !== "ไฟฟ้า (BEV)";
  if (!isMoto) {
    if (needsCc && v.cc === null) missing.push("cc");
    if (!needsCc && v.weight === null) missing.push("weight");
  }
  return missing;
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

export function TaxRenewalPage() {
  const [form, setForm] = useState<FormState>(freshForm);
  const [selectedVehicle, setSelectedVehicle] = useState<TaxRenewalVehicleHit | null>(null);
  const [rows, setRows] = useState<TaxRenewal[]>([]);
  const [preview, setPreview] = useState<TaxRenewalPreview | null>(null);
  const [previewError, setPreviewError] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

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
    setSaving(true);
    setError("");
    setMessage("");
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
                  }}
                />
                {missing.length > 0 && (
                  <p className="sub" style={{ marginTop: 10 }}>
                    รถคันนี้ยังไม่มีข้อมูลที่ต้องใช้คำนวณภาษี กรุณากรอกเพิ่ม
                  </p>
                )}
              </div>
            ) : (
              <>
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
                    {VEHICLE_TYPES.map((t) => (
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
                <label className="field">
                  <span>ประเภทเจ้าของรถ *</span>
                  <select
                    value={form.ownerType}
                    onChange={(e) => set("ownerType", e.target.value as FormState["ownerType"])}
                    required
                  >
                    <option value="">เลือกประเภทเจ้าของรถ</option>
                    <option value="INDIVIDUAL">บุคคลธรรมดา</option>
                    <option value="JURISTIC">นิติบุคคล</option>
                  </select>
                </label>
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
              <label className="field">
                <span>ประเภทเจ้าของรถ *</span>
                <select
                  value={form.ownerType}
                  onChange={(e) => set("ownerType", e.target.value as FormState["ownerType"])}
                  required
                >
                  <option value="">เลือกประเภทเจ้าของรถ</option>
                  <option value="INDIVIDUAL">บุคคลธรรมดา</option>
                  <option value="JURISTIC">นิติบุคคล</option>
                </select>
              </label>
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

      <div className="panel customer-list">
        <div className="panel-head">
          <h2>รายการงานต่อภาษี</h2>
        </div>
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
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
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
                        onChange={(e) => void patch(row.id, { insuranceConfirmed: e.target.checked })}
                      />
                    </td>
                    <td>{baht(row.billTotal)}</td>
                    <td>{baht(row.noBillTotal)}</td>
                    <td>
                      <DateCell value={row.paymentDate} onSave={(v) => patch(row.id, { paymentDate: v })} />
                    </td>
                    <td>
                      <DateCell value={row.receivedDate} onSave={(v) => patch(row.id, { receivedDate: v })} />
                    </td>
                    <td>
                      <DateCell value={row.deliveredDate} onSave={(v) => patch(row.id, { deliveredDate: v })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
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
      onChange={(value) => onChange(formatDateDigits(value.replace(/\D/g, "").slice(0, 8)))}
    />
  );
}

// ช่องวันที่ในตาราง - บันทึกเมื่อพิมพ์ครบ 8 หลักหรือลบจนว่าง ถ้า backend ปฏิเสธให้ดึงค่าเดิมกลับมาแสดง
function DateCell({ value, onSave }: { value: string | null; onSave: (v: string | null) => Promise<boolean> }) {
  const [text, setText] = useState(() => isoToDisplayDate((value ?? "").slice(0, 10)));

  async function handleChange(next: string) {
    setText(next);
    const digits = next.replace(/\D/g, "");
    if (digits.length === 0) {
      if (!(await onSave(null))) setText(isoToDisplayDate((value ?? "").slice(0, 10)));
      return;
    }
    const iso = displayDateToIso(digits);
    if (iso && !(await onSave(iso))) setText(isoToDisplayDate((value ?? "").slice(0, 10)));
  }

  return (
    <DateTextInput value={text} onChange={handleChange} className="inspect-input inspect-input--date" />
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
