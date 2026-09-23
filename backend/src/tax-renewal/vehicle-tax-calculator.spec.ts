import {
  calculateLateMonths,
  calculateVehicleTax,
  calculateVehicleYear,
  getAgeDiscountRate,
  GOV_TAX_FUEL_GROUP_MAP,
  requiresInspection,
  resolveTaxMethod,
  VehicleTaxInput,
  VehicleTaxInputError,
  VehicleTaxRuleSet,
} from './vehicle-tax-calculator.js';
import { GovTaxFuelGroup, GovTaxVehicleFamily, OwnerType } from '../generated/prisma/enums.js';
import { GovernmentTaxOwnerInput } from '../tax/government-tax-calculator.js';

// อัตราตรงกับแถว VERIFIED จริงใน backend/prisma/seed.ts
const WEIGHT_BOUNDS: Array<number | null> = [500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, null];
const PASSENGER = [150, 300, 450, 800, 1000, 1300, 1600, 1900, 2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600];
const TRUCK = [300, 450, 600, 750, 900, 1050, 1350, 1650, 1950, 2250, 2550, 2850, 3150, 3450, 3750, 4050];

function weightRows() {
  const rows: VehicleTaxRuleSet['weightBrackets'] = [];
  WEIGHT_BOUNDS.forEach((weightTo, i) => {
    const weightFrom = i === 0 ? 0 : (WEIGHT_BOUNDS[i - 1] as number);
    rows.push({ vehicleFamily: GovTaxVehicleFamily.RY1, fuelGroup: GovTaxFuelGroup.BEV, weightFrom, weightTo, amount: PASSENGER[i] });
    rows.push({ vehicleFamily: GovTaxVehicleFamily.RY2, fuelGroup: null, weightFrom, weightTo, amount: PASSENGER[i] });
    rows.push({ vehicleFamily: GovTaxVehicleFamily.RY3, fuelGroup: null, weightFrom, weightTo, amount: TRUCK[i] });
  });
  return rows;
}

function rules(overrides: Partial<VehicleTaxRuleSet> = {}): VehicleTaxRuleSet {
  return {
    ccBrackets: [GovTaxFuelGroup.ICE, GovTaxFuelGroup.HEV, GovTaxFuelGroup.PHEV].flatMap((fuelGroup) => [
      { fuelGroup, ccFrom: 0, ccTo: 600, ratePerCc: 0.5 },
      { fuelGroup, ccFrom: 600, ccTo: 1800, ratePerCc: 1.5 },
      { fuelGroup, ccFrom: 1800, ccTo: null, ratePerCc: 4 },
    ]),
    weightBrackets: weightRows(),
    evIncentives: [],
    motorcycleFlat: [
      { fuelGroup: GovTaxFuelGroup.ICE, amount: 100 },
      { fuelGroup: GovTaxFuelGroup.HEV, amount: 100 },
    ],
    fuelPolicies: [],
    ...overrides,
  };
}

const INDIVIDUAL: GovernmentTaxOwnerInput = { ownerType: OwnerType.INDIVIDUAL, isHirePurchaseBusiness: false, hirerType: null };
const JURISTIC: GovernmentTaxOwnerInput = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: false, hirerType: null };
const JURISTIC_HIRE_PURCHASE: GovernmentTaxOwnerInput = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: true, hirerType: OwnerType.INDIVIDUAL };

// จดทะเบียน 2025 / ครบกำหนด 2025 => ปีที่ 1 (ไม่มีส่วนลดอายุ) และชำระตรงเวลา
function input(overrides: Partial<VehicleTaxInput> = {}): VehicleTaxInput {
  return {
    vehicleType: 'รย.1-เก๋ง 2 ตอน',
    fuel: 'เบนซิน',
    engineCc: 600,
    vehicleWeightKg: null,
    firstRegistrationDate: new Date(Date.UTC(2025, 0, 10)),
    taxExpiryDate: new Date(Date.UTC(2025, 11, 31)),
    paymentDate: new Date(Date.UTC(2025, 11, 1)),
    owner: INDIVIDUAL,
    ...overrides,
  };
}

