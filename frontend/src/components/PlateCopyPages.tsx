"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, fetchAuthedBlob, plateCopyPlatePhotoImageUrl } from "@/lib/api";
import { getCachedUser, getToken, submitWriteScopeFor } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatBaht } from "@/lib/plate-swap-fee";
import {
  PLATE_COPY_DUTY_FEE,
  PLATE_COPY_EXPECTED_DAYS,
  plateCopyDueDate,
  PLATE_COPY_MOTO_TYPE,
  PLATE_COPY_REQUEST_FEE,
  type PlateCopyType,
  type PlateCopyVehicleClass,
  calculatePlateCopyFees,
  plateCopyBaseNoBillFee,
  plateCopyPlateFee,
  plateCopyUrgentFee,
} from "@/lib/plate-copy-fee";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import {
  plateCopyApi,
  type PlateCopyStatusFilter,
  type PlateCopy,
} from "@/lib/plate-copy-api";
import { DateTextInput, dangerButton, errorText, openReceiptImage, ReasonDialog, textToIso } from "@/components/PlateSwapPages";

// คัดแผ่นป้ายทะเบียน (หมวด "อื่นๆ", ผู้ใช้ 2026-10-02) - กรอกข้อมูลรถเหมือนการสลับเลข (ไม่มีทะเบียนใหม่) ทั้งรถยนต์และมอเตอร์ไซค์
// (มอเตอร์ไซค์เปิดใช้ 2026-10-09: ประเภทรถเป็นช่องในฟอร์มหน้าเดียวกันเหมือนงานโอน เปลี่ยนหลังบันทึกไม่ได้ / มอเตอร์ไซค์มีป้ายใบเดียวจึงไม่มีชนิดการคัดป้าย)
// หน้ายื่น (PlateCopySubmitPage): ประเภทรถ + เจ้าของงาน + ข้อมูลรถ + วันที่ยื่น + งานด่วน (ค่าใช้จ่ายตายตัวตาม lib/plate-copy-fee ไม่ต้องกรอก)
// หน้ารับใบเสร็จ (PlateCopyReturnPage): แนบรูปใบเสร็จอย่างน้อย 1 รูป (อ่าน OCR เติมเลขที่/วันที่/ยอดเงินให้ แก้เองได้)
// แล้วยืนยันวันที่รับเอกสารกลับ - เหมือนขั้นรับใบเสร็จของงานสลับเลข
// แก้/ยกเลิก: ต้องระบุเหตุผลเสมอ (เก็บประวัติ) - ไม่มีการลบงาน งานที่ยกเลิกหายจากรายการแต่ยังอยู่ในฐานข้อมูล


export const PLATE_COPY_HOME = "/registration/other/plate-copy";

const CLASS_LABEL: Record<PlateCopyVehicleClass, string> = { CAR: "รถยนต์", MOTO: "รถจักรยานยนต์" };

// ประเภทรถที่บันทึกได้ = ตามบทบาท (STAFF_CAR = รถยนต์, STAFF_MOTO = มอเตอร์ไซค์, ADMIN/ถือทั้งคู่ = ทั้งสอง) - backend กันอีกชั้น
// บัญชี (ACCOUNTANT) อ่านอย่างเดียว จึงว่าง = ซ่อนฟอร์ม/ปุ่มบันทึก / null = ยังไม่อ่านบทบาท
function useWritableClasses(): PlateCopyVehicleClass[] | null {
  const [classes, setClasses] = useState<PlateCopyVehicleClass[] | null>(null);
  useEffect(() => {
    const scope = submitWriteScopeFor(getCachedUser()?.roles ?? []);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setClasses(scope === "ALL" ? ["CAR", "MOTO"] : scope === "CAR" || scope === "MOTO" ? [scope] : []);
  }, []);
  return classes;
}

// ปุ่มบันทึก/แก้ของงานหนึ่งงาน - ตามประเภทรถของงานนั้น (คนที่ถือบัญชี + ยื่นรถยนต์ เห็นงานมอเตอร์ไซค์ได้แต่แก้ไม่ได้)
const canWriteItem = (classes: PlateCopyVehicleClass[] | null, item: PlateCopy) => Boolean(classes?.includes(item.vehicleClass));

