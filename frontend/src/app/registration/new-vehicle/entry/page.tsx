"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, ApiError, type Brand, type Customer, type DeletedVehicle, type FinanceCompany, type Vehicle } from "@/lib/api";
import { canDeleteVehicle, getCachedUser } from "@/lib/auth";
import { FUEL_TYPES, OWNER_TYPES, PROVINCES, VEHICLE_COLUMNS, VEHICLE_TYPES, getVehicleStatus } from "@/lib/vehicle-reference-data";
import { getVehicleRowErrors, normalizeVehicleRow, requiredSizeField, type NormalizedVehicleRow } from "@/lib/vehicle-validation";
import { entryOwnerType, ownerDisplayLabel } from "@/lib/vehicle-owner";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, parseBatchDate, todayIso } from "@/lib/date";

type Tab = "single" | "batch";
type BatchRow = NormalizedVehicleRow & { sourceRow: number; issues: string[] };

const EMPTY_SINGLE: NormalizedVehicleRow = {
  date: "",
  customerId: "",
  chassis: "",
  engine: "",
  brandId: "",
  fuel: "",
  cc: "",
  weight: "",
  color: "",
  body: "",
  registrationProvince: "กรุงเทพมหานคร",
  ownerProvince: "",
  ownerType: "",
  financeId: "",
  ownerName: "",
  hirerName: "",
};

