"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, fetchAuthedBlob, plateSwapBookPhotoImageUrl, plateSwapPlatePhotoImageUrl, receiptImageUrl } from "@/lib/api";
import { getCachedUser, getToken } from "@/lib/auth";
import { displayDateToIso, formatDateDigitsCe, isoToDisplayDate, todayIso } from "@/lib/date";
import {
  plateSwapApi,
  type PlateSwap,
  type PlateSwapKind,
  type PlateSwapNewVehicle,
  type PlateSwapVehicleClass,
  type PlateSwapStatusFilter,
  type PlateSwapVehicleHit,
} from "@/lib/plate-swap-api";
import {
  calculatePlateSwapCarFees,
  calculatePlateSwapMotoFees,
  dutyAmountOf,
  formatBaht,
  PLATE_SWAP_CAR_NUMBER_ITEMS,
  PLATE_SWAP_MOTO_NUMBER_ITEM,
  PLATE_SWAP_MOTO_PLATE_ITEM,
  PLATE_SWAP_MOTO_URGENT_ITEM,
  type PlateSwapNumberSource,
} from "@/lib/plate-swap-fee";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import { focusHref, workPageFor } from "@/lib/vehicle-focus";
import { DateInput } from "@/components/DateInput";

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ผู้ใช้ 2026-09-22
// หน้ายื่น (PlateSwapSubmitPage): กรอกรถเก่า + ลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (บังคับ) + เลือกค่าใช้จ่าย แล้วบันทึกวันที่ยื่น
// หน้ารับใบเสร็จ (PlateSwapReturnPage, เดิมชื่อ "รับเอกสารกลับ"): ถ่าย/แนบรูปใบเสร็จ (บังคับ, อ่าน OCR จริงเติมเลขที่/วันที่/ยอดเงินให้)
// แล้วยืนยันวันที่รับเอกสารกลับ - "งานเสร็จ" ยังตัดสินด้วยขั้นนี้อย่างเดียวเหมือนเดิม (ผู้ใช้ 2026-09-28)
// หน้ารับป้าย/รับเล่ม (PlateSwapReceivePlatePage / PlateSwapReceiveBookPage, ใหม่ 2026-09-28): แนบรูปแล้วบันทึกทันที
// ไม่ใช้ AI (เหมือน Step 6/7) เฉพาะฝั่งรถเก่าของงานเอง ไม่ผูกกับ returnedDate/กฎใดๆ
// แก้/ยกเลิก (ผู้ใช้ 2026-09-27): ADMIN + STAFF_CAR แก้ข้อมูลงาน (✎ แก้) ยกเลิกรับกลับ และยกเลิกงานได้ ต้องระบุเหตุผลเสมอ
// (เก็บประวัติ) - ไม่มีการลบงานแล้ว งานที่ยกเลิกหายจากรายการและยอดรวม แต่ยังอยู่ในฐานข้อมูล
// รถใหม่รับ "ทะเบียนเก่า" ของรถเก่า ส่วน "ทะเบียนใหม่" คือเลขที่รถเก่าได้รับ (ผู้ใช้ยืนยัน 2026-09-27)

export const PLATE_SWAP_HOME = "/registration/plate-swap";
export const OLD_NEW_HOME = "/registration/plate-swap/car/old-new";
export const OLD_OLD_HOME = "/registration/plate-swap/car/old-old";

// ทั้ง 4 ชุด (รถยนต์/มอเตอร์ไซค์ × 2 เคส) ใช้หน้าทำงานชุดเดียวกัน ต่างกันแค่ข้อมูลที่ดึงมา อัตราค่าใช้จ่าย และลิงก์กลับ
// (ผู้ใช้ 2026-09-28: "ล้อระบบเหมือนสลับเลขของรถยนต์เลย ... แต่แค่เปลี่ยนเป็นลิงก์ข้อมูลเป็นรถจักรยานยนต์แทน")
const CLASS_SEGMENT: Record<PlateSwapVehicleClass, string> = { CAR: "car", MOTO: "moto" };
const CLASS_LABEL: Record<PlateSwapVehicleClass, string> = { CAR: "รถยนต์", MOTO: "มอเตอร์ไซค์" };
const KIND_SEGMENT: Record<PlateSwapKind, string> = { OLD_NEW: "old-new", OLD_OLD: "old-old" };
const KIND_LABEL: Record<PlateSwapKind, string> = { OLD_NEW: "รถเก่า กับ รถใหม่", OLD_OLD: "รถเก่า กับ รถเก่า" };

const caseHome = (vehicleClass: PlateSwapVehicleClass, kind: PlateSwapKind) => ({
  href: `/registration/plate-swap/${CLASS_SEGMENT[vehicleClass]}/${KIND_SEGMENT[kind]}`,
  label: KIND_LABEL[kind],
});

// อัตราค่าใช้จ่ายตามประเภทรถ - มอเตอร์ไซค์ไม่มีตัวเลือกที่มาของเลข (ใช้เลขที่ไม่เคยออกเสมอ) แต่มีงานด่วน +50
const feesFor = (
  vehicleClass: PlateSwapVehicleClass,
  o: { numberSource: PlateSwapNumberSource; buyNormalPlate: boolean; buyAuctionPlate: boolean; urgent: boolean },
) => (vehicleClass === "MOTO" ? calculatePlateSwapMotoFees({ buyNormalPlate: o.buyNormalPlate, urgent: o.urgent }) : calculatePlateSwapCarFees(o));

const errorText = (err: unknown, fallback: string) => (err instanceof ApiError || err instanceof Error ? err.message : fallback);

// ค้นรถใหม่ระหว่างพิมพ์ (ผู้ใช้ 2026-09-28) - หน่วงเท่าหน้าค้นหารถ และเริ่มค้นตั้งแต่ 2 ตัวอักษร
// (1 ตัวอักษรได้รถเกือบทั้งฐานซึ่งไม่ช่วยอะไร แต่ตั้งไว้ต่ำเพราะจุดประสงค์คือไม่ต้องพิมพ์เลขตัวถังให้ครบ)
const TYPING_DELAY_MS = 300;
const MIN_VEHICLE_QUERY = 2;

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

