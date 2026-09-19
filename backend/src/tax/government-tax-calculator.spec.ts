import { calculateGovernmentTax, GovernmentTaxOwnerInput, GovernmentTaxRuleSet, GovernmentTaxVehicleInput } from './government-tax-calculator.js';
import { GovTaxFuelGroup, GovTaxVehicleFamily, OwnerType } from '../generated/prisma/enums.js';

// Fixture matching the real VERIFIED rows in backend/prisma/seed.ts (0-600@0.5, 600-1800@1.5,
// 1800+@4 บาท/cc for RY1 ICE/HEV/PHEV; RY12 ICE flat 100 บาท/ปี). Weight brackets/EV incentive
// are extra fixture-only rows (not real production data) purely to exercise those code paths.
function baseRules(overrides: Partial<GovernmentTaxRuleSet> = {}): GovernmentTaxRuleSet {
  return {
    ccBrackets: [
      { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 0, ccTo: 600, ratePerCc: 0.5 },
      { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 600, ccTo: 1800, ratePerCc: 1.5 },
      { fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 1800, ccTo: null, ratePerCc: 4 },
    ],
    weightBrackets: [],
    evIncentives: [],
    motorcycleFlat: [{ fuelGroup: GovTaxFuelGroup.ICE, amount: 100 }],
    ...overrides,
  };
}

function vehicle(overrides: Partial<GovernmentTaxVehicleInput> = {}): GovernmentTaxVehicleInput {
  return { body: 'รย.1-เก๋ง 2 ตอน', fuel: 'เบนซิน', cc: 600, weight: null, firstRegistrationDate: null, ...overrides };
}

const INDIVIDUAL: GovernmentTaxOwnerInput = { ownerType: OwnerType.INDIVIDUAL, isHirePurchaseBusiness: false, hirerType: null };
const JURISTIC: GovernmentTaxOwnerInput = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: false, hirerType: null };
const JURISTIC_HIRE_PURCHASE_INDIVIDUAL_HIRER: GovernmentTaxOwnerInput = {
  ownerType: OwnerType.JURISTIC,
  isHirePurchaseBusiness: true,
  hirerType: OwnerType.INDIVIDUAL,
};
const JURISTIC_HIRE_PURCHASE_JURISTIC_HIRER: GovernmentTaxOwnerInput = {
  ownerType: OwnerType.JURISTIC,
  isHirePurchaseBusiness: true,
  hirerType: OwnerType.JURISTIC,
};

describe('calculateGovernmentTax - RY1 CC boundaries (progressive, continuous thresholds)', () => {
  it.each([
    [600, 300], // เกณฑ์แรกพอดี: 600 x 0.5
    [601, 301.5], // เกินเกณฑ์แรก 1cc: 300 + 1x1.5
    [1800, 2100], // เกณฑ์ที่สองพอดี: 300 + 1200x1.5
    [1801, 2104], // เกินเกณฑ์ที่สอง 1cc: 2100 + 1x4
  ])('cc=%d -> base tax %f บาท', (cc, expected) => {
    const result = calculateGovernmentTax(vehicle({ cc }), INDIVIDUAL, baseRules());
    expect(result.reason).toBeNull();
    expect(result.amount).toBe(expected);
  });
});

describe('calculateGovernmentTax - juristic multiplier matrix (RY1)', () => {
  it('individual owner -> x1', () => {
    const result = calculateGovernmentTax(vehicle({ cc: 600 }), INDIVIDUAL, baseRules());
    expect(result.juristicMultiplier).toBe(1);
    expect(result.amount).toBe(300);
  });

  it('juristic owner, not hire-purchase -> x2', () => {
    const result = calculateGovernmentTax(vehicle({ cc: 600 }), JURISTIC, baseRules());
    expect(result.juristicMultiplier).toBe(2);
    expect(result.amount).toBe(600);
  });

  it('juristic hire-purchase business + individual hirer -> exception, x1', () => {
    const result = calculateGovernmentTax(vehicle({ cc: 600 }), JURISTIC_HIRE_PURCHASE_INDIVIDUAL_HIRER, baseRules());
    expect(result.juristicMultiplier).toBe(1);
    expect(result.amount).toBe(300);
  });

  it('juristic hire-purchase business + juristic hirer -> no exception, x2', () => {
    const result = calculateGovernmentTax(vehicle({ cc: 600 }), JURISTIC_HIRE_PURCHASE_JURISTIC_HIRER, baseRules());
    expect(result.juristicMultiplier).toBe(2);
    expect(result.amount).toBe(600);
  });

  it('missing owner for RY1 -> MISSING_INPUT, never guesses individual', () => {
    const result = calculateGovernmentTax(vehicle({ cc: 600 }), null, baseRules());
    expect(result.amount).toBeNull();
    expect(result.reason).toContain('ต้องระบุประเภทเจ้าของรถ');
  });

  it('RY2/RY3/RY12 never double even for a juristic owner', () => {
    const ry2 = calculateGovernmentTax(
      { body: 'รย.2-นั่ง 2 แถว', fuel: 'เบนซิน', cc: null, weight: 1500, firstRegistrationDate: null },
      JURISTIC,
      baseRules({ weightBrackets: [{ vehicleFamily: GovTaxVehicleFamily.RY2, fuelGroup: null, weightFrom: 0, weightTo: null, amount: 500 }] }),
    );
    expect(ry2.juristicMultiplier).toBe(1);
    expect(ry2.amount).toBe(500);

    const ry12 = calculateGovernmentTax(
      { body: 'รย.12-น้อยกว่า 300cc', fuel: 'เบนซิน', cc: null, weight: null, firstRegistrationDate: null },
      JURISTIC,
      baseRules(),
    );
    expect(ry12.juristicMultiplier).toBe(1);
    expect(ry12.amount).toBe(100);
  });
});

