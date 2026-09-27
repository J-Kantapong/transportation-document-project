"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fetchAuthedBlob, receiptImageUrl } from "@/lib/api";
import { getCachedUser, getToken } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  plateSwapApi,
  type PlateSwap,
  type PlateSwapNewVehicle,
  type PlateSwapStatusFilter,
  type PlateSwapVehicleHit,
} from "@/lib/plate-swap-api";
import {
  calculatePlateSwapCarFees,
  dutyAmountOf,
  formatBaht,
  PLATE_SWAP_CAR_NUMBER_ITEMS,
  type PlateSwapNumberSource,
} from "@/lib/plate-swap-fee";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { focusHref, workPageFor } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ผู้ใช้ 2026-09-22
// หน้ายื่น (PlateSwapSubmitPage): กรอกรถเก่า + ลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (บังคับ) + เลือกค่าใช้จ่าย แล้วบันทึกวันที่ยื่น
// หน้ารับเอกสารกลับ (PlateSwapReturnPage): ถ่าย/แนบรูปใบเสร็จ (บังคับ) แล้วยืนยันวันที่รับเอกสารกลับ
// แก้/ยกเลิก (ผู้ใช้ 2026-09-27): ADMIN + STAFF_CAR แก้ข้อมูลงาน (✎ แก้) ยกเลิกรับกลับ และยกเลิกงานได้ ต้องระบุเหตุผลเสมอ
// (เก็บประวัติ) - ไม่มีการลบงานแล้ว งานที่ยกเลิกหายจากรายการและยอดรวม แต่ยังอยู่ในฐานข้อมูล
// รถใหม่รับ "ทะเบียนเก่า" ของรถเก่า ส่วน "ทะเบียนใหม่" คือเลขที่รถเก่าได้รับ (ผู้ใช้ยืนยัน 2026-09-27)

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
// 401 (token หมดอายุ) fetchAuthedBlob พาไปหน้าล็อกอินเองและล้าง session แล้ว - ไม่ต้องเตือน "เปิดไม่สำเร็จ" ซ้ำ (พบ 2026-09-27)
async function openReceiptImage(id: string) {
  const win = window.open("", "_blank");
  try {
    const objectUrl = URL.createObjectURL(await fetchAuthedBlob(receiptImageUrl(id)));
    if (win) win.location.href = objectUrl;
    else window.open(objectUrl, "_blank");
  } catch {
    win?.close();
    if (getToken()) window.alert("เปิดรูปไม่สำเร็จ กรุณาลองใหม่");
  }
}

function DateTextInput({ value, onChange, label }: { value: string; onChange: (text: string) => void; label?: string }) {
  return (
    <DateInput
      aria-label={label}
      value={value}
      // พิมพ์ปี พ.ศ. ตามใบเสร็จได้ - ครบ 8 หลักแล้วแปลงเป็น ค.ศ. ให้ (เดิมขึ้น "กรุณากรอกวันที่ให้ถูกต้อง" - พบ 2026-09-27)
      onChange={(value) => onChange(formatDateDigitsCe(value.replace(/\D/g, "").slice(0, 8)))}
    />
  );
}

const textToIso = (text: string) => displayDateToIso(text.replace(/\D/g, ""));

const plateText = (v: PlateSwapNewVehicle) => [v.plateCategory, v.plateNumber].filter(Boolean).join(" ");

// บรรทัดย่อยของรถเก่าในตาราง - เลขเครื่องมาก่อนเลขตัวถัง ตามลำดับช่องในฟอร์ม (ผู้ใช้ 2026-09-23)
const oldVehicleText = (s: PlateSwap) => `${s.oldBrand} · เครื่อง ${s.oldEngine} · ตัวถัง ${s.oldChassis}`;

// ทะเบียนแสดงเป็น "หมวด เลข" (ผู้ใช้ 2026-09-23: เก็บแยก 2 ช่องเหมือนหน้ายื่นเอกสารรถจดใหม่)
const oldPlateText = (s: PlateSwap) => `${s.oldPlateCategory} ${s.oldPlateNumber}`;
const newPlateText = (s: PlateSwap) => (s.newPlateCategory && s.newPlateNumber ? `${s.newPlateCategory} ${s.newPlateNumber}` : "");

const dangerButton: React.CSSProperties = { color: "#b43434" };
const warnBox: React.CSSProperties = {
  margin: "0 23px 14px",
  padding: "12px 14px",
  border: "1px solid #f0c36d",
  background: "#fff8e6",
  borderRadius: 8,
  fontSize: 13,
  color: "#6b4a00",
};

