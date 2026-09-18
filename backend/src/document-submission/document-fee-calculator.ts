// Step 4 (ยื่นเอกสารจดทะเบียนรถใหม่) ค่าธรรมเนียม Bill/No bill - ported from the reviewed UI mockup
// (Main.dc.html computeHasExtraRequest/computeBillItems/computeNoBillItems), but amounts are looked
// up from the real FeeCarBillParam/FeeCarNoBillParam/FeeMotorcycleBillParam/FeeMotorcycleNoBillParam
// tables by key instead of hardcoded, so a future rate change (seed.ts) never needs a code change.
// Bill and No bill are NOT alternative choices - every vehicle always incurs both (see
// memory/project_fee_pricing_workflow.md), so both are always computed together here.
import { classifyVehicleFamily } from '../tax/government-tax-reference-data.js';
import { GovTaxVehicleFamily } from '../generated/prisma/enums.js';

export type PlateNumberOption = 'NONE' | 'NORMAL' | 'AUCTION';
export type NewPlateOption = 'NONE' | 'BLACKWHITE' | 'AUCTION';

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
}

export interface DocumentFeeResult {
  isMoto: boolean;
  isOtherProvince: boolean;
  hasExtraRequest: boolean;
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
    options.plateNumberOption !== 'NONE' ||
    (!isMoto && options.newPlateOption !== null && options.newPlateOption !== 'NONE') ||
    (!isMoto && options.relocateAddon)
  );
}

export function computeDocumentFees(
  vehicle: DocumentSubmissionVehicleInput,
  options: DocumentSubmissionOptionsInput,
  rules: DocumentFeeRuleSet,
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
  const includePlate = options.plateNumberOption === 'NONE' || options.includePlateFee;
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

  return { isMoto, isOtherProvince, hasExtraRequest, billItems, noBillItems, billTotal, noBillTotal };
}
