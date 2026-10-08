// Step 4 (ยื่นเอกสารจดทะเบียนรถใหม่) ค่าธรรมเนียม Bill/No bill - ported from the reviewed UI mockup
// (Main.dc.html computeHasExtraRequest/computeBillItems/computeNoBillItems), but amounts are looked
// up from the real FeeCarBillParam/FeeCarNoBillParam/FeeMotorcycleBillParam/FeeMotorcycleNoBillParam
// tables by key instead of hardcoded, so a future rate change (seed.ts) never needs a code change.
// Bill and No bill are NOT alternative choices - every vehicle always incurs both (see
// memory/project_fee_pricing_workflow.md), so both are always computed together here.
import { classifyVehicleFamily } from '../tax/government-tax-reference-data.js';
import { GovTaxVehicleFamily } from '../generated/prisma/enums.js';
import { isSupplierProvince, supplierFeeItems, type SupplierRateRow } from './supplier-route.js';

// SWAP_NORMAL / SWAP_AUCTION = "มีคนทำสลับเลขมาให้" (ผู้ใช้ 2026-09-27): คนอื่นทำสลับเลขแล้วส่งเลขมาให้ แผ่นป้ายขาวดำ / ประมูล
// ต้องกรอกหมวด+เลข ไม่มีค่าขอใช้เลข คิดค่าแผ่นป้ายตามปกติ และไม่นับเป็นคำขอเพิ่ม (ค่าคำขอ/ค่าอากรตามปกติ) - รถยนต์เท่านั้น
export type PlateNumberOption = 'NONE' | 'NORMAL' | 'AUCTION' | 'SWAP_NORMAL' | 'SWAP_AUCTION';
export type NewPlateOption = 'NONE' | 'BLACKWHITE' | 'AUCTION';

// เลขจากงานสลับเลขที่คนอื่นทำมาให้ (ไม่ใช่การขอใช้เลข)
export function isSwapPlateOption(option: string | null | undefined): boolean {
  return option === 'SWAP_NORMAL' || option === 'SWAP_AUCTION';
}

// ขอใช้เลขทะเบียนจริง (มีค่าขอใช้เลข + นับเป็นคำขอเพิ่ม) - ใช้แทนการเทียบ !== 'NONE' ทุกที่ที่หมายถึง "ขอใช้เลข"
export function requestsPlateNumber(option: string | null | undefined): boolean {
  return option === 'NORMAL' || option === 'AUCTION';
}

export interface DocumentSubmissionVehicleInput {
  body: string | null;
  registrationProvince: string | null;
  ownerProvince: string | null;
}

export interface DocumentSubmissionOptionsInput {
  plateNumberOption: PlateNumberOption;
  includePlateFee: boolean;
  newPlateOption: NewPlateOption | null; // รถยนต์เท่านั้น - null สำหรับมอเตอร์ไซค์
  relocateAddon: boolean; // รถยนต์เท่านั้น
  stopUseRelocateOut: boolean; // มอเตอร์ไซค์เท่านั้น
  urgent: boolean;
}

export interface FeeItem {
  label: string;
  amount: number;
}

export interface FeeParamRow {
  key: string;
  amount: number | null;
}

export interface DocumentFeeRuleSet {
  carBill: FeeParamRow[];
  carNoBill: FeeParamRow[];
  motoBill: FeeParamRow[];
  motoNoBill: FeeParamRow[];
  // ราคาซับจดต่างจังหวัด (SupplierProvinceRate) - ใช้กับรถที่จดจังหวัดอื่นนอกจากกรุงเทพฯ/สมุทรปราการ (ดู supplier-route.ts)
  supplierRates?: SupplierRateRow[];
}

export interface DocumentFeeResult {
  isMoto: boolean;
  isOtherProvince: boolean;
  hasExtraRequest: boolean;
  // ส่งซับจด (ผู้ใช้ 2026-10-08): billItems = ประมาณการค่าธรรมเนียมราชการที่ซับจ่ายแทน (เทียบกับใบเสร็จตอนรับกลับ)
  // noBillItems = ค่าจ้างซับตามตารางจังหวัด ไม่มีค่าอากร/ลงขันของออฟฟิศ
  viaSupplier: boolean;
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: number;
  noBillTotal: number;
}