describe('GOV_TAX_FUEL_GROUP_MAP', () => {
  it.each([
    ['เบนซิน', GovTaxFuelGroup.ICE],
    ['ดีเซล', GovTaxFuelGroup.ICE],
    ['LPG', GovTaxFuelGroup.ICE],
    ['NGV', GovTaxFuelGroup.ICE],
    ['ไฮบริด (HEV)', GovTaxFuelGroup.HEV],
    ['ปลั๊กอินไฮบริด (PHEV)', GovTaxFuelGroup.PHEV],
    ['ไฟฟ้า (BEV)', GovTaxFuelGroup.BEV],
  ] as const)('%s -> %s', (fuel, group) => {
    expect(GOV_TAX_FUEL_GROUP_MAP[fuel]).toBe(group);
  });
});

describe('resolveTaxMethod', () => {
  it.each([
    [GovTaxVehicleFamily.RY12, GovTaxFuelGroup.ICE, 'FIXED_MOTORCYCLE'],
    [GovTaxVehicleFamily.RY1, GovTaxFuelGroup.ICE, 'ENGINE_CC_RY1'],
    [GovTaxVehicleFamily.RY1, GovTaxFuelGroup.HEV, 'ENGINE_CC_RY1'],
    [GovTaxVehicleFamily.RY1, GovTaxFuelGroup.PHEV, 'ENGINE_CC_RY1'],
    [GovTaxVehicleFamily.RY1, GovTaxFuelGroup.BEV, 'WEIGHT_EV_RY1'],
    [GovTaxVehicleFamily.RY2, GovTaxFuelGroup.ICE, 'WEIGHT_RY2'],
    [GovTaxVehicleFamily.RY3, GovTaxFuelGroup.ICE, 'WEIGHT_RY3'],
  ] as const)('%s + %s -> %s', (family, fuelGroup, expected) => {
    expect(resolveTaxMethod(family, fuelGroup)).toBe(expected);
  });
});

describe('ภาษีพื้นฐาน รย.1 ตาม cc (ขั้นบันได)', () => {
  it.each([
    [1, 0.5],
    [600, 300],
    [601, 301.5],
    [1800, 2100],
    [1801, 2104],
    [3000, 6900],
  ])('cc=%d -> %f บาท', (engineCc, expected) => {
    const r = calculateVehicleTax(input({ engineCc }), rules());
    expect(r.baseTax).toBe(expected);
    expect(r.annualVehicleTax).toBe(expected);
  });

  it.each(['ไฮบริด (HEV)', 'ปลั๊กอินไฮบริด (PHEV)'])('%s ใช้สูตร cc เดียวกับ ICE', (fuel) => {
    const r = calculateVehicleTax(input({ fuel, engineCc: 1800 }), rules());
    expect(r.taxMethod).toBe('ENGINE_CC_RY1');
    expect(r.annualVehicleTax).toBe(2100);
  });
});

describe('ภาษีพื้นฐานตามน้ำหนัก - ทุกขอบเขตช่วง', () => {
  const boundaryCases = WEIGHT_BOUNDS.flatMap((to, i) => {
    const from = i === 0 ? 0 : (WEIGHT_BOUNDS[i - 1] as number);
    const lower = from === 0 ? 1 : from + 1;
    const upper = to ?? 9000;
    return [
      [lower, PASSENGER[i], TRUCK[i]],
      [upper, PASSENGER[i], TRUCK[i]],
    ] as const;
  });

  it.each(boundaryCases)('รย.2 น้ำหนัก %d กก. -> %d บาท', (weight, passenger) => {
    const r = calculateVehicleTax(
      input({ vehicleType: 'รย.2-นั่ง 2 แถว', engineCc: null, vehicleWeightKg: weight }),
      rules(),
    );
    expect(r.taxMethod).toBe('WEIGHT_RY2');
    expect(r.annualVehicleTax).toBe(passenger);
  });

  it.each(boundaryCases)('รย.3 น้ำหนัก %d กก. -> %d บาท', (weight, _passenger, truck) => {
    const r = calculateVehicleTax(
      input({ vehicleType: 'รย.3-กระบะบรรทุก', engineCc: null, vehicleWeightKg: weight }),
      rules(),
    );
    expect(r.taxMethod).toBe('WEIGHT_RY3');
    expect(r.annualVehicleTax).toBe(truck);
  });

  it('น้ำหนักตรงขอบล่างพอดี (500 กก.) ต้องได้ช่วงแรก', () => {
    const r = calculateVehicleTax(
      input({ vehicleType: 'รย.2-นั่ง 2 แถว', engineCc: null, vehicleWeightKg: 500 }),
      rules(),
    );
    expect(r.annualVehicleTax).toBe(150);
  });
});

