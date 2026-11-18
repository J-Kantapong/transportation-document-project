"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { getCachedUser, submitWriteScopeFor } from "@/lib/auth";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { formatBaht, type FeeItem } from "@/lib/plate-swap-fee";
import {
  calculateTransferCarNoBill,
  calculateTransferMotoFees,
  calculateTransferMoveInFees,
  defaultTransferContribution,
  TRANSFER_CAR_URGENT_ITEM,
  TRANSFER_DEFAULT_PROVINCE,
  TRANSFER_MOTO_URGENT_ITEM,
  TRANSFER_MOVE_IN_CONTRIBUTION,
  transferUrgentAmount,
  type TransferContributionRow,
} from "@/lib/vehicle-transfer-fee";
import { transferContributionRatesApi } from "@/lib/transfer-contribution-rates-api";
import { vehicleMoveOutApi, type VehicleMoveOut } from "@/lib/vehicle-move-out-api";
import { PROVINCES } from "@/lib/vehicle-reference-data";
import { compressedFileName, compressReceiptImage } from "@/lib/receipt-image";
import {
  TRANSFER_TYPE_LABEL,
  transferHasInspection,
  transferHome,
  vehicleTransferApi,
  type InspectionResult,
  type TransferStatusFilter,
  type TransferType,
  type TransferVehicleClass,
  type VehicleTransfer,
} from "@/lib/vehicle-transfer-api";
import { DateTextInput, dangerButton, errorText, openReceiptImage, ReasonDialog, textToIso } from "@/components/PlateSwapPages";
import { confirmDialog } from "@/lib/confirm-dialog";

// งานโอน (งานหลัก, ผู้ใช้ 2026-10-02) - หน้าตาเหมือนยกเลิกการใช้รถ กรอกข้อมูลรถเอง รถยนต์ + มอเตอร์ไซค์รวมกันในหน้าเดียว (เลือกประเภทรถในฟอร์ม)
// 2 แบบ: โอนตามผู้ถือกรรมสิทธิ์ (ยื่น -> รับใบเสร็จ) / โอนตรวจรถ (ยื่น -> ตรวจรถ -> รับใบเสร็จ) - ตรวจรถแยกจากคิวตรวจรถของรถจดใหม่
// ทุกงานมีผู้โอน + ผู้รับโอน และ Bill / No Bill: มอเตอร์ไซค์คิดตามอัตราของผู้ใช้ (เลือก โอนปกติ/โอนขอใช้ + ด่วน + ค่าปรับ)
// รถยนต์: No Bill คิดเอง (ลงขัน 100 + ด่วน 100) / Bill ยังไม่มีอัตรา กรอกเอง
// แก้/ยกเลิก: ต้องระบุเหตุผลเสมอ (เก็บประวัติ) - ไม่มีการลบงาน งานที่ยกเลิกหายจากรายการแต่ยังอยู่ในฐานข้อมูล
// แบบที่ 3 โอนย้ายเข้า (MOVE_IN ผู้ใช้ 2026-11-18): เฉพาะมอเตอร์ไซค์ ขั้นตอนเหมือนโอนตรวจรถ - ดึงข้อมูลรถจากงานย้ายออกที่รับใบเสร็จแล้วได้
//   จังหวัดที่ยื่น = จังหวัดที่ย้ายเข้า (ต้องเลือกเอง) · Bill 225 + ค่าปรับ + ค่าอากรโอนตามราคารถ (กรอกที่ข้อมูลใบเสร็จ) · ค่าอากร 40 · ลงขันตั้งต้น 0
//   ยืนยันรับกลับต้องกรอกทะเบียนใหม่ของจังหวัดที่ย้ายเข้า

const CLASS_LABEL: Record<TransferVehicleClass, string> = { CAR: "รถยนต์", MOTO: "รถจักรยานยนต์" };

// ประเภทรถที่บันทึกได้ = ตามบทบาท (STAFF_CAR = รถยนต์, STAFF_MOTO = มอเตอร์ไซค์, ADMIN/ถือทั้งคู่ = ทั้งสอง) - backend กันอีกชั้น
// บัญชี (ACCOUNTANT) อ่านอย่างเดียว จึงว่าง = ซ่อนฟอร์ม/ปุ่มบันทึก / null = ยังไม่อ่านบทบาท
function useWritableClasses(): TransferVehicleClass[] | null {
  const [classes, setClasses] = useState<TransferVehicleClass[] | null>(null);
  useEffect(() => {
    const scope = submitWriteScopeFor(getCachedUser()?.roles ?? []);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setClasses(scope === "ALL" ? ["CAR", "MOTO"] : scope === "CAR" || scope === "MOTO" ? [scope] : []);
  }, []);
  return classes;
}

const canWriteItem = (classes: TransferVehicleClass[] | null, item: VehicleTransfer) => Boolean(classes?.includes(item.vehicleClass));

const moneyOnly = (text: string) => text.replace(/[^0-9.]/g, "");
// รวม = Bill + No Bill - ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่นับในยอดรวม แสดงอีกคอลัมน์ (ผู้ใช้ 2026-10-02)
const totalOf = (c: VehicleTransfer) => Number(c.billTotal) + Number(c.noBillTotal);
const plateText = (c: VehicleTransfer) => `${c.plateCategory} ${c.plateNumber}`;
const isMoveIn = (transferType: TransferType) => transferType === "MOVE_IN";

// ทะเบียนเดิม + ทะเบียนใหม่ของจังหวัดที่ย้ายเข้า (โอนย้ายเข้าที่รับใบเสร็จแล้ว)
function PlateCell({ item }: { item: VehicleTransfer }) {
  return (
    <>
      {plateText(item)}
      {item.newPlateCategory && item.newPlateNumber && (
        <div className="sub">
          ใหม่ {item.newPlateCategory} {item.newPlateNumber} {item.submitProvince ?? ""}
        </div>
      )}
    </>
  );
}
const vehicleText = (c: VehicleTransfer) => `${c.brand} · ตัวถัง ${c.chassis} · เครื่อง ${c.engine}`;

// เจ้าของงาน = ลูกค้าที่ส่งงานมา (คนละคนกับผู้ถือกรรมสิทธิ์/ผู้รับโอน)
function CustomerCell({ item }: { item: VehicleTransfer }) {
  if (!item.customer) return <span className="muted">ยังไม่ระบุ</span>;
  return (
    <>
      <div className="job">{item.customer.company ?? item.customer.name}</div>
      {item.customer.company && <div className="sub">{item.customer.name}</div>}
    </>
  );
}

function PartiesCell({ item }: { item: VehicleTransfer }) {
  return (
    <>
      <div className="job">
        {item.transferorName} → {item.transfereeName}
      </div>
      <div className="sub">{vehicleText(item)}</div>
    </>
  );
}

