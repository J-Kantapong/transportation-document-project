"use client";

import Link from "next/link";
import { ApiError, type VehicleEditWarning } from "@/lib/api";
import { canAccessPage, canEditSubmitSteps, type UserRole } from "@/lib/auth";
import { isoToDisplayDate } from "@/lib/date";
import { formatMoney } from "@/lib/invoice";
import { FOCUS_PARAM } from "@/lib/vehicle-focus";

// แก้ข้อมูลรถหลังขั้นตอนที่ใช้ข้อมูลเดิม (ผู้ใช้ 2026-09-27): PATCH /api/vehicles/:id ตอบ 409 needsConfirm พร้อมขั้นตอนที่กระทบ
// หน้าจอแสดงคำเตือน ให้ผู้ใช้กดยืนยันแล้วส่งซ้ำ (confirm) - ระบบไม่คิดค่าใช้จ่าย/ภาษีใหม่ให้ รายการยื่นที่รอใบเสร็จต้องไป
// ยกเลิกแล้วยื่นใหม่ที่หน้า ดูข้อมูลที่ยื่นแล้ว (ไม่แก้ราคารายการเดียว - ผู้ใช้ 2026-09-25)

const RECORDS_PATH = "/registration/new-vehicle/submit-documents/records";

// อ่านคำเตือนจาก error ของ api.updateVehicle - ไม่ใช่ 409 needsConfirm = null (error อื่นแสดงข้อความตามปกติ)
export function editWarningOf(error: unknown): VehicleEditWarning | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.details?.needsConfirm !== true) return null;
  const affected = Array.isArray(error.details.affected) ? (error.details.affected as VehicleEditWarning["affected"]) : [];
  const taxPreview = error.details.taxPreview as VehicleEditWarning["taxPreview"] | undefined;
  return { affected, ...(taxPreview ? { taxPreview } : {}) };
}

function taxLine(preview: NonNullable<VehicleEditWarning["taxPreview"]>) {
  const oldText = preview.old === null ? "—" : `${formatMoney(preview.old)} บาท`;
  if (preview.new === null) {
    return `ภาษีที่ยื่นไว้ ${oldText} · ภาษีตามข้อมูลใหม่คำนวณไม่ได้${preview.reason ? ` (${preview.reason})` : ""}`;
  }
  const diff = preview.old === null ? null : Math.round((preview.new - preview.old) * 100) / 100;
  let diffText = "";
  if (diff !== null) diffText = diff === 0 ? " (เท่าเดิม)" : ` (${diff > 0 ? "+" : "−"}${formatMoney(Math.abs(diff))} บาท)`;
  return `ภาษีที่ยื่นไว้ ${oldText} → ภาษีตามข้อมูลใหม่ ${formatMoney(preview.new)} บาท${diffText}`;
}

export function EditImpactWarning({
  warning,
  roles,
  isMotorcycle,
  chassis,
  saving,
  onConfirm,
  onCancel,
}: {
  warning: VehicleEditWarning;
  roles: UserRole[];
  isMotorcycle: boolean; // ประเภทรถหลังแก้ - แท็บรถยนต์/จักรยานยนต์ของหน้า ดูข้อมูลที่ยื่นแล้ว
  chassis: string; // เลขตัวถังหลังแก้ - หน้า ดูข้อมูลที่ยื่นแล้วเลื่อนไปที่แถวของรถคันนี้ (?focus=)
  saving: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // ชี้ไปยกเลิกแล้วยื่นใหม่เฉพาะเมื่อช่วยได้ (รอใบเสร็จ + ช่องที่แก้มีผลกับค่าธรรมเนียม/ภาษี) - แก้แค่ลูกค้า/ยี่ห้อ/ชื่อเจ้าของ
  // ไม่ต้องยกเลิก (ผู้ใช้ 2026-09-27 รอบตรวจ: เดิมขึ้นทุกครั้งที่รายการรอใบเสร็จ ขัดกับคำเตือนของ backend)
  const pending = warning.affected.find((a) => a.step === "submission" && a.submissionStatus === "PENDING" && a.repriceable === true);
  // เปิดวันที่ยื่นของรายการนั้นและไฮไลต์แถวของรถ (?date= อ่านในหน้า records, ?focus= โดย FocusVehicleRow)
  const recordsParams = new URLSearchParams({
    ...(isMotorcycle ? { tab: "moto" } : {}),
    ...(pending?.submitDate ? { date: pending.submitDate } : {}),
    ...(chassis.trim() ? { [FOCUS_PARAM]: chassis.trim() } : {}),
  }).toString();
  const recordsHref = recordsParams ? `${RECORDS_PATH}?${recordsParams}` : RECORDS_PATH;
  // STAFF_ENTRY เปิดหน้ารายการที่ยื่นแล้วไม่ได้ และยกเลิกรายการยื่นไม่ได้ (ADMIN / STAFF_CAR / STAFF_MOTO เท่านั้น)
  const canCancelSubmission = canAccessPage(RECORDS_PATH, roles) && canEditSubmitSteps(roles);

  return (
    <div
      role="alert"
      style={{ marginTop: 16, padding: "12px 16px", border: "1px solid #f0d9ae", background: "#fffaf0", borderRadius: 8, fontSize: 13 }}
    >
      <strong style={{ color: "#bb8527" }}>รถคันนี้ผ่านขั้นตอนที่ใช้ข้อมูลเดิมไปแล้ว - ตรวจสอบก่อนยืนยัน</strong>
      <ul style={{ margin: "8px 0", paddingLeft: 20, display: "grid", gap: 6 }}>
        {warning.affected.map((a) => (
          <li key={a.step}>
            <strong>{a.label}</strong> · ช่องที่แก้: {a.fields.join(", ")}
            <div style={{ color: "#5a6885" }}>{a.note}</div>
          </li>
        ))}
      </ul>
      {warning.taxPreview && <p style={{ margin: "0 0 8px", fontWeight: 600 }}>{taxLine(warning.taxPreview)}</p>}
      {pending && (
        <p style={{ margin: "0 0 8px" }}>
          ถ้าต้องการให้ค่าธรรมเนียม/ภาษีตรงกับข้อมูลใหม่: กดยืนยันบันทึกก่อน แล้ว
          {canCancelSubmission ? (
            <>
              {" "}
              ไปยกเลิกรายการยื่นแล้วยื่นใหม่ที่หน้า{" "}
              <Link href={recordsHref} target="_blank" rel="noopener">
                ดูข้อมูลที่ยื่นแล้ว
              </Link>
            </>
          ) : (
            " แจ้งเจ้าหน้าที่ยื่นเอกสารให้ไปยกเลิกรายการยื่นแล้วยื่นใหม่ที่หน้า ดูข้อมูลที่ยื่นแล้ว"
          )}
          {pending.submitDate ? ` (รายการวันที่ยื่น ${isoToDisplayDate(pending.submitDate)})` : ""}
        </p>
      )}
      <p style={{ margin: "0 0 12px", color: "#5a6885" }}>ระบบไม่คิดค่าใช้จ่าย/ค่าธรรมเนียม/ภาษีของขั้นตอนเดิมใหม่ให้อัตโนมัติ</p>
      <div className="form-actions" style={{ marginTop: 0 }}>
        <button type="button" className="primary" disabled={saving} onClick={onConfirm}>
          ยืนยันบันทึกการแก้ไข
        </button>
        <button type="button" className="text-button" disabled={saving} onClick={onCancel}>
          กลับไปแก้ข้อมูล
        </button>
      </div>
    </div>
  );
}
