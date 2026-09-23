// ค่าใช้จ่ายงานต่อภาษี - ตัวเลขจากผู้ใช้ 2026-09-23
// ไม่มีสำเนาฝั่ง frontend (ต่างจาก plate-swap-fee.ts): ฟอร์มขอยอดสดจาก POST /api/tax-renewals/preview
// เพราะยอดภาษีต้องใช้ตารางอัตราในฐานข้อมูลอยู่แล้ว คิดเองฝั่ง client ไม่ได้
//
// Bill (ใบเสร็จกรมขนส่ง): ภาษีรถประจำปี + เงินเพิ่มกรณีชำระล่าช้า - ยอดมาจาก calculateVehicleTax()
// No Bill: ลงขัน รถยนต์ 20 / จักรยานยนต์ 10 บาท - ติ๊ก "ไม่มีค่าลงขัน" เพื่องดรายการนี้ได้
//
// อัตราลงขันของงานนี้เป็นคนละชุดกับงานอื่น (สลับเลข 200, ยื่นเอกสารขั้นที่ 4 = 40) อย่านำมาใช้ร่วมกัน
import type { VehicleTaxResult } from './vehicle-tax-calculator.js';

export interface FeeItem {
  label: string;
  amount: number;
}

export const TAX_RENEWAL_CONTRIBUTION_CAR = 20;
export const TAX_RENEWAL_CONTRIBUTION_MOTO = 10;

export type TaxRenewalVehicleClass = 'CAR' | 'MOTO';

export function vehicleClassOf(vehicleType: string | null | undefined): TaxRenewalVehicleClass {
  return vehicleType?.startsWith('รย.12-') ? 'MOTO' : 'CAR';
}

export function contributionAmountFor(vehicleClass: TaxRenewalVehicleClass): number {
  return vehicleClass === 'MOTO' ? TAX_RENEWAL_CONTRIBUTION_MOTO : TAX_RENEWAL_CONTRIBUTION_CAR;
}

export interface TaxRenewalFees {
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: number;
  noBillTotal: number;
  total: number;
}

const sum = (items: FeeItem[]) => items.reduce((acc, item) => acc + item.amount, 0);

export function calculateTaxRenewalFees(
  tax: VehicleTaxResult,
  options: { skipContribution: boolean },
): TaxRenewalFees {
  const billItems: FeeItem[] = [
    {
      label: tax.taxCycleCount > 1 ? `ภาษีรถประจำปี (${tax.taxCycleCount} รอบปี)` : 'ภาษีรถประจำปี',
      amount: tax.annualVehicleTax,
    },
  ];
  if (tax.lateFee > 0) {
    billItems.push({ label: 'เงินเพิ่มกรณีชำระล่าช้า', amount: tax.lateFee });
  }

  const noBillItems: FeeItem[] = options.skipContribution
    ? []
    : [{ label: 'ลงขัน', amount: contributionAmountFor(vehicleClassOf(tax.vehicleType)) }];

  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, billTotal, noBillTotal, total: billTotal + noBillTotal };
}