describe('calculateGovernmentTax - RY12 motorcycle flat', () => {
  it('ICE -> 100 บาท/ปี (VERIFIED ในระบบจริง)', () => {
    const result = calculateGovernmentTax(
      { body: 'รย.12-300-799cc', fuel: 'เบนซิน', cc: null, weight: null, firstRegistrationDate: null },
      INDIVIDUAL,
      baseRules(),
    );
    expect(result.amount).toBe(100);
    expect(result.reason).toBeNull();
  });

  it('BEV -> ยังไม่มีอัตรา -> MISSING_VERIFIED_RULE, ไม่คืน 0', () => {
    const result = calculateGovernmentTax(
      { body: 'รย.12-300-799cc', fuel: 'ไฟฟ้า (BEV)', cc: null, weight: null, firstRegistrationDate: null },
      INDIVIDUAL,
      baseRules(),
    );
    expect(result.amount).toBeNull();
    expect(result.reason).toContain('อัตราภาษี');
  });
});

// รย.2 กับ รย.3 มี fuelGroup = null เหมือนกัน - ต้องแยกตารางด้วย vehicleFamily เท่านั้น
// ค่าจริงตรงกับ seed.ts (ตารางที่ผู้ใช้ยืนยัน: รย.2 และ รย.3 คนละคอลัมน์)
describe('calculateGovernmentTax - RY2 vs RY3 weight tables stay separate', () => {
  const ry2Amounts = [150, 300, 450, 800, 1000, 1300, 1600, 1900, 2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600];
  const ry3Amounts = [300, 450, 600, 750, 900, 1050, 1350, 1650, 1950, 2250, 2550, 2850, 3150, 3450, 3750, 4050];
  const bounds: Array<[number, number | null]> = [
    [0, 500], [500, 750], [750, 1000], [1000, 1250], [1250, 1500], [1500, 1750], [1750, 2000], [2000, 2500],
    [2500, 3000], [3000, 3500], [3500, 4000], [4000, 4500], [4500, 5000], [5000, 6000], [6000, 7000], [7000, null],
  ];
  const table = (family: GovTaxVehicleFamily, amounts: number[]) =>
    bounds.map(([weightFrom, weightTo], i) => ({ vehicleFamily: family, fuelGroup: null, weightFrom, weightTo, amount: amounts[i] }));
  // สลับลำดับแถว RY3 มาก่อน RY2 ตั้งใจ - ต้องไม่ขึ้นกับลำดับที่ DB คืนมา
  const rules = baseRules({ weightBrackets: [...table(GovTaxVehicleFamily.RY3, ry3Amounts), ...table(GovTaxVehicleFamily.RY2, ry2Amounts)].reverse() });

  it.each([
    [500, 150], [501, 300], [750, 300], [1000, 450], [1500, 1000], [1751, 1600], [7000, 3400], [7001, 3600],
  ])('รย.2 น้ำหนัก %d กก. -> %d บาท (≤ ขอบบนเป็นของช่วงล่าง)', (weight, expected) => {
    const result = calculateGovernmentTax({ body: 'รย.2-นั่ง 2 แถว', fuel: 'ดีเซล', cc: null, weight, firstRegistrationDate: null }, INDIVIDUAL, rules);
    expect(result.amount).toBe(expected);
  });

  it.each([
    [500, 300], [501, 450], [750, 450], [1000, 600], [1500, 900], [1751, 1350], [7000, 3750], [7001, 4050],
  ])('รย.3 น้ำหนัก %d กก. -> %d บาท (ใช้ตาราง รย.3 ไม่ใช่ รย.2)', (weight, expected) => {
    const result = calculateGovernmentTax({ body: 'รย.3-กระบะบรรทุก', fuel: 'ดีเซล', cc: null, weight, firstRegistrationDate: null }, INDIVIDUAL, rules);
    expect(result.amount).toBe(expected);
  });

  it('รย.3 เจ้าของนิติบุคคล -> ไม่คูณสอง', () => {
    const result = calculateGovernmentTax({ body: 'รย.3-กระบะบรรทุกมีหลังคา', fuel: 'ดีเซล', cc: null, weight: 1500, firstRegistrationDate: null }, JURISTIC, rules);
    expect(result.juristicMultiplier).toBe(1);
    expect(result.amount).toBe(900);
  });
});