function Summary({ item }: { item: VehicleTransfer }) {
  return (
    <div style={{ padding: "10px 12px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 8, fontSize: 14 }}>
      <strong>
        {item.transferorName} → {item.transfereeName}
      </strong>{" "}
      · ทะเบียน {plateText(item)}
      <div className="muted">{vehicleText(item)}</div>
    </div>
  );
}

// สถานะของงานตามแบบงาน - โอนตรวจรถบอกขั้นตรวจรถด้วย
function StatusBadge({ item }: { item: VehicleTransfer }) {
  if (item.returnedDate) return <span className="badge portal-badge-done">รับกลับ {isoToDisplayDate(item.returnedDate)}</span>;
  if (transferHasInspection(item.transferType)) {
    if (!item.inspectionSentDate) return <span className="badge">รอส่งตรวจ</span>;
    if (!item.inspectionResult) return <span className="badge">ส่งตรวจ {isoToDisplayDate(item.inspectionSentDate)} · รอผล</span>;
    if (item.inspectionResult === "FAIL") return <span className="badge" style={{ color: "#b43434" }}>ตรวจไม่ผ่าน</span>;
  }
  return <span className="badge">รอรับเอกสารกลับ</span>;
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
  vehicleClass: TransferVehicleClass | "";
  customerId: string;
  transferorName: string;
  transfereeName: string;
  chassis: string;
  engine: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  billTotal: string; // รถยนต์ - Bill กรอกเอง
  useRequest: boolean; // มอเตอร์ไซค์ - โอนขอใช้ (false = โอนปกติ)
  urgent: boolean; // งานด่วน (ทั้งสองประเภทรถ)
  submitProvince: string; // จังหวัดที่ยื่น (ผู้ใช้ 2026-11-18)
  contribution: string | null; // ลงขัน - null = ยังไม่แก้ ใช้อัตราตั้งต้นของจังหวัด (ดู contributionText)
  fineAmount: string; // มอเตอร์ไซค์ - ค่าปรับ
}

const EMPTY_FORM: FormState = {
  vehicleClass: "",
  customerId: "",
  transferorName: "",
  transfereeName: "",
  chassis: "",
  engine: "",
  brand: "",
  plateCategory: "",
  plateNumber: "",
  billTotal: "",
  useRequest: false,
  urgent: false,
  submitProvince: TRANSFER_DEFAULT_PROVINCE,
  contribution: null,
  fineAmount: "",
};

type Option = { id: string; label: string };

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

// ค่าใช้จ่ายในฟอร์ม: มอเตอร์ไซค์เลือกประเภท (โอนปกติ/โอนขอใช้) ค่าอากรออโต้ตามประเภท + ติ๊กด่วน + กรอกค่าปรับ (ถ้าเกิน 15 วันหลังออกใบเสร็จ/ใบกำกับภาษี)
// รถยนต์: No Bill คิดเอง / Bill ยังไม่มีอัตรา กรอกเอง (ผู้ใช้ 2026-10-02) / ยอดที่บันทึกจริงคิดที่ backend
function FeeLines({ title, items, total }: { title: string; items: FeeItem[]; total: number }) {
  return (
    <div style={{ padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
      <strong>{title}</strong>
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14, marginTop: 4 }}>
          <span>{item.label}</span>
          <span>{formatBaht(item.amount)}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, marginTop: 8, paddingTop: 6, borderTop: "1px solid #dfe5f0" }}>
        <strong>รวม {title}</strong>
        <strong>{formatBaht(total)} บาท</strong>
      </div>
    </div>
  );
}

// ตารางลงขันรายจังหวัด (ผู้ใช้ 2026-11-18) - โหลดครั้งเดียวต่อหน้า ระหว่างโหลด/โหลดไม่ได้ = [] (ช่องลงขันว่าง backend เติมอัตราของตารางให้เอง)
function useContributionRates(): TransferContributionRow[] {
  const [rates, setRates] = useState<TransferContributionRow[]>([]);
  useEffect(() => {
    transferContributionRatesApi
      .list()
      .then((data) => setRates(data.rates))
      .catch(() => undefined);
  }, []);
  return rates;
}

// ลงขันที่แสดง/ส่ง: ที่พนักงานแก้ไว้ หรืออัตราตั้งต้นของจังหวัดจากตาราง - จังหวัดที่ยังไม่ได้ตั้งอัตรา = ว่าง ต้องกรอกเอง (0 ได้)
// โอนย้ายเข้า: จังหวัดที่ยังไม่ได้ตั้ง = 0 (ผู้ใช้ไปทำเอง ยังไม่มีอัตรา) แก้ได้
function contributionText(form: FormState, rates: TransferContributionRow[], moveIn = false): string {
  if (form.contribution !== null) return form.contribution;
  if (!form.vehicleClass) return moveIn ? String(TRANSFER_MOVE_IN_CONTRIBUTION) : "";
  const fallback = defaultTransferContribution(rates, form.vehicleClass, form.submitProvince, moveIn);
  if (fallback === null) return moveIn ? String(TRANSFER_MOVE_IN_CONTRIBUTION) : "";
  return String(fallback);
}

// จังหวัดที่ยื่น + ลงขัน (ผู้ใช้ 2026-11-18: แต่ละจังหวัดราคาไม่เท่ากัน บางทีไม่เสีย) - เปลี่ยนจังหวัด = เติมอัตราตั้งต้นใหม่
function ProvinceContributionFields({
  form,
  onChange,
  rates,
  moveIn = false,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  rates: TransferContributionRow[];
  moveIn?: boolean;
}) {
  const noRate = !moveIn && !!form.vehicleClass && defaultTransferContribution(rates, form.vehicleClass, form.submitProvince) === null;
  return (
    <>
      <label className="field" style={{ minWidth: 200 }}>
        {moveIn ? "จังหวัดที่ย้ายเข้า *" : "จังหวัดที่ยื่น *"}
        {/* เปลี่ยนจังหวัด = เติมอัตราตั้งต้นของจังหวัดใหม่จากตาราง */}
        <select value={form.submitProvince} onChange={(e) => onChange({ submitProvince: e.target.value, contribution: null })}>
          {moveIn && <option value="">เลือกจังหวัด</option>}
          {PROVINCES.map((province) => (
            <option key={province} value={province}>
              {province}
            </option>
          ))}
        </select>
      </label>
      <label className="field" style={{ minWidth: 200 }}>
        ลงขัน (บาท) *
        <input
          value={contributionText(form, rates, moveIn)}
          onChange={(e) => onChange({ contribution: moneyOnly(e.target.value) })}
          inputMode="decimal"
          placeholder={noRate ? "กรอกเอง - ไม่เสียใส่ 0" : "0"}
        />
      </label>
    </>
  );
}

// โอนย้ายเข้า: Bill ตายตัว 225 + ค่าปรับ + ค่าอากรโอน (stampDuty - กรอกที่ข้อมูลใบเสร็จ แสดงที่นี่เมื่อมีแล้ว) / ค่าอากรแยก 40 / ลงขันตั้งต้น 0
function MoveInFeeSection({
  form,
  onChange,
  stampDuty,
  rates,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  stampDuty: number;
  rates: TransferContributionRow[];
}) {
  const fees = calculateTransferMoveInFees({ urgent: form.urgent, fine: Number(form.fineAmount) || 0, stampDuty, contribution: Number(contributionText(form, rates, true)) || 0 });
  return (
    <>
      <h2 style={{ marginTop: 22 }}>ค่าใช้จ่าย</h2>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <ProvinceContributionFields form={form} onChange={onChange} rates={rates} moveIn />
        <label className="field" style={{ minWidth: 200 }}>
          ค่าปรับ (บาท)
          <input value={form.fineAmount} onChange={(e) => onChange({ fineAmount: moneyOnly(e.target.value) })} inputMode="decimal" placeholder="ไม่มีเว้นว่าง" />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 10 }}>
          <input type="checkbox" checked={form.urgent} onChange={(e) => onChange({ urgent: e.target.checked })} />
          งานด่วน (+{formatBaht(TRANSFER_MOTO_URGENT_ITEM.amount)} ใน No Bill)
        </label>
      </div>
      <p className="muted" style={{ margin: "6px 0 12px" }}>
        ค่าปรับใส่เมื่อโอนเกิน 15 วันหลังออกใบกำกับภาษี · ลงขันเติมตามตารางลงขันรายจังหวัด (จังหวัดที่ยังไม่ได้ตั้ง = 0 แก้ได้) · ค่าอากรโอนตามราคารถรู้เมื่อใบเสร็จออก - กรอกที่หน้ารับใบเสร็จ ระบบบวกเข้า Bill ให้
      </p>
      <div className="customer-grid">
        <FeeLines title="Bill" items={fees.billItems} total={fees.billTotal} />
        <FeeLines title="No Bill" items={fees.noBillItems} total={fees.noBillTotal} />
        <div style={{ padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
          <strong>{fees.dutyItem.label}</strong>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14, marginTop: 4 }}>
            <span>โอนย้ายเข้า (แยกต่างหาก ไม่รวมใน No Bill)</span>
            <strong>{formatBaht(fees.dutyItem.amount)} บาท</strong>
          </div>
        </div>
        <div className="wide" style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
          <strong>รวม (Bill + No Bill)</strong>
          <span style={{ textAlign: "right" }}>
            <strong>{formatBaht(fees.total)} บาท</strong>
            <div className="muted">แยกค่าอากร {formatBaht(fees.dutyTotal)} บาท (ไม่รวมใน No Bill)</div>
          </span>
        </div>
      </div>
    </>
  );
}

