"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, receiptImageUrl } from "@/lib/api";
import { getCachedUser, getToken } from "@/lib/auth";
import { displayDateToIso, formatDateDigits, isoToDisplayDate, todayIso } from "@/lib/date";
import { plateSwapApi, type PlateSwap, type PlateSwapNewVehicle, type PlateSwapStatusFilter } from "@/lib/plate-swap-api";
import {
  calculatePlateSwapCarFees,
  dutyAmountOf,
  formatBaht,
  PLATE_SWAP_CAR_NUMBER_ITEMS,
  type PlateSwapNumberSource,
} from "@/lib/plate-swap-fee";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ผู้ใช้ 2026-09-22
// หน้ายื่น (PlateSwapSubmitPage): กรอกรถเก่า + ลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (บังคับ) + เลือกค่าใช้จ่าย แล้วบันทึกวันที่ยื่น
// หน้ารับเอกสารกลับ (PlateSwapReturnPage): ถ่าย/แนบรูปใบเสร็จ (บังคับ) แล้วยืนยันวันที่รับเอกสารกลับ

export const PLATE_SWAP_HOME = "/registration/plate-swap";
export const OLD_NEW_HOME = "/registration/plate-swap/old-new";

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);

// บันทึกได้เฉพาะ ADMIN / STAFF_CAR (backend กันอีกชั้น) - บัญชี (ACCOUNTANT) อ่านอย่างเดียว จึงซ่อนฟอร์ม/ปุ่มบันทึก
function useCanWrite(): boolean | null {
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  useEffect(() => {
    const roles = getCachedUser()?.roles ?? [];
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCanWrite(roles.includes("ADMIN") || roles.includes("STAFF_CAR"));
  }, []);
  return canWrite;
}

// รูปอยู่หลัง backend ที่ต้องมี Authorization - โหลดเป็น blob แล้วเปิดในแท็บใหม่ (เปิดแท็บก่อน await กัน popup ถูกบล็อก)
async function openReceiptImage(id: string) {
  const win = window.open("", "_blank");
  try {
    const token = getToken();
    const res = await fetch(receiptImageUrl(id), { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const objectUrl = URL.createObjectURL(await res.blob());
    if (win) win.location.href = objectUrl;
    else window.open(objectUrl, "_blank");
  } catch {
    win?.close();
    window.alert("เปิดรูปไม่สำเร็จ กรุณาลองใหม่");
  }
}

function DateTextInput({ value, onChange, label }: { value: string; onChange: (text: string) => void; label?: string }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      placeholder="วว/ดด/ปปปป"
      aria-label={label}
      value={value}
      onChange={(e) => onChange(formatDateDigits(e.target.value.replace(/\D/g, "").slice(0, 8)))}
    />
  );
}

const plateText = (v: PlateSwapNewVehicle) => [v.plateCategory, v.plateNumber].filter(Boolean).join(" ");

// บรรทัดย่อยของรถเก่าในตาราง - เลขเครื่องมาก่อนเลขตัวถัง ตามลำดับช่องในฟอร์ม (ผู้ใช้ 2026-09-23)
const oldVehicleText = (s: PlateSwap) => `${s.oldBrand} · เครื่อง ${s.oldEngine} · ตัวถัง ${s.oldChassis}`;

// ทะเบียนแสดงเป็น "หมวด เลข" (ผู้ใช้ 2026-09-23: เก็บแยก 2 ช่องเหมือนหน้ายื่นเอกสารรถจดใหม่)
const oldPlateText = (s: PlateSwap) => `${s.oldPlateCategory} ${s.oldPlateNumber}`;
const newPlateText = (s: PlateSwap) => (s.newPlateCategory && s.newPlateNumber ? `${s.newPlateCategory} ${s.newPlateNumber}` : "");

// เลขทะเบียนใหม่ในตาราง - ตอนยื่นอาจยังไม่รู้ จึงกรอก/แก้ได้จากตรงนี้ (ผู้ใช้ 2026-09-23)
function NewPlateCell({ swap, canWrite, onChange }: { swap: PlateSwap; canWrite: boolean; onChange: (swap: PlateSwap) => void }) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(swap.newPlateCategory ?? "");
  const [number, setNumber] = useState(swap.newPlateNumber ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      onChange((await plateSwapApi.setNewPlate(swap.id, category, number)).swap);
      setEditing(false);
    } catch (err) {
      window.alert(errorText(err, "บันทึกทะเบียนใหม่ไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 4, flexWrap: "wrap" }}>
        <input
          value={category}
          onChange={(e) => setCategory(e.target.value.slice(0, 3))}
          placeholder="4กข"
          aria-label="หมวดทะเบียนใหม่"
          className="inspect-input"
          style={{ width: 62 }}
        />
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value.replace(/\D/g, "").slice(0, 4))}
          placeholder="4444"
          aria-label="เลขทะเบียนใหม่"
          inputMode="numeric"
          className="inspect-input"
          style={{ width: 70 }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        <button type="button" className="text-button" disabled={busy} onClick={save}>
          บันทึก
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setCategory(swap.newPlateCategory ?? "");
            setNumber(swap.newPlateNumber ?? "");
            setEditing(false);
          }}
        >
          ยกเลิก
        </button>
      </div>
    );
  }

  const text = newPlateText(swap);
  return (
    <div className="sub">
      {text ? `ใหม่: ${text}` : <span style={{ color: "#bb8527" }}>ยังไม่ได้เลขใหม่</span>}
      {canWrite && (
        <button type="button" className="text-button" style={{ paddingLeft: 6 }} onClick={() => setEditing(true)}>
          {text ? "แก้ไข" : "กรอกเลข"}
        </button>
      )}
    </div>
  );
}

