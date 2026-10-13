import { describe, expect, it } from 'vitest';
import { GovTaxFuelGroup } from '../generated/prisma/enums.js';
import type { GovernmentTaxRuleSet } from '../tax/government-tax-calculator.js';
import type { DocumentFeeRuleSet, DocumentSubmissionOptionsInput } from './document-fee-calculator.js';
import { suggestSizeFixes, type SizeHintVehicle } from './receipt-size-hint.js';

// Bill รถยนต์ในชุดทดสอบ = 5 + 50 + 100 + 60 = 215 (กรุงเทพฯ ไม่ขอใช้ ไม่ขอเลข)
const feeRules: DocumentFeeRuleSet = {
  carBill: [
    { key: 'ค่าคำขอ (ปกติ)', amount: 5 },
    { key: 'ค่าตรวจสภาพรถ (Step4)', amount: 50 },
    { key: 'ค่าแผ่นป้ายทะเบียนรถ', amount: 100 },
    { key: 'ค่าใบคู่มือการจดทะเบียน', amount: 60 },
  ],
  carNoBill: [],
  motoBill: [
    { key: 'ค่าคำขอ (ปกติ)', amount: 5 },
    { key: 'ค่าตรวจสภาพรถ (จยย.)', amount: 50 },
    { key: 'ค่าแผ่นป้ายทะเบียน', amount: 100 },
    { key: 'ค่าใบคู่มือจดทะเบียน', amount: 60 },
  ],
  motoNoBill: [],
} as unknown as DocumentFeeRuleSet;

const taxRules: GovernmentTaxRuleSet = {
  ccBrackets: [
    { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 0, ccTo: 600, ratePerCc: 0.5 },
    { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 600, ccTo: 1800, ratePerCc: 1.5 },
    { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 1800, ccTo: null, ratePerCc: 4 },
  ],
  weightBrackets: [],
  evIncentives: [],
  motorcycleFlat: [{ fuelGroup: GovTaxFuelGroup.ICE, amount: 100 }],
};

const options: DocumentSubmissionOptionsInput = {
  plateNumberOption: 'NONE',
  includePlateFee: false,
  newPlateOption: null,
  relocateAddon: false,
  stopUseRelocateOut: false,
  urgent: false,
};

const owner = { ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null } as never;

function car(cc: number): SizeHintVehicle {
  return {
    body: 'รย.1-เก๋ง 2 ตอน',
    fuel: 'เบนซิน',
    cc,
    weight: null,
    registrationProvince: 'กรุงเทพมหานคร',
    ownerProvince: 'กรุงเทพมหานคร',
    firstRegistrationDate: null,
  };
}

describe('suggestSizeFixes', () => {
  it('ยอดตรงกับข้อมูลรถอยู่แล้ว = ไม่มีข้อเสนอ', () => {
    // CC 1500: ภาษี 300 + 900 x 1.5 = 1650 → 215 + 1650 = 1865
    expect(suggestSizeFixes({ vehicle: car(1500), owner, options, receiptAmount: 1865, feeRules, taxRules })).toEqual([]);
  });

  it('CC คีย์ผิด: ใบเสร็จตรงกับ CC 1500 ไม่ใช่ 1000', () => {
    const hints = suggestSizeFixes({ vehicle: car(1000), owner, options, receiptAmount: 1865, feeRules, taxRules });
    expect(hints).toEqual([{ field: 'cc', current: 1000, from: 1500, to: 1500 }]);
  });

  it('ยอดที่ไม่ตรงกับ CC ไหนเลย = ไม่เดา', () => {
    expect(suggestSizeFixes({ vehicle: car(1000), owner, options, receiptAmount: 1000.37, feeRules, taxRules })).toEqual([]);
  });
});
