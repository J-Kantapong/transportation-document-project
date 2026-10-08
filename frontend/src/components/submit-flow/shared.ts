import { useSyncExternalStore } from "react";
import type {
  DocumentSubmission,
  DocumentSubmissionOptionsInput,
  FeeItem,
  FeePreview,
  OwnerType,
  PlateNumberOption,
  SubmitCandidate,
  Vehicle,
} from "@/lib/api";
import { getToken, rolesFromToken, submitWriteScopeFor, vehicleScopeFor, type VehicleScope } from "@/lib/auth";
import { OWNER_TYPE_LABEL, ownerDisplayLabel } from "@/lib/vehicle-owner";
import { isoToDisplayDate, todayIso } from "@/lib/date";
import { isSupplierProvince } from "@/lib/supplier-route";

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
  // จังหวัดอื่นนอกจากกรุงเทพฯ/สมุทรปราการ = ส่งซับจด (ผู้ใช้ 2026-10-08) - ขั้นนี้คือส่งงานให้ซับ ไม่ใช่ออฟฟิศยื่นเอง
  const supplier = isSupplierProvince(vehicle.registrationProvince) ? `ส่งซับจด${vehicle.registrationProvince}` : null;
  const otherProvince = !!vehicle.registrationProvince && !!vehicle.ownerProvince && vehicle.registrationProvince !== vehicle.ownerProvince;
  if (supplier) return otherProvince ? `${supplier} (ขอใช้)` : supplier;
  return otherProvince ? `ขอใช้${vehicle.registrationProvince}` : "จดทะเบียนปกติ";
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
    // รถใหม่รับ "ทะเบียนเก่า" ของรถเก่า (oldPlate*) - newPlate* คือเลขที่รถเก่าได้ใหม่ (ผู้ใช้ยืนยัน 2026-09-27: เดิมเติมผิดฝั่ง)
    plateCategory: vehicle.plateSwap?.oldPlateCategory ?? vehicle.plateCategory ?? "",
    plateNumber: vehicle.plateSwap?.oldPlateNumber ?? vehicle.plateNumber ?? "",
    ownerType: vehicle.ownerType ?? undefined,
  };
}

// "มีคนทำสลับเลขมาให้" (ผู้ใช้ 2026-09-27): คนอื่นทำสลับเลขแล้วส่งเลขมาให้ - ไม่ใช่การขอใช้เลข (ไม่มีค่าขอใช้เลข ไม่นับเป็นคำขอเพิ่ม)
export function isSwapPlateOption(option: PlateNumberOption | string | null | undefined): boolean {
  return option === "SWAP_NORMAL" || option === "SWAP_AUCTION";
}

// ป้ายกำกับรายการที่ยื่นด้วยเลขจากงานสลับเลขที่คนอื่นทำมาให้ (ตารางรายการที่ยื่นแล้ว) - ตัวเลือกอื่น = null
export function swapPlateLabel(option: PlateNumberOption | string | null | undefined): string | null {
  if (option === "SWAP_NORMAL") return "มีคนทำสลับเลขมาให้ · ป้ายขาวดำ";
  if (option === "SWAP_AUCTION") return "มีคนทำสลับเลขมาให้ · ป้ายประมูล";
  return null;
}

const plateKey = (category: string, number: string) => `${category}${number}`.replace(/\s+/g, "").toUpperCase();

// ทะเบียนที่กรอกในแถวไม่ตรงกับเลขที่รถคันนี้รับจากงานสลับเลข (ทะเบียนเก่าของรถเก่า) - เตือนให้ตรวจ ไม่บล็อก
export function plateSwapPrefillMismatch(vehicle: Vehicle, settings: EntrySettings): boolean {
  const swap = vehicle.plateSwap;
  if (!swap) return false;
  return plateKey(settings.plateCategory, settings.plateNumber) !== plateKey(swap.oldPlateCategory, swap.oldPlateNumber);
}

// ค่าอากรอยู่ในรายการ No bill (label ขึ้นต้น "ค่าอากร") - ยอดรวมทั้งหมดแยกค่าอากรออก แสดงเป็นบรรทัดต่างหาก
export function dutyOfItems(noBillItems: FeeItem[] | unknown): number {
  return (Array.isArray(noBillItems) ? (noBillItems as FeeItem[]) : [])
    .filter((item) => item.label.startsWith("ค่าอากร"))
    .reduce((sum, item) => sum + Number(item.amount), 0);
}

