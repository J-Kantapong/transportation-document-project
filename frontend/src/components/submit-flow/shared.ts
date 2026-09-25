import type { DocumentSubmissionOptionsInput, FeePreview, OwnerType, SubmitCandidate, Vehicle } from "@/lib/api";
import { OWNER_TYPE_LABEL, ownerDisplayLabel } from "@/lib/vehicle-owner";
import { isoToDisplayDate } from "@/lib/date";

// ยื่นเอกสารจดทะเบียน (Step 4) แบบ 3 ขั้น (ผู้ใช้ 2026-09-25): เลือกรถ -> ตรวจทานและตั้งค่า -> ผลการยื่น แต่ละขั้นเป็น URL
// ของตัวเอง ใช้ state ร่วมกันผ่าน SubmitFlowProvider ใน submit/layout.tsx (ไม่เก็บร่างในเครื่องแล้ว - รีเฟรช = เริ่มใหม่)
export const MENU_HREF = "/registration/new-vehicle/submit-documents";
export const PICK_HREF = `${MENU_HREF}/submit`;
export const SETTINGS_HREF = `${PICK_HREF}/settings`;
export const REVIEW_HREF = `${PICK_HREF}/review`;
export const DONE_HREF = `${PICK_HREF}/done`;
export const RECORDS_HREF = `${MENU_HREF}/records`;

export const DEFAULT_OPTIONS: DocumentSubmissionOptionsInput = {
  plateNumberOption: "NONE",
  includePlateFee: true,
  newPlateOption: "NONE",
  relocateAddon: false,
  stopUseRelocateOut: false,
  urgent: false,
};

// ตั้งค่ารายคันในขั้นตรวจทาน - ownerType undefined = ใช้เจ้าของรถเดิม (ถ้ารถยังไม่มีเจ้าของด้วย = ยังไม่ระบุ ยื่นไม่ได้)
export interface EntrySettings {
  options: DocumentSubmissionOptionsInput;
  plateCategory: string;
  plateNumber: string;
  ownerType: OwnerType | undefined;
}

export function formatMoney(amount: number): string {
  return amount.toLocaleString("th-TH", { maximumFractionDigits: 2 });
}

export function isMotoBody(body: string | null): boolean {
  return !!body && body.startsWith("รย.12-");
}

export function jobTypeLabel(vehicle: Vehicle): string {
  if (!vehicle.registrationProvince || !vehicle.ownerProvince) return "จดทะเบียนปกติ";
  if (vehicle.registrationProvince === vehicle.ownerProvince) return "จดทะเบียนปกติ";
  return `ขอใช้${vehicle.registrationProvince}`;
}

export function summarizeList(items: string[]): string {
  return `${items.slice(0, 10).join(", ")}${items.length > 10 ? " ..." : ""}`;
}

export function lastFailedLabel(failed: NonNullable<SubmitCandidate["lastFailedSubmission"]>): string {
  return `ยื่นไม่สำเร็จ ${isoToDisplayDate(failed.submitDate)}: ${failed.failRemark || "—"}`;
}

// ประเภทเจ้าของรถ: ตั้งแต่ 2026-09-22 กรอกตั้งแต่หน้าเพิ่มข้อมูลรถจดใหม่ หน้านี้แสดงตามข้อมูลรถโดยไม่ให้เลือกซ้ำ -
// รถเก่าที่ยังไม่มีเจ้าของเป็น "ยังไม่ระบุ" ให้เลือกเอง ระบบไม่เดาให้ (ผู้ใช้ 2026-09-20) เพราะภาษี รย.1 นิติบุคคลคูณสอง
export function hasEntryOwner(vehicle: Vehicle): boolean {
  return vehicle.ownerType !== null;
}

export function isOwnerUnspecified(vehicle: Vehicle, settings: EntrySettings): boolean {
  return !settings.ownerType && !vehicle.ownerType;
}

// ส่ง ownerType ให้ backend เฉพาะรถที่ไม่มีเจ้าของจากหน้าเพิ่มข้อมูลรถ - ไม่งั้น backend จะสร้างเจ้าของแบบไม่มีไฟแนนซ์ทับ
export function ownerTypeForApi(vehicle: Vehicle, settings: EntrySettings): OwnerType | undefined {
  return hasEntryOwner(vehicle) ? undefined : settings.ownerType;
}

export function ownerLabel(vehicle: Vehicle, settings: EntrySettings): string | null {
  const fromEntry = ownerDisplayLabel(vehicle, vehicle.financeName);
  if (fromEntry) return fromEntry;
  return settings.ownerType ? OWNER_TYPE_LABEL[settings.ownerType] : null;
}

export function defaultSettings(vehicle: Vehicle): EntrySettings {
  return {
    options: DEFAULT_OPTIONS,
    // รถที่มีเลขทะเบียนอยู่แล้วแสดงไว้ให้เลย - รถที่รับเลขจากงานสลับเลขใช้ทะเบียนของงานนั้นก่อน (ผู้ใช้ 2026-09-23)
    plateCategory: vehicle.plateSwap?.newPlateCategory ?? vehicle.plateCategory ?? "",
    plateNumber: vehicle.plateSwap?.newPlateNumber ?? vehicle.plateNumber ?? "",
    ownerType: vehicle.ownerType ?? undefined,
  };
}

// ค่าอากรอยู่ในรายการ No bill (label ขึ้นต้น "ค่าอากร") - ยอดรวมทั้งหมดแยกค่าอากรออก แสดงเป็นบรรทัดต่างหาก
export function dutyAmount(fee: FeePreview): number {
  return fee.noBillItems.filter((item) => item.label.startsWith("ค่าอากร")).reduce((sum, item) => sum + item.amount, 0);
}

// รวมทั้งหมด (ยังไม่รวมค่าอากร) = Bill + No bill (หักค่าอากร) + ภาษี
export function grandTotalExcludingDuty(fee: FeePreview, taxAmount: number | null): number {
  return fee.billTotal + fee.noBillTotal - dutyAmount(fee) + (taxAmount ?? 0);
}

export function plateMissing(settings: EntrySettings): boolean {
  return settings.options.plateNumberOption !== "NONE" && (!settings.plateCategory.trim() || !settings.plateNumber.trim());
}
