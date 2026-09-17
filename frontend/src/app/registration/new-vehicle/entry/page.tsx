"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, ApiError, type Brand, type Customer, type Vehicle } from "@/lib/api";
import { FUEL_TYPES, PROVINCES, VEHICLE_COLUMNS, VEHICLE_TYPES, getVehicleStatus } from "@/lib/vehicle-reference-data";
import { getVehicleRowErrors, normalizeVehicleRow, type NormalizedVehicleRow } from "@/lib/vehicle-validation";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";

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
  registrationProvince: "",
  ownerProvince: "",
};

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
  const matches = rows.filter((r) => r.name === value);
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
  const [lookupReady, setLookupReady] = useState(false);
  const [lookupMessage, setLookupMessage] = useState("กำลังโหลดลูกค้าและยี่ห้อ…");

  const [showBrandForm, setShowBrandForm] = useState(false);
  const [brandName, setBrandName] = useState("");
  const [brandSaving, setBrandSaving] = useState(false);
  const [brandMessage, setBrandMessage] = useState("");

  const [single, setSingle] = useState<NormalizedVehicleRow>({ ...EMPTY_SINGLE, date: todayIso() });
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

  async function loadLookups() {
    setLookupReady(false);
    setLookupMessage("กำลังโหลดลูกค้าและยี่ห้อ…");
    try {
      const [c, b] = await Promise.all([api.listCustomers(), api.listBrands()]);
      setCustomers(c.customers);
      setBrands(b.brands);
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

  useEffect(() => {
    // Standard fetch-on-mount; both loaders set a loading flag before their first await.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadLookups();
    loadVehicles();
  }, []);

  const customerOptions = useMemo(
    () => customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") })),
    [customers],
  );

  function updateSingle<K extends keyof NormalizedVehicleRow>(key: K, value: string) {
    setSingle((prev) => ({ ...prev, [key]: value }));
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

  async function handleSingleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!lookupReady) return;
    const row = normalizeVehicleRow(single);
    const errors = getVehicleRowErrors(row);
    if (errors.length) {
      setSingleMessage({ text: errors.join(" · "), error: true });
      return;
    }
    setSingleSaving(true);
    setSingleMessage({ text: "กำลังบันทึก…" });
    try {
      await api.createVehicles([row]);
      setSingle({ ...EMPTY_SINGLE, date: todayIso() });
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
        const { Workbook } = await import("exceljs");
        const workbook = new Workbook();
        await workbook.xlsx.load(await file.arrayBuffer());
        const sheet = workbook.worksheets[0];
        if (!sheet) throw new Error("ไม่พบชีตข้อมูล");
        if (sheet.rowCount > 101) throw new Error("รองรับไม่เกิน 100 แถวต่อไฟล์");
        cells = [];
        sheet.eachRow({ includeEmpty: true }, (row) => {
          const values: string[] = [];
          for (let i = 1; i <= Math.max(12, row.cellCount); i++) {
            const cell = row.getCell(i);
            const value = cell.value;
            if (value && typeof value === "object" && ("formula" in value || "sharedFormula" in value)) {
              throw new Error("ไม่รองรับสูตร Excel กรุณาวางเป็นค่า");
            }
            values.push(value instanceof Date ? value.toISOString().slice(0, 10) : cell.text);
          }
          cells.push(values);
        });
      } else {
        throw new Error("เลือกไฟล์ .xlsx หรือ .csv เท่านั้น");
      }

      const withIndex = cells
        .map((row, i) => ({ cells: row, sourceRow: i + 1 }))
        .filter((r) => r.cells.some((c) => String(c ?? "").trim()));
      if (withIndex.length < 2) throw new Error("ไฟล์ยังไม่มีข้อมูลรถ");
      if (withIndex.length > 101) throw new Error("รองรับไม่เกิน 100 แถวต่อไฟล์");

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
            <div className="vehicle-fields">
              <label className="field">
                วันที่ *
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="วว/ดด/ปปปป"
                  required
                  value={dateText}
                  onChange={(e) => handleDateTextChange(e.target.value)}
                />
              </label>
              <label className="field">
                ชื่อลูกค้า *
                <select required value={single.customerId} onChange={(e) => updateSingle("customerId", e.target.value)}>
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
                <input
                  maxLength={250}
                  required
                  value={single.chassis}
                  onChange={(e) => updateSingle("chassis", e.target.value)}
                />
              </label>
              <label className="field">
                เลขเครื่อง
                <input maxLength={250} value={single.engine} onChange={(e) => updateSingle("engine", e.target.value)} />
              </label>
              <label className="field">
                ยี่ห้อ *
                <select required value={single.brandId} onChange={(e) => updateSingle("brandId", e.target.value)}>
                  <option value="">เลือกยี่ห้อ</option>
                  {brands.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                ประเภทเชื้อเพลิง
                <select value={single.fuel} onChange={(e) => updateSingle("fuel", e.target.value)}>
                  <option value="">เลือกประเภทเชื้อเพลิง</option>
                  {FUEL_TYPES.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                ขนาด CC
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={single.cc}
                  onChange={(e) => updateSingle("cc", e.target.value)}
                />
              </label>
              <label className="field">
                น้ำหนักรถ (กก.)
                <input
                  type="number"
                  min={0}
                  step="any"
                  value={single.weight}
                  onChange={(e) => updateSingle("weight", e.target.value)}
                />
              </label>
              <label className="field">
                สี
                <input maxLength={250} value={single.color} onChange={(e) => updateSingle("color", e.target.value)} />
              </label>
              <label className="field">
                ประเภทรถ
                <select value={single.body} onChange={(e) => updateSingle("body", e.target.value)}>
                  <option value="">เลือกประเภทรถ</option>
                  {VEHICLE_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                จังหวัดที่จดทะเบียน
                <select
                  value={single.registrationProvince}
                  onChange={(e) => updateSingle("registrationProvince", e.target.value)}
                >
                  <option value="">เลือกจังหวัด</option>
                  {PROVINCES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                จังหวัดเจ้าของรถ
                <select value={single.ownerProvince} onChange={(e) => updateSingle("ownerProvince", e.target.value)}>
                  <option value="">เลือกจังหวัด</option>
                  {PROVINCES.map((p) => (
                    <option key={p}>{p}</option>
                  ))}
                </select>
              </label>
            </div>
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
              รองรับ Excel (.xlsx) และ CSV UTF-8 · สูงสุด 100 คันต่อไฟล์ · ไม่เกิน 5 MB
              <br />
              ใช้ 12 คอลัมน์ตามแบบฟอร์ม วันที่เป็น ค.ศ. YYYY-MM-DD และตั้งเลขตัวถัง / เลขเครื่องเป็นข้อความ
              <br />
              คอลัมน์ลูกค้าและยี่ห้อใช้ชื่อที่มีในฐานข้อมูล หรือรหัสจากรายการอ้างอิง กรณีชื่อซ้ำให้ใช้รหัส
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
                      <th>ลูกค้า</th>
                      <th>เลขตัวถัง</th>
                      <th>ผลตรวจสอบ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batchRows.map((row) => (
                      <tr key={row.sourceRow}>
                        <td>{row.sourceRow}</td>
                        <td>{row.customerId}</td>
                        <td>{row.chassis}</td>
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
          <button className="text-button" onClick={loadVehicles}>
            โหลดรายการใหม่
          </button>
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
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

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
    </section>
  );
}