describe('รย.12 เหมาจ่าย', () => {
  it.each(['รย.12-น้อยกว่า 300cc', 'รย.12-300-799cc', 'รย.12-800-999cc', 'รย.12-1000cc ขึ้นไป'])(
    '%s -> 100 บาททุกช่วง cc',
    (vehicleType) => {
      const r = calculateVehicleTax(input({ vehicleType, engineCc: 1200 }), rules());
      expect(r.taxMethod).toBe('FIXED_MOTORCYCLE');
      expect(r.annualVehicleTax).toBe(100);
    },
  );
});

describe('ส่วนลดตามอายุรถ', () => {
  it.each([
    [1, 0],
    [5, 0],
    [6, 0.1],
    [7, 0.2],
    [8, 0.3],
    [9, 0.4],
    [10, 0.5],
    [20, 0.5],
  ])('ปีที่ %d -> ลด %f', (year, rate) => {
    expect(getAgeDiscountRate(year)).toBe(rate);
  });

  it('ปีที่จดทะเบียนนับเป็นปีที่ 1', () => {
    expect(calculateVehicleYear(new Date(Date.UTC(2020, 5, 1)), new Date(Date.UTC(2020, 11, 31)))).toBe(1);
    expect(calculateVehicleYear(new Date(Date.UTC(2020, 5, 1)), new Date(Date.UTC(2025, 11, 31)))).toBe(6);
  });

  it('ปีที่ 6 ของ รย.1 cc=600 -> 300 ลด 10% = 270', () => {
    const r = calculateVehicleTax(
      input({ firstRegistrationDate: new Date(Date.UTC(2020, 0, 10)), taxExpiryDate: new Date(Date.UTC(2025, 11, 31)), paymentDate: new Date(Date.UTC(2025, 11, 1)) }),
      rules(),
    );
    expect(r.vehicleYear).toBe(6);
    expect(r.ageDiscountRate).toBe(0.1);
    expect(r.ageDiscountAmount).toBe(30);
    expect(r.taxAfterAgeDiscount).toBe(270);
    expect(r.annualVehicleTax).toBe(270);
  });

  it.each([
    ['รย.2-นั่ง 2 แถว', 1000],
    ['รย.3-กระบะบรรทุก', 1000],
  ])('%s ไม่ได้ส่วนลดอายุรถแม้รถเก่า', (vehicleType, weight) => {
    const r = calculateVehicleTax(
      input({
        vehicleType,
        engineCc: null,
        vehicleWeightKg: weight,
        firstRegistrationDate: new Date(Date.UTC(2005, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2025, 11, 31)),
        paymentDate: new Date(Date.UTC(2025, 11, 1)),
      }),
      rules(),
    );
    expect(r.ageDiscountRate).toBe(0);
    expect(r.ageDiscountAmount).toBe(0);
  });

  it('รย.12 ไม่ได้ส่วนลดอายุรถ', () => {
    const r = calculateVehicleTax(
      input({
        vehicleType: 'รย.12-300-799cc',
        firstRegistrationDate: new Date(Date.UTC(2005, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2025, 11, 31)),
        paymentDate: new Date(Date.UTC(2025, 11, 1)),
      }),
      rules(),
    );
    expect(r.ageDiscountRate).toBe(0);
    expect(r.annualVehicleTax).toBe(100);
  });

  it('BEV ไม่ได้ส่วนลดอายุรถ', () => {
    const r = calculateVehicleTax(
      input({
        fuel: 'ไฟฟ้า (BEV)',
        engineCc: null,
        vehicleWeightKg: 1600,
        firstRegistrationDate: new Date(Date.UTC(2010, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2025, 11, 31)),
        paymentDate: new Date(Date.UTC(2025, 11, 1)),
      }),
      rules(),
    );
    expect(r.taxMethod).toBe('WEIGHT_EV_RY1');
    expect(r.ageDiscountRate).toBe(0);
    expect(r.annualVehicleTax).toBe(1300);
  });
});