// เจ้าของงานในตาราง (ผู้ใช้ 2026-09-28) - งานที่บันทึกก่อนวันนั้นไม่มีลูกค้า แก้ได้ที่ ✎ แก้
function CustomerCell({ swap }: { swap: PlateSwap }) {
  if (!swap.customer) return <span className="muted">ยังไม่ระบุ</span>;
  return (
    <>
      <div className="job">{swap.customer.company ?? swap.customer.name}</div>
      {swap.customer.company && <div className="sub">{swap.customer.name}</div>}
    </>
  );
}

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

// เลขที่ใบเสร็จ/วันที่/ยอดเงิน (ผู้ใช้ 2026-09-28) - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ (ช่องยังว่างทั้ง 3) แก้เองได้เสมอทีหลัง
// งานที่รับเอกสารกลับแล้ว แก้ได้แต่ต้องมีเหตุผล (โครงเดียวกับ NewPlateCell)
function ReceiptFieldsCell({ swap, canWrite, onChange }: { swap: PlateSwap; canWrite: boolean; onChange: (swap: PlateSwap) => void }) {
  const [editing, setEditing] = useState(false);
  const [receiptNo, setReceiptNo] = useState(swap.receiptNo ?? "");
  const [dateText, setDateText] = useState(() => (swap.receiptDate ? isoToDisplayDate(swap.receiptDate) : ""));
  const [amount, setAmount] = useState(swap.receiptAmount ?? "");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsRemark = Boolean(swap.returnedDate);

  async function save() {
    setError("");
    const receiptDate = dateText.trim() ? textToIso(dateText) : "";
    if (dateText.trim() && !receiptDate) return setError("วันที่ใบเสร็จไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    if (needsRemark && !remark.trim()) return setError("งานนี้รับเอกสารกลับแล้ว - กรุณาระบุเหตุผลที่แก้ข้อมูลใบเสร็จ");
    setBusy(true);
    try {
      const { swap: updated } = await plateSwapApi.updateReceiptFields(
        swap.id,
        { receiptNo: receiptNo.trim(), receiptDate, receiptAmount: amount.trim() },
        needsRemark ? remark.trim() : undefined,
      );
      onChange(updated);
      setEditing(false);
      setRemark("");
    } catch (err) {
      setError(errorText(err, "บันทึกไม่สำเร็จ"));
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div>
        <div>{swap.receiptNo || <span className="muted">ยังไม่มีเลขที่ใบเสร็จ</span>}</div>
        <div className="sub">
          {swap.receiptDate ? `วันที่ ${isoToDisplayDate(swap.receiptDate)}` : ""}
          {swap.receiptAmount ? `${swap.receiptDate ? " · " : ""}${formatBaht(Number(swap.receiptAmount))} บาท` : ""}
        </div>
        {canWrite && (
          <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => setEditing(true)}>
            ✎ แก้
          </button>
        )}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4, minWidth: 160 }}>
      <input
        value={receiptNo}
        onChange={(e) => setReceiptNo(e.target.value)}
        placeholder="เลขที่ใบเสร็จ"
        aria-label="เลขที่ใบเสร็จ"
        className="inspect-input"
      />
      <DateTextInput value={dateText} onChange={setDateText} label="วันที่ใบเสร็จ" />
      <input
        value={amount}
        onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder="ยอดเงิน"
        aria-label="ยอดเงินตามใบเสร็จ"
        inputMode="decimal"
        className="inspect-input"
      />
      {needsRemark && (
        <input
          value={remark}
          onChange={(e) => setRemark(e.target.value)}
          placeholder="เหตุผลที่แก้ *"
          aria-label="เหตุผลที่แก้ข้อมูลใบเสร็จ"
          className="inspect-input"
        />
      )}
      {error && (
        <p className="customer-message error" role="alert">
          {error}
        </p>
      )}
      <div style={{ display: "flex", gap: 6 }}>
        <button type="button" className="text-button" disabled={busy} onClick={save}>
          บันทึก
        </button>
        <button
          type="button"
          className="text-button"
          onClick={() => {
            setReceiptNo(swap.receiptNo ?? "");
            setDateText(swap.receiptDate ? isoToDisplayDate(swap.receiptDate) : "");
            setAmount(swap.receiptAmount ?? "");
            setRemark("");
            setError("");
            setEditing(false);
          }}
        >
          ยกเลิก
        </button>
      </div>
    </div>
  );
}