export function dutyAmount(fee: FeePreview): number {
  return dutyOfItems(fee.noBillItems);
}

// รวมทั้งหมด (ยังไม่รวมค่าอากร) = Bill + No bill (หักค่าอากร) + ภาษี
export function grandTotalExcludingDuty(fee: FeePreview, taxAmount: number | null): number {
  return fee.billTotal + fee.noBillTotal - dutyAmount(fee) + (taxAmount ?? 0);
}

// ยอดรวมของรายการที่ยื่นแล้ว (หน้าผลการยื่น/ดูข้อมูลที่ยื่นแล้ว) แบบเดียวกับขั้นตรวจทาน: ไม่รวมค่าอากร (ผู้ใช้ 2026-09-23)
// (พบ 2026-09-27: เดิมรวมค่าอากร ยอดสูงกว่าที่ตรวจทานและที่พิมพ์ในใบส่งงาน) ภาษีที่คำนวณไม่ได้ (null) นับ 0 - ผู้เรียกต้องแสดงว่ายังไม่รวมภาษี
export function savedTotalExcludingDuty(r: Pick<DocumentSubmission, "billFeeTotal" | "noBillTotal" | "noBillItems" | "taxAmount">): number {
  return Number(r.billFeeTotal) + Number(r.noBillTotal) - dutyOfItems(r.noBillItems) + Number(r.taxAmount ?? 0);
}

// ลำดับที่ยื่น (ลำดับในใบส่งงาน) - backend บันทึกตามลำดับที่เลือก createdAt ไล่ขึ้น, เท่ากันใช้ id ให้ได้ลำดับเดิมทุกครั้ง
export function compareSubmittedOrder(a: Pick<DocumentSubmission, "createdAt" | "id">, b: Pick<DocumentSubmission, "createdAt" | "id">): number {
  return a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

// ขอบเขตการบันทึกของบัญชีนี้ครอบรถคันนี้ไหม (writeScope จาก useWriteScope)
export function isInWriteScope(scope: VehicleScope, body: string | null): boolean {
  if (scope === "ALL") return true;
  if (scope === "NONE") return false;
  return isMotoBody(body) === (scope === "MOTO");
}

// roles อ่านจาก token ใน cookie ได้เฉพาะฝั่ง browser (แบบเดียวกับหน้าดูข้อมูลที่ยื่นแล้ว) - ตอน render ฝั่ง server = ยังไม่รู้
const noopSubscribe = () => () => {};

// ประเภทรถที่บัญชีนี้ยื่น/ยกเลิกได้ (ACCOUNTANT อย่างเดียว = NONE, STAFF_CAR + ACCOUNTANT = CAR) - backend ตรวจซ้ำ (พบ 2026-09-27)
export function useWriteScope(): VehicleScope {
  return useSyncExternalStore(noopSubscribe, () => submitWriteScopeFor(rolesFromToken(getToken() ?? "")), () => "NONE");
}

// ประเภทรถที่บัญชีนี้เห็น (STAFF_MOTO อย่างเดียว = MOTO) - null = ยังไม่รู้ (render ฝั่ง server)
export function useReadScope(): VehicleScope | null {
  return useSyncExternalStore(noopSubscribe, () => vehicleScopeFor(rolesFromToken(getToken() ?? "")), () => null);
}

// วันนี้ (เวลาเครื่อง = เวลาไทย) อัปเดตเมื่อกลับมาที่หน้าต่าง/แท็บ - หน้าที่เปิดค้างข้ามคืนได้วันใหม่ (พบ 2026-09-27)
function subscribeDayChange(onChange: () => void) {
  window.addEventListener("focus", onChange);
  document.addEventListener("visibilitychange", onChange);
  return () => {
    window.removeEventListener("focus", onChange);
    document.removeEventListener("visibilitychange", onChange);
  };
}

export function useTodayIso(): string {
  return useSyncExternalStore(subscribeDayChange, todayIso, todayIso);
}

// ขอใช้เลข (NORMAL/AUCTION) และเลขจากงานสลับเลข (SWAP_*) ต้องกรอกหมวด+เลข - "ไม่ขอ" เว้นว่างได้
export function plateMissing(settings: EntrySettings): boolean {
  return settings.options.plateNumberOption !== "NONE" && (!settings.plateCategory.trim() || !settings.plateNumber.trim());
}