// Shared field grid for both the single-entry form and the edit dialog.
// financeOn = ช่องติ๊ก "ไฟแนนซ์" (เก็บแยกจาก row เพราะติ๊กแล้วยังไม่ได้เลือกบริษัทก็ต้องเห็น dropdown) - ติ๊กแล้วต้องเลือกไฟแนนซ์
function VehicleFieldsFieldset({
  row,
  dateText,
  onDateTextChange,
  onFieldChange,
  customerOptions,
  brands,
  financeCompanies,
  financeOn,
  onFinanceToggle,
}: {
  row: NormalizedVehicleRow;
  dateText: string;
  onDateTextChange: (raw: string) => void;
  onFieldChange: <K extends keyof NormalizedVehicleRow>(key: K, value: string) => void;
  customerOptions: Array<{ id: string; label: string }>;
  brands: Brand[];
  financeCompanies: FinanceCompany[];
  financeOn: boolean;
  onFinanceToggle: (checked: boolean) => void;
}) {
  // CC หรือ น้ำหนัก บังคับตามประเภทรถ + เชื้อเพลิงที่เลือก (ใช้คำนวณภาษี) - ดู requiredSizeField
  const sizeField = requiredSizeField(row.body, row.fuel);
  // ติ๊กไฟแนนซ์: ผู้ถือกรรมสิทธิ์ = ชื่อไฟแนนซ์ที่เลือก (แสดงอย่างเดียว แก้ไม่ได้) และกรอกชื่อผู้ครอบครองแทน
  const financeLabel = financeCompanies.find((f) => f.id === row.financeId)?.name ?? "";
  return (
    <div className="vehicle-fields">
      <label className="field">
        วันที่ *
        <input
          type="text"
          inputMode="numeric"
          placeholder="วว/ดด/ปปปป"
          required
          value={dateText}
          onChange={(e) => onDateTextChange(e.target.value)}
        />
      </label>
      <label className="field">
        ชื่อลูกค้า *
        <select required value={row.customerId} onChange={(e) => onFieldChange("customerId", e.target.value)}>
          <option value="">เลือกลูกค้า</option>
          {customerOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        เลขตัวถัง *
        <input maxLength={250} required value={row.chassis} onChange={(e) => onFieldChange("chassis", e.target.value)} />
      </label>
      <label className="field">
        เลขเครื่อง *
        <input maxLength={250} required value={row.engine} onChange={(e) => onFieldChange("engine", e.target.value)} />
      </label>
      <label className="field">
        ยี่ห้อ *
        <select required value={row.brandId} onChange={(e) => onFieldChange("brandId", e.target.value)}>
          <option value="">เลือกยี่ห้อ</option>
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        ประเภทเชื้อเพลิง *
        <select required value={row.fuel} onChange={(e) => onFieldChange("fuel", e.target.value)}>
          <option value="">เลือกประเภทเชื้อเพลิง</option>
          {FUEL_TYPES.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        ขนาด CC{sizeField === "cc" ? " *" : ""}
        <input type="number" min={0} step="any" required={sizeField === "cc"} value={row.cc} onChange={(e) => onFieldChange("cc", e.target.value)} />
      </label>
      <label className="field">
        น้ำหนักรถ (กก.){sizeField === "weight" ? " *" : ""}
        <input
          type="number"
          min={0}
          step="any"
          required={sizeField === "weight"}
          value={row.weight}
          onChange={(e) => onFieldChange("weight", e.target.value)}
        />
      </label>
      <label className="field">
        สี
        <input maxLength={250} value={row.color} onChange={(e) => onFieldChange("color", e.target.value)} />
      </label>
      <label className="field">
        ประเภทรถ *
        <select required value={row.body} onChange={(e) => onFieldChange("body", e.target.value)}>
          <option value="">เลือกประเภทรถ</option>
          {VEHICLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        จังหวัดที่จดทะเบียน *
        <select required value={row.registrationProvince} onChange={(e) => onFieldChange("registrationProvince", e.target.value)}>
          <option value="">เลือกจังหวัด</option>
          {PROVINCES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="field">
        จังหวัดเจ้าของรถ *
        <select required value={row.ownerProvince} onChange={(e) => onFieldChange("ownerProvince", e.target.value)}>
          <option value="">เลือกจังหวัด</option>
          {PROVINCES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="field">
        ประเภทเจ้าของรถ *
        <select required value={row.ownerType} onChange={(e) => onFieldChange("ownerType", e.target.value)}>
          <option value="">เลือกบุคคลธรรมดา / นิติบุคคล</option>
          {OWNER_TYPES.map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <div className="field">
        <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
          <input
            type="checkbox"
            style={{ width: 18, height: 18, minHeight: 0, padding: 0, margin: 0 }}
            checked={financeOn}
            onChange={(e) => onFinanceToggle(e.target.checked)}
          />
          ไฟแนนซ์
        </label>
        {financeOn && (
          <select required value={row.financeId} onChange={(e) => onFieldChange("financeId", e.target.value)} aria-label="เลือกไฟแนนซ์">
            <option value="">เลือกไฟแนนซ์</option>
            {financeCompanies.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {financeOn ? (
        <>
          <div className="field">
            ผู้ถือกรรมสิทธิ์
            <input value={financeLabel} readOnly placeholder="ชื่อไฟแนนซ์ที่เลือก" aria-label="ผู้ถือกรรมสิทธิ์ (ไฟแนนซ์)" />
          </div>
          <label className="field">
            ชื่อผู้ครอบครอง *
            <input
              required
              maxLength={250}
              value={row.hirerName}
              onChange={(e) => onFieldChange("hirerName", e.target.value)}
              placeholder="ชื่อผู้เช่าซื้อ / ผู้ครอบครองรถ"
            />
          </label>
        </>
      ) : (
        <label className="field">
          ชื่อผู้ถือกรรมสิทธิ์ *
          <input
            required
            maxLength={250}
            value={row.ownerName}
            onChange={(e) => onFieldChange("ownerName", e.target.value)}
            placeholder="ชื่อเจ้าของรถตามทะเบียน"
          />
        </label>
      )}
    </div>
  );
}

const VEHICLE_DETAIL_FIELDS: Array<[string, (v: Vehicle) => string]> = [
  ["วันที่", (v) => isoToDisplayDate(v.date) || v.date],
  ["ชื่อลูกค้า", (v) => v.customerName],
  ["เลขตัวถัง", (v) => v.chassis],
  ["เลขเครื่อง", (v) => v.engine ?? ""],
  ["ยี่ห้อ", (v) => v.brandName],
  ["ประเภทเชื้อเพลิง", (v) => v.fuel ?? ""],
  ["ขนาด CC", (v) => v.cc ?? ""],
  ["น้ำหนักรถ", (v) => v.weight ?? ""],
  ["สี", (v) => v.color ?? ""],
  ["ประเภทรถ", (v) => v.body ?? ""],
  ["จังหวัดที่จดทะเบียน", (v) => v.registrationProvince ?? ""],
  ["สถานะ", (v) => getVehicleStatus(v.registrationProvince ?? "")],
  ["จังหวัดเจ้าของรถ", (v) => v.ownerProvince ?? ""],
  ["ประเภทเจ้าของรถ", (v) => ownerDisplayLabel(v, v.financeName) ?? ""],
  ["ผู้ถือกรรมสิทธิ์", (v) => v.ownerName ?? ""],
  ["ผู้ครอบครอง", (v) => v.hirerName ?? ""],
];

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (!quoted && cell !== "") {
        throw new Error("รูปแบบ CSV ไม่ถูกต้อง");
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (quoted) throw new Error("เครื่องหมายคำพูดใน CSV ไม่ครบ");
  if (row.length || cell) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function lookupId(value: string, rows: Array<{ id: string; name: string }>, label: string): string {
  const exact = rows.filter((r) => r.id === value);
  if (exact.length === 1) return exact[0].id;
  const normalizedValue = value.trim().toLowerCase();
  const matches = rows.filter((r) => r.name.trim().toLowerCase() === normalizedValue);
  if (matches.length === 1) return matches[0].id;
  throw new Error(matches.length ? `ชื่อ${label}ซ้ำ กรุณาใช้รหัสจากรายการอ้างอิง` : `ไม่พบ${label}ในฐานข้อมูล`);
}

function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function VehicleEntryPage() {
  const [tab, setTab] = useState<Tab>("single");

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [brands, setBrands] = useState<Brand[]>([]);
  const [financeCompanies, setFinanceCompanies] = useState<FinanceCompany[]>([]);
  const [lookupReady, setLookupReady] = useState(false);
  const [lookupMessage, setLookupMessage] = useState("กำลังโหลดลูกค้าและยี่ห้อ…");

  const [showBrandForm, setShowBrandForm] = useState(false);
  const [brandName, setBrandName] = useState("");
  const [brandSaving, setBrandSaving] = useState(false);
  const [brandMessage, setBrandMessage] = useState("");

  // "+ เพิ่มไฟแนนซ์" - ฟอร์มย่อยแบบเดียวกับยี่ห้อ (รายชื่อไฟแนนซ์ผู้ใช้กำหนดเอง ไม่มี seed)
  const [showFinanceForm, setShowFinanceForm] = useState(false);
  const [financeName, setFinanceName] = useState("");
  const [financeSaving, setFinanceSaving] = useState(false);
  const [financeMessage, setFinanceMessage] = useState("");

  const [single, setSingle] = useState<NormalizedVehicleRow>({ ...EMPTY_SINGLE, date: todayIso() });
  const [singleFinanceOn, setSingleFinanceOn] = useState(false);
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const [singleSaving, setSingleSaving] = useState(false);
  const [singleMessage, setSingleMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  const [batchRows, setBatchRows] = useState<BatchRow[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [vehiclesLoading, setVehiclesLoading] = useState(true);
  const [vehiclesError, setVehiclesError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState<Vehicle | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRow, setEditRow] = useState<NormalizedVehicleRow>(EMPTY_SINGLE);
  const [editFinanceOn, setEditFinanceOn] = useState(false);
  const [editDateText, setEditDateText] = useState("");
  const [editRemark, setEditRemark] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editMessage, setEditMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const editDialogRef = useRef<HTMLDialogElement>(null);

  // ลบข้อมูลรถ (ผู้ใช้ 2026-09-23): ADMIN เท่านั้น ต้องระบุเหตุผลทุกครั้ง - ลบแล้วซ่อนไว้ ไม่หายจากฐานข้อมูล
  // และกู้คืนได้จากรายการ "รถที่ลบแล้ว" ด้านล่าง (backend กันสิทธิ์อีกชั้นใน auth/access-policy.ts)
  const [canDelete, setCanDelete] = useState(false);
  const [deleting, setDeleting] = useState<Vehicle | null>(null);
  const [deleteRemark, setDeleteRemark] = useState("");
  const [deleteSaving, setDeleteSaving] = useState(false);
  const [deleteMessage, setDeleteMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const deleteDialogRef = useRef<HTMLDialogElement>(null);

  const [showDeleted, setShowDeleted] = useState(false);
  const [deletedVehicles, setDeletedVehicles] = useState<DeletedVehicle[]>([]);
  const [deletedLoading, setDeletedLoading] = useState(false);
  const [deletedMessage, setDeletedMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [restoringId, setRestoringId] = useState<string | null>(null);

  async function loadLookups() {
    setLookupReady(false);
    setLookupMessage("กำลังโหลดลูกค้าและยี่ห้อ…");
    try {
      const [c, b, f] = await Promise.all([api.listCustomers(), api.listBrands(), api.listFinanceCompanies()]);
      setCustomers(c.customers);
      setBrands(b.brands);
      setFinanceCompanies(f.financeCompanies);
      setLookupReady(true);
      setLookupMessage(
        !c.customers.length
          ? "ยังไม่มีลูกค้า กรุณาเพิ่มในเมนูฐานข้อมูลลูกค้าก่อน"
          : !b.brands.length
            ? "ยังไม่มียี่ห้อ กดเพิ่มยี่ห้อเพื่อใช้ในรายการรถ"
            : "",
      );
    } catch (error) {
      setLookupMessage(error instanceof ApiError ? error.message : "โหลดข้อมูลไม่สำเร็จ");
    }
  }

  async function loadVehicles() {
    setVehiclesLoading(true);
    setVehiclesError("");
    try {
      const data = await api.listVehicles();
      setVehicles(data.vehicles);
    } catch (error) {
      setVehiclesError(error instanceof ApiError ? error.message : "โหลดรายการรถไม่สำเร็จ");
    } finally {
      setVehiclesLoading(false);
    }
  }

  // รายการรถที่ถูกลบไว้ (ADMIN เท่านั้น) - โหลดเมื่อกดเปิดดูและหลังลบ/กู้คืนทุกครั้ง
  async function loadDeletedVehicles() {
    setDeletedLoading(true);
    setDeletedMessage({ text: "" });
    try {
      const data = await api.listDeletedVehicles();
      setDeletedVehicles(data.vehicles);
    } catch (error) {
      setDeletedMessage({ text: error instanceof ApiError ? error.message : "โหลดรายการรถที่ลบแล้วไม่สำเร็จ", error: true });
    } finally {
      setDeletedLoading(false);
    }
  }

  useEffect(() => {
    // Standard fetch-on-mount; both loaders set a loading flag before their first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLookups();
    loadVehicles();
    // localStorage อ่านได้เฉพาะฝั่ง browser จึงตั้งค่าใน effect ไม่ใช่ตอน useState (แบบเดียวกับหน้าฐานข้อมูลลูกค้า)
    setCanDelete(canDeleteVehicle(getCachedUser()?.roles ?? []));
  }, []);

  const customerOptions = useMemo(
    () => customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") })),
    [customers],
  );
  // ตารางตัวอย่างก่อนนำเข้า (batch) แสดงชื่อแทน id ที่ผู้ใช้อ่านไม่รู้เรื่อง
  const customerNameById = useMemo(() => new Map(customers.map((c) => [c.id, c.name])), [customers]);
  const brandNameById = useMemo(() => new Map(brands.map((b) => [b.id, b.name])), [brands]);

  function updateSingle<K extends keyof NormalizedVehicleRow>(key: K, value: string) {
    setSingle((prev) => ({ ...prev, [key]: value }));
  }

  // เอาติ๊กไฟแนนซ์ออก = ล้างบริษัทและชื่อผู้ครอบครองที่กรอกไว้ด้วย ไม่งั้นค่าเก่าจะถูกส่งไปทั้งที่ผู้ใช้ไม่เห็นช่องแล้ว
  // (ชื่อผู้ถือกรรมสิทธิ์ที่กรอกไว้ก่อนติ๊กเก็บไว้ - backend ไม่ใช้เมื่อมีไฟแนนซ์ และจะกลับมาเห็นเมื่อเอาติ๊กออก)
  function toggleSingleFinance(checked: boolean) {
    setSingleFinanceOn(checked);
    if (!checked) setSingle((prev) => ({ ...prev, financeId: "", hirerName: "" }));
  }

  // ติ๊กไฟแนนซ์แล้วต้องเลือกบริษัท - ตรวจฝั่งหน้าจอเพราะ backend รู้แค่ว่า financeId ว่าง (ซึ่งถูกต้องเมื่อไม่ติ๊ก)
  function financeError(financeOn: boolean, row: NormalizedVehicleRow): string | null {
    return financeOn && !row.financeId ? "กรุณาเลือกไฟแนนซ์ หรือเอาติ๊กไฟแนนซ์ออก" : null;
  }

  function handleDateTextChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    setDateText(formatDateDigits(digits));
    updateSingle("date", displayDateToIso(digits));
  }

  async function handleAddBrand(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBrandSaving(true);
    setBrandMessage("");
    try {
      const data = await api.createBrand(brandName);
      await loadLookups();
      setSingle((s) => ({ ...s, brandId: data.brand.id }));
      setBrandName("");
      setShowBrandForm(false);
    } catch (error) {
      setBrandMessage(error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ");
    } finally {
      setBrandSaving(false);
    }
  }

  async function handleAddFinance(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFinanceSaving(true);
    setFinanceMessage("");
    try {
      const data = await api.createFinanceCompany(financeName);
      await loadLookups();
      // เลือกไฟแนนซ์ที่เพิ่งเพิ่มให้ในฟอร์ม Single ทันที (เหมือนยี่ห้อ) และเปิดติ๊กไฟแนนซ์ให้ด้วย
      setSingleFinanceOn(true);
      setSingle((s) => ({ ...s, financeId: data.financeCompany.id }));
      setFinanceName("");
      setShowFinanceForm(false);
    } catch (error) {
      setFinanceMessage(error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ");
    } finally {
      setFinanceSaving(false);
    }
  }

  async function handleSingleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookupReady) return;
    const row = normalizeVehicleRow(single);
    const errors = getVehicleRowErrors(row);
    const finance = financeError(singleFinanceOn, row);
    if (finance) errors.push(finance);
    if (errors.length) {
      setSingleMessage({ text: errors.join(" · "), error: true });
      return;
    }
    setSingleSaving(true);
    setSingleMessage({ text: "กำลังบันทึก…" });
    try {
      await api.createVehicles([row]);
      setSingle({ ...EMPTY_SINGLE, date: todayIso() });
      setSingleFinanceOn(false);
      setDateText(isoToDisplayDate(todayIso()));
      setSingleMessage({ text: "บันทึกข้อมูลรถเรียบร้อยแล้ว" });
      await loadVehicles();
    } catch (error) {
      setSingleMessage({ text: error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setSingleSaving(false);
    }
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    if (batchBusy) return;
    setBatchRows([]);
    const file = event.target.files?.[0];
    if (!file) return;
    setBatchBusy(true);
    setBatchMessage({ text: "กำลังตรวจไฟล์…" });
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("ไฟล์ต้องไม่เกิน 5 MB");

      let cells: string[][];
      if (/\.csv$/i.test(file.name)) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer()).replace(/^﻿/, "");
        cells = parseCSV(text);
      } else if (/\.xlsx$/i.test(file.name)) {
        const XLSX = await import("xlsx");
        const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
        const sheetName = workbook.SheetNames[0];
        if (!sheetName) throw new Error("ไม่พบชีตข้อมูล");
        const sheet = workbook.Sheets[sheetName];
        const range = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]) : null;
        const rowCount = range ? range.e.r - range.s.r + 1 : 0;
        if (rowCount > 1001) throw new Error("รองรับไม่เกิน 1,000 แถวต่อไฟล์");
        const startRow = range ? range.s.r : 0;
        const endRow = range ? range.e.r : -1;
        const startCol = range ? range.s.c : 0;
        const colCount = Math.max(VEHICLE_COLUMNS.length, range ? range.e.c - range.s.c + 1 : 0);
        cells = [];
        for (let r = startRow; r <= endRow; r++) {
          const values: string[] = [];
          for (let ci = 0; ci < colCount; ci++) {
            const cell = sheet[XLSX.utils.encode_cell({ r, c: startCol + ci })];
            if (cell?.f) throw new Error("ไม่รองรับสูตร Excel กรุณาวางเป็นค่า");
            const value = cell?.v;
            values.push(value instanceof Date ? value.toISOString().slice(0, 10) : value == null ? "" : String(value));
          }
          cells.push(values);
        }
      } else {
        throw new Error("เลือกไฟล์ .xlsx หรือ .csv เท่านั้น");
      }

      const withIndex = cells
        .map((row, i) => ({ cells: row, sourceRow: i + 1 }))
        .filter((r) => r.cells.some((c) => String(c ?? "").trim()));
      if (withIndex.length < 2) throw new Error("ไฟล์ยังไม่มีข้อมูลรถ");
      if (withIndex.length > 1001) throw new Error("รองรับไม่เกิน 1,000 แถวต่อไฟล์");

      const headerRow = withIndex[0].cells.map((c) => (String(c).trim() === "ลักษณะรถ" ? "ประเภทรถ" : String(c).trim()));
      const dataRows = withIndex.slice(1);

      const indexes = VEHICLE_COLUMNS.map(([key, label]) => {
        const idx = headerRow.findIndex((h) => h === label || h === key);
        if (idx < 0) throw new Error(`ไม่พบคอลัมน์ ${label}`);
        if (headerRow.filter((h) => h === label || h === key).length > 1) throw new Error(`คอลัมน์ซ้ำ: ${label}`);
        return idx;
      });

      const seen = new Set<string>();
      let bad = 0;
      const preview: BatchRow[] = dataRows.map(({ cells: raw, sourceRow }) => {
        const rawObj: Record<string, unknown> = {};
        VEHICLE_COLUMNS.forEach(([key], i) => {
          rawObj[key] = raw[indexes[i]] ?? "";
        });
        const values = normalizeVehicleRow(rawObj);
        values.date = parseBatchDate(values.date);
        const issues: string[] = [];
        try {
          values.customerId = lookupId(values.customerId, customers, "ลูกค้า");
        } catch (e) {
          issues.push((e as Error).message);
        }
        try {
          values.brandId = lookupId(values.brandId, brands, "ยี่ห้อ");
        } catch (e) {
          issues.push((e as Error).message);
        }
        // ไฟแนนซ์เว้นว่างได้ (= ไม่ติ๊กไฟแนนซ์) ใส่มาแล้วต้องตรงกับชื่อ/รหัสในฐานข้อมูลเหมือนลูกค้า/ยี่ห้อ
        if (values.financeId) {
          try {
            values.financeId = lookupId(values.financeId, financeCompanies, "ไฟแนนซ์");
          } catch (e) {
            issues.push((e as Error).message);
          }
        }
        issues.push(...getVehicleRowErrors(values));
        if (seen.has(values.chassis)) issues.push("เลขตัวถังซ้ำในไฟล์");
        seen.add(values.chassis);
        if (issues.length) bad++;
        return { ...values, sourceRow, issues };
      });

      setBatchRows(preview);
      setBatchMessage({
        text: `พบ ${dataRows.length} รายการ${bad ? ` · ต้องแก้ไข ${bad} แถว แล้วเลือกไฟล์ใหม่` : " · ตรวจสอบแล้ว กดบันทึกเพื่อนำเข้า"}`,
        error: bad > 0,
      });
    } catch (error) {
      setBatchRows([]);
      setBatchMessage({ text: error instanceof Error ? error.message : "ไฟล์ไม่ถูกต้อง", error: true });
    } finally {
      setBatchBusy(false);
    }
  }

  async function handleBatchSave() {
    if (batchBusy || !batchRows.length) return;
    setBatchBusy(true);
    setBatchMessage({ text: "กำลังบันทึก…" });
    try {
      const payload = batchRows.map((row) =>
        Object.fromEntries(VEHICLE_COLUMNS.map(([key]) => [key, row[key]])),
      );
      const result = await api.createVehicles(payload);
      setBatchMessage({ text: `บันทึกแล้ว ${result.count} รายการ` });
      setBatchRows([]);
      if (fileInputRef.current) fileInputRef.current.value = "";
      await loadVehicles();
    } catch (error) {
      if (error instanceof ApiError) {
        const rowsText = error.rows
          ?.map((r) => `แถว ${batchRows[r.row - 1]?.sourceRow ?? r.row + 1}: ${r.errors.join(", ")}`)
          .join(" / ");
        setBatchMessage({ text: error.message + (rowsText ? " · " + rowsText : ""), error: true });
      } else {
        setBatchMessage({ text: "บันทึกไม่สำเร็จ", error: true });
      }
    } finally {
      setBatchBusy(false);
    }
  }

  function downloadVehicleCsvTemplate() {
    const line = VEHICLE_COLUMNS.map(([, label]) => label).join(",") + "\r\n";
    downloadBlob(new Blob(["﻿" + line], { type: "text/csv;charset=utf-8" }), "vehicle-import-template.csv");
  }

  function downloadLookupCsv() {
    const quote = (v: string) => '"' + String(v).replaceAll('"', '""') + '"';
    const rows = [
      ["ประเภท", "รหัส", "ชื่อ", "บริษัท", "สาขา"],
      ...customers.map((c) => ["ลูกค้า", c.id, c.name, c.company ?? "", c.branch ?? ""]),
      ...brands.map((b) => ["ยี่ห้อ", b.id, b.name, "", ""]),
      ...financeCompanies.map((f) => ["ไฟแนนซ์", f.id, f.name, "", ""]),
    ];
    downloadBlob(
      new Blob(["﻿" + rows.map((r) => r.map(quote).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8" }),
      "vehicle-reference.csv",
    );
  }

  function openDetail(vehicle: Vehicle) {
    setDetail(vehicle);
    dialogRef.current?.showModal();
  }

  function openEdit(vehicle: Vehicle) {
    setEditingId(vehicle.id);
    setEditRow({
      date: vehicle.date,
      customerId: vehicle.customerId,
      chassis: vehicle.chassis,
      engine: vehicle.engine ?? "",
      brandId: vehicle.brandId,
      fuel: vehicle.fuel ?? "",
      cc: vehicle.cc ?? "",
      weight: vehicle.weight ?? "",
      color: vehicle.color ?? "",
      body: vehicle.body ?? "",
      registrationProvince: vehicle.registrationProvince ?? "",
      ownerProvince: vehicle.ownerProvince ?? "",
      // แสดงประเภทที่ผู้ใช้เลือกไว้ (มีไฟแนนซ์ = ผู้เช่าซื้อ) ไม่ใช่ ownerType ดิบที่เป็นไฟแนนซ์ - ดู lib/vehicle-owner.ts
      ownerType: entryOwnerType(vehicle) ?? "",
      financeId: vehicle.financeCompanyId ?? "",
      // รถติดไฟแนนซ์: ownerName ในฐานข้อมูลคือชื่อไฟแนนซ์ ไม่ใช่ค่าที่ผู้ใช้กรอก จึงเว้นว่างไว้เผื่อเอาติ๊กไฟแนนซ์ออกแล้วกรอกใหม่
      ownerName: vehicle.financeCompanyId ? "" : (vehicle.ownerName ?? ""),
      hirerName: vehicle.hirerName ?? "",
    });
    setEditFinanceOn(Boolean(vehicle.financeCompanyId));
    setEditDateText(isoToDisplayDate(vehicle.date));
    setEditRemark("");
    setEditMessage({ text: "" });
    editDialogRef.current?.showModal();
  }

  function updateEditRow<K extends keyof NormalizedVehicleRow>(key: K, value: string) {
    setEditRow((prev) => ({ ...prev, [key]: value }));
  }

  function toggleEditFinance(checked: boolean) {
    setEditFinanceOn(checked);
    if (!checked) setEditRow((prev) => ({ ...prev, financeId: "", hirerName: "" }));
  }

  function handleEditDateTextChange(raw: string) {
    const digits = raw.replace(/\D/g, "").slice(0, 8);
    setEditDateText(formatDateDigits(digits));
    updateEditRow("date", displayDateToIso(digits));
  }

  async function handleEditSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingId) return;
    const remark = editRemark.trim();
    if (!remark) {
      setEditMessage({ text: "กรุณาระบุเหตุผลที่แก้ไข (Remark) ก่อนบันทึก", error: true });
      return;
    }
    const row = normalizeVehicleRow(editRow);
    const errors = getVehicleRowErrors(row);
    const finance = financeError(editFinanceOn, row);
    if (finance) errors.push(finance);
    if (errors.length) {
      setEditMessage({ text: errors.join(" · "), error: true });
      return;
    }
    setEditSaving(true);
    setEditMessage({ text: "กำลังบันทึก…" });
    try {
      await api.updateVehicle(editingId, { ...row, remark });
      setEditMessage({ text: "บันทึกการแก้ไขเรียบร้อยแล้ว" });
      await loadVehicles();
      editDialogRef.current?.close();
    } catch (error) {
      setEditMessage({ text: error instanceof ApiError ? error.message : "บันทึกไม่สำเร็จ", error: true });
    } finally {
      setEditSaving(false);
    }
  }

  // เปิดกล่องยืนยันการลบ - เหตุผล (Remark) บังคับกรอก ไม่งั้นปุ่มลบกดไม่ได้
  function openDelete(vehicle: Vehicle) {
    setDeleting(vehicle);
    setDeleteRemark("");
    setDeleteMessage({ text: "" });
    deleteDialogRef.current?.showModal();
  }

  async function handleDeleteSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!deleting) return;
    const remark = deleteRemark.trim();
    if (!remark) {
      setDeleteMessage({ text: "กรุณาระบุเหตุผลที่ลบ (Remark) ก่อนลบ", error: true });
      return;
    }
    setDeleteSaving(true);
    setDeleteMessage({ text: "กำลังลบ…" });
    try {
      await api.deleteVehicle(deleting.id, remark);
      deleteDialogRef.current?.close();
      setDeleting(null);
      await loadVehicles();
      if (showDeleted) await loadDeletedVehicles();
    } catch (error) {
      setDeleteMessage({ text: error instanceof ApiError ? error.message : "ลบไม่สำเร็จ", error: true });
    } finally {
      setDeleteSaving(false);
    }
  }

  async function handleRestore(vehicle: DeletedVehicle) {
    if (!window.confirm(`กู้คืนรถเลขตัวถัง ${vehicle.chassis} กลับเข้ารายการ?`)) return;
    setRestoringId(vehicle.id);
    setDeletedMessage({ text: "" });
    try {
      await api.restoreVehicle(vehicle.id);
      await Promise.all([loadVehicles(), loadDeletedVehicles()]);
    } catch (error) {
      setDeletedMessage({ text: error instanceof ApiError ? error.message : "กู้คืนไม่สำเร็จ", error: true });
    } finally {
      setRestoringId(null);
    }
  }

  // เปิด/ปิดรายการรถที่ลบแล้ว - โหลดข้อมูลตอนกดเปิดครั้งแรก
  function toggleDeletedList() {
    const next = !showDeleted;
    setShowDeleted(next);
    if (next) loadDeletedVehicles();
  }

  const batchHasErrors = batchRows.some((r) => r.issues.length > 0);

  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>เพิ่มข้อมูลรถจดใหม่</h1>

      <div className="vehicle-tabs" role="tablist" aria-label="วิธีเพิ่มข้อมูลรถ">
        <button
          className={`vehicle-tab${tab === "single" ? " selected" : ""}`}
          role="tab"
          aria-selected={tab === "single"}
          onClick={() => setTab("single")}
        >
          Single · เพิ่มทีละคัน
        </button>
        <button
          className={`vehicle-tab${tab === "batch" ? " selected" : ""}`}
          role="tab"
          aria-selected={tab === "batch"}
          onClick={() => setTab("batch")}
        >
          Batch · นำเข้าไฟล์
        </button>
      </div>

      <div className="vehicle-tools">
        <span role="status">{lookupMessage}</span>
        <button className="text-button" onClick={loadLookups}>
          โหลดลูกค้า / ยี่ห้อใหม่
        </button>
        <button className="text-button" onClick={() => setShowBrandForm((v) => !v)}>
          + เพิ่มยี่ห้อ
        </button>
        <button className="text-button" onClick={() => setShowFinanceForm((v) => !v)}>
          + เพิ่มไฟแนนซ์
        </button>
      </div>

      {showBrandForm && (
        <div className="panel" style={{ marginBottom: 20 }}>
          <form className="brand-form" onSubmit={handleAddBrand}>
            <label className="field">
              ชื่อยี่ห้อ
              <input
                maxLength={100}
                required
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
              />
            </label>
            <button className="primary" disabled={brandSaving}>
              บันทึกยี่ห้อ
            </button>
            <span role="status">{brandMessage}</span>
          </form>
        </div>
      )}

      {showFinanceForm && (
        <div className="panel" style={{ marginBottom: 20 }}>
          <form className="brand-form" onSubmit={handleAddFinance}>
            <label className="field">
              ชื่อไฟแนนซ์
              <input
                maxLength={100}
                required
                value={financeName}
                onChange={(e) => setFinanceName(e.target.value)}
              />
            </label>
            <button className="primary" disabled={financeSaving}>
              บันทึกไฟแนนซ์
            </button>
            <span role="status">{financeMessage}</span>
          </form>
        </div>
      )}

      {tab === "single" && (
        <section role="tabpanel" className="panel">
          <div className="panel-head">
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <h2>ข้อมูลรถจดใหม่</h2>
              <span className="status-badge" role="status">
                สถานะ: {getVehicleStatus(single.registrationProvince)}
              </span>
            </div>
            <span className="muted">* จำเป็นต้องกรอก</span>
          </div>
          <form className="customer-form" onSubmit={handleSingleSubmit}>
            <VehicleFieldsFieldset
              row={single}
              dateText={dateText}
              onDateTextChange={handleDateTextChange}
              onFieldChange={updateSingle}
              customerOptions={customerOptions}
              brands={brands}
              financeCompanies={financeCompanies}
              financeOn={singleFinanceOn}
              onFinanceToggle={toggleSingleFinance}
            />
            <div className="form-actions">
              <button type="submit" className="primary" disabled={singleSaving}>
                บันทึกข้อมูลรถ
              </button>
              <span
                className={`customer-message${singleMessage.error ? " error" : singleMessage.text ? " success" : ""}`}
                role="status"
              >
                {singleMessage.text}
              </span>
            </div>
          </form>
        </section>
      )}

      {tab === "batch" && (
        <section role="tabpanel" className="panel">
          <div className="panel-head">
            <h2>นำเข้าข้อมูลรถจากไฟล์</h2>
          </div>
          <div className="customer-form">
            <p style={{ lineHeight: 1.9 }}>
              รองรับ Excel (.xlsx) และ CSV UTF-8 · สูงสุด 1,000 คันต่อไฟล์ · ไม่เกิน 5 MB
              <br />
              ใช้ {VEHICLE_COLUMNS.length} คอลัมน์ตามแบบฟอร์ม วันที่เป็น DD-MM-YYYY และตั้งเลขตัวถัง / เลขเครื่องเป็นข้อความ
              <br />
              คอลัมน์ลูกค้า ยี่ห้อ และไฟแนนซ์ใช้ชื่อที่มีในฐานข้อมูล หรือรหัสจากรายการอ้างอิง กรณีชื่อซ้ำให้ใช้รหัส
              <br />
              ประเภทเจ้าของรถกรอก บุคคลธรรมดา หรือ นิติบุคคล · ไฟแนนซ์เว้นว่างได้ถ้าไม่ได้ไฟแนนซ์
              <br />
              ต้องกรอกทุกคอลัมน์ยกเว้นสีและไฟแนนซ์ · ขนาด CC บังคับสำหรับ รย.1 ที่ไม่ใช่ไฟฟ้า (BEV) และ รย.12 · น้ำหนักรถบังคับสำหรับ
              รย.1 ไฟฟ้า (BEV), รย.2 และ รย.3
            </p>
            <div className="vehicle-tools">
              <button type="button" className="text-button" onClick={downloadVehicleCsvTemplate}>
                ดาวน์โหลดหัวตาราง CSV
              </button>
              <button type="button" className="text-button" onClick={downloadLookupCsv}>
                ดาวน์โหลดรหัสลูกค้า / ยี่ห้อ
              </button>
            </div>
            <label className="file-zone">
              เลือกไฟล์ Excel หรือ CSV
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.csv"
                disabled={batchBusy || !lookupReady}
                onChange={handleFileChange}
              />
            </label>
            <div className="customer-message" style={{ margin: "18px 0" }} role="status">
              {batchMessage.text && <span className={batchMessage.error ? "error" : "success"}>{batchMessage.text}</span>}
            </div>
            {batchRows.length > 0 && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>แถว</th>
                      <th>ชื่อลูกค้า</th>
                      <th>เลขตัวถัง</th>
                      <th>ยี่ห้อ</th>
                      <th>ประเภทเชื้อเพลิง</th>
                      <th>ประเภทรถ</th>
                      <th>ผลตรวจสอบ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchRows.map((row) => (
                      <tr key={row.sourceRow}>
                        <td>{row.sourceRow}</td>
                        <td>{customerNameById.get(row.customerId) ?? row.customerId}</td>
                        <td>{row.chassis}</td>
                        <td>{brandNameById.get(row.brandId) ?? row.brandId}</td>
                        <td>{row.fuel}</td>
                        <td>{row.body}</td>
                        <td className={row.issues.length ? "import-error" : "import-ok"}>
                          {row.issues.length ? row.issues.join(" · ") : "พร้อมนำเข้า"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <button
              className="primary"
              style={{ marginTop: 22 }}
              disabled={!batchRows.length || batchHasErrors || batchBusy}
              onClick={handleBatchSave}
            >
              บันทึกรายการที่ตรวจสอบแล้ว
            </button>
          </div>
        </section>
      )}

      <section className="panel customer-list">
        <div className="panel-head">
          <h2>รถจดใหม่ที่บันทึกแล้ว</h2>
          <div>
            {canDelete && (
              <>
                <button className="text-button" onClick={toggleDeletedList}>
                  {showDeleted ? "ซ่อนรายการที่ลบแล้ว" : "รายการที่ลบแล้ว"}
                </button>
                {" · "}
              </>
            )}
            <button className="text-button" onClick={loadVehicles}>
              โหลดรายการใหม่
            </button>
          </div>
        </div>
        <p style={{ padding: "0 24px 12px", fontSize: 12 }}>แสดง 100 รายการล่าสุด</p>
        {vehiclesLoading ? (
          <div className="empty-customers">กำลังโหลดรายการรถ…</div>
        ) : vehiclesError ? (
          <div className="empty-customers" role="alert">
            {vehiclesError}
          </div>
        ) : !vehicles.length ? (
          <div className="empty-customers">ยังไม่มีข้อมูลรถจดใหม่</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่</th>
                  <th>ชื่อลูกค้า</th>
                  <th>เลขตัวถัง</th>
                  <th>ยี่ห้อ</th>
                  <th>จังหวัดที่จดทะเบียน</th>
                  <th>สถานะ</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td>{isoToDisplayDate(v.date) || v.date}</td>
                    <td>{v.customerName}</td>
                    <td>{v.chassis}</td>
                    <td>{v.brandName}</td>
                    <td>{v.registrationProvince || "—"}</td>
                    <td>{getVehicleStatus(v.registrationProvince ?? "")}</td>
                    <td>
                      <button className="text-button" onClick={() => openDetail(v)}>
                        ดูข้อมูล
                      </button>
                      {" · "}
                      <button className="text-button" onClick={() => openEdit(v)}>
                        แก้ไข
                      </button>
                      {canDelete && (
                        <>
                          {" · "}
                          <button className="text-button danger" onClick={() => openDelete(v)}>
                            ลบ
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canDelete && showDeleted && (
        <section className="panel customer-list" style={{ marginTop: 24 }}>
          <div className="panel-head">
            <h2>รถที่ลบแล้ว</h2>
            <button className="text-button" onClick={loadDeletedVehicles}>
              โหลดรายการใหม่
            </button>
          </div>
          <p style={{ padding: "0 24px 12px", fontSize: 12 }}>
            แสดง 100 รายการล่าสุด - ข้อมูลยังอยู่ในระบบ กดกู้คืนเพื่อนำกลับเข้ารายการได้
          </p>
          {deletedMessage.text && (
            <p className={`customer-message${deletedMessage.error ? " error" : ""}`} style={{ padding: "0 24px 12px" }} role="alert">
              {deletedMessage.text}
            </p>
          )}
          {deletedLoading ? (
            <div className="empty-customers">กำลังโหลดรายการรถที่ลบแล้ว…</div>
          ) : !deletedVehicles.length ? (
            <div className="empty-customers">ยังไม่มีรถที่ถูกลบ</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>วันที่ลบ</th>
                    <th>ชื่อลูกค้า</th>
                    <th>เลขตัวถัง</th>
                    <th>ยี่ห้อ</th>
                    <th>เหตุผลที่ลบ</th>
                    <th>ผู้ลบ</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {deletedVehicles.map((v) => (
                    <tr key={v.id}>
                      <td>{v.deletedAt ? isoToDisplayDate(v.deletedAt.slice(0, 10)) : "—"}</td>
                      <td>{v.customerName}</td>
                      <td>{v.chassis}</td>
                      <td>{v.brandName}</td>
                      <td style={{ whiteSpace: "normal", minWidth: 220 }}>{v.deletedReason || "—"}</td>
                      <td>{v.deletedByName || "—"}</td>
                      <td>
                        <button className="text-button" disabled={restoringId === v.id} onClick={() => handleRestore(v)}>
                          {restoringId === v.id ? "กำลังกู้คืน…" : "กู้คืน"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      <dialog
        ref={deleteDialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) deleteDialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => deleteDialogRef.current?.close()}>
          ×
        </button>
        <h2>ลบข้อมูลรถจดใหม่</h2>
        {deleting && (
          <>
            <p style={{ margin: "0 0 4px" }}>
              เลขตัวถัง <strong>{deleting.chassis}</strong> · {deleting.customerName} · {deleting.brandName}
            </p>
            <p style={{ margin: "0 0 4px", fontSize: 13, color: "#5a6885" }}>
              รถคันนี้จะหายไปจากทุกรายการและทุกคิวงาน แต่ข้อมูลยังเก็บไว้ในระบบ ผู้ดูแลระบบกู้คืนได้จากรายการ &quot;รถที่ลบแล้ว&quot;
            </p>
            <form onSubmit={handleDeleteSubmit}>
              <label className="field" style={{ marginTop: 16 }}>
                เหตุผลที่ลบ (Remark) *
                <textarea
                  required
                  maxLength={500}
                  value={deleteRemark}
                  onChange={(e) => setDeleteRemark(e.target.value)}
                  placeholder="ระบุเหตุผลที่ลบรถคันนี้ - จำเป็นต้องกรอกทุกครั้ง"
                />
              </label>
              <div className="form-actions" style={{ marginTop: 16 }}>
                <button type="submit" className="primary danger" disabled={deleteSaving || !deleteRemark.trim()}>
                  ลบข้อมูลรถ
                </button>
                <span
                  className={`customer-message${deleteMessage.error ? " error" : deleteMessage.text ? " success" : ""}`}
                  role="status"
                >
                  {deleteMessage.text}
                </span>
              </div>
            </form>
          </>
        )}
      </dialog>

      <dialog
        ref={dialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) dialogRef.current?.close();
        }}
      >
        <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
          ×
        </button>
        {detail && (
          <>
            <h2>ข้อมูลรถจดใหม่</h2>
            <dl className="customer-detail">
              {VEHICLE_DETAIL_FIELDS.map(([label, getValue]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{getValue(detail) || "—"}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </dialog>

      <dialog
        ref={editDialogRef}
        onClick={(event) => {
          if (event.target === event.currentTarget) editDialogRef.current?.close();
        }}
        style={{ width: "min(760px, 92vw)" }}
      >
        <button className="close" aria-label="ปิด" onClick={() => editDialogRef.current?.close()}>
          ×
        </button>
        <h2>แก้ไขข้อมูลรถจดใหม่</h2>
        <form onSubmit={handleEditSubmit}>
          <VehicleFieldsFieldset
            row={editRow}
            dateText={editDateText}
            onDateTextChange={handleEditDateTextChange}
            onFieldChange={updateEditRow}
            customerOptions={customerOptions}
            brands={brands}
            financeCompanies={financeCompanies}
            financeOn={editFinanceOn}
            onFinanceToggle={toggleEditFinance}
          />
          <label className="field" style={{ marginTop: 20 }}>
            เหตุผลที่แก้ไข (Remark) *
            <textarea
              required
              maxLength={500}
              value={editRemark}
              onChange={(e) => setEditRemark(e.target.value)}
              placeholder="ระบุเหตุผลที่แก้ไขข้อมูลรถคันนี้ - จำเป็นต้องกรอกทุกครั้ง"
            />
          </label>
          <div className="form-actions" style={{ marginTop: 16 }}>
            <button type="submit" className="primary" disabled={editSaving || !editRemark.trim()}>
              บันทึกการแก้ไข
            </button>
            <span
              className={`customer-message${editMessage.error ? " error" : editMessage.text ? " success" : ""}`}
              role="status"
            >
              {editMessage.text}
            </span>
          </div>
        </form>
      </dialog>
    </section>
  );
}
