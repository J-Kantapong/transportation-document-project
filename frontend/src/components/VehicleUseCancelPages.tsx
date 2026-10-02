"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getCachedUser, submitWriteScopeFor } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatBaht } from "@/lib/plate-swap-fee";
import { VEHICLE_USE_CANCEL_BILL_FEE, VEHICLE_USE_CANCEL_DUTY_FEE, VEHICLE_USE_CANCEL_NO_BILL_FEE } from "@/lib/vehicle-use-cancel-fee";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import {
  vehicleUseCancelApi,
  type CancellationStatusFilter,
  type CancellationVehicleClass,
  type VehicleUseCancellation,
} from "@/lib/vehicle-use-cancel-api";
import { DateTextInput, dangerButton, errorText, openReceiptImage, ReasonDialog, textToIso } from "@/components/PlateSwapPages";

// ยกเลิกการใช้รถ (หมวด "อื่นๆ", ผู้ใช้ 2026-10-02) - กรอกข้อมูลรถเหมือนการสลับเลข (ไม่มีทะเบียนใหม่) ทั้งรถยนต์และมอเตอร์ไซค์
// หน้ายื่น (VehicleUseCancelSubmitPage): เจ้าของงาน + ข้อมูลรถ + วันที่ยื่น (ค่าใช้จ่ายตายตัว Bill 25 / No Bill 100 ไม่ต้องกรอก)
// หน้ารับใบเสร็จ (VehicleUseCancelReturnPage): แนบรูปใบเสร็จอย่างน้อย 1 รูป (อ่าน OCR เติมเลขที่/วันที่/ยอดเงินให้ แก้เองได้)
// แล้วยืนยันวันที่รับเอกสารกลับ - เหมือนขั้นรับใบเสร็จของงานสลับเลข
// แก้/ยกเลิก: ต้องระบุเหตุผลเสมอ (เก็บประวัติ) - ไม่มีการลบงาน งานที่ยกเลิกหายจากรายการแต่ยังอยู่ในฐานข้อมูล

const CLASS_SEGMENT: Record<CancellationVehicleClass, string> = { CAR: "car", MOTO: "moto" };
const CLASS_LABEL: Record<CancellationVehicleClass, string> = { CAR: "รถยนต์", MOTO: "รถจักรยานยนต์" };

export const cancelUseHome = (vehicleClass: CancellationVehicleClass) => `/registration/other/cancel-use/${CLASS_SEGMENT[vehicleClass]}`;

// บันทึกได้เฉพาะกลุ่มยื่นเอกสารของประเภทรถนั้น (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO, ADMIN ทุกประเภท) - backend กันอีกชั้น
// บัญชี (ACCOUNTANT) อ่านอย่างเดียว จึงซ่อนฟอร์ม/ปุ่มบันทึก
function useCanWrite(vehicleClass: CancellationVehicleClass): boolean | null {
  const [canWrite, setCanWrite] = useState<boolean | null>(null);
  useEffect(() => {
    const scope = submitWriteScopeFor(getCachedUser()?.roles ?? []);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setCanWrite(scope === "ALL" || scope === vehicleClass);
  }, [vehicleClass]);
  return canWrite;
}

const plateText = (c: VehicleUseCancellation) => `${c.plateCategory} ${c.plateNumber}`;
const vehicleText = (c: VehicleUseCancellation) => `${c.brand} · เครื่อง ${c.engine} · ตัวถัง ${c.chassis}`;
// รวม = Bill + No Bill - ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่นับในยอดรวม (ผู้ใช้ 2026-10-02)
const totalOf = (c: VehicleUseCancellation) => Number(c.billTotal) + Number(c.noBillTotal);