describe('ตัวคูณนิติบุคคล', () => {
  it('รย.1 นิติบุคคล -> x2 และคูณหลังหักส่วนลดอายุ', () => {
    const r = calculateVehicleTax(
      input({
        owner: JURISTIC,
        firstRegistrationDate: new Date(Date.UTC(2020, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2025, 11, 31)),
        paymentDate: new Date(Date.UTC(2025, 11, 1)),
      }),
      rules(),
    );
    expect(r.baseTax).toBe(300);
    expect(r.ageDiscountAmount).toBe(30);
    expect(r.taxAfterAgeDiscount).toBe(270);
    expect(r.companyMultiplier).toBe(2);
    expect(r.companyAdjustmentAmount).toBe(270);
    expect(r.annualVehicleTax).toBe(540);
  });

  it('บุคคลธรรมดา -> x1', () => {
    const r = calculateVehicleTax(input({ owner: INDIVIDUAL }), rules());
    expect(r.companyMultiplier).toBe(1);
    expect(r.companyAdjustmentAmount).toBe(0);
  });

  it('นิติบุคคลธุรกิจเช่าซื้อ ผู้เช่าซื้อเป็นบุคคลธรรมดา -> x1 (ข้อยกเว้น)', () => {
    const r = calculateVehicleTax(input({ owner: JURISTIC_HIRE_PURCHASE }), rules());
    expect(r.companyMultiplier).toBe(1);
    expect(r.annualVehicleTax).toBe(300);
  });

  it.each([
    ['รย.2-นั่ง 2 แถว', 1000, 450],
    ['รย.3-กระบะบรรทุก', 1000, 600],
  ])('%s นิติบุคคลไม่คูณสอง', (vehicleType, weight, expected) => {
    const r = calculateVehicleTax(
      input({ vehicleType, engineCc: null, vehicleWeightKg: weight, owner: JURISTIC }),
      rules(),
    );
    expect(r.companyMultiplier).toBe(1);
    expect(r.annualVehicleTax).toBe(expected);
  });

  it('รย.12 นิติบุคคลไม่คูณสอง', () => {
    const r = calculateVehicleTax(input({ vehicleType: 'รย.12-300-799cc', owner: JURISTIC }), rules());
    expect(r.companyMultiplier).toBe(1);
    expect(r.annualVehicleTax).toBe(100);
  });
});

describe('BEV และมาตรการ EV', () => {
  const bev = (overrides: Partial<VehicleTaxInput> = {}) =>
    input({ fuel: 'ไฟฟ้า (BEV)', engineCc: null, vehicleWeightKg: 1600, ...overrides });

  // น้ำหนัก 1600 กก. -> ช่วง 1501-1750 = 1300 บาท
  it('ไม่มีมาตรการ EV -> ตัวคูณ 1 พร้อมคำเตือน', () => {
    const r = calculateVehicleTax(bev(), rules());
    expect(r.fuelMultiplier).toBe(1);
    expect(r.annualVehicleTax).toBe(1300);
    expect(r.warnings.join()).toContain('ไม่พบมาตรการลดภาษีรถไฟฟ้า');
  });

  it('มีมาตรการ EV ลด 80% -> คิดส่วนลดครั้งเดียว', () => {
    const r = calculateVehicleTax(
      bev({ firstRegistrationDate: new Date(Date.UTC(2023, 0, 10)) }),
      rules({ evIncentives: [{ effectiveFrom: new Date(Date.UTC(2022, 0, 1)), effectiveTo: new Date(Date.UTC(2025, 11, 31)), discountPercent: 80 }] }),
    );
    expect(r.fuelMultiplier).toBeCloseTo(0.2);
    expect(r.annualVehicleTax).toBe(260);
    expect(r.warnings).toHaveLength(0);
  });

  it('วันจดทะเบียนนอกช่วงมาตรการ -> ไม่ลด', () => {
    const r = calculateVehicleTax(
      bev({ firstRegistrationDate: new Date(Date.UTC(2021, 0, 10)) }),
      rules({ evIncentives: [{ effectiveFrom: new Date(Date.UTC(2022, 0, 1)), effectiveTo: new Date(Date.UTC(2025, 11, 31)), discountPercent: 80 }] }),
    );
    expect(r.annualVehicleTax).toBe(1300);
  });

  it('BEV นิติบุคคล: คูณสองก่อนแล้วจึงลด EV', () => {
    const r = calculateVehicleTax(
      bev({ owner: JURISTIC, firstRegistrationDate: new Date(Date.UTC(2023, 0, 10)) }),
      rules({ evIncentives: [{ effectiveFrom: new Date(Date.UTC(2022, 0, 1)), effectiveTo: null, discountPercent: 80 }] }),
    );
    expect(r.companyMultiplier).toBe(2);
    expect(r.annualVehicleTax).toBe(520);
  });
});