const plateText = (c: PlateCopy) => `${c.plateCategory} ${c.plateNumber}`;
const vehicleText = (c: PlateCopy) => `${c.brand} · เครื่อง ${c.engine} · ตัวถัง ${c.chassis}`;
// ประเภทรถของงาน (+ งานด่วน) - แสดงในทุกรายการ/การ์ด
const classText = (c: PlateCopy) => `${CLASS_LABEL[c.vehicleClass]}${c.urgent ? " · งานด่วน" : ""}`;
// รวม = Bill + No Bill - ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่นับในยอดรวม (ผู้ใช้ 2026-10-02)
const totalOf = (c: PlateCopy) => Number(c.billTotal) + Number(c.noBillTotal);

// เจ้าของงาน = ลูกค้าที่ส่งงานมา (คนละคนกับชื่อเจ้าของรถตามทะเบียน)
function CustomerCell({ item }: { item: PlateCopy }) {
  if (!item.customer) return <span className="muted">ยังไม่ระบุ</span>;
  return (
    <>
      <div className="job">{item.customer.company ?? item.customer.name}</div>
      {item.customer.company && <div className="sub">{item.customer.name}</div>}
    </>
  );
}

function Summary({ item }: { item: PlateCopy }) {
  return (
    <div style={{ padding: "10px 12px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 8, fontSize: 14 }}>
      <strong>{item.ownerName}</strong> · ทะเบียน {plateText(item)}
      <div className="muted">
        {classText(item)} · {vehicleText(item)}
      </div>
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
  vehicleClass: PlateCopyVehicleClass | ""; // "" = ยังไม่เลือก (เฉพาะฟอร์มยื่นของคนที่บันทึกได้ทั้งสองประเภท)
  customerId: string;
  ownerName: string;
  chassis: string;
  engine: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  copyType: PlateCopyType; // รถยนต์เท่านั้น - มอเตอร์ไซค์ส่ง SINGLE_NORMAL เสมอ
  urgent: boolean; // งานด่วน (ลงขันด่วนเพิ่มใน No Bill)
}

const COPY_TYPE_LABELS: Record<PlateCopyType, string> = {
  BOTH: "คัดคู่ (หน้า-หลัง) · เลขขาวดำปกติ",
  SINGLE_NORMAL: "คัดใบเดียว · เลขขาวดำปกติ",
  BOTH_AUCTION: "คัดคู่ (หน้า-หลัง) · ประมูล",
  SINGLE_AUCTION: "คัดใบเดียว · ประมูล",
};

const EMPTY_FORM: FormState = {
  vehicleClass: "",
  customerId: "",
  ownerName: "",
  chassis: "",
  engine: "",
  brand: "",
  plateCategory: "",
  plateNumber: "",
  copyType: "BOTH",
  urgent: false,
};

// ชนิดการคัดป้ายที่ส่งให้ backend - มอเตอร์ไซค์มีป้ายใบเดียว (backend ปฏิเสธชนิดอื่น)
const copyTypeOf = (form: FormState): PlateCopyType => (form.vehicleClass === "MOTO" ? PLATE_COPY_MOTO_TYPE : form.copyType);

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
  classOptions,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  // ประเภทรถที่เลือกได้ (ฟอร์มยื่น - ตามสิทธิ์บันทึกของผู้ใช้) / ไม่ส่ง = ป๊อปอัปแก้ ประเภทรถเปลี่ยนไม่ได้
  classOptions?: PlateCopyVehicleClass[];
  submitDateText: string;
  onSubmitDateChange: (text: string) => void;
  returnedDateText?: string;
  onReturnedDateChange?: (text: string) => void;
  brandNames: string[];
  customerOptions: Option[];
  customerPlaceholder?: string;
}) {
  const text = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => onChange({ [key]: e.target.value });
  const vehicleClass = form.vehicleClass;
  const fees = vehicleClass ? calculatePlateCopyFees(vehicleClass, form.copyType, form.urgent) : null;
  return (
    <>
      {/* ประเภทรถ: ฟอร์มยื่นเลือกได้เฉพาะที่ผู้ใช้บันทึกได้ (มีประเภทเดียว = ล็อกไว้) / ป๊อปอัปแก้เปลี่ยนไม่ได้ */}
      <label className="field" style={{ maxWidth: 420 }}>
        ประเภทรถ *
        {classOptions && classOptions.length > 1 ? (
          <select value={vehicleClass} onChange={(e) => onChange({ vehicleClass: e.target.value as PlateCopyVehicleClass | "" })}>
            <option value="">เลือกประเภทรถ</option>
            {classOptions.map((c) => (
              <option key={c} value={c}>
                {CLASS_LABEL[c]}
              </option>
            ))}
          </select>
        ) : (
          <input value={vehicleClass ? CLASS_LABEL[vehicleClass] : ""} readOnly disabled title={classOptions ? undefined : "ประเภทรถเปลี่ยนไม่ได้หลังบันทึก"} />
        )}
      </label>

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

      {/* มอเตอร์ไซค์มีป้ายใบเดียว - ไม่มีชนิดการคัดป้ายให้เลือก (ผู้ใช้ 2026-10-09) */}
      {vehicleClass !== "MOTO" && (
        <div className="customer-grid" style={{ marginTop: 14 }}>
          <label className="field">
            ชนิดการคัดป้าย *
            <select value={form.copyType} onChange={(e) => onChange({ copyType: e.target.value as PlateCopyType })}>
              {(Object.keys(COPY_TYPE_LABELS) as PlateCopyType[]).map((t) => (
                <option key={t} value={t}>
                  {COPY_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <h2 style={{ marginTop: 22 }}>ค่าใช้จ่าย</h2>
      {/* ค่าใช้จ่ายตายตัวตามประเภทรถ (รถยนต์ 2026-10-02 / มอเตอร์ไซค์ + งานด่วน 2026-10-09) - ไม่ต้องกรอก backend เก็บยอดตามอัตรานี้ตอนบันทึก */}
      {!vehicleClass || !fees ? (
        <p className="muted">เลือกประเภทรถก่อน ระบบจะแสดงค่าใช้จ่ายตามประเภทรถ</p>
      ) : (
        <>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <input type="checkbox" checked={form.urgent} onChange={(e) => onChange({ urgent: e.target.checked })} />
            งานด่วน (ลงขันด่วนเพิ่ม {formatBaht(plateCopyUrgentFee(vehicleClass))} ใน No Bill)
          </label>
          <div className="customer-grid">
            <div>
              <strong>Bill (ใบเสร็จ)</strong>
              <div>{formatBaht(fees.billTotal)} บาท</div>
              <div className="muted">
                คำขอ {formatBaht(PLATE_COPY_REQUEST_FEE)} + ค่าแผ่นป้าย {formatBaht(plateCopyPlateFee(copyTypeOf(form)))}
              </div>
            </div>
            <div>
              <strong>No Bill</strong>
              <div>{formatBaht(fees.noBillTotal)} บาท</div>
              <div className="muted">
                ลงขัน {formatBaht(plateCopyBaseNoBillFee(vehicleClass))}
                {form.urgent ? ` + ลงขันด่วนเพิ่ม ${formatBaht(plateCopyUrgentFee(vehicleClass))}` : ""}
              </div>
            </div>
            <div>
              <strong>ค่าอากร</strong>
              <div>{formatBaht(PLATE_COPY_DUTY_FEE)} บาท (แยกต่างหาก ไม่รวมใน No Bill)</div>
            </div>
            <div className="wide" style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
              <strong>รวม (Bill + No Bill)</strong>
              <span style={{ textAlign: "right" }}>
                <strong>{formatBaht(fees.billTotal + fees.noBillTotal)} บาท</strong>
                <div className="muted">แยกค่าอากร {formatBaht(PLATE_COPY_DUTY_FEE)} บาท</div>
              </span>
            </div>
          </div>
        </>
      )}
    </>
  );
}

// ตรวจฟอร์มฝั่งหน้าเว็บ (backend ตรวจซ้ำ) - คืนข้อความผิดพลาดข้อแรก หรือ "" ถ้าผ่าน
function validateForm(form: FormState, requireCustomer: boolean): string {
  if (!form.vehicleClass) return "กรุณาเลือกประเภทรถ (รถยนต์ / รถจักรยานยนต์)";
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
  item: PlateCopy;
  onClose: () => void;
  onSaved: (item: PlateCopy) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormState>({
    vehicleClass: item.vehicleClass,
    urgent: item.urgent,
    customerId: item.customer?.id ?? "",
    ownerName: item.ownerName,
    chassis: item.chassis,
    engine: item.engine,
    brand: item.brand,
    plateCategory: item.plateCategory,
    plateNumber: item.plateNumber,
    copyType: item.copyType ?? "BOTH",
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
      const { plateCopy } = await plateCopyApi.update(item.id, {
        ownerName: form.ownerName,
        engine: form.engine,
        chassis: form.chassis,
        brand: form.brand,
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        copyType: copyTypeOf(form),
        urgent: form.urgent, // เปลี่ยนติ๊กด่วน = backend คิด No Bill ใหม่
        // ส่งเฉพาะตอนเลือกไว้จริง - งานที่ไม่มีเจ้าของงานและไม่ได้เลือกในรอบนี้ ไม่ต้องแตะ
        ...(form.customerId ? { customerId: form.customerId } : {}),
        submitDate,
        ...(returnedDate ? { returnedDate } : {}),
        remark: remark.trim(),
        // ฟอร์มส่งทุกช่องจากตอนเปิด - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดค้างไว้ backend ตอบ 409 ไม่ทับของเขา
        expectedUpdatedAt: item.updatedAt,
      });
      onSaved(plateCopy);
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
      <h2>แก้งานคัดแผ่นป้ายทะเบียน</h2>
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

function CancelDialog({ item, onClose, onCancelled }: { item: PlateCopy; onClose: () => void; onCancelled: (id: string) => void }) {
  return (
    <ReasonDialog
      title="ยกเลิกงานคัดแผ่นป้ายทะเบียน"
      confirmLabel="ยืนยันยกเลิกงาน"
      placeholder="เช่น บันทึกซ้ำ / ลูกค้ายกเลิก"
      onClose={onClose}
      onConfirm={async (remark) => {
        await plateCopyApi.cancel(item.id, remark);
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

type RowDialog = { kind: "edit" | "cancel"; item: PlateCopy } | null;

export function PlateCopySubmitPage() {
  const writable = useWritableClasses();
  const canWrite = Boolean(writable?.length);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // บันทึกได้ประเภทเดียว = ใช้ประเภทนั้นเลย ไม่ต้องเลือก
  const classValue: PlateCopyVehicleClass | "" = form.vehicleClass || (writable?.length === 1 ? writable[0] : "");
  const liveForm: FormState = { ...form, vehicleClass: classValue };
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => textToIso(submitDateText), [submitDateText]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const { brandNames, customerOptions } = useChoices();

  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [items, setItems] = useState<PlateCopy[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dialog, setDialog] = useState<RowDialog>(null);

  async function load(forMonth: string) {
    setLoading(true);
    setListError("");
    try {
      setItems((await plateCopyApi.list("all", forMonth)).plateCopies);
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
  }, [month]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submitDate) return setMessage({ text: "กรุณากรอกวันที่ยื่นให้ถูกต้อง", error: true });
    const invalid = validateForm(liveForm, true);
    if (invalid || !classValue) return setMessage({ text: invalid, error: true });
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await plateCopyApi.create({
        vehicleClass: classValue,
        customerId: form.customerId,
        ownerName: form.ownerName,
        engine: form.engine,
        chassis: form.chassis,
        brand: form.brand,
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        copyType: copyTypeOf(liveForm),
        urgent: form.urgent,
        submitDate,
      });
      setMessage({ text: "บันทึกงานที่ยื่นแล้ว" });
      // เจ้าของงานคนเดิมมักส่งมาหลายคัน (ประเภทรถเดิม) - คงไว้ให้ / งานด่วนกลับเป็นไม่ติ๊ก กันติดไปคันถัดไป
      setForm((prev) => ({ ...EMPTY_FORM, customerId: prev.customerId, vehicleClass: prev.vehicleClass }));
      if (submitDate.slice(0, 7) === month) await load(month);
      else setMonth(submitDate.slice(0, 7));
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setSaving(false);
    }
  }

  const replace = (updated: PlateCopy) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  const totals = items.reduce(
    (acc, s) => ({ bill: acc.bill + Number(s.billTotal), noBill: acc.noBill + Number(s.noBillTotal), duty: acc.duty + Number(s.dutyAmount) }),
    { bill: 0, noBill: 0, duty: 0 },
  );

  return (
    <section className="content">
      <Link href={PLATE_COPY_HOME} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← คัดแผ่นป้ายทะเบียน
      </Link>
      <h1>ยื่นงานคัดแผ่นป้ายทะเบียน</h1>

      {canWrite && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <form className="customer-form" onSubmit={handleSubmit}>
            <VehicleFormFields
              form={liveForm}
              classOptions={writable ?? []}
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
                    <th>ประเภทรถ</th>
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
                      <td>
                        {CLASS_LABEL[item.vehicleClass]}
                        {item.urgent && <div className="sub">งานด่วน</div>}
                      </td>
                      <td>
                        {plateText(item)}
                        {item.vehicleClass === "CAR" && item.copyType !== "BOTH" && <div className="sub">{COPY_TYPE_LABELS[item.copyType]}</div>}
                      </td>
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
                          {canWriteItem(writable, item) && (
                            <RowActions onEdit={() => setDialog({ kind: "edit", item })} onCancel={() => setDialog({ kind: "cancel", item })} />
                          )}
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
function ReceiptFieldsCell({ item, canWrite, onChange }: { item: PlateCopy; canWrite: boolean; onChange: (item: PlateCopy) => void }) {
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
      const { plateCopy } = await plateCopyApi.updateReceiptFields(
        item.id,
        { receiptNo: receiptNo.trim(), receiptDate, receiptAmount: amount.trim() },
        needsRemark ? remark.trim() : undefined,
      );
      onChange(plateCopy);
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

type ReturnDialog = { kind: "edit" | "cancel" | "undo"; item: PlateCopy } | null;

export function PlateCopyReturnPage() {
  const writable = useWritableClasses();
  const canWrite = Boolean(writable?.length);
  const [status, setStatus] = useState<Exclude<PlateCopyStatusFilter, "all">>("pending");
  const [items, setItems] = useState<PlateCopy[]>([]);
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
      setItems((await plateCopyApi.list(forStatus)).plateCopies);
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
  }, [status]);

  const replace = (updated: PlateCopy) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  const drop = (id: string) => setItems((prev) => prev.filter((s) => s.id !== id));

  async function confirmReturn(item: PlateCopy) {
    if (!returnDate) return setMessage({ text: "กรุณากรอกวันที่รับเอกสารกลับให้ถูกต้อง", error: true });
    // พิมพ์ปีผิดเป็นอนาคตไม่ได้ (backend กันอีกชั้น)
    if (returnDate > todayIso()) return setMessage({ text: "วันที่รับเอกสารกลับต้องไม่เกินวันนี้", error: true });
    // ยืนยันก่อนเสมอ - กดผิดงาน/ผิดวันแล้วต้องยกเลิกรับกลับพร้อมเหตุผล
    const ok = window.confirm(`ยืนยันรับเอกสารกลับ?\n\nวันที่รับกลับ: ${isoToDisplayDate(returnDate)}\nรถ: ${item.ownerName} (ทะเบียน ${plateText(item)})`);
    if (!ok) return;
    try {
      await plateCopyApi.markReturned(item.id, returnDate);
      drop(item.id);
      setMessage({ text: `รับเอกสารกลับแล้ว: ${item.ownerName} (${plateText(item)})` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  return (
    <section className="content">
      <Link href={PLATE_COPY_HOME} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← คัดแผ่นป้ายทะเบียน
      </Link>
      <h1>รับใบเสร็จ (คัดแผ่นป้ายทะเบียน)</h1>
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
                  <th>ประเภทรถ</th>
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
                    showActions={canWrite}
                    canWrite={canWriteItem(writable, item)}
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
            await plateCopyApi.undoReturn(dialog.item.id, remark);
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
  showActions,
  canWrite,
  onChange,
  onConfirm,
  onMessage,
  onDialog,
}: {
  item: PlateCopy;
  showActions: boolean; // ตารางมีคอลัมน์ปุ่มแก้ (ผู้ใช้บันทึกได้อย่างน้อยหนึ่งประเภทรถ)
  canWrite: boolean; // บันทึกงานนี้ได้ (ตามประเภทรถของงาน)
  onChange: (item: PlateCopy) => void;
  onConfirm: (item: PlateCopy) => void;
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
        onChange((await plateCopyApi.addReceipt(item.id, image, compressedFileName(file), returned ? receiptRemark.trim() : undefined)).plateCopy);
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
      onChange((await plateCopyApi.removeReceipt(item.id, receiptId, returned ? receiptRemark.trim() : undefined)).plateCopy);
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
      <td>
        {CLASS_LABEL[item.vehicleClass]}
        {item.urgent && <div className="sub">งานด่วน</div>}
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
      {showActions && (
        <td>
          {canWrite && (
            <RowActions onEdit={() => onDialog("edit")} onCancel={() => onDialog("cancel")}>
              {returned && (
                <button type="button" className="text-button" style={dangerButton} onClick={() => onDialog("undo")}>
                  ยกเลิกรับกลับ
                </button>
              )}
            </RowActions>
          )}
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ารับป้าย (ผู้ใช้ 2026-10-02: คัดแผ่นป้ายต้องมีรับป้ายกลับมาด้วย และถ่ายรูปป้ายในการ์ดยืนยันรับป้าย)
// การ์ดละงาน: ถ่าย/เลือกรูปป้ายที่ได้รับ + วันที่รับ -> ดูตัวอย่างรูป -> กด "ยืนยันรับป้าย" จึงบันทึก (รูปจำเป็นเสมอ)
// ไม่ใช้ AI ไม่ผูกกับ returnedDate (แนบได้แม้ยังไม่รับใบเสร็จ) เหมือนรับป้ายงานสลับเลข
// ปกติป้ายออกภายใน 15 วันทำการนับจากวันที่ยื่น: การ์ดบอกวันที่คาดว่าจะได้ป้ายและเตือนเมื่อเกิน (ไม่ได้บังคับขั้นตอนใด)
// ---------------------------------------------------------------------------------------------

const daysBetweenIso = (fromIso: string, toIso: string) => Math.round((Date.parse(`${toIso}T00:00:00.000Z`) - Date.parse(`${fromIso}T00:00:00.000Z`)) / 86400000);

async function openPlatePhoto(plateCopyId: string) {
  const win = window.open("", "_blank");
  try {
    const objectUrl = URL.createObjectURL(await fetchAuthedBlob(plateCopyPlatePhotoImageUrl(plateCopyId)));
    if (win) win.location.href = objectUrl;
    else window.open(objectUrl, "_blank");
  } catch {
    win?.close();
    if (getToken()) window.alert("เปิดรูปไม่สำเร็จ กรุณาลองใหม่");
  }
}

function ReceivePlateCard({
  item,
  canWrite,
  onMessage,
  onDone,
}: {
  item: PlateCopy;
  canWrite: boolean;
  onMessage: (text: string, error?: boolean) => void;
  onDone: () => void;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const [editDateText, setEditDateText] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"date" | "detach" | null>(null);
  const received = Boolean(item.plateReceivedDate);

  const dueIso = plateCopyDueDate(item.submitDate);
  const overdueDays = !received ? daysBetweenIso(dueIso, todayIso()) : 0;

  // ตัวอย่างรูปที่เลือก - คืนหน่วยความจำของ object URL เมื่อเปลี่ยนรูป/ออกจากการ์ด
  useEffect(() => {
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- ล้างตัวอย่างเมื่อไม่มีรูปที่เลือก
      setPreviewUrl("");
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(files: FileList | null) {
    const picked = files?.[0];
    if (cameraRef.current) cameraRef.current.value = "";
    if (galleryRef.current) galleryRef.current.value = "";
    if (picked) setFile(picked);
  }

  async function confirm() {
    const date = textToIso(dateText);
    if (!date) return onMessage("กรุณากรอกวันที่รับป้ายให้ถูกต้อง", true);
    if (date > todayIso()) return onMessage("วันที่รับป้ายต้องไม่เกินวันนี้", true);
    if (!file) return onMessage("กรุณาถ่ายหรือเลือกรูปป้ายที่ได้รับก่อนยืนยัน", true);
    if (!window.confirm(`ยืนยันรับป้าย?\n\n${item.ownerName} · ทะเบียน ${plateText(item)}\nวันที่รับป้าย: ${isoToDisplayDate(date)}`)) return;
    setBusy(true);
    onMessage("");
    try {
      const image = await compressReceiptImage(file);
      await plateCopyApi.attachPlatePhoto(item.id, image, compressedFileName(file), date);
      setFile(null);
      onMessage(`รับป้ายแล้ว: ${item.ownerName} (${plateText(item)})`);
      onDone();
    } catch (err) {
      onMessage(errorText(err, "บันทึกรับป้ายไม่สำเร็จ"), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ padding: "16px 23px", borderTop: "1px solid #edf0f6" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="job">
            <strong>{item.ownerName}</strong> · ทะเบียน {plateText(item)}
          </div>
          <div className="sub">
            {classText(item)} · {vehicleText(item)}
          </div>
          <div className="sub">
            เจ้าของงาน: {item.customer ? (item.customer.company ?? item.customer.name) : "ยังไม่ระบุ"} · ยื่น {isoToDisplayDate(item.submitDate)}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {received ? (
            <span className="badge portal-badge-done">รับป้าย {isoToDisplayDate(item.plateReceivedDate!)}</span>
          ) : (
            <>
              <div className="sub">
                คาดว่าได้ป้ายภายใน {isoToDisplayDate(dueIso)} (ปกติ {PLATE_COPY_EXPECTED_DAYS} วันทำการ)
              </div>
              {overdueDays > 0 && (
                <span className="badge" style={{ background: "#fff1dc", color: "#9a5a00" }}>
                  ⚠ เกินกำหนด {overdueDays} วัน
                </span>
              )}
            </>
          )}
          <div className="sub">{item.returnedDate ? `ได้ใบเสร็จแล้ว ${isoToDisplayDate(item.returnedDate)}` : "ยังไม่ได้ใบเสร็จ"}</div>
        </div>
      </div>

      {received ? (
        <div style={{ marginTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
          {item.platePhotoId && (
            <button type="button" className="text-button" style={{ paddingLeft: 0 }} onClick={() => openPlatePhoto(item.id)}>
              📷 ดูรูปป้าย
            </button>
          )}
          {canWrite && (
            <>
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setEditDateText(isoToDisplayDate(item.plateReceivedDate!));
                  setDialog("date");
                }}
              >
                ✎ แก้วันที่
              </button>
              <button type="button" className="text-button" style={dangerButton} onClick={() => setDialog("detach")}>
                ถอดรูป
              </button>
            </>
          )}
        </div>
      ) : canWrite ? (
        <div style={{ marginTop: 12, padding: 14, border: "1px solid #dfe5f0", borderRadius: 10, background: "#f7f9ff" }}>
          <strong>ยืนยันรับป้าย</strong>
          <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "flex-start", marginTop: 10 }}>
            <div>
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element -- ตัวอย่างรูปจาก object URL ในเครื่อง ไม่ผ่าน next/image
                <img src={previewUrl} alt="ตัวอย่างรูปป้ายที่เลือก" style={{ width: 160, height: 120, objectFit: "cover", borderRadius: 8, border: "1px solid #dfe5f0" }} />
              ) : (
                <div className="muted" style={{ width: 160, height: 120, display: "grid", placeItems: "center", border: "1px dashed #b9c3d6", borderRadius: 8 }}>
                  ยังไม่มีรูปป้าย
                </div>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {/* capture = เปิดกล้องหลังบนมือถือทันที / ปุ่มเลือกรูปใช้เลือกจากแกลเลอรีหรือไฟล์ในเครื่อง */}
              <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files)} />
              <input ref={galleryRef} type="file" accept="image/*" hidden onChange={(e) => pick(e.target.files)} />
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button type="button" disabled={busy} onClick={() => cameraRef.current?.click()}>
                  📷 ถ่ายรูปป้าย
                </button>
                <button type="button" disabled={busy} onClick={() => galleryRef.current?.click()}>
                  🖼 เลือกรูป
                </button>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
                วันที่รับป้าย
                <DateTextInput value={dateText} onChange={setDateText} label="วันที่รับป้าย" />
              </label>
              <button type="button" className="primary" disabled={busy || !file} title={!file ? "ถ่ายหรือเลือกรูปป้ายก่อน" : undefined} onClick={confirm}>
                {busy ? "กำลังบันทึก…" : "ยืนยันรับป้าย"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="muted" style={{ marginTop: 8 }}>
          รอรับป้าย
        </div>
      )}

      {dialog === "date" && (
        <ReasonDialog
          title="แก้วันที่รับป้าย"
          confirmLabel="บันทึก"
          placeholder="เช่น พิมพ์วันผิด"
          onClose={() => setDialog(null)}
          onConfirm={async (remark) => {
            const date = textToIso(editDateText);
            if (!date) throw new Error("กรุณากรอกวันที่ให้ถูกต้อง");
            await plateCopyApi.updatePlateReceivedDate(item.id, date, remark);
            onDone();
          }}
        >
          <Summary item={item} />
          <label className="field" style={{ marginTop: 12 }}>
            วันที่รับป้ายใหม่ *
            <DateTextInput value={editDateText} onChange={setEditDateText} label="วันที่รับป้าย" />
          </label>
        </ReasonDialog>
      )}
      {dialog === "detach" && (
        <ReasonDialog
          title="ถอดรูปป้ายที่แนบผิด"
          confirmLabel="ยืนยันถอดรูป"
          placeholder="เช่น แนบผิดคัน"
          onClose={() => setDialog(null)}
          onConfirm={async (remark) => {
            await plateCopyApi.detachPlatePhoto(item.id, remark);
            onDone();
          }}
        >
          <Summary item={item} />
          <p style={{ marginTop: 12 }}>งานนี้จะกลับไปรอรับป้ายอีกครั้ง</p>
        </ReasonDialog>
      )}
    </div>
  );
}

export function PlateCopyReceivePlatePage() {
  const writable = useWritableClasses();
  const [status, setStatus] = useState<"pending" | "received">("pending");
  const [items, setItems] = useState<PlateCopy[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });

  async function load(forStatus: typeof status) {
    setLoading(true);
    setListError("");
    try {
      setItems((await plateCopyApi.plateQueue(forStatus)).plateCopies);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load อ่านแท็บที่อยู่ใน deps แล้ว
  }, [status]);

  return (
    <section className="content">
      <Link href={PLATE_COPY_HOME} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← คัดแผ่นป้ายทะเบียน
      </Link>
      <h1>รับป้าย (คัดแผ่นป้ายทะเบียน)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        ถ่ายหรือเลือกรูปป้ายที่ได้รับ ใส่วันที่รับ แล้วกดยืนยันรับป้ายในการ์ดของงานนั้น (ไม่ต้องรอรับใบเสร็จก่อน) ปกติป้ายออกภายใน {PLATE_COPY_EXPECTED_DAYS} วัน
      </p>

      <div className="panel">
        <div className="panel-head">
          <div className="inspect-filter" style={{ padding: 0 }}>
            <button type="button" className={`filter-chip${status === "pending" ? " selected" : ""}`} onClick={() => setStatus("pending")}>
              รอรับป้าย
            </button>
            <button type="button" className={`filter-chip${status === "received" ? " selected" : ""}`} onClick={() => setStatus("received")}>
              รับป้ายแล้ว
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
        ) : items.length === 0 ? (
          <div className="empty-customers">{status === "pending" ? "ไม่มีงานที่รอรับป้าย" : "ยังไม่มีงานที่รับป้ายแล้ว"}</div>
        ) : (
          items.map((item) => (
            <ReceivePlateCard key={item.id} item={item} canWrite={canWriteItem(writable, item)} onMessage={(text, error) => setMessage({ text, error })} onDone={() => load(status)} />
          ))
        )}
      </div>
    </section>
  );
}
