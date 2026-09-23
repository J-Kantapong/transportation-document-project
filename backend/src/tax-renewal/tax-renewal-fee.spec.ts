import {
  calculateTaxRenewalFees,
  contributionAmountFor,
  vehicleClassOf,
} from './tax-renewal-fee.js';
import type { VehicleTaxResult } from './vehicle-tax-calculator.js';

// ใช้เฉพาะช่องที่ calculateTaxRenewalFees อ่าน
function tax(overrides: Partial<VehicleTaxResult> = {}): VehicleTaxResult {
  return {
    vehicleType: 'รย.1-เก๋ง 2 ตอน',
    annualVehicleTax: 2900,
    lateFee: 0,
    taxCycleCount: 1,
    ...overrides,
  } as VehicleTaxResult;
}

const taxWith = tax;

describe('vehicleClassOf', () => {
  it.each([
    ['รย.12-น้อยกว่า 300cc', 'MOTO'],
    ['รย.12-1000cc ขึ้นไป', 'MOTO'],
    ['รย.1-เก๋ง 2 ตอน', 'CAR'],
    ['รย.2-นั่ง 2 แถว', 'CAR'],
    ['รย.3-กระบะบรรทุก', 'CAR'],
  ] as const)('%s -> %s', (vehicleType, expected) => {
    expect(vehicleClassOf(vehicleType)).toBe(expected);
  });
});

describe('อัตราลงขัน', () => {
  it('รถยนต์ 20 จักรยานยนต์ 10', () => {
    expect(contributionAmountFor('CAR')).toBe(20);
    expect(contributionAmountFor('MOTO')).toBe(10);
  });
});

describe('calculateTaxRenewalFees', () => {
  it('ไม่มีเงินเพิ่ม -> Bill มีรายการเดียว', () => {
    const fees = calculateTaxRenewalFees(tax(), { skipContribution: false });
    expect(fees.billItems).toEqual([{ label: 'ภาษีรถประจำปี', amount: 2900 }]);
    expect(fees.noBillItems).toEqual([{ label: 'ลงขัน', amount: 20 }]);
    expect(fees.billTotal).toBe(2900);
    expect(fees.noBillTotal).toBe(20);
    expect(fees.total).toBe(2920);
  });

  it('มีเงินเพิ่ม -> เพิ่มรายการเงินเพิ่ม', () => {
    const fees = calculateTaxRenewalFees(taxWith({ lateFee: 87 }), { skipContribution: false });
    expect(fees.billItems).toHaveLength(2);
    expect(fees.billItems[1]).toEqual({ label: 'เงินเพิ่มกรณีชำระล่าช้า', amount: 87 });
    expect(fees.billTotal).toBe(2987);
  });

  it('ติ๊กไม่มีค่าลงขัน -> ไม่มีรายการ No Bill', () => {
    const fees = calculateTaxRenewalFees(tax(), { skipContribution: true });
    expect(fees.noBillItems).toEqual([]);
    expect(fees.noBillTotal).toBe(0);
    expect(fees.total).toBe(2900);
  });

  it('จักรยานยนต์ลงขัน 10', () => {
    const fees = calculateTaxRenewalFees(taxWith({ vehicleType: 'รย.12-300-799cc', annualVehicleTax: 100 }), {
      skipContribution: false,
    });
    expect(fees.noBillItems).toEqual([{ label: 'ลงขัน', amount: 10 }]);
    expect(fees.total).toBe(110);
  });

  it('ค้างหลายรอบปี -> ป้ายรายการบอกจำนวนรอบ', () => {
    const fees = calculateTaxRenewalFees(taxWith({ taxCycleCount: 2, annualVehicleTax: 5800, lateFee: 1044 }), {
      skipContribution: false,
    });
    expect(fees.billItems[0].label).toBe('ภาษีรถประจำปี (2 รอบปี)');
    expect(fees.billTotal).toBe(6844);
  });
});