describe('Policy เชื้อเพลิง NGV', () => {
  it('ไม่มี Policy -> ตัวคูณ 1 พร้อมคำเตือน (NGV อยู่กลุ่ม ICE จึงต้องเช็คจาก fuel ตรงๆ)', () => {
    const r = calculateVehicleTax(input({ fuel: 'NGV' }), rules());
    expect(r.govTaxFuelGroup).toBe(GovTaxFuelGroup.ICE);
    expect(r.fuelMultiplier).toBe(1);
    expect(r.warnings.join()).toContain('NGV');
  });

  it('มี Policy ลดครึ่ง -> คูณตาม Policy', () => {
    const r = calculateVehicleTax(
      input({ fuel: 'NGV' }),
      rules({ fuelPolicies: [{ fuel: 'NGV', multiplier: 0.5, effectiveFrom: new Date(Date.UTC(2020, 0, 1)) }] }),
    );
    expect(r.fuelMultiplier).toBe(0.5);
    expect(r.annualVehicleTax).toBe(150);
    expect(r.fuelAdjustmentAmount).toBe(150);
  });

  it('เบนซินไม่มี Policy -> ไม่มีคำเตือน', () => {
    const r = calculateVehicleTax(input(), rules());
    expect(r.warnings).toHaveLength(0);
  });
});

describe('จำนวนเดือนที่ล่าช้าและเงินเพิ่ม', () => {
  it('ชำระก่อนหรือตรงวันครบกำหนด -> 0 เดือน', () => {
    expect(calculateLateMonths(new Date(Date.UTC(2025, 11, 31)), new Date(Date.UTC(2025, 11, 1)))).toBe(0);
    expect(calculateLateMonths(new Date(Date.UTC(2025, 11, 31)), new Date(Date.UTC(2025, 11, 31)))).toBe(0);
  });

  it('เกิน 1 วันก็คิด 1 เดือน', () => {
    expect(calculateLateMonths(new Date(Date.UTC(2025, 0, 10)), new Date(Date.UTC(2025, 0, 11)))).toBe(1);
  });

  it('ครบเดือนพอดี -> 1 เดือน', () => {
    expect(calculateLateMonths(new Date(Date.UTC(2025, 0, 10)), new Date(Date.UTC(2025, 1, 10)))).toBe(1);
  });

  it('เศษของเดือนนับเป็นหนึ่งเดือน', () => {
    expect(calculateLateMonths(new Date(Date.UTC(2025, 0, 10)), new Date(Date.UTC(2025, 1, 11)))).toBe(2);
  });

  it('ข้ามปี', () => {
    expect(calculateLateMonths(new Date(Date.UTC(2024, 11, 31)), new Date(Date.UTC(2025, 11, 31)))).toBe(12);
  });

  it('เงินเพิ่ม 1% ต่อเดือนของภาษีสุทธิ', () => {
    const r = calculateVehicleTax(
      input({ engineCc: 2000, taxExpiryDate: new Date(Date.UTC(2025, 0, 10)), paymentDate: new Date(Date.UTC(2025, 3, 10)) }),
      rules(),
    );
    expect(r.annualVehicleTax).toBe(2900);
    expect(r.lateMonths).toBe(3);
    expect(r.lateFee).toBe(87);
  });

  it('ชำระตรงเวลา -> ไม่มีเงินเพิ่ม', () => {
    const r = calculateVehicleTax(input(), rules());
    expect(r.lateMonths).toBe(0);
    expect(r.lateFee).toBe(0);
  });

});