function FeeSection({
  form,
  onChange,
  rates,
  moveIn = false,
  stampDuty = 0,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  rates: TransferContributionRow[];
  moveIn?: boolean;
  stampDuty?: number;
}) {
  if (moveIn) return <MoveInFeeSection form={form} onChange={onChange} stampDuty={stampDuty} rates={rates} />;
  if (!form.vehicleClass) {
    return (
      <>
        <h2 style={{ marginTop: 22 }}>ค่าใช้จ่าย</h2>
        <p className="muted">เลือกประเภทรถก่อน ระบบจะคิด Bill / No Bill ให้</p>
      </>
    );
  }
  if (form.vehicleClass === "CAR") {
    const carNoBill = calculateTransferCarNoBill({ urgent: form.urgent, contribution: Number(contributionText(form, rates)) || 0 });
    const bill = Number(form.billTotal) || 0;
    return (
      <>
        <h2 style={{ marginTop: 22 }}>ค่าใช้จ่าย</h2>
        {/* รถยนต์: No Bill = ลงขันตามจังหวัดที่ยื่น + ด่วน 100 / Bill ยังไม่มีอัตรา กรอกเอง (ผู้ใช้ 2026-10-02) */}
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label className="field" style={{ minWidth: 200 }}>
            Bill (บาท) *
            <input value={form.billTotal} onChange={(e) => onChange({ billTotal: moneyOnly(e.target.value) })} inputMode="decimal" placeholder="0" />
          </label>
          <ProvinceContributionFields form={form} onChange={onChange} rates={rates} />
          <label style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 10 }}>
            <input type="checkbox" checked={form.urgent} onChange={(e) => onChange({ urgent: e.target.checked })} />
            งานด่วน (+{formatBaht(TRANSFER_CAR_URGENT_ITEM.amount)} ใน No Bill)
          </label>
        </div>
        <p className="muted" style={{ margin: "6px 0 12px" }}>
          รถยนต์ยังไม่มีอัตรา Bill - กรอกเอง (ไม่มีให้ใส่ 0) · ลงขันระบบเติมให้ตามจังหวัดที่ยื่น แก้ได้ จังหวัดที่ยังไม่มีอัตราให้กรอกเอง (ไม่เสียใส่ 0)
        </p>
        <div className="customer-grid">
          <FeeLines title="No Bill" items={carNoBill.noBillItems} total={carNoBill.noBillTotal} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
            <strong>รวม (Bill + No Bill)</strong>
            <strong>{formatBaht(bill + carNoBill.noBillTotal)} บาท</strong>
          </div>
        </div>
      </>
    );
  }
  const fees = calculateTransferMotoFees({ useRequest: form.useRequest, urgent: form.urgent, fine: Number(form.fineAmount) || 0, contribution: Number(contributionText(form, rates)) || 0 });
  return (
    <>
      <h2 style={{ marginTop: 22 }}>ค่าใช้จ่าย</h2>
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label className="field" style={{ minWidth: 200 }}>
          ประเภทโอน *
          <select value={form.useRequest ? "USE_REQUEST" : "NORMAL"} onChange={(e) => onChange({ useRequest: e.target.value === "USE_REQUEST" })}>
            <option value="NORMAL">โอนปกติ</option>
            <option value="USE_REQUEST">โอนขอใช้</option>
          </select>
        </label>
        <label className="field" style={{ minWidth: 200 }}>
          ค่าปรับ (บาท)
          <input value={form.fineAmount} onChange={(e) => onChange({ fineAmount: moneyOnly(e.target.value) })} inputMode="decimal" placeholder="ไม่มีเว้นว่าง" />
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 10 }}>
          <input type="checkbox" checked={form.urgent} onChange={(e) => onChange({ urgent: e.target.checked })} />
          งานด่วน (+{formatBaht(TRANSFER_MOTO_URGENT_ITEM.amount)} ใน No Bill)
        </label>
        <ProvinceContributionFields form={form} onChange={onChange} rates={rates} />
      </div>
      <p className="muted" style={{ margin: "6px 0 12px" }}>
        ค่าปรับใส่เมื่อเกิน 15 วันหลังออกใบเสร็จรับเงิน/ใบกำกับภาษี (ทั้งโอนปกติและโอนขอใช้) - ค่าอากรแยกต่างหากและออโต้ตามประเภทที่เลือก · ลงขันระบบเติมให้ตามจังหวัดที่ยื่น แก้ได้ จังหวัดที่ยังไม่มีอัตราให้กรอกเอง (ไม่เสียใส่ 0)
      </p>
      <div className="customer-grid">
        <FeeLines title="Bill" items={fees.billItems} total={fees.billTotal} />
        <FeeLines title="No Bill" items={fees.noBillItems} total={fees.noBillTotal} />
        <div style={{ padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
          <strong>{fees.dutyItem.label}</strong>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14, marginTop: 4 }}>
            <span>{form.useRequest ? "โอนขอใช้" : "โอนปกติ"} (แยกต่างหาก ไม่รวมใน No Bill)</span>
            <strong>{formatBaht(fees.dutyItem.amount)} บาท</strong>
          </div>
        </div>
        <div className="wide" style={{ display: "flex", justifyContent: "space-between", padding: "12px 16px", background: "#f7f9ff", border: "1px solid #dfe5f0", borderRadius: 10 }}>
          <strong>รวม (Bill + No Bill)</strong>
          <span style={{ textAlign: "right" }}>
            <strong>{formatBaht(fees.total)} บาท</strong>
            <div className="muted">แยกค่าอากร {formatBaht(fees.dutyTotal)} บาท (ไม่รวมใน No Bill)</div>
          </span>
        </div>
      </div>
    </>
  );
}

// ค่าใช้จ่ายที่ส่ง backend: มอเตอร์ไซค์ส่งตัวเลือก (backend คิดยอด) / รถยนต์ส่ง Bill ที่กรอก + ติ๊กด่วน / ทั้งคู่ส่งจังหวัดที่ยื่น + ลงขัน (backend รวม No Bill)
function feePayload(form: FormState, rates: TransferContributionRow[], moveIn = false) {
  const province = { submitProvince: form.submitProvince, contribution: contributionText(form, rates, moveIn) };
  // โอนย้ายเข้าไม่มีโอนขอใช้
  if (moveIn) return { urgent: form.urgent, fineAmount: form.fineAmount, ...province };
  return form.vehicleClass === "MOTO"
    ? { useRequest: form.useRequest, urgent: form.urgent, fineAmount: form.fineAmount, ...province }
    : { billTotal: form.billTotal, urgent: form.urgent, ...province };
}

