// เดาว่า CC / น้ำหนัก / ประเภทรถ ที่คีย์ไว้ผิดตรงไหน จากยอดบนใบเสร็จจริง (ผู้ใช้ 2026-10-13: พนักงานคีย์ CC ผิดแล้วกระทบการคิดเงิน)
// ลองแทนค่าในข้อมูลรถ คิด Bill ใหม่ด้วยกฎเดียวกับตอนยื่น แล้วดูว่าค่าไหนให้ยอดเท่าใบเสร็จ - เป็น "ข้อเสนอ" เท่านั้น
// ไม่แก้ข้อมูลรถเอง (ยอดในระบบ AI อ่านหรือพนักงานพิมพ์ ต้องให้คนยืนยันแล้วไปแก้ในหน้าข้อมูลรถ)

import { calculateGovernmentTax, type GovernmentTaxOwnerInput, type GovernmentTaxRuleSet } from '../tax/government-tax-calculator.js';
import { VEHICLE_TYPES, isMotorcycleType } from '../vehicles/vehicle-reference-data.js';
import { computeDocumentFees, type DocumentFeeRuleSet, type DocumentSubmissionOptionsInput } from './document-fee-calculator.js';

export interface SizeHintVehicle {
  body: string | null;
  fuel: string | null;
  cc: string | number | null;
  weight: string | number | null;
  registrationProvince: string | null;
  ownerProvince: string | null;
  firstRegistrationDate: Date | null;
}

export type SizeHint =
  | { field: 'body'; current: string | null; suggested: string }
  | { field: 'cc' | 'weight'; current: number | null; from: number; to: number };

const CC_SCAN_MAX = 10_000;
const WEIGHT_SCAN_MAX = 15_000;
const WEIGHT_STEP = 5;
const EPSILON = 0.005;

export function suggestSizeFixes(input: {
  vehicle: SizeHintVehicle;
  owner: GovernmentTaxOwnerInput | null;
  options: DocumentSubmissionOptionsInput;
  receiptAmount: number;
  feeRules: DocumentFeeRuleSet;
  taxRules: GovernmentTaxRuleSet;
}): SizeHint[] {
  const { vehicle, owner, options, receiptAmount, feeRules, taxRules } = input;

  const feeFor = (body: string | null): number | null => {
    try {
      return computeDocumentFees(
        { body, registrationProvince: vehicle.registrationProvince, ownerProvince: vehicle.ownerProvince },
        options,
        feeRules,
        { billOnly: true },
      ).billTotal;
    } catch {
      return null;
    }
  };
  const taxFor = (patch: Partial<SizeHintVehicle>): number | null => calculateGovernmentTax({ ...vehicle, ...patch }, owner, taxRules).amount;
  const matches = (total: number | null) => total !== null && Math.abs(total - receiptAmount) < EPSILON;

  const currentFee = feeFor(vehicle.body);
  const currentTax = taxFor({});
  if (currentFee !== null && currentTax !== null && matches(currentFee + currentTax)) return []; // ยอดตรงอยู่แล้ว

  const hints: SizeHint[] = [];

  // 1) ประเภทรถผิด (เช่น มอเตอร์ไซค์ 149.5cc แต่เลือก "300-799cc") - ลองประเภทอื่นในกลุ่มเดียวกัน (มอเตอร์ไซค์ / รถยนต์)
  const sameGroup = VEHICLE_TYPES.filter((b) => b !== vehicle.body && isMotorcycleType(b) === isMotorcycleType(vehicle.body));
  for (const body of sameGroup) {
    const fee = feeFor(body);
    const tax = taxFor({ body });
    if (fee !== null && tax !== null && matches(fee + tax)) hints.push({ field: 'body', current: vehicle.body, suggested: body });
  }

  // 2) CC / น้ำหนักผิด (รถยนต์) - ภาษีบนใบเสร็จ = ยอดรวม - Bill ค่าธรรมเนียม แล้วหาช่วงที่ให้ภาษีเท่านั้น (ภาษีไม่ลดลงเมื่อ CC/น้ำหนักเพิ่ม จึงเป็นช่วงต่อเนื่อง)
  if (currentFee !== null && !isMotorcycleType(vehicle.body) && receiptAmount - currentFee > 0) {
    const targetTax = receiptAmount - currentFee;
    const scan = (field: 'cc' | 'weight', max: number, step: number): SizeHint | null => {
      let from: number | null = null;
      let to = 0;
      for (let value = step; value <= max; value += step) {
        const amount = taxFor({ [field]: value });
        if (amount !== null && Math.abs(amount - targetTax) < EPSILON) {
          if (from === null) from = value;
          to = value;
        } else if (from !== null) break;
      }
      if (from === null) return null;
      const current = Number(vehicle[field]);
      return { field, current: Number.isFinite(current) && current > 0 ? current : null, from, to };
    };
    // ลองเฉพาะช่องที่ภาษีของรถประเภทนี้ใช้คิด: คำนวณจากค่าปัจจุบันก่อนว่าช่องไหนทำให้ภาษีเปลี่ยนได้
    const probeCc = taxFor({ cc: 1000 }) !== taxFor({ cc: 3000 });
    const hint = probeCc ? scan('cc', CC_SCAN_MAX, 1) : scan('weight', WEIGHT_SCAN_MAX, WEIGHT_STEP);
    if (hint) hints.push(hint);
  }

  return hints;
}