describe('ค้างภาษีหลายรอบปี - คิดแยกรอบแล้วรวม', () => {
  it('ชำระตรงเวลา -> 1 รอบ', () => {
    const r = calculateVehicleTax(input(), rules());
    expect(r.taxCycleCount).toBe(1);
    expect(r.cycles[0].lateMonths).toBe(0);
  });

  it('เลยกำหนด 1 วัน -> ยังเป็น 1 รอบ (ไม่ใช่ 2)', () => {
    const r = calculateVehicleTax(
      input({ taxExpiryDate: new Date(Date.UTC(2025, 0, 10)), paymentDate: new Date(Date.UTC(2025, 0, 11)) }),
      rules(),
    );
    expect(r.taxCycleCount).toBe(1);
    expect(r.lateMonths).toBe(1);
  });

  it('ค้าง 2 รอบ -> คิดภาษีสองรอบและเงินเพิ่มแยกรอบ', () => {
    const r = calculateVehicleTax(
      input({
        engineCc: 2000,
        firstRegistrationDate: new Date(Date.UTC(2022, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2023, 0, 10)),
        paymentDate: new Date(Date.UTC(2025, 0, 5)),
      }),
      rules(),
    );
    expect(r.taxCycleCount).toBe(2);
    expect(r.cycles.map((c) => c.dueDate.getFullYear())).toEqual([2023, 2024]);
    // รย.1 cc=2000 = 2900 บาท ทั้งสองรอบ (ปีที่ 2 และ 3 ยังไม่ถึงเกณฑ์ลดอายุ)
    expect(r.cycles.map((c) => c.annualVehicleTax)).toEqual([2900, 2900]);
    expect(r.annualVehicleTax).toBe(5800);
    // เงินเพิ่ม: รอบแรกช้า 24 เดือน, รอบสองช้า 12 เดือน
    expect(r.cycles.map((c) => c.lateMonths)).toEqual([24, 12]);
    expect(r.lateFee).toBe(roundTo2(2900 * 0.01 * 24 + 2900 * 0.01 * 12));
    expect(r.grandTotal).toBe(roundTo2(5800 + 2900 * 0.01 * 36));
  });

  it('ส่วนลดอายุรถคิดตามปีของแต่ละรอบ ไม่ใช่ค่าเดียวทั้งก้อน', () => {
    // จดทะเบียน 2019 -> รอบครบกำหนด 2024 = ปีที่ 6 (ลด 10%), รอบ 2025 = ปีที่ 7 (ลด 20%)
    const r = calculateVehicleTax(
      input({
        engineCc: 600,
        firstRegistrationDate: new Date(Date.UTC(2019, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2024, 0, 10)),
        paymentDate: new Date(Date.UTC(2025, 5, 1)),
      }),
      rules(),
    );
    expect(r.taxCycleCount).toBe(2);
    expect(r.cycles.map((c) => c.vehicleYear)).toEqual([6, 7]);
    expect(r.cycles.map((c) => c.ageDiscountRate)).toEqual([0.1, 0.2]);
    expect(r.cycles.map((c) => c.annualVehicleTax)).toEqual([270, 240]);
    expect(r.annualVehicleTax).toBe(510);
  });

  it('ค้างเกิน 3 ปี -> เตือนเรื่องทะเบียนระงับ', () => {
    const r = calculateVehicleTax(
      input({
        firstRegistrationDate: new Date(Date.UTC(2018, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2020, 0, 10)),
        paymentDate: new Date(Date.UTC(2025, 0, 5)),
      }),
      rules(),
    );
    expect(r.taxCycleCount).toBe(5);
    expect(r.warnings.join()).toContain('ทะเบียนอาจถูกระงับ');
  });

  it('ใบคำนวณแสดงรายรอบเมื่อค้างหลายปี', () => {
    const r = calculateVehicleTax(
      input({
        firstRegistrationDate: new Date(Date.UTC(2022, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2023, 0, 10)),
        paymentDate: new Date(Date.UTC(2025, 0, 5)),
      }),
      rules(),
    );
    expect(r.calculationDetails.map((d) => d.label)).toContain('จำนวนรอบปีภาษีที่ค้างชำระ');
  });
});