function VehicleFormFields({
  form,
  onChange,
  classOptions,
  submitDateText,
  onSubmitDateChange,
  returnedDateText,
  onReturnedDateChange,
  brandNames,
  customerOptions,
  customerPlaceholder = "เลือกลูกค้า",
  moveIn = false,
  stampDuty = 0,
  rates,
  children,
}: {
  rates: TransferContributionRow[]; // ตารางลงขันรายจังหวัด
  moveIn?: boolean;
  stampDuty?: number;
  children?: React.ReactNode; // ช่องเพิ่มท้ายข้อมูลรถ (ทะเบียนใหม่ของโอนย้ายเข้าในป๊อปอัปแก้)
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  classOptions: TransferVehicleClass[];
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
      {/* เจ้าของงาน = ลูกค้าที่ส่งงานมาให้เรา ไว้ส่งงาน/วางบิลให้ถูกเจ้าของ - ไม่ใช่ผู้โอน/ผู้รับโอน (ช่องข้างล่าง) */}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
        <label className="field" style={{ minWidth: 280, maxWidth: 420, flex: 1 }}>
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
        {/* รถยนต์/มอเตอร์ไซค์รวมกันในหน้าเดียว (ผู้ใช้ 2026-10-02) - ราคาต่างกันจึงต้องระบุประเภทรถทุกงาน */}
        <label className="field" style={{ minWidth: 200 }}>
          ประเภทรถ *
          <select value={form.vehicleClass} onChange={(e) => onChange({ vehicleClass: e.target.value as TransferVehicleClass | "", contribution: null })}>
            <option value="">เลือกประเภทรถ</option>
            {classOptions.map((c) => (
              <option key={c} value={c}>
                {CLASS_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h2 style={{ marginTop: 22 }}>ผู้โอน / ผู้รับโอน</h2>
      <div className="customer-grid">
        <label className="field">
          ผู้โอน *
          <input value={form.transferorName} onChange={text("transferorName")} />
        </label>
        <label className="field">
          ผู้รับโอน *
          <input value={form.transfereeName} onChange={text("transfereeName")} />
        </label>
      </div>

      <h2 style={{ marginTop: 22 }}>ข้อมูลรถ</h2>
      {/* ลำดับช่อง (ผู้ใช้ 2026-10-02): วันที่ยื่น -> ยี่ห้อ -> เลขตัวถัง -> เลขเครื่อง -> ทะเบียน */}
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
        <label className="field">
          เลขตัวถัง *
          <input value={form.chassis} onChange={text("chassis")} />
        </label>
        <label className="field">
          เลขเครื่อง *
          <input value={form.engine} onChange={text("engine")} />
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
        {children}
      </div>

      <FeeSection form={form} onChange={onChange} rates={rates} moveIn={moveIn} stampDuty={stampDuty} />
    </>
  );
}

// ตรวจฟอร์มฝั่งหน้าเว็บ (backend ตรวจซ้ำ) - คืนข้อความผิดพลาดข้อแรก หรือ "" ถ้าผ่าน
function validateForm(form: FormState, requireCustomer: boolean, moveIn = false): string {
  if (!form.vehicleClass) return "กรุณาเลือกประเภทรถ (รถยนต์ / รถจักรยานยนต์)";
  if (moveIn && form.vehicleClass !== "MOTO") return "โอนย้ายเข้ามีอัตราเฉพาะรถจักรยานยนต์";
  if (moveIn && !form.submitProvince) return "กรุณาเลือกจังหวัดที่ย้ายเข้า";
  if (requireCustomer && !form.customerId) return "กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)";
  if (!form.transferorName.trim()) return "กรุณากรอกผู้โอน";
  if (!form.transfereeName.trim()) return "กรุณากรอกผู้รับโอน";
  if (!form.brand) return "กรุณาเลือกยี่ห้อ";
  if (!form.chassis.trim()) return "กรุณากรอกเลขตัวถัง";
  if (!form.engine.trim()) return "กรุณากรอกเลขเครื่อง";
  if (!form.plateCategory.trim() || !form.plateNumber.trim()) return "กรุณากรอกทะเบียน (หมวดทะเบียนและเลขทะเบียน)";
  if (form.vehicleClass === "MOTO") {
    if (form.fineAmount.trim() && Number.isNaN(Number(form.fineAmount))) return "ค่าปรับไม่ถูกต้อง";
  } else {
    if (!form.billTotal.trim() || Number.isNaN(Number(form.billTotal))) return "กรุณากรอก Bill (ไม่มีให้ใส่ 0)";
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// ป๊อปอัปแก้ / ยกเลิกงาน
// ---------------------------------------------------------------------------------------------

function EditDialog({
  item,
  classOptions,
  onClose,
  onSaved,
}: {
  item: VehicleTransfer;
  classOptions: TransferVehicleClass[];
  onClose: () => void;
  onSaved: (item: VehicleTransfer) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [form, setForm] = useState<FormState>({
    vehicleClass: item.vehicleClass,
    customerId: item.customer?.id ?? "",
    transferorName: item.transferorName,
    transfereeName: item.transfereeName,
    chassis: item.chassis,
    engine: item.engine,
    brand: item.brand,
    plateCategory: item.plateCategory,
    plateNumber: item.plateNumber,
    billTotal: String(Number(item.billTotal)),
    useRequest: item.useRequest,
    urgent: item.urgent,
    // งานก่อนมีช่องจังหวัด (null) แสดงเป็นกรุงเทพมหานคร · ลงขันเดิม = No Bill หักด่วนเพิ่ม (คงยอดเดิมไว้จนกว่าจะแก้)
    submitProvince: item.submitProvince ?? TRANSFER_DEFAULT_PROVINCE,
    contribution: String(Math.max(0, Number(item.noBillTotal) - transferUrgentAmount(item.vehicleClass, item.urgent))),
    fineAmount: Number(item.fineAmount) > 0 ? String(Number(item.fineAmount)) : "",
  });
  const moveIn = isMoveIn(item.transferType);
  // ทะเบียนใหม่ของโอนย้ายเข้า - แก้ได้เมื่อรับกลับแล้ว (ก่อนนั้นกรอกตอนยืนยันรับกลับ)
  const editNewPlate = moveIn && Boolean(item.returnedDate);
  const [newPlateCategory, setNewPlateCategory] = useState(item.newPlateCategory ?? "");
  const [newPlateNumber, setNewPlateNumber] = useState(item.newPlateNumber ?? "");
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(item.submitDate));
  const [returnedDateText, setReturnedDateText] = useState(() => (item.returnedDate ? isoToDisplayDate(item.returnedDate) : ""));
  const [remark, setRemark] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { brandNames, customerOptions } = useChoices(item.brand);
  const rates = useContributionRates();

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
    const invalid = validateForm(form, false, moveIn);
    if (invalid) return setError(invalid);
    if (editNewPlate && (!newPlateCategory.trim() || !newPlateNumber.trim())) return setError("กรุณากรอกทะเบียนใหม่ (หมวดและเลข)");
    if (!remark.trim()) return setError("กรุณาระบุเหตุผลที่แก้");
    setSaving(true);
    try {
      const { transfer } = await vehicleTransferApi.update(item.id, {
        vehicleClass: form.vehicleClass as TransferVehicleClass,
        transferorName: form.transferorName,
        transfereeName: form.transfereeName,
        engine: form.engine,
        chassis: form.chassis,
        brand: form.brand,
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        ...feePayload(form, rates, moveIn),
        ...(editNewPlate ? { newPlateCategory: newPlateCategory.trim(), newPlateNumber: newPlateNumber.trim() } : {}),
        // ส่งเฉพาะตอนเลือกไว้จริง - งานที่ไม่มีเจ้าของงานและไม่ได้เลือกในรอบนี้ ไม่ต้องแตะ
        ...(form.customerId ? { customerId: form.customerId } : {}),
        submitDate,
        ...(returnedDate ? { returnedDate } : {}),
        remark: remark.trim(),
        // ฟอร์มส่งทุกช่องจากตอนเปิด - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดค้างไว้ backend ตอบ 409 ไม่ทับของเขา
        expectedUpdatedAt: item.updatedAt,
      });
      onSaved(transfer);
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
      <h2>แก้งานโอน ({TRANSFER_TYPE_LABEL[item.transferType]})</h2>
      <Summary item={item} />
      <div style={{ marginTop: 12 }}>
        <VehicleFormFields
          form={form}
          onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          classOptions={moveIn ? ["MOTO"] : classOptions.includes(item.vehicleClass) ? classOptions : [item.vehicleClass, ...classOptions]}
          submitDateText={submitDateText}
          onSubmitDateChange={setSubmitDateText}
          returnedDateText={item.returnedDate ? returnedDateText : undefined}
          onReturnedDateChange={setReturnedDateText}
          brandNames={brandNames}
          customerOptions={customerOptions}
          customerPlaceholder={item.customer ? "เลือกลูกค้า" : "ยังไม่ระบุ"}
          moveIn={moveIn}
          stampDuty={Number(item.stampDutyAmount) || 0}
          rates={rates}
        >
          {editNewPlate && (
            <div className="field">
              ทะเบียนใหม่ ({form.submitProvince}) *
              <NewPlateInputs category={newPlateCategory} number={newPlateNumber} onCategory={setNewPlateCategory} onNumber={setNewPlateNumber} />
            </div>
          )}
        </VehicleFormFields>
      </div>
      <label className="field" style={{ marginTop: 12 }}>
        เหตุผลที่แก้ *
        <input type="text" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="เช่น พิมพ์ชื่อผู้รับโอนผิด" />
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

// ช่องทะเบียนใหม่ (หมวด + เลข) ของโอนย้ายเข้า - ใช้ทั้งหน้ารับใบเสร็จและป๊อปอัปแก้
function NewPlateInputs({
  category,
  number,
  onCategory,
  onNumber,
  compact = false,
}: {
  category: string;
  number: string;
  onCategory: (value: string) => void;
  onNumber: (value: string) => void;
  compact?: boolean;
}) {
  const className = compact ? "inspect-input" : undefined;
  return (
    <div style={{ display: "flex", gap: 6 }}>
      <input value={category} onChange={(e) => onCategory(e.target.value)} maxLength={3} placeholder="หมวด" aria-label="หมวดทะเบียนใหม่" className={className} style={compact ? { width: 70 } : undefined} />
      <input
        value={number}
        onChange={(e) => onNumber(e.target.value.replace(/\D/g, "").slice(0, 4))}
        maxLength={4}
        inputMode="numeric"
        placeholder="เลข"
        aria-label="เลขทะเบียนใหม่"
        className={className}
        style={compact ? { width: 70 } : undefined}
      />
    </div>
  );
}

function CancelDialog({ item, onClose, onCancelled }: { item: VehicleTransfer; onClose: () => void; onCancelled: (id: string) => void }) {
  return (
    <ReasonDialog
      title="ยกเลิกงานโอน"
      confirmLabel="ยืนยันยกเลิกงาน"
      placeholder="เช่น บันทึกซ้ำ / ลูกค้ายกเลิก"
      onClose={onClose}
      onConfirm={async (remark) => {
        await vehicleTransferApi.cancel(item.id, remark);
        onCancelled(item.id);
      }}
    >
      <Summary item={item} />
      <p style={{ marginTop: 12 }}>
        งานนี้จะหายจากรายการ (ยังเก็บไว้ในประวัติพร้อมเหตุผล)
        {item.receipts.length > 0 ? " - รูปใบเสร็จที่แนบไว้นำไปแนบกับงานที่บันทึกใหม่ได้" : ""}
      </p>
    </ReasonDialog>
  );
}

const BackLink = ({ transferType }: { transferType: TransferType }) => (
  <Link href={transferHome(transferType)} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
    ← งานโอน · {TRANSFER_TYPE_LABEL[transferType]}
  </Link>
);

// ---------------------------------------------------------------------------------------------
// หน้ายื่น
// ---------------------------------------------------------------------------------------------

type RowDialog = { kind: "edit" | "cancel"; item: VehicleTransfer } | null;

export function VehicleTransferSubmitPage({ transferType }: { transferType: TransferType }) {
  const allWritable = useWritableClasses();
  const moveIn = isMoveIn(transferType);
  // โอนย้ายเข้ามีอัตราเฉพาะมอเตอร์ไซค์ - ผู้ที่บันทึกได้แต่รถยนต์จึงไม่เห็นฟอร์ม
  const writable = useMemo(() => (moveIn && allWritable ? allWritable.filter((c) => c === "MOTO") : allWritable), [allWritable, moveIn]);
  // โอนย้ายเข้า: จังหวัดที่ย้ายเข้าต้องเลือกเอง ไม่ตั้งต้นเป็นกรุงเทพฯ
  const emptyForm = useMemo<FormState>(() => (moveIn ? { ...EMPTY_FORM, submitProvince: "" } : EMPTY_FORM), [moveIn]);
  const [form, setForm] = useState<FormState>(emptyForm);
  // งานย้ายออก (มอเตอร์ไซค์ รับใบเสร็จแล้ว) ที่ยังไม่ถูกผูกกับงานโอนย้ายเข้า - เลือกแล้วเติมข้อมูลรถให้
  const [moveOuts, setMoveOuts] = useState<VehicleMoveOut[]>([]);
  const [moveOutId, setMoveOutId] = useState("");
  const [submitDateText, setSubmitDateText] = useState(() => isoToDisplayDate(todayIso()));
  const submitDate = useMemo(() => textToIso(submitDateText), [submitDateText]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const { brandNames, customerOptions } = useChoices();
  const rates = useContributionRates();

  const [month, setMonth] = useState(() => todayIso().slice(0, 7));
  const [items, setItems] = useState<VehicleTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dialog, setDialog] = useState<RowDialog>(null);

  async function loadMoveOuts() {
    try {
      const [outs, used] = await Promise.all([vehicleMoveOutApi.list("returned", "MOTO"), vehicleTransferApi.list("all", "MOVE_IN")]);
      const taken = new Set(used.transfers.map((t) => t.moveOutId).filter(Boolean));
      setMoveOuts(outs.moveOuts.filter((m) => !taken.has(m.id)));
    } catch {
      setMoveOuts([]); // ดึงรายการไม่ได้ก็ยังกรอกเองได้
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดตัวเลือกงานย้ายออกครั้งแรก
    if (moveIn && writable && writable.length > 0) void loadMoveOuts();
  }, [moveIn, writable]);

  function pickMoveOut(id: string) {
    setMoveOutId(id);
    const picked = moveOuts.find((m) => m.id === id);
    if (!picked) return;
    // ผู้โอน = เจ้าของรถตามงานย้ายออก · ผู้รับโอน/จังหวัดกรอกเอง
    setForm((prev) => ({
      ...prev,
      customerId: picked.customer?.id ?? prev.customerId,
      transferorName: picked.ownerName,
      chassis: picked.chassis,
      engine: picked.engine,
      brand: picked.brand,
      plateCategory: picked.plateCategory,
      plateNumber: picked.plateNumber,
    }));
  }

  // ผู้ใช้ที่บันทึกได้ประเภทรถเดียวเลือกให้เลย
  const onlyClass = writable && writable.length === 1 ? writable[0] : "";
  const classValue = form.vehicleClass || onlyClass;
  const showActions = Boolean(writable && writable.length > 0);

  async function load(forMonth: string) {
    setLoading(true);
    setListError("");
    try {
      setItems((await vehicleTransferApi.list("all", transferType, forMonth)).transfers);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load อ่าน transferType ที่อยู่ใน deps แล้ว
  }, [month, transferType]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!submitDate) return setMessage({ text: "กรุณากรอกวันที่ยื่นให้ถูกต้อง", error: true });
    const invalid = validateForm({ ...form, vehicleClass: classValue }, true, moveIn);
    if (invalid) return setMessage({ text: invalid, error: true });
    setSaving(true);
    setMessage({ text: "กำลังบันทึก…" });
    try {
      await vehicleTransferApi.create({
        transferType,
        vehicleClass: classValue as TransferVehicleClass,
        customerId: form.customerId,
        transferorName: form.transferorName,
        transfereeName: form.transfereeName,
        engine: form.engine,
        chassis: form.chassis,
        brand: form.brand,
        plateCategory: form.plateCategory,
        plateNumber: form.plateNumber,
        submitDate,
        ...feePayload({ ...form, vehicleClass: classValue }, rates, moveIn),
        ...(moveIn && moveOutId ? { moveOutId } : {}),
      });
      setMessage({ text: "บันทึกงานที่ยื่นแล้ว" });
      // เจ้าของงานคนเดิมและประเภทรถเดิมมักส่งมาหลายคัน - คงไว้ให้ (โอนย้ายเข้าคงจังหวัดที่ย้ายเข้าไว้ด้วย)
      setForm((prev) => ({ ...emptyForm, customerId: prev.customerId, vehicleClass: prev.vehicleClass, ...(moveIn ? { submitProvince: prev.submitProvince } : {}) }));
      if (moveIn) {
        setMoveOutId("");
        void loadMoveOuts();
      }
      if (submitDate.slice(0, 7) === month) await load(month);
      else setMonth(submitDate.slice(0, 7));
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    } finally {
      setSaving(false);
    }
  }

  const replace = (updated: VehicleTransfer) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));

  return (
    <section className="content">
      <BackLink transferType={transferType} />
      <h1>ยื่นงานโอน ({TRANSFER_TYPE_LABEL[transferType]})</h1>

      {showActions && (
        <div className="panel" style={{ marginBottom: 24 }}>
          <form className="customer-form" onSubmit={handleSubmit}>
            {moveIn && (
              <label className="field" style={{ maxWidth: 620, marginBottom: 16 }}>
                ดึงข้อมูลจากงานย้ายออก (รับใบเสร็จแล้ว)
                <select value={moveOutId} onChange={(e) => pickMoveOut(e.target.value)}>
                  <option value="">{moveOuts.length === 0 ? "ไม่มีงานย้ายออกที่รอโอนย้ายเข้า - กรอกเอง" : "ไม่เลือก - กรอกเอง"}</option>
                  {moveOuts.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.plateCategory} {m.plateNumber} · {m.ownerName} · {m.brand} · ตัวถัง {m.chassis}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <VehicleFormFields
              moveIn={moveIn}
              rates={rates}
              form={{ ...form, vehicleClass: classValue }}
              onChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
              classOptions={writable ?? []}
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
                    <th scope="col">วันที่ยื่น</th>
                    <th scope="col">เจ้าของงาน</th>
                    <th scope="col">ผู้โอน → ผู้รับโอน</th>
                    <th scope="col">ประเภทรถ</th>
                    <th scope="col">ทะเบียน</th>
                    <th scope="col">Bill</th>
                    <th scope="col">No Bill</th>
                    <th scope="col">ค่าอากร</th>
                    <th scope="col">รวม</th>
                    <th scope="col">สถานะ</th>
                    {showActions && <th />}
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
                        <PartiesCell item={item} />
                      </td>
                      <td>
                        {CLASS_LABEL[item.vehicleClass]}
                        {item.useRequest && <div className="sub">โอนขอใช้</div>}
                        {item.urgent && <div className="sub">งานด่วน</div>}
                        {item.submitProvince && (moveIn || item.submitProvince !== TRANSFER_DEFAULT_PROVINCE) && (
                          <div className="sub">
                            {moveIn ? "ย้ายเข้า" : "ยื่นที่"}
                            {item.submitProvince}
                          </div>
                        )}
                      </td>
                      <td>
                        <PlateCell item={item} />
                      </td>
                      <td>
                        {formatBaht(Number(item.billTotal))}
                        {Number(item.fineAmount) > 0 && <div className="sub">รวมค่าปรับ {formatBaht(Number(item.fineAmount))}</div>}
                        {Number(item.stampDutyAmount) > 0 && <div className="sub">รวมค่าอากรโอน {formatBaht(Number(item.stampDutyAmount))}</div>}
                      </td>
                      <td>{formatBaht(Number(item.noBillTotal))}</td>
                      <td>{formatBaht(Number(item.dutyAmount))}</td>
                      <td>
                        <strong>{formatBaht(totalOf(item))}</strong>
                      </td>
                      <td>
                        <StatusBadge item={item} />
                      </td>
                      {showActions && (
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
                รวม {items.length} คัน · Bill {formatBaht(items.reduce((sum, s) => sum + Number(s.billTotal), 0))} · No Bill{" "}
                {formatBaht(items.reduce((sum, s) => sum + Number(s.noBillTotal), 0))} · ค่าอากร {formatBaht(items.reduce((sum, s) => sum + Number(s.dutyAmount), 0))} · รวม (ไม่รวมค่าอากร){" "}
                {formatBaht(items.reduce((sum, s) => sum + totalOf(s), 0))} บาท
              </strong>
            </div>
          </>
        )}
      </div>

      {dialog?.kind === "edit" && (
        <EditDialog
          item={dialog.item}
          classOptions={writable ?? []}
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
// หน้าตรวจรถ (เฉพาะโอนตรวจรถ): รอส่งตรวจ -> รอผลตรวจ -> ตรวจแล้ว (ผ่านไปรับใบเสร็จต่อ / ไม่ผ่านยกเลิกผลแล้วตรวจใหม่ได้)
// ---------------------------------------------------------------------------------------------

type InspectionTab = Extract<TransferStatusFilter, "to-send" | "to-result" | "inspected">;
const INSPECTION_TABS: { key: InspectionTab; label: string; empty: string }[] = [
  { key: "to-send", label: "รอส่งตรวจ", empty: "ไม่มีงานที่รอส่งตรวจ" },
  { key: "to-result", label: "ส่งตรวจแล้ว รอผล", empty: "ไม่มีงานที่รอผลตรวจ" },
  { key: "inspected", label: "ได้ผลตรวจแล้ว", empty: "ยังไม่มีงานที่ได้ผลตรวจ (งานที่รับเอกสารกลับแล้วไม่แสดงที่นี่)" },
];

type InspectionDialog = { kind: "edit" | "cancel" | "undo"; item: VehicleTransfer } | null;

export function VehicleTransferInspectionPage({ transferType = "INSPECTION" }: { transferType?: TransferType }) {
  const writable = useWritableClasses();
  const [tab, setTab] = useState<InspectionTab>("to-send");
  const [items, setItems] = useState<VehicleTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [dateText, setDateText] = useState(() => isoToDisplayDate(todayIso()));
  const date = useMemo(() => textToIso(dateText), [dateText]);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [dialog, setDialog] = useState<InspectionDialog>(null);

  async function load(forTab: InspectionTab) {
    setLoading(true);
    setListError("");
    try {
      setItems((await vehicleTransferApi.list(forTab, transferType)).transfers);
    } catch (err) {
      setListError(errorText(err, "โหลดรายการไม่สำเร็จ"));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- โหลดรายการใหม่เมื่อเปลี่ยนแท็บ
    load(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load อ่าน transferType ที่อยู่ใน deps แล้ว
  }, [tab, transferType]);

  const replace = (updated: VehicleTransfer) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  const drop = (id: string) => setItems((prev) => prev.filter((s) => s.id !== id));
  const label = (item: VehicleTransfer) => `${item.transferorName} → ${item.transfereeName} (${plateText(item)})`;
  const anyWritable = Boolean(writable && writable.length > 0);

  function checkDate(): string | null {
    if (!date) {
      setMessage({ text: "กรุณากรอกวันที่ให้ถูกต้อง", error: true });
      return null;
    }
    // พิมพ์ปีผิดเป็นอนาคตไม่ได้ (backend กันอีกชั้น)
    if (date > todayIso()) {
      setMessage({ text: "วันที่ต้องไม่เกินวันนี้", error: true });
      return null;
    }
    return date;
  }

  async function send(item: VehicleTransfer) {
    const sentDate = checkDate();
    if (!sentDate) return;
    if (!await confirmDialog(`ยืนยันบันทึกส่งตรวจ?\n\nวันที่ส่งตรวจ: ${isoToDisplayDate(sentDate)}\nรถ: ${label(item)}`)) return;
    try {
      await vehicleTransferApi.markInspectionSent(item.id, sentDate);
      drop(item.id);
      setMessage({ text: `บันทึกส่งตรวจแล้ว: ${label(item)}` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  async function record(item: VehicleTransfer, result: InspectionResult) {
    const resultDate = checkDate();
    if (!resultDate) return;
    const resultText = result === "PASS" ? "ผ่าน" : "ไม่ผ่าน";
    if (!await confirmDialog(`ยืนยันบันทึกผลตรวจ "${resultText}"?\n\nวันที่ผลตรวจ: ${isoToDisplayDate(resultDate)}\nรถ: ${label(item)}`)) return;
    try {
      await vehicleTransferApi.recordInspectionResult(item.id, result, resultDate);
      drop(item.id);
      setMessage({ text: `บันทึกผลตรวจ ${resultText} แล้ว: ${label(item)}${result === "PASS" ? " - ไปรับใบเสร็จต่อได้" : ""}` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  return (
    <section className="content">
      <BackLink transferType={transferType} />
      <h1>ตรวจรถ ({TRANSFER_TYPE_LABEL[transferType]})</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        บันทึกวันที่ส่งตรวจ แล้วบันทึกผลตรวจ - ตรวจผ่านแล้วถึงจะรับใบเสร็จได้ (การตรวจรถนี้แยกจากคิวตรวจรถของรถจดใหม่)
      </p>

      <div className="panel">
        <div className="panel-head">
          <div className="inspect-filter" style={{ padding: 0 }}>
            {INSPECTION_TABS.map((t) => (
              <button key={t.key} type="button" className={`filter-chip${tab === t.key ? " selected" : ""}`} onClick={() => setTab(t.key)}>
                {t.label}
              </button>
            ))}
          </div>
          {tab !== "inspected" && anyWritable && (
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 14 }}>
              {tab === "to-send" ? "วันที่ส่งตรวจ" : "วันที่ผลตรวจ"}
              <DateTextInput value={dateText} onChange={setDateText} label={tab === "to-send" ? "วันที่ส่งตรวจ" : "วันที่ผลตรวจ"} />
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
          <div className="empty-customers">{INSPECTION_TABS.find((t) => t.key === tab)?.empty}</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">วันที่ยื่น</th>
                  <th scope="col">เจ้าของงาน</th>
                  <th scope="col">ผู้โอน → ผู้รับโอน</th>
                  <th scope="col">ประเภทรถ</th>
                  <th scope="col">ทะเบียน</th>
                  <th scope="col">{tab === "to-send" ? "" : "ส่งตรวจ"}</th>
                  <th scope="col">{tab === "inspected" ? "ผลตรวจ" : ""}</th>
                  {anyWritable && <th />}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const canWrite = canWriteItem(writable, item);
                  return (
                    <tr key={item.id}>
                      <td>{isoToDisplayDate(item.submitDate)}</td>
                      <td style={{ whiteSpace: "normal", minWidth: 140 }}>
                        <CustomerCell item={item} />
                      </td>
                      <td>
                        <PartiesCell item={item} />
                      </td>
                      <td>{CLASS_LABEL[item.vehicleClass]}</td>
                      <td>{plateText(item)}</td>
                      <td>{item.inspectionSentDate ? isoToDisplayDate(item.inspectionSentDate) : ""}</td>
                      <td>
                        {tab === "to-send" && canWrite && (
                          <button type="button" className="primary" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => send(item)}>
                            บันทึกส่งตรวจ
                          </button>
                        )}
                        {tab === "to-result" && canWrite && (
                          <div style={{ display: "flex", gap: 6 }}>
                            <button type="button" className="primary" style={{ padding: "8px 14px", fontSize: 13 }} onClick={() => record(item, "PASS")}>
                              ผ่าน
                            </button>
                            <button type="button" style={{ padding: "8px 14px", fontSize: 13, ...dangerButton }} onClick={() => record(item, "FAIL")}>
                              ไม่ผ่าน
                            </button>
                          </div>
                        )}
                        {tab === "inspected" && (
                          <>
                            {item.inspectionResult === "PASS" ? (
                              <span className="badge portal-badge-done">ผ่าน {item.inspectionResultDate ? isoToDisplayDate(item.inspectionResultDate) : ""}</span>
                            ) : (
                              <span className="badge" style={{ color: "#b43434" }}>
                                ไม่ผ่าน {item.inspectionResultDate ? isoToDisplayDate(item.inspectionResultDate) : ""}
                              </span>
                            )}
                            {item.inspectionResult === "FAIL" && <div className="sub">ยกเลิกผลตรวจแล้วบันทึกใหม่ได้ (ตรวจซ้ำ)</div>}
                          </>
                        )}
                      </td>
                      {anyWritable && (
                        <td>
                          {canWrite && (
                            <RowActions onEdit={() => setDialog({ kind: "edit", item })} onCancel={() => setDialog({ kind: "cancel", item })}>
                              {tab !== "to-send" && (
                                <button type="button" className="text-button" style={dangerButton} onClick={() => setDialog({ kind: "undo", item })}>
                                  {tab === "to-result" ? "ยกเลิกส่งตรวจ" : "ยกเลิกผลตรวจ"}
                                </button>
                              )}
                            </RowActions>
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

      {dialog?.kind === "edit" && <EditDialog item={dialog.item} classOptions={writable ?? []} onClose={() => setDialog(null)} onSaved={replace} />}
      {dialog?.kind === "cancel" && (
        <CancelDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onCancelled={(id) => {
            drop(id);
            setMessage({ text: `ยกเลิกงานแล้ว: ${label(dialog.item)}` });
          }}
        />
      )}
      {dialog?.kind === "undo" && (
        <ReasonDialog
          title={dialog.item.inspectionResult ? "ยกเลิกผลตรวจ" : "ยกเลิกการส่งตรวจ"}
          confirmLabel="ยืนยัน"
          placeholder={dialog.item.inspectionResult ? "เช่น กดผลตรวจผิดงาน / ตรวจซ้ำหลังไม่ผ่าน" : "เช่น กดส่งตรวจผิดงาน"}
          onClose={() => setDialog(null)}
          onConfirm={async (remark) => {
            await vehicleTransferApi.undoInspection(dialog.item.id, remark);
            drop(dialog.item.id);
            setMessage({ text: `${dialog.item.inspectionResult ? "ล้างผลตรวจ" : "ล้างวันที่ส่งตรวจ"}แล้ว: ${label(dialog.item)}` });
          }}
        >
          <Summary item={dialog.item} />
          <p style={{ marginTop: 12 }}>
            {dialog.item.inspectionResult
              ? 'งานนี้จะกลับไปอยู่แท็บ "ส่งตรวจแล้ว รอผล" เพื่อบันทึกผลใหม่'
              : 'งานนี้จะกลับไปอยู่แท็บ "รอส่งตรวจ"'}
          </p>
        </ReasonDialog>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// หน้ารับใบเสร็จ (รับเอกสารกลับ)
// ---------------------------------------------------------------------------------------------

// เลขที่ใบเสร็จ/วันที่/ยอดเงิน - เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ (ช่องยังว่างทั้ง 3) แก้เองได้เสมอทีหลัง
// งานที่รับเอกสารกลับแล้ว แก้ได้แต่ต้องมีเหตุผล
function ReceiptFieldsCell({ item, canWrite, onChange }: { item: VehicleTransfer; canWrite: boolean; onChange: (item: VehicleTransfer) => void }) {
  const [editing, setEditing] = useState(false);
  const [receiptNo, setReceiptNo] = useState(item.receiptNo ?? "");
  const [dateText, setDateText] = useState(() => (item.receiptDate ? isoToDisplayDate(item.receiptDate) : ""));
  const [amount, setAmount] = useState(item.receiptAmount ?? "");
  // ค่าอากรโอนตามราคารถ (เฉพาะโอนย้ายเข้า) - รู้เมื่อใบเสร็จออก บันทึกแล้วระบบบวกเข้า Bill
  const moveIn = isMoveIn(item.transferType);
  const stampText = (value: string) => (Number(value) > 0 ? String(Number(value)) : "");
  const [stampDuty, setStampDuty] = useState(() => stampText(item.stampDutyAmount));
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
    setStampDuty(Number(item.stampDutyAmount) > 0 ? String(Number(item.stampDutyAmount)) : "");
  }, [editing, item.receiptNo, item.receiptDate, item.receiptAmount, item.stampDutyAmount]);

  async function save() {
    setError("");
    const receiptDate = dateText.trim() ? textToIso(dateText) : "";
    if (dateText.trim() && !receiptDate) return setError("วันที่ใบเสร็จไม่ถูกต้อง - ใส่เป็น วว/ดด/ปปปป");
    if (needsRemark && !remark.trim()) return setError("งานนี้รับเอกสารกลับแล้ว - กรุณาระบุเหตุผลที่แก้ข้อมูลใบเสร็จ");
    setBusy(true);
    try {
      const { transfer } = await vehicleTransferApi.updateReceiptFields(
        item.id,
        { receiptNo: receiptNo.trim(), receiptDate, receiptAmount: amount.trim(), ...(moveIn ? { stampDutyAmount: stampDuty.trim() } : {}) },
        needsRemark ? remark.trim() : undefined,
      );
      onChange(transfer);
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
        {moveIn && <div className="sub">ค่าอากรโอน {Number(item.stampDutyAmount) > 0 ? `${formatBaht(Number(item.stampDutyAmount))} บาท` : "ไม่มี"}</div>}
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
      {moveIn && (
        <input
          value={stampDuty}
          onChange={(e) => setStampDuty(moneyOnly(e.target.value))}
          placeholder="ค่าอากรโอน (ไม่มีเว้นว่าง)"
          aria-label="ค่าอากรโอนตามราคารถ"
          inputMode="decimal"
          className="inspect-input"
        />
      )}
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

type ReturnDialog = { kind: "edit" | "cancel" | "undo"; item: VehicleTransfer } | null;

export function VehicleTransferReturnPage({ transferType }: { transferType: TransferType }) {
  const writable = useWritableClasses();
  const [status, setStatus] = useState<Extract<TransferStatusFilter, "pending" | "returned">>("pending");
  const [items, setItems] = useState<VehicleTransfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [returnDateText, setReturnDateText] = useState(() => isoToDisplayDate(todayIso()));
  const returnDate = useMemo(() => textToIso(returnDateText), [returnDateText]);
  const [message, setMessage] = useState<{ text: string; error?: boolean }>({ text: "" });
  const [dialog, setDialog] = useState<ReturnDialog>(null);
  const anyWritable = Boolean(writable && writable.length > 0);

  async function load(forStatus: typeof status) {
    setLoading(true);
    setListError("");
    try {
      setItems((await vehicleTransferApi.list(forStatus, transferType)).transfers);
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
  }, [status, transferType]);

  const replace = (updated: VehicleTransfer) => setItems((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
  const drop = (id: string) => setItems((prev) => prev.filter((s) => s.id !== id));
  const label = (item: VehicleTransfer) => `${item.transferorName} → ${item.transfereeName} (${plateText(item)})`;

  async function confirmReturn(item: VehicleTransfer, newPlate?: { newPlateCategory: string; newPlateNumber: string }) {
    // โอนย้ายเข้า: ป้ายเปลี่ยนเป็นของจังหวัดที่ย้ายเข้า ต้องกรอกทะเบียนใหม่ก่อนยืนยัน
    if (isMoveIn(item.transferType) && (!newPlate?.newPlateCategory || !newPlate.newPlateNumber)) {
      return setMessage({ text: "กรุณากรอกทะเบียนใหม่ (หมวดและเลข) ก่อนยืนยันรับกลับ", error: true });
    }
    if (!returnDate) return setMessage({ text: "กรุณากรอกวันที่รับเอกสารกลับให้ถูกต้อง", error: true });
    // พิมพ์ปีผิดเป็นอนาคตไม่ได้ (backend กันอีกชั้น)
    if (returnDate > todayIso()) return setMessage({ text: "วันที่รับเอกสารกลับต้องไม่เกินวันนี้", error: true });
    // ยืนยันก่อนเสมอ - กดผิดงาน/ผิดวันแล้วต้องยกเลิกรับกลับพร้อมเหตุผล
    const plateLine = newPlate ? `\nทะเบียนใหม่: ${newPlate.newPlateCategory} ${newPlate.newPlateNumber} ${item.submitProvince ?? ""}` : "";
    const ok = await confirmDialog(`ยืนยันรับเอกสารกลับ?\n\nวันที่รับกลับ: ${isoToDisplayDate(returnDate)}\nรถ: ${label(item)}${plateLine}`);
    if (!ok) return;
    try {
      await vehicleTransferApi.markReturned(item.id, returnDate, newPlate);
      drop(item.id);
      setMessage({ text: `รับเอกสารกลับแล้ว: ${label(item)}` });
    } catch (err) {
      setMessage({ text: errorText(err, "บันทึกไม่สำเร็จ"), error: true });
    }
  }

  return (
    <section className="content">
      <BackLink transferType={transferType} />
      <h1>รับใบเสร็จ ({TRANSFER_TYPE_LABEL[transferType]})</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        {transferHasInspection(transferType) ? "แสดงเฉพาะงานที่ตรวจรถผ่านแล้ว - " : ""}
        ถ่ายหรือแนบรูปใบเสร็จอย่างน้อย 1 รูป (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ แก้เองได้) แล้วกดยืนยันรับเอกสารกลับตามวันที่ที่ระบุ
        {isMoveIn(transferType) ? " - โอนย้ายเข้าต้องกรอกทะเบียนใหม่ของจังหวัดที่ย้ายเข้า และใส่ค่าอากรโอน (ถ้าใบเสร็จมี) ที่ ✎ แก้ ของข้อมูลใบเสร็จ" : ""}
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
          {status === "pending" && anyWritable && (
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
                  <th scope="col">วันที่ยื่น</th>
                  <th scope="col">เจ้าของงาน</th>
                  <th scope="col">ผู้โอน → ผู้รับโอน</th>
                  <th scope="col">ประเภทรถ</th>
                  <th scope="col">ทะเบียน</th>
                  <th scope="col">รูปใบเสร็จ</th>
                  <th scope="col">ข้อมูลใบเสร็จ</th>
                  <th scope="col">{status === "pending" ? "" : "วันที่รับกลับ"}</th>
                  {anyWritable && <th />}
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <ReturnRow
                    key={item.id}
                    item={item}
                    canWrite={canWriteItem(writable, item)}
                    showActions={anyWritable}
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

      {dialog?.kind === "edit" && <EditDialog item={dialog.item} classOptions={writable ?? []} onClose={() => setDialog(null)} onSaved={replace} />}
      {dialog?.kind === "cancel" && (
        <CancelDialog
          item={dialog.item}
          onClose={() => setDialog(null)}
          onCancelled={(id) => {
            drop(id);
            setMessage({ text: `ยกเลิกงานแล้ว: ${label(dialog.item)}` });
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
            await vehicleTransferApi.undoReturn(dialog.item.id, remark);
            drop(dialog.item.id);
            setMessage({ text: `ย้ายกลับไปรอรับเอกสารแล้ว: ${label(dialog.item)}` });
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
  showActions,
  onChange,
  onConfirm,
  onMessage,
  onDialog,
}: {
  item: VehicleTransfer;
  canWrite: boolean;
  showActions: boolean;
  onChange: (item: VehicleTransfer) => void;
  onConfirm: (item: VehicleTransfer, newPlate?: { newPlateCategory: string; newPlateNumber: string }) => void;
  onMessage: (text: string, error?: boolean) => void;
  onDialog: (kind: "edit" | "cancel" | "undo") => void;
}) {
  const moveIn = isMoveIn(item.transferType);
  // ทะเบียนใหม่ของโอนย้ายเข้า - เติมค่าที่เคยกรอกไว้ (งานที่ยกเลิกรับกลับแล้วรับใหม่)
  const [newPlateCategory, setNewPlateCategory] = useState(item.newPlateCategory ?? "");
  const [newPlateNumber, setNewPlateNumber] = useState(item.newPlateNumber ?? "");
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
        onChange((await vehicleTransferApi.addReceipt(item.id, image, compressedFileName(file), returned ? receiptRemark.trim() : undefined)).transfer);
      }
    } catch (err) {
      onMessage(errorText(err, "แนบรูปไม่สำเร็จ"), true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function removeReceipt(receiptId: string) {
    if (!await confirmDialog("ลบรูปใบเสร็จนี้?")) return;
    try {
      onChange((await vehicleTransferApi.removeReceipt(item.id, receiptId, returned ? receiptRemark.trim() : undefined)).transfer);
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
        <PartiesCell item={item} />
      </td>
      <td>{CLASS_LABEL[item.vehicleClass]}</td>
      <td>
        <PlateCell item={item} />
        {moveIn && !returned && canWrite && (
          <div style={{ marginTop: 4 }}>
            <div className="sub">ทะเบียนใหม่ {item.submitProvince ?? ""} *</div>
            <NewPlateInputs category={newPlateCategory} number={newPlateNumber} onCategory={setNewPlateCategory} onNumber={setNewPlateNumber} compact />
          </div>
        )}
      </td>
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
            onClick={() => onConfirm(item, moveIn ? { newPlateCategory: newPlateCategory.trim(), newPlateNumber: newPlateNumber.trim() } : undefined)}
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