// แถวที่ไม่พบ/amount เป็น null ถือว่าเป็นบั๊ก (key ไม่ตรงกับ seed.ts) ไม่ใช่กรณี "ยังไม่มีข้อมูล" แบบ
// GovernmentTax* - Fee*Param ทุกคีย์ที่ใช้ในนี้มีค่าใน seed.ts อยู่แล้วเสมอ จึง throw ตรงๆ แทนการ fail-closed
function lookupFee(rows: FeeParamRow[], key: string): number {
  const row = rows.find((r) => r.key === key);
  if (!row || row.amount === null) throw new Error(`ไม่พบข้อมูลค่าธรรมเนียม: ${key}`);
  return row.amount;
}

export function isMotorcycle(body: string | null): boolean {
  return classifyVehicleFamily(body) === GovTaxVehicleFamily.RY12;
}

export function computeHasExtraRequest(vehicle: DocumentSubmissionVehicleInput, options: DocumentSubmissionOptionsInput): boolean {
  const isMoto = isMotorcycle(vehicle.body);
  const isOtherProvince = !!vehicle.registrationProvince && !!vehicle.ownerProvince && vehicle.registrationProvince !== vehicle.ownerProvince;
  return (
    isOtherProvince ||
    requestsPlateNumber(options.plateNumberOption) || // เลขจากงานสลับเลข (SWAP_*) ไม่นับเป็นคำขอเพิ่ม (ผู้ใช้ 2026-09-27)
    (!isMoto && options.newPlateOption !== null && options.newPlateOption !== 'NONE') ||
    (!isMoto && options.relocateAddon)
  );
}