describe('เงื่อนไขตรวจสภาพ (ตรอ.)', () => {
  // ครบ 7 ปี / ครบ 5 ปี แบบ date-to-date (>= ไม่ใช่ >)
  it.each([
    ['รย.1', 6, 0, false],
    ['รย.1', 7, 0, true],
    ['รย.1', 8, 0, true],
    ['รย.2', 7, 0, true],
    ['รย.3', 7, 0, true],
    ['รย.12', 4, 0, false],
    ['รย.12', 5, 0, true],
    ['รย.12', 6, 0, true],
    ['รย.1', 1, 2, true],
    ['รย.12', 1, 2, true],
    ['รย.1', 1, 1, false],
  ] as const)('%s อายุ %d ปี ค้างภาษี %d ปี -> %s', (code, age, overdue, expected) => {
    expect(requiresInspection(code, age, overdue)).toBe(expected);
  });

  it('ครบ 7 ปีพอดีแบบ date-to-date -> ต้องตรวจ', () => {
    const r = calculateVehicleTax(
      input({
        firstRegistrationDate: new Date(Date.UTC(2018, 5, 1)),
        taxExpiryDate: new Date(Date.UTC(2025, 5, 1)),
        paymentDate: new Date(Date.UTC(2025, 5, 1)),
      }),
      rules(),
    );
    expect(r.vehicleAgeYears).toBe(7);
    expect(r.inspectionRequired).toBe(true);
  });

  it('ขาดอีก 1 วันจะครบ 7 ปี -> ยังไม่ต้องตรวจ', () => {
    const r = calculateVehicleTax(
      input({
        firstRegistrationDate: new Date(Date.UTC(2018, 5, 2)),
        taxExpiryDate: new Date(Date.UTC(2025, 5, 1)),
        paymentDate: new Date(Date.UTC(2025, 5, 1)),
      }),
      rules(),
    );
    expect(r.vehicleAgeYears).toBe(6);
    expect(r.inspectionRequired).toBe(false);
  });

  it('รถเกิน 7 ปีและยังไม่ติ๊กว่ามีใบตรวจ -> เตือน', () => {
    const r = calculateVehicleTax(
      input({ firstRegistrationDate: new Date(Date.UTC(2015, 0, 10)), taxExpiryDate: new Date(Date.UTC(2025, 11, 31)), paymentDate: new Date(Date.UTC(2025, 11, 1)) }),
      rules(),
    );
    expect(r.inspectionRequired).toBe(true);
    expect(r.warnings.join()).toContain('ตรอ.');
  });

  it('ติ๊กว่ามีใบตรวจแล้ว -> ไม่เตือน', () => {
    const r = calculateVehicleTax(
      input({
        firstRegistrationDate: new Date(Date.UTC(2015, 0, 10)),
        taxExpiryDate: new Date(Date.UTC(2025, 11, 31)),
        paymentDate: new Date(Date.UTC(2025, 11, 1)),
        inspectionCertificateConfirmed: true,
      }),
      rules(),
    );
    expect(r.inspectionRequired).toBe(true);
    expect(r.warnings).toHaveLength(0);
  });

  it('รถใหม่ไม่ต้องตรวจ', () => {
    const r = calculateVehicleTax(input(), rules());
    expect(r.inspectionRequired).toBe(false);
  });
});

describe('ค่าใช้จ่ายอื่นและยอดรวม', () => {
  it('รวมทุกรายการ', () => {
    const r = calculateVehicleTax(
      input({
        engineCc: 2000,
        taxExpiryDate: new Date(Date.UTC(2025, 0, 10)),
        paymentDate: new Date(Date.UTC(2025, 3, 10)),
        compulsoryInsuranceFee: 645.21,
        inspectionFee: 200,
        serviceFee: 300,
        deliveryFee: 100,
      }),
      rules(),
    );
    expect(r.annualVehicleTax).toBe(2900);
    expect(r.lateFee).toBe(87);
    expect(r.grandTotal).toBe(roundTo2(2900 + 87 + 645.21 + 200 + 300 + 100));
  });

  it('ไม่ส่งค่าใช้จ่ายมา -> นับเป็น 0', () => {
    const r = calculateVehicleTax(input(), rules());
    expect(r.compulsoryInsuranceFee).toBe(0);
    expect(r.grandTotal).toBe(300);
  });
});