// ค้นรถใหม่ด้วยเลขตัวถังแล้วเลือก 1 คัน (ปุ่มลิงก์ข้อมูลรถในฐานข้อมูลรถจดใหม่)
// F51 (ผู้ใช้ 2026-09-27): รถที่ยื่นเอกสารแล้ว หรือผูกกับงานสลับเลขอื่นที่ยังไม่รับกลับ เลือกไม่ได้ (แสดงเหตุผล)
// excludeSwapId = งานที่กำลังเปลี่ยนคัน - รถที่ผูกกับงานนี้เองไม่นับว่าผูกซ้ำ
function NewVehiclePicker({
  excludeSwapId,
  vehicleClass = "CAR",
  onPick,
  onCancel,
}: {
  excludeSwapId?: string;
  vehicleClass?: PlateSwapVehicleClass;
  onPick: (v: PlateSwapNewVehicle) => void;
  onCancel?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<PlateSwapVehicleHit[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // ลำดับคำค้นล่าสุด - คำตอบของคำค้นเก่าที่มาช้าต้องไม่ทับผลของคำที่พิมพ์ทีหลัง (ผู้ใช้ 2026-09-28)
  const searchSeq = useRef(0);

  const runSearch = useCallback(
    async (raw: string) => {
      const chassis = raw.trim();
      const seq = ++searchSeq.current;
      if (!chassis) {
        setResults(null);
        setError("");
        setBusy(false);
        return;
      }
      setBusy(true);
      setError("");
      try {
        const { vehicles } = await plateSwapApi.searchNewVehicles(chassis, excludeSwapId, vehicleClass);
        if (seq !== searchSeq.current) return; // พิมพ์ต่อไปแล้ว ผลนี้เก่า
        setResults(vehicles);
      } catch (err) {
        if (seq !== searchSeq.current) return;
        setError(errorText(err, "ค้นหาไม่สำเร็จ"));
        setResults(null);
      } finally {
        if (seq === searchSeq.current) setBusy(false);
      }
    },
    [excludeSwapId, vehicleClass],
  );

  // ผู้ใช้ 2026-09-28: "เวลาพิม เลขที่ใกลเคียงกับข้อมูลโชวมาเลยไม่ต้องพิมครบ" - ค้นเองระหว่างพิมพ์
  // หน่วง 300 ms เท่าหน้าค้นหารถ (TYPING_DELAY_MS ใน app/vehicles/page.tsx) และเริ่มค้นตั้งแต่ 2 ตัวอักษร
  // (การล้างผลตอนพิมพ์สั้นกว่าเกณฑ์ทำใน onChange ไม่ใช่ที่นี่ - effect นี้จึงมีหน้าที่ตั้งเวลาอย่างเดียว)
  useEffect(() => {
    const chassis = query.trim();
    if (chassis.length < MIN_VEHICLE_QUERY) return;
    const timer = setTimeout(() => runSearch(chassis), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  function changeQuery(next: string) {
    setQuery(next);
    // ลบเลขทิ้งจนสั้นกว่าเกณฑ์ = ทิ้งผลที่ค้างอยู่ และตัดคำตอบที่ยังค้างอยู่ ไม่ให้เด้งกลับมาทีหลัง
    if (next.trim().length < MIN_VEHICLE_QUERY) {
      searchSeq.current++;
      setResults(null);
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <input
          type="text"
          placeholder={`เลขตัวถัง${CLASS_LABEL[vehicleClass]}ที่จะรับเลข`}
          value={query}
          onChange={(e) => changeQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              runSearch(query); // กด Enter = ค้นทันทีไม่ต้องรอหน่วง
            }
          }}
          style={{ flex: "1 1 200px", minWidth: 0 }}
        />
        <button type="button" className="filter-chip" onClick={() => runSearch(query)} disabled={busy}>
          {busy ? "กำลังค้นหา…" : "ค้นหา"}
        </button>
        {onCancel && (
          <button type="button" className="text-button" onClick={onCancel}>
            ยกเลิก
          </button>
        )}
      </div>
      {error && <div className="customer-message error">{error}</div>}
      {!error && query.trim().length > 0 && query.trim().length < MIN_VEHICLE_QUERY && (
        <div className="muted" style={{ fontSize: 13 }}>
          พิมพ์เลขตัวถังอย่างน้อย {MIN_VEHICLE_QUERY} ตัว แล้วรายการจะขึ้นเอง (ไม่ต้องพิมพ์ครบ)
        </div>
      )}
      {results && results.length === 0 && (
        <div className="customer-message">ไม่พบ{CLASS_LABEL[vehicleClass]}ที่เลขตัวถังตรงกันในฐานข้อมูลรถจดใหม่</div>
      )}
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
  // เจ้าของงาน (ผู้ใช้ 2026-09-28) - งานเก่าที่ยังไม่มีเจ้าของงานมาเติมตรงนี้ได้ แต่ล้างให้ว่างอีกไม่ได้
  const [customerId, setCustomerId] = useState(swap.customer?.id ?? "");
  const [customerOptions, setCustomerOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
    api
      .listBrands()
      .then((data) => setBrandNames(Array.from(new Set([swap.oldBrand, ...data.brands.map((b) => b.name)]))))
      .catch(() => undefined);
    api
      .listCustomers()
      .then((data) => setCustomerOptions(data.customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") }))))
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
        // ส่งเฉพาะตอนเลือกไว้จริง - งานเก่าที่ยังไม่มีเจ้าของงานและไม่ได้เลือกในรอบนี้ ไม่ต้องแตะ
        ...(customerId ? { customerId } : {}),
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
        {/* เจ้าของงาน = ลูกค้าที่ส่งงานมา ไม่ใช่ชื่อเจ้าของรถข้างล่าง (ผู้ใช้ 2026-09-28) */}
        <label className="field">
          เจ้าของงาน (ลูกค้าที่ส่งงานมา)
          <select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">{swap.customer ? "เลือกลูกค้า" : "ยังไม่ระบุ"}</option>
            {customerOptions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
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
          เลขตัวถัง *
          <input value={form.oldChassis} onChange={set("oldChassis")} />
        </label>
        <label className="field">
          เลขเครื่อง *
          <input value={form.oldEngine} onChange={set("oldEngine")} />
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

export function PlateSwapSubmitPage({ vehicleClass = "CAR" }: { vehicleClass?: PlateSwapVehicleClass }) {
  const canWrite = useCanWrite();
  const [form, setForm] = useState(EMPTY_FORM);
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => textToIso(submitDateText), [submitDateText]);
  const [newVehicle, setNewVehicle] = useState<PlateSwapNewVehicle | null>(null);
  const [picking, setPicking] = useState(false);
  const [numberSource, setNumberSource] = useState<PlateSwapNumberSource>("NEW_UNUSED");
  const [buyNormalPlate, setBuyNormalPlate] = useState(false);
  const [buyAuctionPlate, setBuyAuctionPlate] = useState(false);
  const [urgent, setUrgent] = useState(false); // งานด่วน - มีเฉพาะมอเตอร์ไซค์
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [brandNames, setBrandNames] = useState<string[]>([]);
  // เจ้าของงาน = ลูกค้าที่ส่งงานมา (ผู้ใช้ 2026-09-28) - คนละคนกับชื่อเจ้าของรถเก่าที่กรอกเอง
  const [customerId, setCustomerId] = useState("");
  const [customerOptions, setCustomerOptions] = useState<Array<{ id: string; label: string }>>([]);

  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [swaps, setSwaps] = useState<PlateSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dialog, setDialog] = useState<RowDialog>(null);

  const fees = feesFor(vehicleClass, { numberSource, buyNormalPlate, buyAuctionPlate, urgent });

  async function load(forMonth: string) {
    setLoading(true);
    setListError("");
    try {
setSwaps((await plateSwapApi.list("all", forMonth, "OLD_NEW", vehicleClass)).swaps);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load อ่าน vehicleClass ที่อยู่ใน deps แล้ว
  }, [month, vehicleClass]);

  useEffect(() => {
    // ยี่ห้อรถเก่าเลือกจาก dropdown ยี่ห้อในฐานข้อมูล (ผู้ใช้ 2026-09-22) - ยี่ห้อที่ยังไม่มีให้เพิ่มจากหน้าเพิ่มข้อมูลรถจดใหม่
    api
      .listBrands()
      .then((data) => setBrandNames(data.brands.map((b) => b.name)))
      .catch(() => setBrandNames([]));
    // เจ้าของงานเลือกจากฐานข้อมูลลูกค้า (ผู้ใช้ 2026-09-28) - ป้ายกำกับเหมือนหน้าเพิ่มข้อมูลรถจดใหม่
    api
      .listCustomers()
      .then((data) => setCustomerOptions(data.customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") }))))
      .catch(() => setCustomerOptions([]));
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
    if (!customerId) {
      setMessage({ text: "กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)", error: true });
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
        vehicleClass,
        urgent,
        customerId,
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
      <h1>ยื่นงานสลับเลข ({CLASS_LABEL[vehicleClass]})</h1>

      {canWrite && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <form className="customer-form" onSubmit={handleSubmit}>
            {/* เจ้าของงานอยู่นอกหัวข้อ "รถเก่า" ตั้งใจ (ผู้ใช้ 2026-09-28): เป็นลูกค้าที่ส่งงานมาให้เรา ไว้ส่งงาน/วางบิลให้ถูกเจ้าของ
                ไม่ใช่เจ้าของรถตามทะเบียน (ช่อง "ชื่อเจ้าของรถ" ข้างล่าง) - กฎเดียวกับรถจดใหม่ที่แยกสองอย่างนี้ออกจากกัน */}
            <label className="field" style={{ maxWidth: 420 }}>
              เจ้าของงาน * (ลูกค้าที่ส่งงานมา)
              <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
                <option value="">เลือกลูกค้า</option>
                {customerOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>

            <h2 style={{ marginTop: 22 }}>รถเก่า</h2>
            {/* ลำดับช่องตามที่ผู้ใช้กำหนด: วันที่ยื่น -> ชื่อเจ้าของรถ -> เลขตัวถัง -> เลขเครื่อง -> ยี่ห้อ -> ทะเบียนเก่า/ใหม่
                (เดิม 2026-09-23 เลขเครื่องมาก่อน ผู้ใช้สลับเป็นเลขตัวถังก่อนเมื่อ 2026-09-28) */}
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
                เลขตัวถัง *
                <input value={form.oldChassis} onChange={setField("oldChassis")} required />
              </label>
              <label className="field">
                เลขเครื่อง *
                <input value={form.oldEngine} onChange={setField("oldEngine")} required />
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
                vehicleClass={vehicleClass}
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
            <FeeOptionFields
              vehicleClass={vehicleClass}
              numberSource={numberSource}
              onNumberSource={chooseNumberSource}
              buyNormalPlate={buyNormalPlate}
              onBuyNormalPlate={setBuyNormalPlate}
              buyAuctionPlate={buyAuctionPlate}
              onBuyAuctionPlate={setBuyAuctionPlate}
              urgent={urgent}
              onUrgent={setUrgent}
            />

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
                    <th>เจ้าของงาน</th>
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
      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
        <CustomerCell swap={swap} />
      </td>
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
          <NewVehiclePicker excludeSwapId={swap.id} vehicleClass={swap.vehicleClass} onPick={pick} onCancel={() => setPicking(false)} />
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

export function PlateSwapReturnPage({
  swapKind = "OLD_NEW",
  vehicleClass = "CAR",
}: {
  swapKind?: PlateSwapKind;
  vehicleClass?: PlateSwapVehicleClass;
}) {
  const home = caseHome(vehicleClass, swapKind);
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
      setSwaps((await plateSwapApi.list(forStatus, undefined, swapKind, vehicleClass)).swaps);
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
  }, [status, swapKind, vehicleClass]);

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
      <Link href={home.href} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← {home.label}
      </Link>
      <h1>รับใบเสร็จ ({CLASS_LABEL[vehicleClass]})</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        ถ่ายหรือแนบรูปใบเสร็จอย่างน้อย 1 รูป (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ แก้เองได้) แล้วกดยืนยันรับเอกสารกลับตามวันที่ที่ระบุ
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
                    <th>เจ้าของงาน</th>
                    <th>รถเก่า</th>
                    <th>ทะเบียนเก่า / ใหม่</th>
                    <th>รถใหม่ที่ลิงก์</th>
                    <th>รูปใบเสร็จ</th>
                    <th>ข้อมูลใบเสร็จ</th>
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
      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
        <CustomerCell swap={swap} />
      </td>
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
        <ReceiptFieldsCell swap={swap} canWrite={canWrite} onChange={onChange} />
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

// ---------------------------------------------------------------------------------------------
// หน้ารับป้าย / รับเล่ม (ผู้ใช้ 2026-09-28) - แยกจาก "รับเอกสารกลับ" เดิม เหมือนฝั่งรถจดใหม่ (Step 6/7 ปัจจุบัน)
// ไม่ใช้ AI: แนบรูปทีละคันจากคิว บันทึกรับทันที เฉพาะฝั่งรถเก่าของงานเอง ไม่ผูกกับ returnedDate/กฎใดๆ (แนบได้แม้ยังไม่รับใบเสร็จ)
// ทรง list เรียบ ไม่ใช้ ReceivingQueuePage เต็มรูปแบบเพราะไม่มี job-sheet ให้จัดกลุ่ม (ต่างจากคิวรับป้าย/รับเล่มรถจดใหม่)
// ---------------------------------------------------------------------------------------------

type PlateOrBook = "plate" | "book";

const PLATE_OR_BOOK_LABEL: Record<PlateOrBook, string> = { plate: "ป้าย", book: "เล่ม" };

// รูปอยู่หลัง backend ที่ต้องมี Authorization - เหมือน openReceiptImage แต่คีย์ด้วย swap id (ไม่ใช่ photo id)
async function openPlateSwapPhoto(kind: PlateOrBook, swapId: string) {
  const win = window.open("", "_blank");
  try {
    const url = kind === "plate" ? plateSwapPlatePhotoImageUrl(swapId) : plateSwapBookPhotoImageUrl(swapId);
    const objectUrl = URL.createObjectURL(await fetchAuthedBlob(url));
    if (win) win.location.href = objectUrl;
    else window.open(objectUrl, "_blank");
  } catch {
    win?.close();
    if (getToken()) window.alert("เปิดรูปไม่สำเร็จ กรุณาลองใหม่");
  }
}

function ReceivePlateOrBookRow({
  kind,
  swap,
  canWrite,
  onMessage,
  onDone,
}: {
  kind: PlateOrBook;
  swap: PlateSwap;
  canWrite: boolean;
  onMessage: (text: string, error?: boolean) => void;
  onDone: () => void;
}) {
  const label = PLATE_OR_BOOK_LABEL[kind];
  const inputRef = useRef<HTMLInputElement>(null);
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const [editDateText, setEditDateText] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"date" | "detach" | null>(null);
  const receivedDate = kind === "plate" ? swap.plateReceivedDate : swap.bookReceivedDate;
  const photoId = kind === "plate" ? swap.platePhotoId : swap.bookPhotoId;

  async function attach(files: FileList | null) {
    if (!files || files.length === 0) return;
    const date = textToIso(dateText);
    if (!date) {
      onMessage(`กรุณากรอกวันที่รับ${label}ให้ถูกต้อง`, true);
      return;
    }
    setBusy(true);
    onMessage("");
    try {
      const file = files[0];
      const image = await compressReceiptImage(file);
      const fn = kind === "plate" ? plateSwapApi.attachPlatePhoto : plateSwapApi.attachBookPhoto;
      await fn(swap.id, image, compressedFileName(file), date);
      onDone();
    } catch (err) {
      onMessage(errorText(err, `แนบรูป${label}ไม่สำเร็จ`), true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  function openDateDialog() {
    setEditDateText(receivedDate ? isoToDisplayDate(receivedDate) : isoToDisplayDate(todayIso()));
    setDialog("date");
  }

  return (
    <tr>
      <td>{isoToDisplayDate(swap.submitDate)}</td>
      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
        <CustomerCell swap={swap} />
      </td>
      <td>
        <div className="job">{swap.oldOwnerName}</div>
        <div className="sub">{oldVehicleText(swap)}</div>
      </td>
      <td>{oldPlateText(swap)}</td>
      <td style={{ whiteSpace: "normal" }}>{swap.newVehicle ? <LinkedVehicle vehicle={swap.newVehicle} /> : <span className="muted">ยังไม่ลิงก์</span>}</td>
      <td>
        {receivedDate ? (
          <>
            <div>{isoToDisplayDate(receivedDate)}</div>
            {photoId && (
              <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => openPlateSwapPhoto(kind, swap.id)}>
                📷 ดูรูป
              </button>
            )}
            {canWrite && (
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={openDateDialog}>
                  ✎ แก้วันที่
                </button>
                <button type="button" className="text-button" style={dangerButton} onClick={() => setDialog("detach")}>
                  ถอดรูป
                </button>
              </div>
            )}
          </>
        ) : canWrite ? (
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <DateTextInput value={dateText} onChange={setDateText} label={`วันที่รับ${label}`} />
            <input ref={inputRef} type="file" accept="image/*" hidden onChange={(e) => attach(e.target.files)} />
            <button type="button" className="text-button" style={{ paddingLeft: 0 }} disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? "กำลังอัปโหลด…" : `📷 แนบรูป${label}`}
            </button>
          </div>
        ) : (
          <span className="muted">รอรับ{label}</span>
        )}
      </td>

      {dialog === "date" && (
        <ReasonDialog
          title={`แก้วันที่รับ${label}`}
          confirmLabel="บันทึก"
          placeholder="เช่น พิมพ์วันผิด"
          onClose={() => setDialog(null)}
          onConfirm={async (remark) => {
            const date = textToIso(editDateText);
            if (!date) throw new Error("กรุณากรอกวันที่ให้ถูกต้อง");
            const fn = kind === "plate" ? plateSwapApi.updatePlateReceivedDate : plateSwapApi.updateBookReceivedDate;
            await fn(swap.id, date, remark);
            onDone();
          }}
        >
          <SwapSummary swap={swap} />
          <label className="field" style={{ marginTop: 12 }}>
            วันที่รับ{label}ใหม่ *
            <DateTextInput value={editDateText} onChange={setEditDateText} label={`วันที่รับ${label}`} />
          </label>
        </ReasonDialog>
      )}
      {dialog === "detach" && (
        <ReasonDialog
          title={`ถอดรูป${label}ที่แนบผิด`}
          confirmLabel="ยืนยันถอดรูป"
          placeholder="เช่น แนบผิดคัน"
          onClose={() => setDialog(null)}
          onConfirm={async (remark) => {
            const fn = kind === "plate" ? plateSwapApi.detachPlatePhoto : plateSwapApi.detachBookPhoto;
            await fn(swap.id, remark);
            onDone();
          }}
        >
          <SwapSummary swap={swap} />
          <p style={{ marginTop: 12 }}>งานนี้จะกลับไปรอรับ{label}อีกครั้ง</p>
        </ReasonDialog>
      )}
    </tr>
  );
}

function PlateSwapReceivePlateOrBookPage({
  kind,
  swapKind,
  vehicleClass,
}: {
  kind: PlateOrBook;
  swapKind: PlateSwapKind;
  vehicleClass: PlateSwapVehicleClass;
}) {
  const home = caseHome(vehicleClass, swapKind);
  const canWrite = useCanWrite();
  const label = PLATE_OR_BOOK_LABEL[kind];
  const [status, setStatus] = useState<"pending" | "received">("pending");
  const [swaps, setSwaps] = useState<PlateSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  async function load(forStatus: typeof status) {
    setLoading(true);
    setListError("");
    try {
      const fn = kind === "plate" ? plateSwapApi.plateQueue : plateSwapApi.bookQueue;
      setSwaps((await fn(forStatus, swapKind, vehicleClass)).swaps);
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
  }, [status, kind, swapKind, vehicleClass]);

  return (
    <section className="content">
      <Link href={home.href} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← {home.label}
      </Link>
      <h1>
        รับ{label} ({CLASS_LABEL[vehicleClass]})
      </h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        แนบรูป{label}ที่ได้รับแล้วบันทึกทันที (เฉพาะฝั่งรถเก่าของงานนี้) - ไม่ต้องรอรับใบเสร็จก่อน
      </p>

      <div className="panel">
        <div className="panel-head">
          <div className="inspect-filter" style={{ padding: 0 }}>
            <button type="button" className={`filter-chip${status === "pending" ? " selected" : ""}`} onClick={() => setStatus("pending")}>
              รอรับ{label}
            </button>
            <button type="button" className={`filter-chip${status === "received" ? " selected" : ""}`} onClick={() => setStatus("received")}>
              รับ{label}แล้ว
            </button>
          </div>
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
          <div className="empty-customers">{status === "pending" ? `ไม่มีงานที่รอรับ${label}` : `ยังไม่มีงานที่รับ${label}แล้ว`}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ยื่น</th>
                  <th>เจ้าของงาน</th>
                  <th>รถเก่า</th>
                  <th>ทะเบียนเก่า</th>
                  <th>รถใหม่ที่ลิงก์</th>
                  <th>{label}</th>
                </tr>
              </thead>
              <tbody>
                {swaps.map((swap) => (
                  <ReceivePlateOrBookRow
                    key={swap.id}
                    kind={kind}
                    swap={swap}
                    canWrite={!!canWrite}
                    onMessage={(text, error) => setMessage({ text, error })}
                    onDone={() => load(status)}
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

export function PlateSwapReceivePlatePage({
  swapKind = "OLD_NEW",
  vehicleClass = "CAR",
}: {
  swapKind?: PlateSwapKind;
  vehicleClass?: PlateSwapVehicleClass;
}) {
  return <PlateSwapReceivePlateOrBookPage kind="plate" swapKind={swapKind} vehicleClass={vehicleClass} />;
}

export function PlateSwapReceiveBookPage({
  swapKind = "OLD_NEW",
  vehicleClass = "CAR",
}: {
  swapKind?: PlateSwapKind;
  vehicleClass?: PlateSwapVehicleClass;
}) {
  return <PlateSwapReceivePlateOrBookPage kind="book" swapKind={swapKind} vehicleClass={vehicleClass} />;
}

// ---------------------------------------------------------------------------------------------
// หน้ายื่นงาน "รถเก่า กับ รถเก่า" (ผู้ใช้ 2026-09-28)
// กรอก 2 คันในหน้าเดียว แต่ระบบเก็บ "แยกเป็น 2 งาน" คันละแถวที่ผูกกันด้วย pairId
// ทะเบียนไขว้กันตั้งแต่ตอนยื่น (คันที่ 1 ได้ทะเบียนของคันที่ 2 และกลับกัน) จึงไม่มีช่องกรอกทะเบียนใหม่
// และไม่ลิงก์ฐานข้อมูลรถจดใหม่เลยเพราะทั้งคู่เป็นรถเก่า - ค่าใช้จ่ายคิดคันละชุด ราคาเท่าเคสรถเก่า-รถใหม่
// ---------------------------------------------------------------------------------------------

const EMPTY_PAIR_CAR = { oldOwnerName: "", oldEngine: "", oldChassis: "", oldBrand: "", oldPlateCategory: "", oldPlateNumber: "" };
type PairCar = typeof EMPTY_PAIR_CAR;

function PairCarFields({
  label,
  value,
  brandNames,
  onChange,
}: {
  label: string;
  value: PairCar;
  brandNames: string[];
  onChange: (next: PairCar) => void;
}) {
  const set = (key: keyof PairCar) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ ...value, [key]: e.target.value });
  return (
    <div className="panel" style={{ padding: 18, marginBottom: 0 }}>
      <h3 style={{ marginTop: 0 }}>{label}</h3>
      <div style={{ display: "grid", gap: 12 }}>
        <label className="field">
          ชื่อเจ้าของรถ *
          <input value={value.oldOwnerName} onChange={set("oldOwnerName")} required />
        </label>
        {/* ผู้ใช้ 2026-09-28: เลขตัวถังมาก่อนเลขเครื่อง (สลับจากลำดับเดิมที่กำหนดไว้ 2026-09-23) */}
        <label className="field">
          เลขตัวถัง *
          <input value={value.oldChassis} onChange={set("oldChassis")} required />
        </label>
        <label className="field">
          เลขเครื่อง *
          <input value={value.oldEngine} onChange={set("oldEngine")} required />
        </label>
        <label className="field">
          ยี่ห้อ *
          <select value={value.oldBrand} onChange={set("oldBrand")} required>
            <option value="">เลือกยี่ห้อ</option>
            {brandNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          ทะเบียนเดิม *
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={value.oldPlateCategory}
              onChange={set("oldPlateCategory")}
              maxLength={3}
              placeholder="หมวด เช่น 4กข"
              aria-label={`หมวดทะเบียน ${label}`}
              required
            />
            <input
              value={value.oldPlateNumber}
              onChange={(e) => onChange({ ...value, oldPlateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
              maxLength={4}
              inputMode="numeric"
              placeholder="เลข เช่น 4444"
              aria-label={`เลขทะเบียน ${label}`}
              required
            />
          </div>
        </div>
      </div>
    </div>
  );
}

const pairPlateText = (car: PairCar) => (car.oldPlateCategory && car.oldPlateNumber ? `${car.oldPlateCategory} ${car.oldPlateNumber}` : "—");

// ตัวเลือกค่าใช้จ่าย - ใช้ร่วมกันทั้ง 2 เคส ต่างกันตามประเภทรถ (ผู้ใช้ 2026-09-28)
// รถยนต์: เลือกที่มาของเลข (เลขไม่เคยออก / เลขประมูล) + ป้าย 200 + ป้ายประมูล 1,200
// มอเตอร์ไซค์: ใช้เลขที่ไม่เคยออกเสมอ (ไม่มีให้เลือก) + ป้าย 100 + งานด่วน 50 ซึ่งรถยนต์ไม่มี
function FeeOptionFields({
  vehicleClass,
  numberSource,
  onNumberSource,
  buyNormalPlate,
  onBuyNormalPlate,
  buyAuctionPlate,
  onBuyAuctionPlate,
  urgent,
  onUrgent,
}: {
  vehicleClass: PlateSwapVehicleClass;
  numberSource: PlateSwapNumberSource;
  onNumberSource: (s: PlateSwapNumberSource) => void;
  buyNormalPlate: boolean;
  onBuyNormalPlate: (v: boolean) => void;
  buyAuctionPlate: boolean;
  onBuyAuctionPlate: (v: boolean) => void;
  urgent: boolean;
  onUrgent: (v: boolean) => void;
}) {
  const isMoto = vehicleClass === "MOTO";
  const carItems = PLATE_SWAP_CAR_NUMBER_ITEMS[numberSource];
  const plateItem = isMoto ? PLATE_SWAP_MOTO_PLATE_ITEM : carItems.normalPlate;
  return (
    <>
      {isMoto ? (
        <p className="muted" style={{ marginTop: 0, marginBottom: 14 }}>
          ใช้เลขทะเบียนที่ไม่เคยออกให้รถคันอื่น ({formatBaht(PLATE_SWAP_MOTO_NUMBER_ITEM.amount)} บาท) — มอเตอร์ไซค์ไม่มีตัวเลือกเลขประมูล/ชุดสงวน
        </p>
      ) : (
        <div className="inspect-filter" style={{ padding: 0, marginBottom: 14 }}>
          {(Object.keys(PLATE_SWAP_CAR_NUMBER_ITEMS) as PlateSwapNumberSource[]).map((source) => (
            <button
              key={source}
              type="button"
              className={`filter-chip${numberSource === source ? " selected" : ""}`}
              onClick={() => onNumberSource(source)}
            >
              {PLATE_SWAP_CAR_NUMBER_ITEMS[source].title}
            </button>
          ))}
        </div>
      )}
      <div style={{ display: "flex", gap: 22, flexWrap: "wrap", fontSize: 14, marginBottom: 16 }}>
        <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <input type="checkbox" checked={buyNormalPlate} onChange={(e) => onBuyNormalPlate(e.target.checked)} />
          ซื้อ{plateItem.label.replace(/^ค่า/, "")} ({formatBaht(plateItem.amount)} บาท)
        </label>
        {!isMoto && carItems.auctionPlate && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={buyAuctionPlate} onChange={(e) => onBuyAuctionPlate(e.target.checked)} />
            ซื้อ{carItems.auctionPlate.label.replace(/^ค่า/, "")} ({formatBaht(carItems.auctionPlate.amount)} บาท)
          </label>
        )}
        {isMoto && (
          <label style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={urgent} onChange={(e) => onUrgent(e.target.checked)} />
            งานด่วน (+{formatBaht(PLATE_SWAP_MOTO_URGENT_ITEM.amount)} บาท)
          </label>
        )}
      </div>
    </>
  );
}

// แถวรายการของเคสคู่ - ไม่มีคอลัมน์ "รถใหม่ที่ลิงก์" เพราะไม่มีการลิงก์ และทะเบียนที่ได้มาจากอีกคันเสมอ
function OldOldRow({ swap, canWrite, onEdit, onCancel }: { swap: PlateSwap; canWrite: boolean; onEdit: () => void; onCancel: () => void }) {
  return (
    <tr>
      <td>{isoToDisplayDate(swap.submitDate)}</td>
      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
        <CustomerCell swap={swap} />
      </td>
      <td>
        <div className="job">{swap.oldOwnerName}</div>
        <div className="sub">{oldVehicleText(swap)}</div>
      </td>
      <td>
        <div>{oldPlateText(swap)}</div>
        <div className="sub">→ ได้ {newPlateText(swap) || "—"}</div>
      </td>
      <td title={swap.billItems.map((i) => `${i.label} ${formatBaht(i.amount)}`).join("\n")}>{formatBaht(Number(swap.billTotal))}</td>
      <td>{formatBaht(Number(swap.noBillTotal))}</td>
      <td>{formatBaht(dutyAmountOf(swap.noBillItems))}</td>
      <td>
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

export function PlateSwapOldOldSubmitPage({ vehicleClass = "CAR" }: { vehicleClass?: PlateSwapVehicleClass }) {
  const canWrite = useCanWrite();
  const [carA, setCarA] = useState<PairCar>(EMPTY_PAIR_CAR);
  const [carB, setCarB] = useState<PairCar>(EMPTY_PAIR_CAR);
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => textToIso(submitDateText), [submitDateText]);
  const [customerId, setCustomerId] = useState("");
  const [customerOptions, setCustomerOptions] = useState<Array<{ id: string; label: string }>>([]);
  const [numberSource, setNumberSource] = useState<PlateSwapNumberSource>("NEW_UNUSED");
  const [buyNormalPlate, setBuyNormalPlate] = useState(false);
  const [buyAuctionPlate, setBuyAuctionPlate] = useState(false);
  const [urgent, setUrgent] = useState(false); // งานด่วน - มีเฉพาะมอเตอร์ไซค์
  const [brandNames, setBrandNames] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [swaps, setSwaps] = useState<PlateSwap[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dialog, setDialog] = useState<RowDialog>(null);

  // ค่าใช้จ่ายคิดคันละชุดด้วยสูตรเดียวกับเคสรถเก่า-รถใหม่ (ผู้ใช้ 2026-09-28: "ราคาเท่ากันให้อิงตามยอดรถเก่าเลย")
  const fees = feesFor(vehicleClass, { numberSource, buyNormalPlate, buyAuctionPlate, urgent });
  const perCarTotal = fees.billTotal + fees.noBillTotal - dutyAmountOf(fees.noBillItems);

  async function load(forMonth: string) {
    setLoading(true);
    setListError("");
    try {
      setSwaps((await plateSwapApi.list("all", forMonth, "OLD_OLD", vehicleClass)).swaps);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load อ่าน vehicleClass ที่อยู่ใน deps แล้ว
  }, [month, vehicleClass]);

  useEffect(() => {
    api
      .listBrands()
      .then((data) => setBrandNames(data.brands.map((b) => b.name)))
      .catch(() => setBrandNames([]));
    api
      .listCustomers()
      .then((data) => setCustomerOptions(data.customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") }))))
      .catch(() => setCustomerOptions([]));
  }, []);

  function chooseNumberSource(source: PlateSwapNumberSource) {
    setNumberSource(source);
    if (source === "NEW_UNUSED") setBuyAuctionPlate(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submitDate) return setMessage({ text: "กรุณากรอกวันที่ยื่นให้ถูกต้อง", error: true });
    if (!customerId) return setMessage({ text: "กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)", error: true });
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await plateSwapApi.createPair({ vehicleClass, urgent, customerId, submitDate, numberSource, buyNormalPlate, buyAuctionPlate, carA, carB });
      setMessage({ text: "บันทึกแล้ว - ระบบแยกเป็น 2 งาน (คันละงาน)" });
      setCarA(EMPTY_PAIR_CAR);
      setCarB(EMPTY_PAIR_CAR);
      if (submitDate.slice(0, 7) === month) await load(month);
      else setMonth(submitDate.slice(0, 7));
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setSaving(false);
    }
  }

  const replaceSwap = (updated: PlateSwap) => setSwaps((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

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
      <Link href={caseHome(vehicleClass, "OLD_OLD").href} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← รถเก่า กับ รถเก่า
      </Link>
      <h1>ยื่นงานสลับเลข · รถเก่า กับ รถเก่า ({CLASS_LABEL[vehicleClass]})</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        กรอกรถทั้ง 2 คันในหน้านี้ ระบบจะบันทึกแยกเป็น 2 งาน (คันละงาน) และสลับทะเบียนให้อัตโนมัติ
      </p>

      {canWrite && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <form className="customer-form" onSubmit={handleSubmit}>
            <div className="customer-grid">
              <label className="field">
                เจ้าของงาน * (ลูกค้าที่ส่งงานมา)
                <select value={customerId} onChange={(e) => setCustomerId(e.target.value)} required>
                  <option value="">เลือกลูกค้า</option>
                  {customerOptions.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                วันที่ยื่น *
                <DateTextInput value={submitDateText} onChange={setSubmitDateText} />
              </label>
            </div>

            <div className="customer-grid" style={{ marginTop: 20 }}>
              <PairCarFields label="คันที่ 1" value={carA} brandNames={brandNames} onChange={setCarA} />
              <PairCarFields label="คันที่ 2" value={carB} brandNames={brandNames} onChange={setCarB} />
            </div>

            {/* บอกผลลัพธ์ก่อนบันทึก - กันกรอกสลับข้างแล้วมารู้ตัวหลังบันทึกไปแล้ว */}
            <div className="customer-message" style={{ marginTop: 18 }}>
              หลังบันทึก: คันที่ 1 ({pairPlateText(carA)}) จะได้ทะเบียน <strong>{pairPlateText(carB)}</strong> · คันที่ 2 ({pairPlateText(carB)}) จะได้ทะเบียน{" "}
              <strong>{pairPlateText(carA)}</strong>
            </div>

            <h2 style={{ marginTop: 28 }}>ค่าใช้จ่าย (คิดคันละชุด)</h2>
            <FeeOptionFields
              vehicleClass={vehicleClass}
              numberSource={numberSource}
              onNumberSource={chooseNumberSource}
              buyNormalPlate={buyNormalPlate}
              onBuyNormalPlate={setBuyNormalPlate}
              buyAuctionPlate={buyAuctionPlate}
              onBuyAuctionPlate={setBuyAuctionPlate}
              urgent={urgent}
              onUrgent={setUrgent}
            />

            <div className="customer-grid">
              <div>
                <strong>Bill (ใบเสร็จ) ต่อคัน</strong>
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
                        <strong>รวม Bill / คัน</strong>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <strong>{formatBaht(fees.billTotal)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div>
                <strong>No Bill ต่อคัน</strong>
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
                        <strong>รวม No Bill / คัน</strong>
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <strong>{formatBaht(fees.noBillTotal)}</strong>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <p style={{ marginTop: 14 }}>
              <strong>รวมทั้ง 2 คัน (ไม่รวมค่าอากร): {formatBaht(perCarTotal * 2)} บาท</strong>{" "}
              <span className="muted">· แยกค่าอากร {formatBaht(dutyAmountOf(fees.noBillItems) * 2)} บาท</span>
            </p>

            {message.text && (
              <div className={`customer-message${message.error ? " error" : " success"}`} role="status" style={{ marginTop: 12 }}>
                {message.text}
              </div>
            )}
            <div style={{ marginTop: 16 }}>
              <button type="submit" className="primary" disabled={saving}>
                {saving ? "กำลังบันทึก…" : "บันทึกการยื่น (2 งาน)"}
              </button>
            </div>
          </form>
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2 style={{ margin: 0 }}>รายการที่ยื่นแล้ว</h2>
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
          <div className="empty-customers">ยังไม่มีงานรถเก่า กับ รถเก่าในเดือนนี้</div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>วันที่ยื่น</th>
                    <th>เจ้าของงาน</th>
                    <th>รถ</th>
                    <th>ทะเบียนเดิม / ที่ได้</th>
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
                    <OldOldRow
                      key={swap.id}
                      swap={swap}
                      canWrite={!!canWrite}
                      onEdit={() => setDialog({ kind: "edit", swap })}
                      onCancel={() => setDialog({ kind: "cancel", swap })}
                    />
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: "12px 23px" }}>
              <strong>
                รวม {swaps.length} งาน · Bill {formatBaht(monthTotals.bill)} · No Bill {formatBaht(monthTotals.noBill)} · ค่าอากร{" "}
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
            // แก้ทะเบียนของงานคู่ทำให้อีกแถวเปลี่ยนตามที่ backend - โหลดใหม่ทั้งรายการให้ตรงกัน
            replaceSwap(updated);
            void load(month);
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        // ยกเลิกงานที่เป็นคู่ = backend ยกเลิกทั้ง 2 งาน จึงโหลดรายการใหม่แทนการตัดแถวเดียว
        <CancelSwapDialog swap={dialog.swap} onClose={() => setDialog(null)} onCancelled={() => void load(month)} />
      )}
    </section>
  );
}