// ป๊อปอัปถามเหตุผล (บังคับ) ก่อนแก้/ยกเลิก - ใช้ซ้ำทั้งยกเลิกงาน ยกเลิกรับกลับ และเปลี่ยนคันหลังรับกลับ
// onConfirm โยน error ได้ ข้อความขึ้นในป๊อปอัปและยังไม่ปิด
function ReasonDialog({
  title,
  children,
  confirmLabel,
  placeholder,
  onConfirm,
  onClose,
}: {
  title: string;
  children?: React.ReactNode;
  confirmLabel: string;
  placeholder?: string;
  onConfirm: (remark: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  async function handleConfirm() {
    setError("");
    if (!remark.trim()) return setError("กรุณาระบุเหตุผล");
    setSaving(true);
    try {
      await onConfirm(remark.trim());
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(520px, 94vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>{title}</h2>
      {children}
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผล *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder={placeholder} />
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
        <button type="button" className="primary" onClick={handleConfirm} disabled={saving}>
          {saving ? "กำลังบันทึก..." : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}

// สรุปงานในป๊อปอัป - ให้เห็นว่ากำลังแก้/ยกเลิกงานไหน
function SwapSummary({ swap }: { swap: PlateSwap }) {
  return (
    <p className="muted">
      {swap.oldOwnerName} · ทะเบียนเก่า {oldPlateText(swap)}
      {newPlateText(swap) ? ` · ใหม่ ${newPlateText(swap)}` : ""} · ยื่น {isoToDisplayDate(swap.submitDate)}
      {swap.returnedDate ? ` · รับกลับ ${isoToDisplayDate(swap.returnedDate)}` : ""}
    </p>
  );
}

// F20 (ผู้ใช้ 2026-09-27): ก่อนแก้ ขั้นยื่นเอกสารเติม "ทะเบียนใหม่ของรถเก่า" ให้รถใหม่ (ผิดฝั่ง) - ขึ้นเตือนให้พนักงานตรวจ
// ที่แก้ขึ้นกับสถานะการยื่นของรถใหม่ (พบ 2026-09-27: เดิมบอกให้แก้ในหน้ารับใบเสร็จทุกกรณี แต่ฟอร์มรับใบเสร็จแก้ได้แค่รายการที่รอใบเสร็จ)
// - รอใบเสร็จ: กรอกทะเบียนตามใบเสร็จตอนบันทึกใบเสร็จ (ลิงก์เปิดใบยื่นของรถคันนี้ให้)
// - ได้ใบเสร็จแล้ว: ปุ่ม ✎ แก้ ในตาราง "ได้ใบเสร็จแล้ว" ของหน้ารับใบเสร็จ (ต้องระบุเหตุผล)
// - ไม่มีรายการยื่นที่ยังมีผล (ยื่นไม่ผ่าน / ยกเลิกการยื่น): ตอนยื่นใหม่ ขั้นยื่นเอกสารเติมทะเบียนเก่าให้แล้ว
const RECEIPT_CAR_PAGE = workPageFor("receipt", "car", [], "/registration/new-vehicle/receive-receipt");

function WrongPlateNote({ swap }: { swap: PlateSwap }) {
  const vehicle = swap.newVehicle;
  if (!swap.linkedPlateIsNewPlate || !vehicle) return null;
  return (
    <div className="sub" style={{ color: "#a86200", whiteSpace: "normal" }}>
      ⚠ รถใหม่ถูกบันทึกทะเบียน {plateText(vehicle)} ซึ่งเป็นทะเบียนใหม่ของรถเก่า - รถใหม่ต้องได้ทะเบียนเก่า {oldPlateText(swap)}{" "}
      กรุณาตรวจกับใบเสร็จจริง{" - "}
      {vehicle.activeSubmissionStatus === "PENDING" ? (
        <>
          รถคันนี้รอใบเสร็จอยู่: กรอกทะเบียนตามใบเสร็จตอนบันทึกใบเสร็จ{" "}
          <Link href={focusHref(RECEIPT_CAR_PAGE, vehicle.chassis)}>ไปหน้ารับใบเสร็จ →</Link>
        </>
      ) : vehicle.activeSubmissionStatus === "RECEIPT_RECEIVED" ? (
        <>
          รถคันนี้ได้ใบเสร็จแล้ว: แก้ที่ปุ่ม ✎ แก้ ในตาราง &quot;ได้ใบเสร็จแล้ว&quot; (ค้นเลขตัวถัง {vehicle.chassis}) พร้อมเหตุผล{" "}
          <Link href={RECEIPT_CAR_PAGE}>ไปหน้ารับใบเสร็จ →</Link>
        </>
      ) : (
        <>รถคันนี้ยังไม่มีรายการยื่นที่รอใบเสร็จ: ตอนยื่นเอกสารใหม่ ระบบเติมทะเบียนเก่าให้แล้ว ตรวจอีกครั้งก่อนยื่น</>
      )}
    </div>
  );
}

function WrongPlateBanner({ swaps }: { swaps: PlateSwap[] }) {
  const count = swaps.filter((s) => s.linkedPlateIsNewPlate).length;
  if (count === 0) return null;
  return (
    <div style={warnBox} role="alert">
      ⚠ มี {count} งานที่รถใหม่ถูกบันทึกทะเบียนเป็น &quot;ทะเบียนใหม่ของรถเก่า&quot; (ขั้นยื่นเอกสารเคยเติมเลขผิดฝั่งก่อน 27/09/2026)
      รถใหม่ต้องได้ทะเบียนเก่าของรถเก่า - ดูแถวที่มี ⚠ ตรวจกับใบเสร็จจริง แล้วแก้ตามที่บอกในแถวนั้น (ที่แก้ขึ้นกับว่ารถคันนั้นยื่นเอกสารถึงขั้นไหนแล้ว)
    </div>
  );
}

// เลขทะเบียนใหม่ในตาราง - ตอนยื่นอาจยังไม่รู้ จึงกรอก/แก้ได้จากตรงนี้ (ผู้ใช้ 2026-09-23)
// งานที่รับเอกสารกลับแล้ว แก้ได้แต่ต้องมีเหตุผล (ผู้ใช้ 2026-09-27)
function NewPlateCell({ swap, canWrite, onChange }: { swap: PlateSwap; canWrite: boolean; onChange: (swap: PlateSwap) => void }) {
  const [editing, setEditing] = useState(false);
  const [category, setCategory] = useState(swap.newPlateCategory ?? "");
  const [number, setNumber] = useState(swap.newPlateNumber ?? "");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const needsRemark = Boolean(swap.returnedDate);

  async function save() {
    if (needsRemark && !remark.trim()) {
      window.alert("งานนี้รับเอกสารกลับแล้ว - กรุณาระบุเหตุผลที่แก้ทะเบียนใหม่");
      return;
    }
    setBusy(true);
    try {
      onChange((await plateSwapApi.setNewPlate(swap.id, category, number, needsRemark ? remark.trim() : undefined)).swap);
      setEditing(false);
      setRemark("");
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
        {needsRemark && (
          <input
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            placeholder="เหตุผลที่แก้ *"
            aria-label="เหตุผลที่แก้ทะเบียนใหม่"
            className="inspect-input"
            style={{ width: 150 }}
          />
        )}
        <button type="button" className="text-button" disabled={busy} onClick={save}>
          บันทึก
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setCategory(swap.newPlateCategory ?? "");
            setNumber(swap.newPlateNumber ?? "");
            setRemark("");
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
// F51 (ผู้ใช้ 2026-09-27): รถที่ยื่นเอกสารแล้ว หรือผูกกับงานสลับเลขอื่นที่ยังไม่รับกลับ เลือกไม่ได้ (แสดงเหตุผล)
// excludeSwapId = งานที่กำลังเปลี่ยนคัน - รถที่ผูกกับงานนี้เองไม่นับว่าผูกซ้ำ
function NewVehiclePicker({
  excludeSwapId,
  onPick,
  onCancel,
}: {
  excludeSwapId?: string;
  onPick: (v: PlateSwapNewVehicle) => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlateSwapVehicleHit[] | null>(null);
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
      setResults((await plateSwapApi.searchNewVehicles(query, excludeSwapId)).vehicles);
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
            <button
              key={v.id}
              type="button"
              disabled={Boolean(v.linkBlockedReason)}
              title={v.linkBlockedReason ?? undefined}
              style={v.linkBlockedReason ? { opacity: 0.65, cursor: "not-allowed" } : undefined}
              onClick={() => {
                if (!v.linkBlockedReason) onPick(v);
              }}
            >
              <strong>{v.chassis}</strong>
              <div className="muted">
                {v.brandName} · {v.customerName}
                {plateText(v) ? ` · ทะเบียน ${plateText(v)}` : ""}
              </div>
              {v.linkBlockedReason && (
                <div style={{ color: "#b43434", fontSize: 12, marginTop: 4, whiteSpace: "normal" }}>🔒 {v.linkBlockedReason}</div>
              )}
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

// ✎ แก้งาน (F34 ผู้ใช้ 2026-09-27): ข้อมูลรถเก่า วันที่ยื่น ที่มาของเลข/ป้าย (คิดค่าใช้จ่ายใหม่) และวันที่รับกลับ (งานที่รับกลับแล้ว)
// ต้องระบุเหตุผล - backend บันทึกเฉพาะช่องที่เปลี่ยนลงประวัติ / ทะเบียนใหม่และรถใหม่แก้ที่ช่องในตาราง
function EditSwapDialog({ swap, onClose, onSaved }: { swap: PlateSwap; onClose: () => void; onSaved: (swap: PlateSwap) => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState({
    oldOwnerName: swap.oldOwnerName,
    oldEngine: swap.oldEngine,
    oldChassis: swap.oldChassis,
    oldBrand: swap.oldBrand,
    oldPlateCategory: swap.oldPlateCategory,
    oldPlateNumber: swap.oldPlateNumber,
  });
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(swap.submitDate));
  const [returnedDateText, setReturnedDateText] = useState(() => (swap.returnedDate ? isoToDisplayDate(swap.returnedDate) : ""));
  const [numberSource, setNumberSource] = useState<PlateSwapNumberSource>(swap.numberSource);
  const [buyNormalPlate, setBuyNormalPlate] = useState(swap.buyNormalPlate);
  const [buyAuctionPlate, setBuyAuctionPlate] = useState(swap.buyAuctionPlate);
  const [brandNames, setBrandNames] = useState<string[]>([swap.oldBrand]);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    api
      .listBrands()
      .then((data) => setBrandNames(Array.from(new Set([swap.oldBrand, ...data.brands.map((b) => b.name)]))))
      .catch(() => undefined);
  }, [swap.oldBrand]);

  const numberItems = PLATE_SWAP_CAR_NUMBER_ITEMS[numberSource];
  const feesChanged = numberSource !== swap.numberSource || buyNormalPlate !== swap.buyNormalPlate || buyAuctionPlate !== swap.buyAuctionPlate;
  const fees = calculatePlateSwapCarFees({ numberSource, buyNormalPlate, buyAuctionPlate });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function save() {
    setError("");
    const submitDate = textToIso(submitDateText);
    if (!submitDate) return setError("วันที่ยื่นไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    const returnedDate = swap.returnedDate ? textToIso(returnedDateText) : "";
    if (swap.returnedDate && !returnedDate) return setError("วันที่รับเอกสารกลับไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    if (returnedDate && returnedDate > todayIso()) return setError("วันที่รับเอกสารกลับต้องไม่เกินวันนี้");
    if (returnedDate && returnedDate < submitDate) return setError("วันที่รับเอกสารกลับต้องไม่ก่อนวันที่ยื่น");
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้");
    setSaving(true);
    try {
      const { swap: updated } = await plateSwapApi.update(swap.id, {
        ...form,
        submitDate,
        numberSource,
        buyNormalPlate,
        buyAuctionPlate: numberSource === "AUCTION_RESERVED" && buyAuctionPlate,
        ...(returnedDate ? { returnedDate } : {}),
        remark: remark.trim(),
        // ฟอร์มส่งทุกช่องจากตอนเปิด - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดค้างไว้ backend ตอบ 409 ไม่ทับของเขา (พบ 2026-09-27)
        expectedUpdatedAt: swap.updatedAt,
      });
      onSaved(updated);
      dialogRef.current?.close();
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <dialog ref={dialogRef} onClose={onClose} style={{ width: "min(720px, 96vw)" }}>
      <button className="close" aria-label="ปิด" onClick={() => dialogRef.current?.close()}>
        ×
      </button>
      <h2>แก้งานสลับเลข</h2>
      <SwapSummary swap={swap} />
      <div className="customer-grid" style={{ marginTop: 12 }}>
        <label className="field">
          วันที่ยื่น *
          <DateTextInput value={submitDateText} onChange={setSubmitDateText} label="วันที่ยื่น" />
        </label>
        {swap.returnedDate && (
          <label className="field">
            วันที่รับเอกสารกลับ *
            <DateTextInput value={returnedDateText} onChange={setReturnedDateText} label="วันที่รับเอกสารกลับ" />
          </label>
        )}
        <label className="field">
          ชื่อเจ้าของรถ *
          <input value={form.oldOwnerName} onChange={set("oldOwnerName")} />
        </label>
        <label className="field">
          เลขเครื่อง *
          <input value={form.oldEngine} onChange={set("oldEngine")} />
        </label>
        <label className="field">
          เลขตัวถัง *
          <input value={form.oldChassis} onChange={set("oldChassis")} />
        </label>
        <label className="field">
          ยี่ห้อ *
          <select value={form.oldBrand} onChange={set("oldBrand")}>
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
            <input value={form.oldPlateCategory} onChange={set("oldPlateCategory")} maxLength={3} aria-label="หมวดทะเบียนเก่า" />
            <input
              value={form.oldPlateNumber}
              onChange={(e) => setForm((prev) => ({ ...prev, oldPlateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) }))}
              maxLength={4}
              inputMode="numeric"
              aria-label="เลขทะเบียนเก่า"
            />
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 18 }}>ค่าใช้จ่าย</h3>
      <div className="inspect-filter" style={{ padding: 0, marginBottom: 10 }}>
        {(Object.keys(PLATE_SWAP_CAR_NUMBER_ITEMS) as PlateSwapNumberSource[]).map((source) => (
          <button
            key={source}
            type="button"
            className={`filter-chip${numberSource === source ? " selected" : ""}`}
            onClick={() => {
              setNumberSource(source);
              if (source === "NEW_UNUSED") setBuyAuctionPlate(false);
            }}
          >
            {PLATE_SWAP_CAR_NUMBER_ITEMS[source].title}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 14 }}>
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
      {feesChanged && (
        <p className="customer-message" style={{ marginTop: 8 }}>
          ค่าใช้จ่ายจะคิดใหม่: Bill {formatBaht(Number(swap.billTotal))} → {formatBaht(fees.billTotal)} · No Bill{" "}
          {formatBaht(Number(swap.noBillTotal))} → {formatBaht(fees.noBillTotal)} บาท
        </p>
      )}

      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น พิมพ์ชื่อเจ้าของรถผิด" />
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

// ยกเลิกงาน (แทนการลบเดิม) - ทุกสถานะ ต้องมีเหตุผล / รูปใบเสร็จที่แนบไว้นำไปแนบกับงานที่คีย์ใหม่ได้
function CancelSwapDialog({ swap, onClose, onCancelled }: { swap: PlateSwap; onClose: () => void; onCancelled: (id: string) => void }) {
  return (
    <ReasonDialog
      title="ยกเลิกงานสลับเลข"
      confirmLabel="ยืนยันยกเลิกงาน"
      placeholder="เช่น บันทึกซ้ำ / ลูกค้ายกเลิก"
      onClose={onClose}
      onConfirm={async (remark) => {
        await plateSwapApi.cancel(swap.id, remark);
        onCancelled(swap.id);
      }}
    >
      <SwapSummary swap={swap} />
      <p style={{ marginTop: 12 }}>
        งานนี้จะหายจากรายการและยอดรวม (ยังเก็บไว้ในประวัติพร้อมเหตุผล)
        {swap.newVehicle ? ` และรถใหม่ ${swap.newVehicle.chassis} จะไม่ถูกล็อกการยื่นเอกสารจากงานนี้อีก` : ""}
        {swap.receipts.length > 0 ? " - รูปใบเสร็จที่แนบไว้นำไปแนบกับงานที่บันทึกใหม่ได้" : ""}
      </p>
    </ReasonDialog>
  );
}

// ปุ่มแก้/ยกเลิกท้ายแถว (ADMIN / STAFF_CAR)
function RowActions({ onEdit, onCancel, children }: { onEdit: () => void; onCancel: () => void; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2 }}>
      <button type="button" className="text-button" onClick={onEdit}>
        ✎ แก้
      </button>
      {children}
      <button type="button" className="text-button" style={dangerButton} onClick={onCancel}>
        ยกเลิกงาน
      </button>
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

type RowDialog = { kind: "edit" | "cancel"; swap: PlateSwap } | null;

export function PlateSwapSubmitPage() {
  const canWrite = useCanWrite();
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => textToIso(submitDateText), [submitDateText]);
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
  const [dialog, setDialog] = useState<RowDialog>(null);

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

  // เปลี่ยนคัน - งานที่รับกลับแล้วต้องมีเหตุผล (ผู้ใช้ 2026-09-27) error โยนต่อให้ผู้เรียกแสดง
  async function relink(swap: PlateSwap, vehicle: PlateSwapNewVehicle, remark?: string) {
    replaceSwap((await plateSwapApi.linkNewVehicle(swap.id, vehicle.id, remark)).swap);
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
                ทะเบียนเก่า * (รถใหม่จะได้เลขนี้)
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
                ทะเบียนใหม่ของรถเก่า (ยังไม่รู้เว้นว่างได้)
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
            <WrongPlateBanner swaps={swaps} />
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
                    <SubmittedRow
                      key={swap.id}
                      swap={swap}
                      canWrite={!!canWrite}
                      onRelink={relink}
                      onPlateChange={replaceSwap}
                      onEdit={() => setDialog({ kind: "edit", swap })}
                      onCancel={() => setDialog({ kind: "cancel", swap })}
                    />
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

      {dialog?.kind === "edit" && (
        <EditSwapDialog
          swap={dialog.swap}
          onClose={() => setDialog(null)}
          onSaved={(updated) => {
            // แก้วันที่ยื่นข้ามเดือน = ไม่อยู่ในเดือนที่ดูอยู่แล้ว โหลดใหม่ให้ตรงกับ backend
            if (updated.submitDate.slice(0, 7) !== month) void load(month);
            else replaceSwap(updated);
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelSwapDialog
          swap={dialog.swap}
          onClose={() => setDialog(null)}
          onCancelled={(id) => setSwaps((prev) => prev.filter((s) => s.id !== id))}
        />
      )}
    </section>
  );
}

function SubmittedRow({
  swap,
  canWrite,
  onRelink,
  onPlateChange,
  onEdit,
  onCancel,
}: {
  swap: PlateSwap;
  canWrite: boolean;
  onRelink: (swap: PlateSwap, vehicle: PlateSwapNewVehicle, remark?: string) => Promise<void>;
  onPlateChange: (swap: PlateSwap) => void;
  onEdit: () => void;
  onCancel: () => void;
}) {
  const [picking, setPicking] = useState(false);
  // งานที่รับกลับแล้ว: เลือกคันใหม่แล้วต้องใส่เหตุผลก่อนบันทึก (ผู้ใช้ 2026-09-27)
  const [pendingVehicle, setPendingVehicle] = useState<PlateSwapNewVehicle | null>(null);

  async function pick(vehicle: PlateSwapNewVehicle) {
    setPicking(false);
    if (swap.returnedDate) {
      setPendingVehicle(vehicle);
      return;
    }
    try {
      await onRelink(swap, vehicle);
    } catch (err) {
      window.alert(errorText(err, "บันทึกไม่สำเร็จ"));
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
        <NewPlateCell swap={swap} canWrite={canWrite} onChange={onPlateChange} />
      </td>
      <td style={{ whiteSpace: "normal", minWidth: 200 }}>
        {picking ? (
          <NewVehiclePicker excludeSwapId={swap.id} onPick={pick} onCancel={() => setPicking(false)} />
        ) : (
          <>
            {swap.newVehicle ? <LinkedVehicle vehicle={swap.newVehicle} /> : <span className="muted">ยังไม่ลิงก์</span>}
            <WrongPlateNote swap={swap} />
            {canWrite && (
              <div>
                <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => setPicking(true)}>
                  {swap.newVehicle ? "เปลี่ยนคัน" : "🔗 ลิงก์รถใหม่"}
                </button>
              </div>
            )}
          </>
        )}
        {pendingVehicle && (
          <ReasonDialog
            title="เปลี่ยนรถใหม่ของงานที่รับเอกสารกลับแล้ว"
            confirmLabel="ยืนยันเปลี่ยนคัน"
            placeholder="เช่น ลิงก์ผิดคัน"
            onClose={() => setPendingVehicle(null)}
            onConfirm={(remark) => onRelink(swap, pendingVehicle, remark)}
          >
            <SwapSummary swap={swap} />
            <p style={{ marginTop: 12 }}>
              เปลี่ยนรถใหม่จาก {swap.newVehicle?.chassis ?? "-"} เป็น <strong>{pendingVehicle.chassis}</strong>
            </p>
          </ReasonDialog>
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
          <RowActions onEdit={onEdit} onCancel={onCancel} />
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ารับเอกสารกลับ
// ---------------------------------------------------------------------------------------------

type ReturnDialog = { kind: "edit" | "cancel" | "undo"; swap: PlateSwap } | null;

export function PlateSwapReturnPage() {
  const canWrite = useCanWrite();
  const [status, setStatus] = useState<Exclude<PlateSwapStatusFilter, "all">>("pending");
  const [swaps, setSwaps] = useState<PlateSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [returnDateText, setReturnDateText] = useState(() => isoToDisplayDate(todayIso()));
  const returnDate = useMemo(() => textToIso(returnDateText), [returnDateText]);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [dialog, setDialog] = useState<ReturnDialog>(null);

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
  const drop = (id: string) => setSwaps((prev) => prev.filter((s) => s.id !== id));

  async function confirmReturn(swap: PlateSwap, newPlateCategory: string, newPlateNumber: string) {
    if (!returnDate) {
      setMessage({ text: "กรุณากรอกวันที่รับเอกสารกลับให้ถูกต้อง", error: true });
      return;
    }
    // พิมพ์ปีผิดเป็นอนาคตไม่ได้ (backend กันอีกชั้น - พบ 2026-09-27)
    if (returnDate > todayIso()) {
      setMessage({ text: "วันที่รับเอกสารกลับต้องไม่เกินวันนี้", error: true });
      return;
    }
    if (!newPlateCategory || !newPlateNumber) {
      setMessage({ text: "กรุณากรอกทะเบียนใหม่ที่ได้รับ (หมวดทะเบียนและเลขทะเบียน)", error: true });
      return;
    }
    // ยืนยันก่อนเสมอ - กดผิดงาน/ผิดวันแล้วต้องยกเลิกรับกลับพร้อมเหตุผล (ผู้ใช้ 2026-09-27)
    const ok = window.confirm(
      `ยืนยันรับเอกสารกลับ?\n\nวันที่รับกลับ: ${isoToDisplayDate(returnDate)}\nรถเก่า: ${swap.oldOwnerName} (ทะเบียนเก่า ${oldPlateText(swap)})\nทะเบียนใหม่ที่รถเก่าได้: ${newPlateCategory} ${newPlateNumber}${
        swap.newVehicle ? `\nรถใหม่ที่รับเลข ${oldPlateText(swap)}: ${swap.newVehicle.chassis}` : ""
      }`,
    );
    if (!ok) return;
    try {
      await plateSwapApi.markReturned(swap.id, returnDate, newPlateCategory, newPlateNumber);
      drop(swap.id);
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
          <>
            <WrongPlateBanner swaps={swaps} />
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
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {swaps.map((swap) => (
                    <ReturnRow
                      key={swap.id}
                      swap={swap}
                      canWrite={!!canWrite}
                      onChange={replace}
                      onConfirm={confirmReturn}
                      onMessage={(text, error) => setMessage({ text, error })}
                      onDialog={(kind) => setDialog({ kind, swap })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      {dialog?.kind === "edit" && <EditSwapDialog swap={dialog.swap} onClose={() => setDialog(null)} onSaved={replace} />}
      {dialog?.kind === "cancel" && (
        <CancelSwapDialog
          swap={dialog.swap}
          onClose={() => setDialog(null)}
          onCancelled={(id) => {
            drop(id);
            setMessage({ text: `ยกเลิกงานแล้ว: ${dialog.swap.oldOwnerName} (${oldPlateText(dialog.swap)})` });
          }}
        />
      )}
      {dialog?.kind === "undo" && (
        <ReasonDialog
          title="ยกเลิกการรับเอกสารกลับ"
          confirmLabel="ยืนยันยกเลิกรับกลับ"
          placeholder="เช่น กดรับกลับผิดงาน"
          onClose={() => setDialog(null)}
          onConfirm={async (remark) => {
            await plateSwapApi.undoReturn(dialog.swap.id, remark);
            drop(dialog.swap.id);
            setMessage({ text: `ย้ายกลับไปรอรับเอกสารแล้ว: ${dialog.swap.oldOwnerName} (${oldPlateText(dialog.swap)})` });
          }}
        >
          <SwapSummary swap={dialog.swap} />
          <p style={{ marginTop: 12 }}>
            งานนี้จะกลับไปอยู่แท็บ &quot;รอรับเอกสารกลับ&quot;
            {dialog.swap.newVehicle ? ` และรถใหม่ ${dialog.swap.newVehicle.chassis} จะยื่นเอกสารไม่ได้จนกว่าจะยืนยันรับกลับอีกครั้ง` : ""}
            {" "}- ถ้าแค่วันที่รับกลับผิด ใช้ ✎ แก้ แทน
          </p>
        </ReasonDialog>
      )}
    </section>
  );
}

function ReturnRow({
  swap,
  canWrite,
  onChange,
  onConfirm,
  onMessage,
  onDialog,
}: {
  swap: PlateSwap;
  canWrite: boolean;
  onChange: (swap: PlateSwap) => void;
  onConfirm: (swap: PlateSwap, newPlateCategory: string, newPlateNumber: string) => void;
  onMessage: (text: string, error?: boolean) => void;
  onDialog: (kind: "edit" | "cancel" | "undo") => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [plateCategoryText, setPlateCategoryText] = useState(swap.newPlateCategory ?? "");
  const [plateNumberText, setPlateNumberText] = useState(swap.newPlateNumber ?? "");
  const returned = Boolean(swap.returnedDate);
  // งานที่รับกลับแล้ว: รูปใบเสร็จเป็นหลักฐาน แก้ได้ (ผู้ใช้ 2026-09-27) แต่ต้องกด "แก้รูปใบเสร็จ" และใส่เหตุผลก่อน
  const [editingReceipts, setEditingReceipts] = useState(false);
  const [receiptRemark, setReceiptRemark] = useState("");
  const receiptWritable = canWrite && (!returned || editingReceipts);
  const remarkMissing = returned && !receiptRemark.trim();

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setBusy(true);
    onMessage("");
    try {
      for (const file of Array.from(files)) {
        const image = await compressReceiptImage(file);
        onChange((await plateSwapApi.addReceipt(swap.id, image, compressedFileName(file), returned ? receiptRemark.trim() : undefined)).swap);
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
      onChange((await plateSwapApi.removeReceipt(swap.id, receiptId, returned ? receiptRemark.trim() : undefined)).swap);
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
        {returned ? (
          <NewPlateCell swap={swap} canWrite={canWrite} onChange={onChange} />
        ) : canWrite ? (
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
        <WrongPlateNote swap={swap} />
      </td>
      <td>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {swap.receipts.length === 0 && <span className="muted">ยังไม่มีรูป</span>}
          {swap.receipts.map((r, i) => (
            <span key={r.id} style={{ display: "inline-flex", alignItems: "center" }}>
              <button type="button" className="text-button" onClick={() => openReceiptImage(r.id)}>
                🧾 รูป {i + 1}
              </button>
              {receiptWritable && (
                <button
                  type="button"
                  className="text-button"
                  aria-label={`ลบรูปใบเสร็จที่ ${i + 1}`}
                  style={dangerButton}
                  disabled={remarkMissing}
                  title={remarkMissing ? "ใส่เหตุผลก่อน" : undefined}
                  onClick={() => removeReceipt(r.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
        </div>
        {canWrite && returned && !editingReceipts && (
          <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => setEditingReceipts(true)}>
            แก้รูปใบเสร็จ
          </button>
        )}
        {receiptWritable && (
          <>
            {returned && (
              <input
                value={receiptRemark}
                onChange={(e) => setReceiptRemark(e.target.value)}
                placeholder="เหตุผลที่แก้รูป *"
                aria-label="เหตุผลที่แก้รูปใบเสร็จ"
                className="inspect-input"
                style={{ width: 170, marginTop: 4 }}
              />
            )}
            <input ref={inputRef} type="file" accept="image/*" multiple hidden onChange={(e) => handleFiles(e.target.files)} />
            <div>
              <button
                type="button"
                className="text-button"
                style={{ paddingLeft: 0 }}
                disabled={busy || remarkMissing}
                title={remarkMissing ? "ใส่เหตุผลก่อน" : undefined}
                onClick={() => inputRef.current?.click()}
              >
                {busy ? "กำลังอัปโหลด…" : "📷 ถ่าย/แนบใบเสร็จ"}
              </button>
              {returned && (
                <button
                  type="button"
                  className="text-button"
                  onClick={() => {
                    setEditingReceipts(false);
                    setReceiptRemark("");
                  }}
                >
                  เสร็จ
                </button>
              )}
            </div>
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
      {canWrite && (
        <td>
          <RowActions onEdit={() => onDialog("edit")} onCancel={() => onDialog("cancel")}>
            {returned && (
              <button type="button" className="text-button" style={dangerButton} onClick={() => onDialog("undo")}>
                ยกเลิกรับกลับ
              </button>
            )}
          </RowActions>
        </td>
      )}
    </tr>
  );
}