describe('Validation', () => {
  it('เชื้อเพลิงไม่รองรับ', () => {
    expect(() => calculateVehicleTax(input({ fuel: 'ไฮโดรเจน' }), rules())).toThrow(VehicleTaxInputError);
  });

  it('ประเภทรถระบุกลุ่ม รย. ไม่ได้', () => {
    expect(() => calculateVehicleTax(input({ vehicleType: 'รถไถ' }), rules())).toThrow(VehicleTaxInputError);
  });

  it.each([null, 0, -100])('รย.1 ICE ต้องมี cc ที่ถูกต้อง (%s)', (engineCc) => {
    expect(() => calculateVehicleTax(input({ engineCc }), rules())).toThrow('ความจุเครื่องยนต์');
  });

  it.each([null, 0, -1])('รย.2 ต้องมีน้ำหนักที่ถูกต้อง (%s)', (vehicleWeightKg) => {
    expect(() =>
      calculateVehicleTax(input({ vehicleType: 'รย.2-นั่ง 2 แถว', engineCc: null, vehicleWeightKg }), rules()),
    ).toThrow('น้ำหนักรถ');
  });

  it('BEV รย.1 ต้องมีน้ำหนัก', () => {
    expect(() =>
      calculateVehicleTax(input({ fuel: 'ไฟฟ้า (BEV)', engineCc: null, vehicleWeightKg: null }), rules()),
    ).toThrow('น้ำหนักรถ');
  });

  it('วันจดทะเบียนอยู่หลังวันครบกำหนดภาษี', () => {
    expect(() =>
      calculateVehicleTax(input({ firstRegistrationDate: new Date(Date.UTC(2026, 0, 1)), taxExpiryDate: new Date(Date.UTC(2025, 11, 31)) }), rules()),
    ).toThrow('วันจดทะเบียนครั้งแรก');
  });

  it('วันที่ไม่ถูกต้อง', () => {
    expect(() => calculateVehicleTax(input({ paymentDate: new Date('ไม่ใช่วันที่') }), rules())).toThrow('วันที่ชำระ');
  });

  it.each([
    ['compulsoryInsuranceFee', 'ค่า พ.ร.บ.'],
    ['inspectionFee', 'ค่าตรวจสภาพ'],
    ['serviceFee', 'ค่าบริการ'],
    ['deliveryFee', 'ค่าจัดส่ง'],
  ] as const)('%s ติดลบไม่ได้', (field, label) => {
    expect(() => calculateVehicleTax(input({ [field]: -1 }), rules())).toThrow(label);
  });

  it('ยังไม่ระบุประเภทเจ้าของรถ รย.1', () => {
    expect(() => calculateVehicleTax(input({ owner: null }), rules())).toThrow(VehicleTaxInputError);
  });
});

describe('ใบคำนวณ', () => {
  it('แสดงรายการตามลำดับที่กำหนด', () => {
    const r = calculateVehicleTax(input(), rules());
    expect(r.calculationDetails.map((d) => d.label)).toEqual([
      'ประเภทรถ',
      'รหัสประเภทรถ',
      'เชื้อเพลิง',
      'กลุ่มเชื้อเพลิงตามภาษี',
      'วิธีคำนวณภาษี',
      'ภาษีพื้นฐาน',
      'ส่วนลดตามอายุรถ',
      'ภาษีหลังหักส่วนลดอายุ',
      'ตัวคูณนิติบุคคล',
      'Policy เชื้อเพลิง',
      'ภาษีรถประจำปีสุทธิ',
      'จำนวนเดือนที่ล่าช้า',
      'เงินเพิ่มกรณีล่าช้า',
      'ค่า พ.ร.บ.',
      'ต้องตรวจสภาพ (ตรอ.)',
      'ค่าตรวจสภาพ',
      'ค่าบริการ',
      'ค่าจัดส่ง',
      'ยอดรวมที่ต้องชำระ',
    ]);
  });

  it('มีคำเตือนต่อท้ายเมื่อมีคำเตือน', () => {
    const r = calculateVehicleTax(input({ fuel: 'NGV' }), rules());
    expect(r.calculationDetails.at(-1)?.label).toBe('คำเตือน');
  });
});

function roundTo2(n: number) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