// ค้นรถใหม่ด้วยเลขตัวถังแล้วเลือก 1 คัน (ปุ่มลิงก์ข้อมูลรถในฐานข้อมูลรถจดใหม่)
function NewVehiclePicker({ onPick, onCancel }: { onPick: (v: PlateSwapNewVehicle) => void; onCancel?: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlateSwapNewVehicle[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function search() {
    if (!query.trim()) {
      setError("พิมพ์เลขตัวถังของรถใหม่ (บางส่วนก็ได้)");
      return;
    }
    setBusy(true);
    setError("");
    try {
      setResults((await plateSwapApi.searchNewVehicles(query)).vehicles);
    } catch (err) {
      setError(errorText(err, "ค้นหาไม่สำเร็จ"));
      setResults(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder="เลขตัวถังรถใหม่"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              search();
            }
          }}
          style={{ flex: "1 1 200px", minWidth: 0 }}
        />
        <button type="button" className="filter-chip" onClick={search} disabled={busy}>
          {busy ? "กำลังค้นหา…" : "ค้นหา"}
        </button>
        {onCancel && (
          <button type="button" className="text-button" onClick={onCancel}>
            ยกเลิก
          </button>
        )}
      </div>
      {error && <div className="customer-message error">{error}</div>}
      {results && results.length === 0 && <div className="customer-message">ไม่พบรถยนต์ที่เลขตัวถังตรงกันในฐานข้อมูลรถจดใหม่</div>}
      {results && results.length > 0 && (
        <div className="choices" style={{ marginTop: 0 }}>
          {results.map((v) => (
            <button key={v.id} type="button" onClick={() => onPick(v)}>
              <strong>{v.chassis}</strong>
              <div className="muted">
                {v.brandName} · {v.customerName}
                {plateText(v) ? ` · ทะเบียน ${plateText(v)}` : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LinkedVehicle({ vehicle }: { vehicle: PlateSwapNewVehicle }) {
  return (
    <div>
      <div className="job">{vehicle.chassis}</div>
      <div className="sub">
        {vehicle.brandName} · {vehicle.customerName}
        {plateText(vehicle) ? ` · ${plateText(vehicle)}` : ""}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ายื่น
// ---------------------------------------------------------------------------------------------

const EMPTY_FORM = {
  oldOwnerName: "",
  oldEngine: "",
  oldChassis: "",
  oldBrand: "",
  oldPlateCategory: "",
  oldPlateNumber: "",
  newPlateCategory: "",
  newPlateNumber: "",
};

export function PlateSwapSubmitPage() {
  const canWrite = useCanWrite();
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => displayDateToIso(submitDateText.replace(/\D/g, "")), [submitDateText]);
  const [newVehicle, setNewVehicle] = useState<PlateSwapNewVehicle | null>(null);
  const [picking, setPicking] = useState(false);
  const [numberSource, setNumberSource] = useState<PlateSwapNumberSource>("NEW_UNUSED");
  const [buyNormalPlate, setBuyNormalPlate] = useState(false);
  const [buyAuctionPlate, setBuyAuctionPlate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [brandNames, setBrandNames] = useState<string[]>([]);

  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [swaps, setSwaps] = useState<PlateSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");

  const fees = calculatePlateSwapCarFees({ numberSource, buyNormalPlate, buyAuctionPlate });
  const numberItems = PLATE_SWAP_CAR_NUMBER_ITEMS[numberSource];

  async function load(forMonth: string) {
    setLoading(true);
    setListError("");
    try {
      setSwaps((await plateSwapApi.list("all", forMonth)).swaps);
    } catch (err) {
      setListError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      setSwaps([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการใหม่เมื่อเปลี่ยนเดือน
    if (month) load(month);
  }, [month]);

  useEffect(() => {
    // ยี่ห้อรถเก่าเลือกจาก dropdown ยี่ห้อในฐานข้อมูล (ผู้ใช้ 2026-09-22) - ยี่ห้อที่ยังไม่มีให้เพิ่มจากหน้าเพิ่มข้อมูลรถจดใหม่
    api
      .listBrands()
      .then((data) => setBrandNames(data.brands.map((b) => b.name)))
      .catch(() => setBrandNames([]));
  }, []);

  function chooseNumberSource(source: PlateSwapNumberSource) {
    setNumberSource(source);
    if (source === "NEW_UNUSED") setBuyAuctionPlate(false);
  }

  const setField = (key: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submitDate) {
      setMessage({ text: "กรุณากรอกวันที่ยื่นให้ถูกต้อง", error: true });
      return;
    }
    if (!newVehicle) {
      setMessage({ text: "กรุณาลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ก่อนบันทึก", error: true });
      return;
    }
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await plateSwapApi.create({
        ...form,
        newVehicleId: newVehicle.id,
        submitDate,
        numberSource,
        buyNormalPlate,
        buyAuctionPlate,
      });
      setMessage({ text: "บันทึกงานที่ยื่นแล้ว" });
      setForm(EMPTY_FORM);
      setNewVehicle(null);
      setPicking(false);
      if (submitDate.slice(0, 7) === month) await load(month);
      else setMonth(submitDate.slice(0, 7));
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setSaving(false);
    }
  }

  const replaceSwap = (updated: PlateSwap) => setSwaps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  async function relink(swap: PlateSwap, vehicle: PlateSwapNewVehicle) {
    try {
      const { swap: updated } = await plateSwapApi.linkNewVehicle(swap.id, vehicle.id);
      setSwaps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
    } catch (err) {
      window.alert(errorText(err, "บันทึกไม่สำเร็จ"));
    }
  }

  async function remove(swap: PlateSwap) {
    if (!window.confirm(`ลบงานสลับเลขของ ${swap.oldOwnerName} (${oldPlateText(swap)})?`)) return;
    try {
      await plateSwapApi.remove(swap.id);
      setSwaps((prev) => prev.filter((s) => s.id !== swap.id));
    } catch (err) {
      window.alert(errorText(err, "ลบไม่สำเร็จ"));
    }
  }

  // ยอดรวมของเดือน - ค่าอากรแยกออกจาก "รวมทั้งหมด" แต่ยังอยู่ในยอด No Bill (ผู้ใช้ 2026-09-23)
  const monthTotals = swaps.reduce(
    (acc, s) => ({
      bill: acc.bill + Number(s.billTotal),
      noBill: acc.noBill + Number(s.noBillTotal),
      duty: acc.duty + dutyAmountOf(s.noBillItems),
    }),
    { bill: 0, noBill: 0, duty: 0 },
  );

  return (
    <section className="content">
      <Link href={OLD_NEW_HOME} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← รถเก่า กับ รถใหม่
      </Link>
      <h1>ยื่นงานสลับเลข (รถยนต์)</h1>

      {canWrite && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <form className="customer-form" onSubmit={handleSubmit}>
            <h2 style={{ marginTop: 0 }}>รถเก่า</h2>
            {/* ลำดับช่องตามที่ผู้ใช้กำหนด 2026-09-23: วันที่ยื่น -> ชื่อเจ้าของรถ -> เลขเครื่อง -> เลขตัวถัง -> ยี่ห้อ -> ทะเบียนเก่า/ใหม่ */}
            <div className="customer-grid">
              <label className="field">
                วันที่ยื่น *
                <DateTextInput value={submitDateText} onChange={setSubmitDateText} />
              </label>
              <label className="field">
                ชื่อเจ้าของรถ *
                <input value={form.oldOwnerName} onChange={setField("oldOwnerName")} required />
              </label>
              <label className="field">
                เลขเครื่อง *
                <input value={form.oldEngine} onChange={setField("oldEngine")} required />
              </label>
              <label className="field">
                เลขตัวถัง *
                <input value={form.oldChassis} onChange={setField("oldChassis")} required />
              </label>
              <label className="field">
                ยี่ห้อ *
                <select value={form.oldBrand} onChange={(e) => setForm((prev) => ({ ...prev, oldBrand: e.target.value }))} required>
                  <option value="">เลือกยี่ห้อ</option>
                  {brandNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field">
                ทะเบียนเก่า *
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={form.oldPlateCategory}
                    onChange={setField("oldPlateCategory")}
                    maxLength={3}
                    placeholder="หมวด เช่น 4กข"
                    aria-label="หมวดทะเบียนเก่า"
                    required
                  />
                  <input
                    value={form.oldPlateNumber}
                    onChange={(e) => setForm((prev) => ({ ...prev, oldPlateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="เลข เช่น 4444"
                    aria-label="เลขทะเบียนเก่า"
                    required
                  />
                </div>
              </div>
              {/* ผู้ใช้ 2026-09-23: ตอนยื่นบางทียังไม่รู้เลขใหม่ - เว้นว่างได้ แล้วมากรอกตอนรับเอกสารกลับ */}
              <div className="field">
                ทะเบียนใหม่ (ยังไม่รู้เว้นว่างได้)
                <div style={{ display: "flex", gap: 8 }}>
                  <input
                    value={form.newPlateCategory}
                    onChange={setField("newPlateCategory")}
                    maxLength={3}
                    placeholder="หมวด เช่น 4กข"
                    aria-label="หมวดทะเบียนใหม่"
                  />
                  <input
                    value={form.newPlateNumber}
                    onChange={(e) => setForm((prev) => ({ ...prev, newPlateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
                    maxLength={4}
                    inputMode="numeric"
                    placeholder="เลข เช่น 4444"
                    aria-label="เลขทะเบียนใหม่"
                  />
                </div>
              </div>
            </div>

            <h2 style={{ marginTop: 28 }}>รถใหม่ (จากฐานข้อมูลรถจดใหม่) *</h2>
            {newVehicle ? (
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <LinkedVehicle vehicle={newVehicle} />
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setNewVehicle(null);
                    setPicking(true);
                  }}
                >
                  เปลี่ยนคัน
                </button>
              </div>
            ) : picking ? (
              <NewVehiclePicker
                onPick={(v) => {
                  setNewVehicle(v);
                  setPicking(false);
                }}
                onCancel={() => setPicking(false)}
              />
            ) : (
              <button type="button" className="filter-chip" onClick={() => setPicking(true)}>
                🔗 ลิงก์ข้อมูลรถใหม่ด้วยเลขตัวถัง
              </button>
            )}

            <h2 style={{ marginTop: 28 }}>ค่าใช้จ่าย</h2>
            <div className="inspect-filter" style={{ padding: 0, marginBottom: 14 }}>
              {(Object.keys(PLATE_SWAP_CAR_NUMBER_ITEMS) as PlateSwapNumberSource[]).map((source) => (
                <button
                  key={source}
                  type="button"
                  className={`filter-chip${numberSource === source ? " selected" : ""}`}
                  onClick={() => chooseNumberSource(source)}
                >
                  {PLATE_SWAP_CAR_NUMBER_ITEMS[source].title}
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 14, marginBottom: 16 }}>
              <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <input type="checkbox" checked={buyNormalPlate} onChange={(e) => setBuyNormalPlate(e.target.checked)} />
                ซื้อ{numberItems.normalPlate.label.replace(/^ค่า/, "")} ({formatBaht(numberItems.normalPlate.amount)} บาท)
              </label>
              {numberItems.auctionPlate && (
                <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input type="checkbox" checked={buyAuctionPlate} onChange={(e) => setBuyAuctionPlate(e.target.checked)} />
                  ซื้อ{numberItems.auctionPlate.label.replace(/^ค่า/, "")} ({formatBaht(numberItems.auctionPlate.amount)} บาท)
                </label>
              )}
            </div>

            <div className="customer-grid">
              <div>
                <strong>Bill (ใบเสร็จ)</strong>
                <table style={{ marginTop: 8 }}>
                  <tbody>
                    {fees.billItems.map((item) => (
                      <tr key={item.label}>
                        <td style={{ whiteSpace: "normal" }}>{item.label}</td>
                        <td style={{ textAlign: "right" }}>{formatBaht(item.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>รวม Bill</strong>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <strong>{formatBaht(fees.billTotal)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <strong>No Bill</strong>
                <table style={{ marginTop: 8 }}>
                  <tbody>
                    {fees.noBillItems.map((item) => (
                      <tr key={item.label}>
                        <td>{item.label}</td>
                        <td style={{ textAlign: "right" }}>{formatBaht(item.amount)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>
                        <strong>รวม No Bill</strong>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <strong>{formatBaht(fees.noBillTotal)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              {/* ยอดรวมสุทธิของงานนี้ (Bill + No Bill) - ผู้ใช้ขอ 2026-09-23 */}
              <div
                className="wide"
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 16,
                  padding: "14px 16px",
                  marginTop: 4,
                  background: "#f7f9ff",
                  border: "1px solid #dfe5f0",
                  borderRadius: 10,
                  fontSize: 15,
                }}
              >
                <strong>รวมทั้งหมด (Bill + No Bill ไม่รวมค่าอากร)</strong>
                <span style={{ textAlign: "right" }}>
                  <strong>{formatBaht(fees.total)} บาท</strong>
                  <div className="muted">แยกค่าอากร {formatBaht(fees.dutyTotal)} บาท</div>
                </span>
              </div>
            </div>

            <div className="form-actions">
              <button className="primary" type="submit" disabled={saving}>
                บันทึกการยื่น
              </button>
              <span className={`customer-message${message.error ? " error" : message.text ? " success" : ""}`} role="status">
                {message.text}
              </span>
            </div>
          </form>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>รายการที่ยื่นแล้ว</h2>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
            เดือนที่ยื่น
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
        </div>
        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : listError ? (
          <div className="empty-customers" role="alert">
            {listError}
          </div>
        ) : swaps.length === 0 ? (
          <div className="empty-customers">ยังไม่มีรายการในเดือนนี้</div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>วันที่ยื่น</th>
                    <th>รถเก่า</th>
                    <th>ทะเบียนเก่า / ใหม่</th>
                    <th>รถใหม่ที่ลิงก์</th>
                    <th>Bill</th>
                    <th>No Bill</th>
                    <th>ค่าอากร</th>
                    <th>รวม</th>
                    <th>สถานะ</th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {swaps.map((swap) => (
                    <SubmittedRow key={swap.id} swap={swap} canWrite={!!canWrite} onRelink={relink} onRemove={remove} onPlateChange={replaceSwap} />
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: "18px 23px", borderTop: "1px solid #edf0f6", fontSize: 13, color: "#34415a" }}>
              <strong>
                รวม {swaps.length} คัน · Bill {formatBaht(monthTotals.bill)} · No Bill {formatBaht(monthTotals.noBill)} · ค่าอากร{" "}
                {formatBaht(monthTotals.duty)} · รวมทั้งหมดไม่รวมค่าอากร {formatBaht(monthTotals.bill + monthTotals.noBill - monthTotals.duty)} บาท
              </strong>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function SubmittedRow({
  swap,
  canWrite,
  onRelink,
  onRemove,
  onPlateChange,
}: {
  swap: PlateSwap;
  canWrite: boolean;
  onRelink: (swap: PlateSwap, vehicle: PlateSwapNewVehicle) => void;
  onRemove: (swap: PlateSwap) => void;
  onPlateChange: (swap: PlateSwap) => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <tr>
      <td>{isoToDisplayDate(swap.submitDate)}</td>
      <td>
        <div className="job">{swap.oldOwnerName}</div>
        <div className="sub">{oldVehicleText(swap)}</div>
      </td>
      <td>
        <div>{oldPlateText(swap)}</div>
        <NewPlateCell swap={swap} canWrite={canWrite} onChange={onPlateChange} />
      </td>
      <td style={{ whiteSpace: "normal", minWidth: 200 }}>
        {picking ? (
          <NewVehiclePicker
            onPick={(v) => {
              setPicking(false);
              onRelink(swap, v);
            }}
            onCancel={() => setPicking(false)}
          />
        ) : (
          <>
            {swap.newVehicle ? <LinkedVehicle vehicle={swap.newVehicle} /> : <span className="muted">ยังไม่ลิงก์</span>}
            {canWrite && (
              <div>
                <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => setPicking(true)}>
                  {swap.newVehicle ? "เปลี่ยนคัน" : "🔗 ลิงก์รถใหม่"}
                </button>
              </div>
            )}
          </>
        )}
      </td>
      <td title={swap.billItems.map((i) => `${i.label} ${formatBaht(i.amount)}`).join("\n")}>{formatBaht(Number(swap.billTotal))}</td>
      <td>{formatBaht(Number(swap.noBillTotal))}</td>
      <td>{formatBaht(dutyAmountOf(swap.noBillItems))}</td>
      <td>
        {/* ยอดรวมไม่นับค่าอากร (ผู้ใช้ 2026-09-23) - ค่าอากรอ่านจาก snapshot รายการ No Bill ของงานนั้น */}
        <strong>{formatBaht(Number(swap.billTotal) + Number(swap.noBillTotal) - dutyAmountOf(swap.noBillItems))}</strong>
      </td>
      <td>
        {swap.returnedDate ? (
          <span className="badge portal-badge-done">รับกลับ {isoToDisplayDate(swap.returnedDate)}</span>
        ) : (
          <span className="badge">รอรับเอกสารกลับ</span>
        )}
      </td>
      {canWrite && (
        <td>
          {!swap.returnedDate && (
            <button type="button" className="text-button" style={{ color: "#b43434" }} onClick={() => onRemove(swap)}>
              ลบ
            </button>
          )}
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ารับเอกสารกลับ
// ---------------------------------------------------------------------------------------------

export function PlateSwapReturnPage() {
  const canWrite = useCanWrite();
  const [status, setStatus] = useState<Exclude<PlateSwapStatusFilter, "all">>("pending");
  const [swaps, setSwaps] = useState<PlateSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [returnDateText, setReturnDateText] = useState(() => isoToDisplayDate(todayIso()));
  const returnDate = useMemo(() => displayDateToIso(returnDateText.replace(/\D/g, "")), [returnDateText]);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  async function load(forStatus: typeof status) {
    setLoading(true);
    setListError("");
    try {
      setSwaps((await plateSwapApi.list(forStatus)).swaps);
    } catch (err) {
      setListError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      setSwaps([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการใหม่เมื่อเปลี่ยนแท็บ
    load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const replace = (updated: PlateSwap) => setSwaps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  async function confirmReturn(swap: PlateSwap, newPlateCategory: string, newPlateNumber: string) {
    if (!returnDate) {
      setMessage({ text: "กรุณากรอกวันที่รับเอกสารกลับให้ถูกต้อง", error: true });
      return;
    }
    if (!newPlateCategory || !newPlateNumber) {
      setMessage({ text: "กรุณากรอกทะเบียนใหม่ที่ได้รับ (หมวดทะเบียนและเลขทะเบียน)", error: true });
      return;
    }
    try {
      await plateSwapApi.markReturned(swap.id, returnDate, newPlateCategory, newPlateNumber);
      setSwaps((prev) => prev.filter((s) => s.id !== swap.id));
      setMessage({ text: `รับเอกสารกลับแล้ว: ${swap.oldOwnerName} (${oldPlateText(swap)})` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  return (
    <section className="content">
      <Link href={OLD_NEW_HOME} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← รถเก่า กับ รถใหม่
      </Link>
      <h1>รับเอกสารกลับ (รถยนต์)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        ถ่ายหรือแนบรูปใบเสร็จอย่างน้อย 1 รูป แล้วกดยืนยันรับเอกสารกลับตามวันที่ที่ระบุ
      </p>

      <div className="panel">
        <div className="panel-head">
          <div className="inspect-filter" style={{ padding: 0 }}>
            <button type="button" className={`filter-chip${status === "pending" ? " selected" : ""}`} onClick={() => setStatus("pending")}>
              รอรับเอกสารกลับ
            </button>
            <button type="button" className={`filter-chip${status === "returned" ? " selected" : ""}`} onClick={() => setStatus("returned")}>
              รับกลับแล้ว
            </button>
          </div>
          {status === "pending" && canWrite && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              วันที่รับเอกสารกลับ
              <DateTextInput value={returnDateText} onChange={setReturnDateText} label="วันที่รับเอกสารกลับ" />
            </label>
          )}
        </div>
        {message.text && (
          <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ padding: "0 23px 14px" }}>
            {message.text}
          </div>
        )}
        {loading ? (
          <div className="empty-customers">กำลังโหลดรายการ…</div>
        ) : listError ? (
          <div className="empty-customers" role="alert">
            {listError}
          </div>
        ) : swaps.length === 0 ? (
          <div className="empty-customers">{status === "pending" ? "ไม่มีงานที่รอรับเอกสารกลับ" : "ยังไม่มีงานที่รับกลับแล้ว"}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ยื่น</th>
                  <th>รถเก่า</th>
                  <th>ทะเบียนเก่า / ใหม่</th>
                  <th>รถใหม่ที่ลิงก์</th>
                  <th>ใบเสร็จ</th>
                  <th>{status === "pending" ? "" : "วันที่รับกลับ"}</th>
                </tr>
              </thead>
              <tbody>
                {swaps.map((swap) => (
                  <ReturnRow
                    key={swap.id}
                    swap={swap}
                    canWrite={!!canWrite && status === "pending"}
                    onChange={replace}
                    onConfirm={confirmReturn}
                    onMessage={(text, error) => setMessage({ text, error })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function ReturnRow({
  swap,
  canWrite,
  onChange,
  onConfirm,
  onMessage,
}: {
  swap: PlateSwap;
  canWrite: boolean;
  onChange: (swap: PlateSwap) => void;
  onConfirm: (swap: PlateSwap, newPlateCategory: string, newPlateNumber: string) => void;
  onMessage: (text: string, error?: boolean) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [plateCategoryText, setPlateCategoryText] = useState(swap.newPlateCategory ?? "");
  const [plateNumberText, setPlateNumberText] = useState(swap.newPlateNumber ?? "");

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    onMessage("");
    try {
      for (const file of Array.from(files)) {
        const image = await compressReceiptImage(file);
        onChange((await plateSwapApi.addReceipt(swap.id, image, compressedFileName(file))).swap);
      }
    } catch (err) {
      onMessage(errorText(err, "แนบรูปไม่สำเร็จ"), true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function removeReceipt(receiptId: string) {
    if (!window.confirm("ลบรูปใบเสร็จนี้?")) return;
    try {
      onChange((await plateSwapApi.removeReceipt(swap.id, receiptId)).swap);
    } catch (err) {
      onMessage(errorText(err, "ลบรูปไม่สำเร็จ"), true);
    }
  }

  return (
    <tr>
      <td>{isoToDisplayDate(swap.submitDate)}</td>
      <td>
        <div className="job">{swap.oldOwnerName}</div>
        <div className="sub">{oldVehicleText(swap)}</div>
      </td>
      <td>
        <div>{oldPlateText(swap)}</div>
        {/* ผู้ใช้ 2026-09-23: ทะเบียนใหม่ได้มาตอนงานเรียบร้อย จึงกรอกที่หน้านี้ได้เลย (หมวด + เลข) */}
        {canWrite ? (
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            <input
              value={plateCategoryText}
              onChange={(e) => setPlateCategoryText(e.target.value.slice(0, 3))}
              placeholder="4กข"
              aria-label="หมวดทะเบียนใหม่"
              className="inspect-input"
              style={{ width: 62 }}
            />
            <input
              value={plateNumberText}
              onChange={(e) => setPlateNumberText(e.target.value.replace(/\D/g, "").slice(0, 4))}
              placeholder="4444"
              aria-label="เลขทะเบียนใหม่"
              inputMode="numeric"
              className="inspect-input"
              style={{ width: 70 }}
            />
          </div>
        ) : (
          <div className="sub">{newPlateText(swap) ? `ใหม่: ${newPlateText(swap)}` : "ยังไม่ได้เลขใหม่"}</div>
        )}
      </td>
      <td style={{ whiteSpace: "normal" }}>
        {swap.newVehicle ? <LinkedVehicle vehicle={swap.newVehicle} /> : <span className="muted">ยังไม่ลิงก์</span>}
      </td>
      <td>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {swap.receipts.length === 0 && <span className="muted">ยังไม่มีรูป</span>}
          {swap.receipts.map((r, i) => (
            <span key={r.id} style={{ display: "inline-flex", alignItems: "center" }}>
              <button type="button" className="text-button" onClick={() => openReceiptImage(r.id)}>
                🧾 รูป {i + 1}
              </button>
              {canWrite && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`ลบรูปใบเสร็จที่ ${i + 1}`}
                  style={{ color: "#b43434" }}
                  onClick={() => removeReceipt(r.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {canWrite && (
          <>
            <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
            <button type="button" className="text-button" style={{ paddingLeft: 0 }} disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? "กำลังอัปโหลด…" : "📷 ถ่าย/แนบใบเสร็จ"}
            </button>
          </>
        )}
      </td>
      <td>
        {swap.returnedDate ? (
          isoToDisplayDate(swap.returnedDate)
        ) : canWrite ? (
          <button
            type="button"
            className="primary"
            style={{ padding: "8px 14px", fontSize: 13 }}
            disabled={busy || swap.receipts.length === 0 || !plateCategoryText.trim() || !plateNumberText.trim()}
            title={
              swap.receipts.length === 0
                ? "แนบรูปใบเสร็จก่อน"
                : !plateCategoryText.trim() || !plateNumberText.trim()
                  ? "กรอกทะเบียนใหม่ (หมวดทะเบียนและเลขทะเบียน) ก่อน"
                  : undefined
            }
            onClick={() => onConfirm(swap, plateCategoryText.trim(), plateNumberText.trim())}
          >
            ยืนยันรับกลับ
          </button>
        ) : null}
      </td>
    </tr>
  );
}