// เจ้าของงาน = ลูกค้าที่ส่งงานมา (คนละคนกับชื่อเจ้าของรถตามทะเบียน)
function CustomerCell({ item }: { item: VehicleUseCancellation }) {
  if (!item.customer) return <span className="muted">ยังไม่ระบุ</span>;
  return (
    <>
      <div className="job">{item.customer.company ?? item.customer.name}</div>
      {item.customer.company && <div className="sub">{item.customer.name}</div>}
    </>
  );
}

function Summary({ item }: { item: VehicleUseCancellation }) {
  return (
    <div style={{ padding: "10px 12px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 8, fontSize: 14 }}>
      <strong>{item.ownerName}</strong> · ทะเบียน {plateText(item)}
      <div className="muted">{vehicleText(item)}</div>
    </div>
  );
}

// ปุ่มแก้/ยกเลิกท้ายแถว (เฉพาะผู้มีสิทธิ์บันทึก)
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
// ช่องกรอกที่ใช้ร่วมกันระหว่างฟอร์มยื่นกับป๊อปอัปแก้
// ---------------------------------------------------------------------------------------------

interface FormState {
  customerId: string;
  ownerName: string;
  chassis: string;
  engine: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
}

const EMPTY_FORM: FormState = {
  customerId: "",
  ownerName: "",
  chassis: "",
  engine: "",
  brand: "",
  plateCategory: "",
  plateNumber: "",
};

type Option = { id: string; label: string };

const moneyOnly = (text: string) => text.replace(/[^0-9.]/g, "");

// โหลดตัวเลือกยี่ห้อ + ลูกค้าจากฐานข้อมูล (ยี่ห้อที่ยังไม่มีเพิ่มจากหน้าเพิ่มข้อมูลรถจดใหม่) - ป้ายกำกับเหมือนหน้าสลับเลข
function useChoices(extraBrand?: string) {
  const [brandNames, setBrandNames] = useState<string[]>(extraBrand ? [extraBrand] : []);
  const [customerOptions, setCustomerOptions] = useState<Option[]>([]);
  useEffect(() => {
    api
      .listBrands()
      .then((data) => setBrandNames(Array.from(new Set([...(extraBrand ? [extraBrand] : []), ...data.brands.map((b) => b.name)]))))
      .catch(() => undefined);
    api
      .listCustomers()
      .then((data) => setCustomerOptions(data.customers.map((c) => ({ id: c.id, label: [c.name, c.company, c.branch].filter(Boolean).join(" · ") }))))
      .catch(() => undefined);
  }, [extraBrand]);
  return { brandNames, customerOptions };
}

function VehicleFormFields({
  form,
  onChange,
  submitDateText,
  onSubmitDateChange,
  returnedDateText,
  onReturnedDateChange,
  brandNames,
  customerOptions,
  customerPlaceholder = "เลือกลูกค้า",
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  submitDateText: string;
  onSubmitDateChange: (text: string) => void;
  returnedDateText?: string;
  onReturnedDateChange?: (text: string) => void;
  brandNames: string[];
  customerOptions: Option[];
  customerPlaceholder?: string;
}) {
  const text = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ [key]: e.target.value });
  return (
    <>
      {/* เจ้าของงาน = ลูกค้าที่ส่งงานมาให้เรา ไว้ส่งงาน/วางบิลให้ถูกเจ้าของ - ไม่ใช่เจ้าของรถตามทะเบียน (ช่อง "ชื่อเจ้าของรถ" ข้างล่าง) */}
      <label className="field" style={{ maxWidth: 420 }}>
        เจ้าของงาน * (ลูกค้าที่ส่งงานมา)
        <select value={form.customerId} onChange={(e) => onChange({ customerId: e.target.value })}>
          <option value="">{customerPlaceholder}</option>
          {customerOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <h2 style={{ marginTop: 22 }}>ข้อมูลรถ</h2>
      {/* ลำดับช่องเหมือนงานสลับเลข: วันที่ยื่น -> ชื่อเจ้าของรถ -> เลขตัวถัง -> เลขเครื่อง -> ยี่ห้อ -> ทะเบียน */}
      <div className="customer-grid">
        <label className="field">
          วันที่ยื่น *
          <DateTextInput value={submitDateText} onChange={onSubmitDateChange} label="วันที่ยื่น" />
        </label>
        {returnedDateText !== undefined && onReturnedDateChange && (
          <label className="field">
            วันที่รับเอกสารกลับ *
            <DateTextInput value={returnedDateText} onChange={onReturnedDateChange} label="วันที่รับเอกสารกลับ" />
          </label>
        )}
        <label className="field">
          ชื่อเจ้าของรถ *
          <input value={form.ownerName} onChange={text("ownerName")} />
        </label>
        <label className="field">
          เลขตัวถัง *
          <input value={form.chassis} onChange={text("chassis")} />
        </label>
        <label className="field">
          เลขเครื่อง *
          <input value={form.engine} onChange={text("engine")} />
        </label>
        <label className="field">
          ยี่ห้อ *
          <select value={form.brand} onChange={(e) => onChange({ brand: e.target.value })}>
            <option value="">เลือกยี่ห้อ</option>
            {brandNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <div className="field">
          ทะเบียน *
          <div style={{ display: "flex", gap: 8 }}>
            <input value={form.plateCategory} onChange={text("plateCategory")} maxLength={3} placeholder="หมวด เช่น 4กข" aria-label="หมวดทะเบียน" />
            <input
              value={form.plateNumber}
              onChange={(e) => onChange({ plateNumber: e.target.value.replace(/\D/g, "").slice(0, 4) })}
              maxLength={4}
              inputMode="numeric"
              placeholder="เลข เช่น 4444"
              aria-label="เลขทะเบียน"
            />
          </div>
        </div>
      </div>

      <h2 style={{ marginTop: 22 }}>ค่าใช้จ่าย</h2>
      {/* ค่าใช้จ่ายตายตัว (ผู้ใช้ 2026-10-02) - ไม่ต้องกรอก ระบบเก็บยอดตามอัตรานี้ตอนบันทึก */}
      <div className="customer-grid">
        <div>
          <strong>Bill (ใบเสร็จ)</strong>
          <div>{formatBaht(VEHICLE_USE_CANCEL_BILL_FEE)} บาท</div>
        </div>
        <div>
          <strong>No Bill</strong>
          <div>{formatBaht(VEHICLE_USE_CANCEL_NO_BILL_FEE)} บาท</div>
        </div>
        <div>
          <strong>ค่าอากร</strong>
          <div>{formatBaht(VEHICLE_USE_CANCEL_DUTY_FEE)} บาท (แยกต่างหาก ไม่รวมใน No Bill)</div>
        </div>
        <div className="wide" style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
          <strong>รวม (Bill + No Bill)</strong>
          <span style={{ textAlign: "right" }}>
            <strong>{formatBaht(VEHICLE_USE_CANCEL_BILL_FEE + VEHICLE_USE_CANCEL_NO_BILL_FEE)} บาท</strong>
            <div className="muted">แยกค่าอากร {formatBaht(VEHICLE_USE_CANCEL_DUTY_FEE)} บาท</div>
          </span>
        </div>
      </div>
    </>
  );
}

// ตรวจฟอร์มฝั่งหน้าเว็บ (backend ตรวจซ้ำ) - คืนข้อความผิดพลาดข้อแรก หรือ "" ถ้าผ่าน
function validateForm(form: FormState, requireCustomer: boolean): string {
  if (requireCustomer && !form.customerId) return "กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)";
  if (!form.ownerName.trim()) return "กรุณากรอกชื่อเจ้าของรถ";
  if (!form.chassis.trim()) return "กรุณากรอกเลขตัวถัง";
  if (!form.engine.trim()) return "กรุณากรอกเลขเครื่อง";
  if (!form.brand) return "กรุณาเลือกยี่ห้อ";
  if (!form.plateCategory.trim() || !form.plateNumber.trim()) return "กรุณากรอกทะเบียน (หมวดทะเบียนและเลขทะเบียน)";
  return "";
}

// ---------------------------------------------------------------------------------------------
// ป๊อปอัปแก้ / ยกเลิกงาน
// ---------------------------------------------------------------------------------------------

function EditDialog({
  item,
  onClose,
  onSaved,
}: {
  item: VehicleUseCancellation;
  onClose: () => void;
  onSaved: (item: VehicleUseCancellation) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormState>({
    customerId: item.customer?.id ?? "",
    ownerName: item.ownerName,
    chassis: item.chassis,
    engine: item.engine,
    brand: item.brand,
    plateCategory: item.plateCategory,
    plateNumber: item.plateNumber,
  });
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(item.submitDate));
  const [returnedDateText, setReturnedDateText] = useState(() => (item.returnedDate ? isoToDisplayDate(item.returnedDate) : ""));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { brandNames, customerOptions } = useChoices(item.brand);

  useEffect(() => {
    if (!dialogRef.current?.open) dialogRef.current?.showModal();
  }, []);

  async function save() {
    setError("");
    const submitDate = textToIso(submitDateText);
    if (!submitDate) return setError("วันที่ยื่นไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    const returnedDate = item.returnedDate ? textToIso(returnedDateText) : "";
    if (item.returnedDate && !returnedDate) return setError("วันที่รับเอกสารกลับไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    if (returnedDate && returnedDate > todayIso()) return setError("วันที่รับเอกสารกลับต้องไม่เกินวันนี้");
    if (returnedDate && returnedDate < submitDate) return setError("วันที่รับเอกสารกลับต้องไม่ก่อนวันที่ยื่น");
    const invalid = validateForm(form, false);
    if (invalid) return setError(invalid);
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้");
    setSaving(true);
    try {
      const { cancellation } = await vehicleUseCancelApi.update(item.id, {
        ownerName: form.ownerName,
        engine: form.engine,
        chassis: form.chassis,
        brand: form.brand,
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        // ส่งเฉพาะตอนเลือกไว้จริง - งานที่ไม่มีเจ้าของงานและไม่ได้เลือกในรอบนี้ ไม่ต้องแตะ
        ...(form.customerId ? { customerId: form.customerId } : {}),
        submitDate,
        ...(returnedDate ? { returnedDate } : {}),
        remark: remark.trim(),
        // ฟอร์มส่งทุกช่องจากตอนเปิด - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดค้างไว้ backend ตอบ 409 ไม่ทับของเขา
        expectedUpdatedAt: item.updatedAt,
      });
      onSaved(cancellation);
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
      <h2>แก้งานยกเลิกการใช้รถ</h2>
      <Summary item={item} />
      <div style={{ marginTop: 12 }}>
        <VehicleFormFields
          form={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          submitDateText={submitDateText}
          onSubmitDateChange={setSubmitDateText}
          returnedDateText={item.returnedDate ? returnedDateText : undefined}
          onReturnedDateChange={setReturnedDateText}
          brandNames={brandNames}
          customerOptions={customerOptions}
          customerPlaceholder={item.customer ? "เลือกลูกค้า" : "ยังไม่ระบุ"}
        />
      </div>
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

function CancelDialog({ item, onClose, onCancelled }: { item: VehicleUseCancellation; onClose: () => void; onCancelled: (id: string) => void }) {
  return (
    <ReasonDialog
      title="ยกเลิกงานยกเลิกการใช้รถ"
      confirmLabel="ยืนยันยกเลิกงาน"
      placeholder="เช่น บันทึกซ้ำ / ลูกค้ายกเลิก"
      onClose={onClose}
      onConfirm={async (remark) => {
        await vehicleUseCancelApi.cancel(item.id, remark);
        onCancelled(item.id);
      }}
    >
      <Summary item={item} />
      <p style={{ marginTop: 12 }}>
        งานนี้จะหายจากรายการและยอดรวม (ยังเก็บไว้ในประวัติพร้อมเหตุผล)
        {item.receipts.length > 0 ? " - รูปใบเสร็จที่แนบไว้นำไปแนบกับงานที่บันทึกใหม่ได้" : ""}
      </p>
    </ReasonDialog>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ายื่น
// ---------------------------------------------------------------------------------------------

type RowDialog = { kind: "edit" | "cancel"; item: VehicleUseCancellation } | null;

export function VehicleUseCancelSubmitPage({ vehicleClass = "CAR" }: { vehicleClass?: CancellationVehicleClass }) {
  const canWrite = useCanWrite(vehicleClass);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => textToIso(submitDateText), [submitDateText]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const { brandNames, customerOptions } = useChoices();

  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [items, setItems] = useState<VehicleUseCancellation[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dialog, setDialog] = useState<RowDialog>(null);

  async function load(forMonth: string) {
    setLoading(true);
    setListError("");
    try {
      setItems((await vehicleUseCancelApi.list("all", vehicleClass, forMonth)).cancellations);
    } catch (err) {
      setListError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการใหม่เมื่อเปลี่ยนเดือน
    if (month) load(month);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load อ่าน vehicleClass ที่อยู่ใน deps แล้ว
  }, [month, vehicleClass]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submitDate) return setMessage({ text: "กรุณากรอกวันที่ยื่นให้ถูกต้อง", error: true });
    const invalid = validateForm(form, true);
    if (invalid) return setMessage({ text: invalid, error: true });
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await vehicleUseCancelApi.create({
        vehicleClass,
        customerId: form.customerId,
        ownerName: form.ownerName,
        engine: form.engine,
        chassis: form.chassis,
        brand: form.brand,
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        submitDate,
      });
      setMessage({ text: "บันทึกงานที่ยื่นแล้ว" });
      setForm((prev) => ({ ...EMPTY_FORM, customerId: prev.customerId })); // เจ้าของงานคนเดิมมักส่งมาหลายคัน - คงไว้ให้
      if (submitDate.slice(0, 7) === month) await load(month);
      else setMonth(submitDate.slice(0, 7));
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setSaving(false);
    }
  }

  const replace = (updated: VehicleUseCancellation) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  const totals = items.reduce(
    (acc, s) => ({ bill: acc.bill + Number(s.billTotal), noBill: acc.noBill + Number(s.noBillTotal), duty: acc.duty + Number(s.dutyAmount) }),
    { bill: 0, noBill: 0, duty: 0 },
  );

  return (
    <section className="content">
      <Link href={cancelUseHome(vehicleClass)} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ยกเลิกการใช้รถ · {CLASS_LABEL[vehicleClass]}
      </Link>
      <h1>ยื่นงานยกเลิกการใช้รถ ({CLASS_LABEL[vehicleClass]})</h1>

      {canWrite && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <form className="customer-form" onSubmit={handleSubmit}>
            <VehicleFormFields
              form={form}
              onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
              submitDateText={submitDateText}
              onSubmitDateChange={setSubmitDateText}
              brandNames={brandNames}
              customerOptions={customerOptions}
            />
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
        ) : items.length === 0 ? (
          <div className="empty-customers">ยังไม่มีรายการในเดือนนี้</div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>วันที่ยื่น</th>
                    <th>เจ้าของงาน</th>
                    <th>รถ</th>
                    <th>ทะเบียน</th>
                    <th>Bill</th>
                    <th>No Bill</th>
                    <th>ค่าอากร</th>
                    <th>รวม</th>
                    <th>สถานะ</th>
                    {canWrite && <th />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <td>{isoToDisplayDate(item.submitDate)}</td>
                      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
                        <CustomerCell item={item} />
                      </td>
                      <td>
                        <div className="job">{item.ownerName}</div>
                        <div className="sub">{vehicleText(item)}</div>
                      </td>
                      <td>{plateText(item)}</td>
                      <td>{formatBaht(Number(item.billTotal))}</td>
                      <td>{formatBaht(Number(item.noBillTotal))}</td>
                      <td>{formatBaht(Number(item.dutyAmount))}</td>
                      <td>
                        <strong>{formatBaht(totalOf(item))}</strong>
                      </td>
                      <td>
                        {item.returnedDate ? (
                          <span className="badge portal-badge-done">รับกลับ {isoToDisplayDate(item.returnedDate)}</span>
                        ) : (
                          <span className="badge">รอรับเอกสารกลับ</span>
                        )}
                      </td>
                      {canWrite && (
                        <td>
                          <RowActions onEdit={() => setDialog({ kind: "edit", item })} onCancel={() => setDialog({ kind: "cancel", item })} />
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ padding: "18px 23px", borderTop: "1px solid #edf0f6", fontSize: 13, color: "#34415a" }}>
              <strong>
                รวม {items.length} คัน · Bill {formatBaht(totals.bill)} · No Bill {formatBaht(totals.noBill)} · ค่าอากร {formatBaht(totals.duty)} ·
                รวม (ไม่รวมค่าอากร) {formatBaht(totals.bill + totals.noBill)} บาท
              </strong>
            </div>
          </>
        )}
      </div>

      {dialog?.kind === "edit" && (
        <EditDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onSaved={(updated) => {
            // แก้วันที่ยื่นข้ามเดือน = ไม่อยู่ในเดือนที่ดูอยู่แล้ว โหลดใหม่ให้ตรงกับ backend
            if (updated.submitDate.slice(0, 7) !== month) void load(month);
            else replace(updated);
          }}
        />
      )}
      {dialog?.kind === "cancel" && (
        <CancelDialog item={dialog.item} onClose={() => setDialog(null)} onCancelled={(id) => setItems((prev) => prev.filter((s) => s.id !== id))} />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ารับใบเสร็จ (รับเอกสารกลับ)
// ---------------------------------------------------------------------------------------------

// เลขที่ใบเสร็จ/วันที่/ยอดเงิน - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ (ช่องยังว่างทั้ง 3) แก้เองได้เสมอทีหลัง
// งานที่รับเอกสารกลับแล้ว แก้ได้แต่ต้องมีเหตุผล
function ReceiptFieldsCell({ item, canWrite, onChange }: { item: VehicleUseCancellation; canWrite: boolean; onChange: (item: VehicleUseCancellation) => void }) {
  const [editing, setEditing] = useState(false);
  const [receiptNo, setReceiptNo] = useState(item.receiptNo ?? "");
  const [dateText, setDateText] = useState(() => (item.receiptDate ? isoToDisplayDate(item.receiptDate) : ""));
  const [amount, setAmount] = useState(item.receiptAmount ?? "");
  const [remark, setRemark] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const needsRemark = Boolean(item.returnedDate);

  // OCR เติมค่าหลังแนบรูป - แถวถูกแทนด้วยค่าใหม่ ให้ช่องที่ยังไม่ได้เปิดแก้ตามไปด้วย
  useEffect(() => {
    if (editing) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- ซิงก์ช่องกรอกกับค่าที่เพิ่งอ่านได้จากรูป
    setReceiptNo(item.receiptNo ?? "");
    setDateText(item.receiptDate ? isoToDisplayDate(item.receiptDate) : "");
    setAmount(item.receiptAmount ?? "");
  }, [editing, item.receiptNo, item.receiptDate, item.receiptAmount]);

  async function save() {
    setError("");
    const receiptDate = dateText.trim() ? textToIso(dateText) : "";
    if (dateText.trim() && !receiptDate) return setError("วันที่ใบเสร็จไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    if (needsRemark && !remark.trim()) return setError("งานนี้รับเอกสารกลับแล้ว - กรุณาระบุเหตุผลที่แก้ข้อมูลใบเสร็จ");
    setBusy(true);
    try {
      const { cancellation } = await vehicleUseCancelApi.updateReceiptFields(
        item.id,
        { receiptNo: receiptNo.trim(), receiptDate, receiptAmount: amount.trim() },
        needsRemark ? remark.trim() : undefined,
      );
      onChange(cancellation);
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
        <div>{item.receiptNo || <span className="muted">ยังไม่มีเลขที่ใบเสร็จ</span>}</div>
        <div className="sub">
          {item.receiptDate ? `วันที่ ${isoToDisplayDate(item.receiptDate)}` : ""}
          {item.receiptAmount ? `${item.receiptDate ? " · " : ""}${formatBaht(Number(item.receiptAmount))} บาท` : ""}
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
      <input value={receiptNo} onChange={(e) => setReceiptNo(e.target.value)} placeholder="เลขที่ใบเสร็จ" aria-label="เลขที่ใบเสร็จ" className="inspect-input" />
      <DateTextInput value={dateText} onChange={setDateText} label="วันที่ใบเสร็จ" />
      <input
        value={amount}
        onChange={(e) => setAmount(moneyOnly(e.target.value))}
        placeholder="ยอดเงิน"
        aria-label="ยอดเงินตามใบเสร็จ"
        inputMode="decimal"
        className="inspect-input"
      />
      {needsRemark && (
        <input value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เหตุผลที่แก้ *" aria-label="เหตุผลที่แก้ข้อมูลใบเสร็จ" className="inspect-input" />
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

type ReturnDialog = { kind: "edit" | "cancel" | "undo"; item: VehicleUseCancellation } | null;

export function VehicleUseCancelReturnPage({ vehicleClass = "CAR" }: { vehicleClass?: CancellationVehicleClass }) {
  const canWrite = useCanWrite(vehicleClass);
  const [status, setStatus] = useState<Exclude<CancellationStatusFilter, "all">>("pending");
  const [items, setItems] = useState<VehicleUseCancellation[]>([]);
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
      setItems((await vehicleUseCancelApi.list(forStatus, vehicleClass)).cancellations);
    } catch (err) {
      setListError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการใหม่เมื่อเปลี่ยนแท็บ
    load(status);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, vehicleClass]);

  const replace = (updated: VehicleUseCancellation) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  const drop = (id: string) => setItems((prev) => prev.filter((s) => s.id !== id));

  async function confirmReturn(item: VehicleUseCancellation) {
    if (!returnDate) return setMessage({ text: "กรุณากรอกวันที่รับเอกสารกลับให้ถูกต้อง", error: true });
    // พิมพ์ปีผิดเป็นอนาคตไม่ได้ (backend กันอีกชั้น)
    if (returnDate > todayIso()) return setMessage({ text: "วันที่รับเอกสารกลับต้องไม่เกินวันนี้", error: true });
    // ยืนยันก่อนเสมอ - กดผิดงาน/ผิดวันแล้วต้องยกเลิกรับกลับพร้อมเหตุผล
    const ok = window.confirm(`ยืนยันรับเอกสารกลับ?\n\nวันที่รับกลับ: ${isoToDisplayDate(returnDate)}\nรถ: ${item.ownerName} (ทะเบียน ${plateText(item)})`);
    if (!ok) return;
    try {
      await vehicleUseCancelApi.markReturned(item.id, returnDate);
      drop(item.id);
      setMessage({ text: `รับเอกสารกลับแล้ว: ${item.ownerName} (${plateText(item)})` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  return (
    <section className="content">
      <Link href={cancelUseHome(vehicleClass)} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ยกเลิกการใช้รถ · {CLASS_LABEL[vehicleClass]}
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
        ) : items.length === 0 ? (
          <div className="empty-customers">{status === "pending" ? "ไม่มีงานที่รอรับเอกสารกลับ" : "ยังไม่มีงานที่รับกลับแล้ว"}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>วันที่ยื่น</th>
                  <th>เจ้าของงาน</th>
                  <th>รถ</th>
                  <th>ทะเบียน</th>
                  <th>รูปใบเสร็จ</th>
                  <th>ข้อมูลใบเสร็จ</th>
                  <th>{status === "pending" ? "" : "วันที่รับกลับ"}</th>
                  {canWrite && <th />}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ReturnRow
                    key={item.id}
                    item={item}
                    canWrite={!!canWrite}
                    onChange={replace}
                    onConfirm={confirmReturn}
                    onMessage={(text, error) => setMessage({ text, error })}
                    onDialog={(kind) => setDialog({ kind, item })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {dialog?.kind === "edit" && <EditDialog item={dialog.item} onClose={() => setDialog(null)} onSaved={replace} />}
      {dialog?.kind === "cancel" && (
        <CancelDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onCancelled={(id) => {
            drop(id);
            setMessage({ text: `ยกเลิกงานแล้ว: ${dialog.item.ownerName} (${plateText(dialog.item)})` });
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
            await vehicleUseCancelApi.undoReturn(dialog.item.id, remark);
            drop(dialog.item.id);
            setMessage({ text: `ย้ายกลับไปรอรับเอกสารแล้ว: ${dialog.item.ownerName} (${plateText(dialog.item)})` });
          }}
        >
          <Summary item={dialog.item} />
          <p style={{ marginTop: 12 }}>
            งานนี้จะกลับไปอยู่แท็บ &quot;รอรับเอกสารกลับ&quot; - ถ้าแค่วันที่รับกลับผิด ใช้ ✎ แก้ แทน
          </p>
        </ReasonDialog>
      )}
    </section>
  );
}

function ReturnRow({
  item,
  canWrite,
  onChange,
  onConfirm,
  onMessage,
  onDialog,
}: {
  item: VehicleUseCancellation;
  canWrite: boolean;
  onChange: (item: VehicleUseCancellation) => void;
  onConfirm: (item: VehicleUseCancellation) => void;
  onMessage: (text: string, error?: boolean) => void;
  onDialog: (kind: "edit" | "cancel" | "undo") => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const returned = Boolean(item.returnedDate);
  // งานที่รับกลับแล้ว: รูปใบเสร็จเป็นหลักฐาน แก้ได้ แต่ต้องกด "แก้รูปใบเสร็จ" และใส่เหตุผลก่อน
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
        onChange((await vehicleUseCancelApi.addReceipt(item.id, image, compressedFileName(file), returned ? receiptRemark.trim() : undefined)).cancellation);
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
      onChange((await vehicleUseCancelApi.removeReceipt(item.id, receiptId, returned ? receiptRemark.trim() : undefined)).cancellation);
    } catch (err) {
      onMessage(errorText(err, "ลบรูปไม่สำเร็จ"), true);
    }
  }

  return (
    <tr>
      <td>{isoToDisplayDate(item.submitDate)}</td>
      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
        <CustomerCell item={item} />
      </td>
      <td>
        <div className="job">{item.ownerName}</div>
        <div className="sub">{vehicleText(item)}</div>
      </td>
      <td>{plateText(item)}</td>
      <td>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {item.receipts.length === 0 && <span className="muted">ยังไม่มีรูป</span>}
          {item.receipts.map((r, i) => (
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
        <ReceiptFieldsCell item={item} canWrite={canWrite} onChange={onChange} />
      </td>
      <td>
        {item.returnedDate ? (
          isoToDisplayDate(item.returnedDate)
        ) : canWrite ? (
          <button
            type="button"
            className="primary"
            style={{ padding: "8px 14px", fontSize: 13 }}
            disabled={busy || item.receipts.length === 0}
            title={item.receipts.length === 0 ? "แนบรูปใบเสร็จก่อน" : undefined}
            onClick={() => onConfirm(item)}
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