describe('calculateGovernmentTax - fail closed when no verified rate exists', () => {
  it('RY1-BEV/RY2/RY3 ไม่มี weight bracket -> MISSING_VERIFIED_RULE, ไม่คืน 0', () => {
    const cases: GovernmentTaxVehicleInput[] = [
      { body: 'รย.1-เก๋ง 2 ตอน', fuel: 'ไฟฟ้า (BEV)', cc: null, weight: 1500, firstRegistrationDate: null },
      { body: 'รย.2-นั่ง 2 แถว', fuel: 'เบนซิน', cc: null, weight: 1500, firstRegistrationDate: null },
      { body: 'รย.3-กระบะบรรทุก', fuel: 'เบนซิน', cc: null, weight: 1500, firstRegistrationDate: null },
    ];
    for (const v of cases) {
      const result = calculateGovernmentTax(v, INDIVIDUAL, baseRules());
      expect(result.amount).toBeNull();
      expect(result.reason).toContain('ตารางอัตรา');
    }
  });

  it('rule ที่ไม่ผ่านการกรอง active+VERIFIED ที่ TaxService จะไม่ถูกส่งเข้ามาเลย จึงคำนวณไม่ได้เหมือนไม่มีข้อมูล', () => {
    // จำลองผลของ TaxService.loadRuleSet() ที่กรอง DRAFT/inactive ออกไปแล้ว - ruleset ว่างเปล่า
    const result = calculateGovernmentTax(vehicle({ cc: 600 }), INDIVIDUAL, baseRules({ ccBrackets: [] }));
    expect(result.amount).toBeNull();
    expect(result.reason).toContain('ตารางอัตรา');
  });
});

describe('calculateGovernmentTax - EV incentive (fixture only, not real production data)', () => {
  const rulesWithIncentive = baseRules({
    weightBrackets: [{ vehicleFamily: GovTaxVehicleFamily.RY1, fuelGroup: GovTaxFuelGroup.BEV, weightFrom: 0, weightTo: null, amount: 1000 }],
    evIncentives: [{ effectiveFrom: new Date('2026-01-01T00:00:00.000Z'), effectiveTo: new Date('2026-12-31T23:59:59.999Z'), discountPercent: 80 }],
  });
  const bevVehicle: GovernmentTaxVehicleInput = {
    body: 'รย.1-เก๋ง 2 ตอน',
    fuel: 'ไฟฟ้า (BEV)',
    cc: null,
    weight: 1500,
    firstRegistrationDate: new Date('2026-06-01T00:00:00.000Z'),
  };

  it('individual + สิทธิ EV -> base x (1 - 80%)', () => {
    const result = calculateGovernmentTax(bevVehicle, INDIVIDUAL, rulesWithIncentive);
    expect(result.baseAmount).toBe(1000);
    expect(result.discountPercent).toBe(80);
    expect(result.juristicMultiplier).toBe(1);
    expect(result.amount).toBe(200);
  });

  it('juristic doubles ก่อน แล้วค่อยหักสิทธิ EV (1000 x2 x20% = 400)', () => {
    const result = calculateGovernmentTax(bevVehicle, JURISTIC, rulesWithIncentive);
    expect(result.juristicMultiplier).toBe(2);
    expect(result.amount).toBe(400);
  });

  it('วันจดทะเบียนอยู่นอกช่วงสิทธิ -> ไม่ได้ส่วนลด', () => {
    const outOfWindow = { ...bevVehicle, firstRegistrationDate: new Date('2027-01-01T00:00:00.000Z') };
    const result = calculateGovernmentTax(outOfWindow, INDIVIDUAL, rulesWithIncentive);
    expect(result.discountPercent).toBeNull();
    expect(result.amount).toBe(1000);
  });
});

describe('calculateGovernmentTax - satang rounding precision (BigInt micro-baht math)', () => {
  it('ทศนิยม 4 ตำแหน่งของ rate x cc 2 ตำแหน่ง ปัดสตางค์แบบ half-up ไม่คลาดเคลื่อนจาก float', () => {
    const rules = baseRules({ ccBrackets: [{ fuelGroup: GovTaxFuelGroup.ICE, ccFrom: 0, ccTo: null, ratePerCc: 1.2345 }] });
    const result = calculateGovernmentTax(vehicle({ cc: 333.33 }), INDIVIDUAL, rules);
    // 333.33 x 1.2345 = 411.495885 บาท -> ปัดสตางค์ half-up = 411.50 บาท (41150 สตางค์)
    expect(result.amountSatang).toBe(41150);
    expect(result.amount).toBe(411.5);
  });
});
