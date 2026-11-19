import { isMotorcycleType, isTransportType } from '../vehicles/vehicle-reference-data.js';
// ค่าใช้จ่ายงานต่อภาษี - ตัวเลขจากผู้ใช้ 2026-09-23 (รถเล็ก) และ 2026-11-09 (รถตาม พ.ร.บ.ขนส่ง)
// ไม่มีสำเนาฝั่ง frontend (ต่างจาก plate-swap-fee.ts): ฟอร์มขอยอดสดจาก POST /api/tax-renewals/preview
// เพราะยอดภาษีต้องใช้ตารางอัตราในฐานข้อมูลอยู่แล้ว คิดเองฝั่ง client ไม่ได้
//
// Bill (ใบเสร็จกรมขนส่ง): ภาษีรถประจำปี + เงินเพิ่มกรณีชำระล่าช้า - ยอดมาจาก calculateVehicleTax()
// Bill เพิ่ม: ใบแทนคู่มือจดทะเบียน (กรณีเล่มเต็ม) 100 บาท ถ้าติ๊ก - รถยนต์และจักรยานยนต์ ไม่ใช่รถ ขส. (ผู้ใช้ 2026-11-19)
// No Bill: ลงขัน รถยนต์ 20 / จักรยานยนต์ 10 / รถตาม พ.ร.บ.ขนส่ง 100 บาท - ติ๊ก "ไม่มีค่าลงขัน" เพื่องดรายการนี้ได้
//   รถตาม พ.ร.บ.ขนส่ง (ขส.-...) ต้องตรวจสภาพรถทุกครั้งก่อนต่อภาษี ค่าตรวจ 1,000 เป็น No Bill อีกบรรทัด
//   (ค่าใช้จ่ายของออฟฟิศ ไม่ใช่ใบเสร็จราชการ - ถ้าลูกค้าต้องจ่ายแยก บัญชีเพิ่มบรรทัดในบิลเอง) ติ๊กงดลงขันไม่ตัดค่าตรวจ
//
// อัตราลงขันของงานนี้เป็นคนละชุดกับงานอื่น (สลับเลข 200, ยื่นเอกสารขั้นที่ 4 = 40) อย่านำมาใช้ร่วมกัน
import type { VehicleTaxResult } from './vehicle-tax-calculator.js';

export interface FeeItem {
  label: string;
  amount: number;
}

export const TAX_RENEWAL_CONTRIBUTION_CAR = 20;
export const TAX_RENEWAL_CONTRIBUTION_MOTO = 10;
export const TAX_RENEWAL_CONTRIBUTION_TRANSPORT = 100; // ลงขัน รถตาม พ.ร.บ.ขนส่ง (ผู้ใช้ 2026-11-09)
export const TAX_RENEWAL_INSPECTION_FEE_TRANSPORT = 1000; // ค่าตรวจสภาพรถ รถตาม พ.ร.บ.ขนส่ง (ผู้ใช้ 2026-11-09)
export const TRANSPORT_INSPECTION_LABEL = 'ค่าตรวจสภาพรถ';
// ใบแทนคู่มือจดทะเบียน (กรณีเล่มเต็ม): Bill 100 บาท รถยนต์และจักรยานยนต์ (ไม่ใช่รถ ขส.) - ผู้ใช้ 2026-11-19
export const TAX_RENEWAL_BOOK_REPLACEMENT_FEE = 100;
export const BOOK_REPLACEMENT_LABEL = 'ใบแทนคู่มือจดทะเบียน (กรณีเล่มเต็ม)';

export type TaxRenewalVehicleClass = 'CAR' | 'MOTO' | 'TRANSPORT';

export function vehicleClassOf(vehicleType: string | null | undefined): TaxRenewalVehicleClass {
  if (isTransportType(vehicleType)) return 'TRANSPORT';
  return isMotorcycleType(vehicleType) ? 'MOTO' : 'CAR';
}

export function contributionAmountFor(vehicleClass: TaxRenewalVehicleClass): number {
  if (vehicleClass === 'TRANSPORT') return TAX_RENEWAL_CONTRIBUTION_TRANSPORT;
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

// Bill ของรถ ขส. ที่ยังไม่มีตารางอัตรา: บรรทัดเดียว = ยอดตามใบเสร็จ (รวมเงินเพิ่มถ้ามี) - 0 จนกว่าจะมียอดใบเสร็จ
export const TAX_FROM_RECEIPT_LABEL = 'ภาษีรถประจำปี (ตามใบเสร็จ)';

export function calculateTaxRenewalFees(
  tax: VehicleTaxResult,
  // receiptAmount: ยอดบนใบเสร็จ - ใช้เฉพาะรถ ขส. ที่ยังไม่มีตารางอัตรา (tax.taxFromReceipt) ซึ่ง Bill = ยอดตามใบเสร็จ (ผู้ใช้ 2026-11-18)
  // bookReplacement: ติ๊กใบแทนคู่มือจดทะเบียน - รถยนต์และจักรยานยนต์ (รถ ขส. ไม่เพิ่มบรรทัด)
  options: { skipContribution: boolean; bookReplacement?: boolean; receiptAmount?: number | null },
): TaxRenewalFees {
  const billItems: FeeItem[] = tax.taxFromReceipt ? [{ label: TAX_FROM_RECEIPT_LABEL, amount: options.receiptAmount ?? 0 }] : [
    {
      label: tax.taxCycleCount > 1 ? `ภาษีรถประจำปี (${tax.taxCycleCount} รอบปี)` : 'ภาษีรถประจำปี',
      amount: tax.annualVehicleTax,
    },
  ];
  if (!tax.taxFromReceipt && tax.lateFee > 0) {
    billItems.push({ label: 'เงินเพิ่มกรณีชำระล่าช้า', amount: tax.lateFee });
  }

  const vehicleClass = vehicleClassOf(tax.vehicleType);
  if (options.bookReplacement && vehicleClass !== 'TRANSPORT') {
    billItems.push({ label: BOOK_REPLACEMENT_LABEL, amount: TAX_RENEWAL_BOOK_REPLACEMENT_FEE });
  }
  const noBillItems: FeeItem[] = [];
  if (vehicleClass === 'TRANSPORT') {
    noBillItems.push({ label: TRANSPORT_INSPECTION_LABEL, amount: TAX_RENEWAL_INSPECTION_FEE_TRANSPORT });
  }
  if (!options.skipContribution) {
    noBillItems.push({ label: 'ลงขัน', amount: contributionAmountFor(vehicleClass) });
  }

  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, billTotal, noBillTotal, total: billTotal + noBillTotal };
}