export function computeDocumentFees(
  vehicle: DocumentSubmissionVehicleInput,
  options: DocumentSubmissionOptionsInput,
  rules: DocumentFeeRuleSet,
  // billOnly: คิดเฉพาะค่าธรรมเนียมราชการ (หน้าวางบิลใช้เทียบกับใบเสร็จ) - ไม่แตะ No bill / ตารางราคาซับ
  mode: { billOnly?: boolean } = {},
): DocumentFeeResult {
  const isMoto = isMotorcycle(vehicle.body);
  const isOtherProvince = !!vehicle.registrationProvince && !!vehicle.ownerProvince && vehicle.registrationProvince !== vehicle.ownerProvince;
  const hasExtraRequest = computeHasExtraRequest(vehicle, options);
  const bill = isMoto ? rules.motoBill : rules.carBill;
  const noBill = isMoto ? rules.motoNoBill : rules.carNoBill;

  const billItems: FeeItem[] = [];
  billItems.push(
    hasExtraRequest
      ? { label: 'ค่าคำขอ (ขอใช้จังหวัดอื่น)', amount: lookupFee(bill, 'ค่าคำขอ (ขอใช้จังหวัดอื่น)') }
      : { label: 'ค่าคำขอ (ปกติ)', amount: lookupFee(bill, 'ค่าคำขอ (ปกติ)') },
  );
  if (isOtherProvince) {
    billItems.push({ label: 'ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)', amount: lookupFee(bill, 'ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)') });
  }

  // ค่าแผ่นป้ายทะเบียน(รถ): บังคับรวมเสมอเมื่อ "ไม่ขอ" เลขทะเบียน แต่ถ้าติ๊กขอใช้เลขทะเบียนแล้ว เลือกได้
  // ว่าจะรวมค่าป้ายนี้ด้วยหรือไม่ (ดู memory/project_fee_pricing_workflow.md)
  // เลขจากงานสลับเลข (SWAP_*) คิดค่าแผ่นป้ายตามปกติเสมอ (ผู้ใช้ 2026-09-27)
  const includePlate = options.plateNumberOption === 'NONE' || isSwapPlateOption(options.plateNumberOption) || options.includePlateFee;
  if (isMoto) {
    billItems.push({ label: 'ค่าตรวจสภาพรถ (จยย.)', amount: lookupFee(bill, 'ค่าตรวจสภาพรถ (จยย.)') });
    if (includePlate) billItems.push({ label: 'ค่าแผ่นป้ายทะเบียน', amount: lookupFee(bill, 'ค่าแผ่นป้ายทะเบียน') });
    billItems.push({ label: 'ค่าใบคู่มือจดทะเบียน', amount: lookupFee(bill, 'ค่าใบคู่มือจดทะเบียน') });
  } else {
    billItems.push({ label: 'ค่าตรวจสภาพรถ', amount: lookupFee(bill, 'ค่าตรวจสภาพรถ (Step4)') });
    if (includePlate) billItems.push({ label: 'ค่าแผ่นป้ายทะเบียนรถ', amount: lookupFee(bill, 'ค่าแผ่นป้ายทะเบียนรถ') });
    billItems.push({ label: 'ค่าใบคู่มือการจดทะเบียน', amount: lookupFee(bill, 'ค่าใบคู่มือการจดทะเบียน') });
    if (options.relocateAddon) billItems.push({ label: 'ค่าย้ายออกต่างจังหวัด', amount: lookupFee(bill, 'ค่าย้ายออกต่างจังหวัด') });
  }

  if (options.plateNumberOption === 'AUCTION' && !isMoto) {
    billItems.push({ label: 'ค่าขอใช้เลขทะเบียน (เลขประมูล)', amount: lookupFee(bill, 'ค่าขอใช้เลขทะเบียน - เลขประมูล') });
  }
  if (options.plateNumberOption === 'NORMAL') {
    billItems.push(
      isMoto
        ? { label: 'ค่าขอใช้เลขทะเบียน', amount: lookupFee(bill, 'ค่าขอใช้เลขทะเบียน') }
        : { label: 'ค่าขอใช้เลขทะเบียน (ไม่ใช่เลขประมูล)', amount: lookupFee(bill, 'ค่าขอใช้เลขทะเบียน - ไม่ใช่เลขประมูล') },
    );
  }
  if (!isMoto && options.newPlateOption === 'BLACKWHITE') {
    billItems.push({ label: 'ค่าทำแผ่นป้ายทะเบียนใหม่ (ป้ายขาวดำ)', amount: lookupFee(bill, 'ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายขาวดำ') });
  }
  if (!isMoto && options.newPlateOption === 'AUCTION') {
    billItems.push({ label: 'ค่าทำแผ่นป้ายทะเบียนใหม่ (ป้ายประมูล)', amount: lookupFee(bill, 'ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายประมูล') });
  }

  const viaSupplier = isSupplierProvince(vehicle.registrationProvince);
  if (mode.billOnly) {
    const billOnlyTotal = billItems.reduce((sum, it) => sum + it.amount, 0);
    return { isMoto, isOtherProvince, hasExtraRequest, viaSupplier, billItems, noBillItems: [], billTotal: billOnlyTotal, noBillTotal: 0 };
  }
  if (viaSupplier) {
    const supplierItems = supplierFeeItems(vehicle.registrationProvince as string, rules.supplierRates);
    return {
      isMoto,
      isOtherProvince,
      hasExtraRequest,
      viaSupplier,
      billItems,
      noBillItems: supplierItems,
      billTotal: billItems.reduce((sum, it) => sum + it.amount, 0),
      noBillTotal: supplierItems.reduce((sum, it) => sum + it.amount, 0),
    };
  }

  const noBillItems: FeeItem[] = [];
  noBillItems.push(
    hasExtraRequest
      ? { label: 'ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)', amount: lookupFee(noBill, 'ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)') }
      : { label: 'ค่าอากร (ปกติ)', amount: lookupFee(noBill, 'ค่าอากร (ปกติ)') },
  );
  if (isMoto) {
    noBillItems.push(
      options.stopUseRelocateOut
        ? { label: 'ลงขัน (จดใหม่ หยุดใช้ย้ายออก)', amount: lookupFee(noBill, 'ลงขัน - จดใหม่ หยุดใช้ย้ายออก') }
        : { label: 'ลงขัน (รย.12)', amount: lookupFee(noBill, 'ลงขัน - รย.12 ทุกประเภท (CC)') },
    );
  } else {
    // ลงขันรถยนต์แปรผันตามประเภทรถ (vehicle.body) จริง ไม่ใช่ราคาเดียวกันทุกประเภทแบบที่ mockup สมมติไว้
    // ตอน demo - คีย์คือ "ลงขัน - " + ประเภทรถเป๊ะๆ (ดู FeeCarNoBillParam ใน seed.ts)
    const key = `ลงขัน - ${vehicle.body ?? ''}`;
    noBillItems.push({ label: `ลงขัน (${vehicle.body ?? '-'})`, amount: lookupFee(noBill, key) });
  }
  if (options.urgent) {
    noBillItems.push(
      isMoto
        ? { label: 'ลงขันด่วนเพิ่ม', amount: lookupFee(noBill, 'ลงขันด่วนเพิ่ม (ต่อคัน)') }
        : { label: 'งานด่วนเพิ่ม', amount: lookupFee(noBill, 'งานด่วนเพิ่ม (ต่อคัน)') },
    );
  }

  const billTotal = billItems.reduce((sum, it) => sum + it.amount, 0);
  const noBillTotal = noBillItems.reduce((sum, it) => sum + it.amount, 0);

  return { isMoto, isOtherProvince, hasExtraRequest, viaSupplier, billItems, noBillItems, billTotal, noBillTotal };
}
