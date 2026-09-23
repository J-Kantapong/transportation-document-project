// ใบคำนวณภาษีรถประจำปีสำหรับงานต่อภาษี (ต่อภาษี) - ภาษีรถ + เงินเพิ่มกรณีล่าช้า + ค่าใช้จ่ายอื่น
//
// อัตราภาษีตามกฎหมาย (ตาราง cc / น้ำหนัก / จักรยานยนต์เหมาจ่าย / มาตรการ EV) ไม่ได้เขียนไว้ในไฟล์นี้
// แต่อ่านจากตาราง GovernmentTax* ผ่าน calculateGovernmentTax() ตัวเดียวกับที่ขั้นตอนที่ 4 ใช้ เพื่อให้
// ยอดภาษีของงานจดใหม่กับงานต่อภาษีมาจากแหล่งเดียวกันเสมอ (แก้อัตราที่เดียว ไม่มีทางเพี้ยนคนละทาง)
//
// ส่วนที่เป็นของงานต่อภาษีโดยเฉพาะและไม่มีในขั้นตอนที่ 4: ส่วนลดตามอายุรถ (รย.1 ที่คิดตาม cc),
// เงินเพิ่ม 1% ต่อเดือนเมื่อชำระช้า, เงื่อนไขต้องตรวจสภาพ (ตรอ.) และค่าใช้จ่ายนอกภาษี
//
// ลำดับการคำนวณ (ห้ามสลับ - ผลลัพธ์ต่างกัน):
//   ภาษีพื้นฐาน -> หักส่วนลดอายุรถ -> คูณนิติบุคคล -> ปรับตาม Policy เชื้อเพลิง/EV -> ภาษีสุทธิ
import { GovTaxFuelGroup, GovTaxVehicleFamily } from '../generated/prisma/enums.js';
import {
  calculateGovernmentTax,
  GovernmentTaxOwnerInput,
  GovernmentTaxRuleSet,
} from '../tax/government-tax-calculator.js';

export type VehicleFuel =
  | 'เบนซิน'
  | 'ดีเซล'
  | 'LPG'
  | 'NGV'
  | 'ไฮบริด (HEV)'
  | 'ปลั๊กอินไฮบริด (PHEV)'
  | 'ไฟฟ้า (BEV)';

export type TaxMethod =
  | 'FIXED_MOTORCYCLE'
  | 'ENGINE_CC_RY1'
  | 'WEIGHT_RY2'
  | 'WEIGHT_RY3'
  | 'WEIGHT_EV_RY1';

// แปลง Vehicle.fuel -> กลุ่มเชื้อเพลิงที่ใช้เลือกสูตรภาษี ห้ามรับ govTaxFuelGroup จากผู้ใช้โดยตรง
export const GOV_TAX_FUEL_GROUP_MAP: Record<VehicleFuel, GovTaxFuelGroup> = {
  เบนซิน: GovTaxFuelGroup.ICE,
  ดีเซล: GovTaxFuelGroup.ICE,
  LPG: GovTaxFuelGroup.ICE,
  NGV: GovTaxFuelGroup.ICE,
  'ไฮบริด (HEV)': GovTaxFuelGroup.HEV,
  'ปลั๊กอินไฮบริด (PHEV)': GovTaxFuelGroup.PHEV,
  'ไฟฟ้า (BEV)': GovTaxFuelGroup.BEV,
};

const REGISTRATION_CODE_BY_FAMILY: Record<GovTaxVehicleFamily, string> = {
  [GovTaxVehicleFamily.RY1]: 'รย.1',
  [GovTaxVehicleFamily.RY2]: 'รย.2',
  [GovTaxVehicleFamily.RY3]: 'รย.3',
  [GovTaxVehicleFamily.RY12]: 'รย.12',
};

// Policy ตัวคูณเชื้อเพลิง (เช่น NGV) - ยังไม่มีตารางในฐานข้อมูล ส่งเป็น [] ได้ แล้วจะใช้ตัวคูณ 1
export interface FuelTaxPolicyRow {
  fuel: string;
  multiplier: number | string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
}

export interface VehicleTaxRuleSet extends GovernmentTaxRuleSet {
  fuelPolicies?: FuelTaxPolicyRow[];
}

export interface VehicleTaxInput {
  vehicleType: string; // Vehicle.body เช่น 'รย.1-เก๋ง 2 ตอน'
  fuel: string; // Vehicle.fuel
  engineCc?: number | string | null;
  vehicleWeightKg?: number | string | null;
  firstRegistrationDate: Date;
  taxExpiryDate: Date; // วันครบกำหนดภาษีของรอบที่กำลังต่อ
  paymentDate: Date;
  owner?: GovernmentTaxOwnerInput | null;
  // ติ๊กว่ามีใบตรวจสภาพ (ตรอ.) แล้ว - ร้านไม่ได้รับตรวจเอง ใช้ตรวจความครบของเอกสารเท่านั้น
  inspectionCertificateConfirmed?: boolean;
  compulsoryInsuranceFee?: number | null;
  inspectionFee?: number | null;
  serviceFee?: number | null;
  deliveryFee?: number | null;
}

export interface VehicleTaxCalculationDetail {
  label: string;
  formula?: string;
  amount?: number;
}

// หนึ่งรอบปีภาษี - ค้างหลายปีต้องคิดภาษีและเงินเพิ่มแยกรอบ เพราะส่วนลดอายุรถของแต่ละรอบไม่เท่ากัน
export interface VehicleTaxCycle {
  dueDate: Date;
  vehicleYear: number;
  baseTax: number;
  ageDiscountRate: number;
  ageDiscountAmount: number;
  taxAfterAgeDiscount: number;
  companyMultiplier: number;
  companyAdjustmentAmount: number;
  fuelMultiplier: number;
  fuelAdjustmentAmount: number;
  annualVehicleTax: number;
  lateMonths: number;
  lateFee: number;
}

export interface VehicleTaxResult {
  vehicleType: string;
  registrationCode: string;

  fuel: string;
  govTaxFuelGroup: GovTaxFuelGroup;
  taxMethod: TaxMethod;

  engineCc: number | null;
  vehicleWeightKg: number | null;
  vehicleYear: number;
  vehicleAgeYears: number;

  baseTax: number;

  ageDiscountRate: number;
  ageDiscountAmount: number;
  taxAfterAgeDiscount: number;

  companyMultiplier: number;
  companyAdjustmentAmount: number;

  fuelMultiplier: number;
  fuelAdjustmentAmount: number;

  annualVehicleTax: number;

  lateMonths: number;
  lateFee: number;

  // ค้างหลายรอบปี: ตัวเลขเงินด้านบนเป็นยอดรวมทุกรอบ ส่วนอัตรา/ตัวคูณมาจากรอบแรกที่ค้าง - ดูรายรอบใน cycles
  taxCycleCount: number;
  cycles: VehicleTaxCycle[];

  compulsoryInsuranceFee: number;
  inspectionRequired: boolean;
  inspectionFee: number;
  serviceFee: number;
  deliveryFee: number;

  grandTotal: number;

  warnings: string[];
  calculationDetails: VehicleTaxCalculationDetail[];
}

export class VehicleTaxInputError extends Error {}

const MAX_TAX_CYCLES = 10;

const roundSatang = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function requireFee(value: number | null | undefined, label: string): number {
  const n = toNumber(value);
  if (n === null) return 0;
  if (n < 0) throw new VehicleTaxInputError(`${label}ต้องไม่ติดลบ`);
  return n;
}

export function resolveTaxMethod(
  family: GovTaxVehicleFamily,
  fuelGroup: GovTaxFuelGroup,
): TaxMethod {
  if (family === GovTaxVehicleFamily.RY12) return 'FIXED_MOTORCYCLE';
  if (family === GovTaxVehicleFamily.RY2) return 'WEIGHT_RY2';
  if (family === GovTaxVehicleFamily.RY3) return 'WEIGHT_RY3';
  return fuelGroup === GovTaxFuelGroup.BEV ? 'WEIGHT_EV_RY1' : 'ENGINE_CC_RY1';
}

// วันที่ทุกใบในระบบถูกเก็บเป็นเที่ยงคืน UTC (ดู parseTaxDate) จึงอ่านส่วนประกอบวันแบบ UTC ทั้งหมด
// ถ้าอ่านแบบ local เครื่องที่ตั้ง timezone ติดลบจะเลื่อนวันไป 1 วันและทำให้เดือนที่ล่าช้าเพี้ยน
// ปีที่จดทะเบียนครั้งแรกนับเป็นปีที่ 1 (ไม่ใช่อายุรถแบบครบรอบวัน) - ใช้กับส่วนลดอายุรถเท่านั้น
export function calculateVehicleYear(firstRegistrationDate: Date, taxExpiryDate: Date): number {
  return Math.max(1, taxExpiryDate.getUTCFullYear() - firstRegistrationDate.getUTCFullYear() + 1);
}

export function getAgeDiscountRate(vehicleYear: number): number {
  if (vehicleYear <= 5) return 0;
  if (vehicleYear === 6) return 0.1;
  if (vehicleYear === 7) return 0.2;
  if (vehicleYear === 8) return 0.3;
  if (vehicleYear === 9) return 0.4;
  return 0.5;
}

// เกินวันหมดภาษีแม้วันเดียวคิดอย่างน้อย 1 เดือน เศษเดือนปัดขึ้นเป็นหนึ่งเดือน
export function calculateLateMonths(taxExpiryDate: Date, paymentDate: Date): number {
  if (paymentDate <= taxExpiryDate) return 0;
  let months =
    (paymentDate.getUTCFullYear() - taxExpiryDate.getUTCFullYear()) * 12 +
    (paymentDate.getUTCMonth() - taxExpiryDate.getUTCMonth());
  if (paymentDate.getUTCDate() > taxExpiryDate.getUTCDate()) months += 1;
  return Math.max(1, months);
}

// อายุรถนับแบบ date-to-date จากวันจดทะเบียนครั้งแรก (ไม่ใช่ปีปฏิทินหรือ year-index):
// รย.1/รย.2/รย.3 ครบ 7 ปี และ รย.12 ครบ 5 ปี ต้องตรวจสภาพ - ผู้ใช้ยืนยัน 2026-09-23
export function requiresInspection(
  registrationCode: string,
  vehicleAgeYears: number,
  taxOverdueYears: number,
): boolean {
  if (taxOverdueYears > 1) return true;
  if (['รย.1', 'รย.2', 'รย.3'].includes(registrationCode) && vehicleAgeYears >= 7) return true;
  if (registrationCode === 'รย.12' && vehicleAgeYears >= 5) return true;
  return false;
}

// เลื่อนไปอีก n ปีแบบ date-to-date - 29 ก.พ. ถูกหนีบไว้ที่วันสุดท้ายของเดือน (ไม่ข้ามไป 1 มี.ค.)
function addYears(date: Date, years: number): Date {
  const shifted = new Date(
    Date.UTC(date.getUTCFullYear() + years, date.getUTCMonth(), date.getUTCDate()),
  );
  if (shifted.getUTCMonth() !== date.getUTCMonth()) shifted.setUTCDate(0);
  return shifted;
}

// งวดภาษีที่ต้องชำระ: ทุกงวดที่ถึงกำหนดก่อนวันชำระ ถ้ายังไม่ถึงกำหนดเลยก็คือชำระล่วงหน้างวดเดียว
function buildTaxDueDates(firstDue: Date, paymentDate: Date, max: number): Date[] {
  const dates: Date[] = [];
  let due = firstDue;
  while (due < paymentDate && dates.length < max) {
    dates.push(due);
    due = addYears(due, 1);
  }
  if (!dates.length) dates.push(firstDue);
  return dates;
}

// อายุรถจริงแบบครบรอบวัน
function ageYearsAt(firstRegistrationDate: Date, asOf: Date): number {
  let age = asOf.getUTCFullYear() - firstRegistrationDate.getUTCFullYear();
  const beforeAnniversary =
    asOf.getUTCMonth() < firstRegistrationDate.getUTCMonth() ||
    (asOf.getUTCMonth() === firstRegistrationDate.getUTCMonth() &&
      asOf.getUTCDate() < firstRegistrationDate.getUTCDate());
  if (beforeAnniversary) age -= 1;
  return Math.max(age, 0);
}

function findFuelPolicy(fuel: string, at: Date, policies: FuelTaxPolicyRow[]) {
  return policies.find(
    (p) => p.fuel === fuel && at >= p.effectiveFrom && (!p.effectiveTo || at <= p.effectiveTo),
  );
}

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

export function calculateVehicleTax(
  input: VehicleTaxInput,
  rules: VehicleTaxRuleSet,
): VehicleTaxResult {
  const warnings: string[] = [];

  if (!isValidDate(input.firstRegistrationDate)) {
    throw new VehicleTaxInputError('กรุณาระบุวันจดทะเบียนครั้งแรกที่ถูกต้อง');
  }
  if (!isValidDate(input.taxExpiryDate)) {
    throw new VehicleTaxInputError('กรุณาระบุวันครบกำหนดภาษีที่ถูกต้อง');
  }
  if (!isValidDate(input.paymentDate)) {
    throw new VehicleTaxInputError('กรุณาระบุวันที่ชำระที่ถูกต้อง');
  }
  if (input.firstRegistrationDate > input.taxExpiryDate) {
    throw new VehicleTaxInputError('วันจดทะเบียนครั้งแรกต้องไม่อยู่หลังวันครบกำหนดภาษี');
  }

  const fuelGroup = GOV_TAX_FUEL_GROUP_MAP[input.fuel as VehicleFuel];
  if (!fuelGroup) {
    throw new VehicleTaxInputError(`ไม่รองรับประเภทเชื้อเพลิง "${input.fuel}"`);
  }

  const family = classifyFamily(input.vehicleType);
  if (!family) {
    throw new VehicleTaxInputError(`ไม่สามารถระบุกลุ่มรถ (รย.) จากประเภทรถ "${input.vehicleType}" ได้`);
  }
  const registrationCode = REGISTRATION_CODE_BY_FAMILY[family];
  const taxMethod = resolveTaxMethod(family, fuelGroup);

  const engineCc = toNumber(input.engineCc);
  const vehicleWeightKg = toNumber(input.vehicleWeightKg);
  if (taxMethod === 'ENGINE_CC_RY1') {
    if (engineCc === null || engineCc <= 0) {
      throw new VehicleTaxInputError('กรุณาระบุความจุเครื่องยนต์ที่ถูกต้อง');
    }
  } else if (taxMethod !== 'FIXED_MOTORCYCLE') {
    if (vehicleWeightKg === null || vehicleWeightKg <= 0) {
      throw new VehicleTaxInputError('กรุณาระบุน้ำหนักรถที่ถูกต้อง');
    }
  }

  // ภาษีพื้นฐาน + ตัวคูณนิติบุคคล + ส่วนลด EV มาจากเครื่องคำนวณกลางที่ขั้นตอนที่ 4 ใช้
  const gov = calculateGovernmentTax(
    {
      body: input.vehicleType,
      fuel: input.fuel,
      cc: engineCc,
      weight: vehicleWeightKg,
      firstRegistrationDate: input.firstRegistrationDate,
    },
    input.owner ?? null,
    rules,
  );
  if (gov.baseAmount === null) {
    throw new VehicleTaxInputError(gov.reason ?? 'คำนวณภาษีพื้นฐานไม่ได้');
  }

  const baseTax = gov.baseAmount;
  const companyMultiplier = gov.juristicMultiplier;

  // ตัวคูณเชื้อเพลิง/EV ไม่ขึ้นกับรอบปี (อิงวันจดทะเบียนครั้งแรก) จึงคิดครั้งเดียวใช้ทุกรอบ
  // BEV ใช้มาตรการ EV เท่านั้น ห้ามคูณ Policy เชื้อเพลิงซ้ำอีกชั้น
  let fuelMultiplier = 1;
  if (fuelGroup === GovTaxFuelGroup.BEV) {
    if (gov.discountPercent === null) {
      warnings.push('ไม่พบมาตรการลดภาษีรถไฟฟ้า (EV) ที่ใช้ได้กับวันจดทะเบียนนี้ - ใช้ตัวคูณ 1');
    } else {
      fuelMultiplier = 1 - gov.discountPercent / 100;
    }
  } else {
    const policy = findFuelPolicy(input.fuel, input.taxExpiryDate, rules.fuelPolicies ?? []);
    if (policy) {
      fuelMultiplier = toNumber(policy.multiplier) ?? 1;
      // NGV ต้องดูจาก Vehicle.fuel ตรงๆ เพราะถูกจัดกลุ่มเป็น ICE เหมือนเบนซิน/ดีเซล/LPG
    } else if (input.fuel === 'NGV') {
      warnings.push('ไม่พบ Policy อัตราภาษีสำหรับ NGV - ใช้ตัวคูณ 1');
    }
  }

  const dueDates = buildTaxDueDates(input.taxExpiryDate, input.paymentDate, MAX_TAX_CYCLES);
  const cycles: VehicleTaxCycle[] = dueDates.map((dueDate) => {
    const vehicleYear = calculateVehicleYear(input.firstRegistrationDate, dueDate);
    // ส่วนลดอายุรถใช้กับ รย.1 ที่คิดตาม cc เท่านั้น - รย.2/รย.3/รย.12 และ BEV ไม่ลด
    const ageDiscountRate = taxMethod === 'ENGINE_CC_RY1' ? getAgeDiscountRate(vehicleYear) : 0;
    const ageDiscountAmount = baseTax * ageDiscountRate;
    const taxAfterAgeDiscount = baseTax - ageDiscountAmount;
    const companyAdjustmentAmount = taxAfterAgeDiscount * (companyMultiplier - 1);
    const taxAfterCompanyAdjustment = taxAfterAgeDiscount * companyMultiplier;
    const annualVehicleTax = taxAfterCompanyAdjustment * fuelMultiplier;
    const lateMonths = calculateLateMonths(dueDate, input.paymentDate);
    return {
      dueDate,
      vehicleYear,
      baseTax: roundSatang(baseTax),
      ageDiscountRate,
      ageDiscountAmount: roundSatang(ageDiscountAmount),
      taxAfterAgeDiscount: roundSatang(taxAfterAgeDiscount),
      companyMultiplier,
      companyAdjustmentAmount: roundSatang(companyAdjustmentAmount),
      fuelMultiplier,
      fuelAdjustmentAmount: roundSatang(taxAfterCompanyAdjustment - annualVehicleTax),
      annualVehicleTax: roundSatang(annualVehicleTax),
      lateMonths,
      lateFee: roundSatang(annualVehicleTax * 0.01 * lateMonths),
    };
  });

  if (cycles.length >= MAX_TAX_CYCLES) {
    warnings.push(`ค้างชำระเกิน ${MAX_TAX_CYCLES} รอบปีภาษี - คิดให้เพียง ${MAX_TAX_CYCLES} รอบ กรุณาตรวจสอบกับกรมขนส่ง`);
  } else if (cycles.length > 3) {
    warnings.push('ค้างชำระภาษีเกิน 3 ปี ทะเบียนอาจถูกระงับ ต้องตรวจสอบสถานะทะเบียนกับกรมขนส่งก่อน');
  }

  const sum = (pick: (c: VehicleTaxCycle) => number) => cycles.reduce((acc, c) => acc + pick(c), 0);
  const first = cycles[0];
  const annualVehicleTax = sum((c) => c.annualVehicleTax);
  const lateFee = sum((c) => c.lateFee);
  const lateMonths = first.lateMonths;

  const vehicleYear = first.vehicleYear;
  const vehicleAgeYears = ageYearsAt(input.firstRegistrationDate, input.paymentDate);
  const taxOverdueYears = lateMonths / 12;
  const inspectionRequired = requiresInspection(registrationCode, vehicleAgeYears, taxOverdueYears);
  if (inspectionRequired && !input.inspectionCertificateConfirmed) {
    warnings.push('รถคันนี้ต้องมีใบตรวจสภาพ (ตรอ.) ก่อนต่อภาษี - ยังไม่ได้ติ๊กยืนยันว่ามีใบตรวจแล้ว');
  }

  const compulsoryInsuranceFee = requireFee(input.compulsoryInsuranceFee, 'ค่า พ.ร.บ.');
  const inspectionFee = requireFee(input.inspectionFee, 'ค่าตรวจสภาพ');
  const serviceFee = requireFee(input.serviceFee, 'ค่าบริการ');
  const deliveryFee = requireFee(input.deliveryFee, 'ค่าจัดส่ง');

  const grandTotal =
    annualVehicleTax +
    lateFee +
    compulsoryInsuranceFee +
    inspectionFee +
    serviceFee +
    deliveryFee;

  const result: VehicleTaxResult = {
    vehicleType: input.vehicleType,
    registrationCode,
    fuel: input.fuel,
    govTaxFuelGroup: fuelGroup,
    taxMethod,
    engineCc,
    vehicleWeightKg,
    vehicleYear,
    vehicleAgeYears,
    baseTax: roundSatang(sum((c) => c.baseTax)),
    ageDiscountRate: first.ageDiscountRate,
    ageDiscountAmount: roundSatang(sum((c) => c.ageDiscountAmount)),
    taxAfterAgeDiscount: roundSatang(sum((c) => c.taxAfterAgeDiscount)),
    companyMultiplier,
    companyAdjustmentAmount: roundSatang(sum((c) => c.companyAdjustmentAmount)),
    fuelMultiplier,
    fuelAdjustmentAmount: roundSatang(sum((c) => c.fuelAdjustmentAmount)),
    annualVehicleTax: roundSatang(annualVehicleTax),
    lateMonths,
    lateFee: roundSatang(lateFee),
    taxCycleCount: cycles.length,
    cycles,
    compulsoryInsuranceFee: roundSatang(compulsoryInsuranceFee),
    inspectionRequired,
    inspectionFee: roundSatang(inspectionFee),
    serviceFee: roundSatang(serviceFee),
    deliveryFee: roundSatang(deliveryFee),
    grandTotal: roundSatang(grandTotal),
    warnings,
    calculationDetails: [],
  };

  result.calculationDetails = buildCalculationDetails(result);
  return result;
}

function classifyFamily(body: string | null | undefined): GovTaxVehicleFamily | null {
  if (!body) return null;
  if (body.startsWith('รย.12-') || body === 'รย.12') return GovTaxVehicleFamily.RY12;
  if (body.startsWith('รย.1-') || body === 'รย.1') return GovTaxVehicleFamily.RY1;
  if (body.startsWith('รย.2-') || body === 'รย.2') return GovTaxVehicleFamily.RY2;
  if (body.startsWith('รย.3-') || body === 'รย.3') return GovTaxVehicleFamily.RY3;
  return null;
}

const TAX_METHOD_LABELS: Record<TaxMethod, string> = {
  FIXED_MOTORCYCLE: 'เหมาจ่ายรถจักรยานยนต์',
  ENGINE_CC_RY1: 'ตามความจุเครื่องยนต์ (รย.1)',
  WEIGHT_RY2: 'ตามน้ำหนักรถ (รย.2)',
  WEIGHT_RY3: 'ตามน้ำหนักรถ (รย.3)',
  WEIGHT_EV_RY1: 'ตามน้ำหนักรถ - รถไฟฟ้า (รย.1)',
};

const formatThaiDate = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear() + 543}`;

function buildCalculationDetails(r: VehicleTaxResult): VehicleTaxCalculationDetail[] {
  return [
    { label: 'ประเภทรถ', formula: r.vehicleType },
    { label: 'รหัสประเภทรถ', formula: r.registrationCode },
    { label: 'เชื้อเพลิง', formula: r.fuel },
    { label: 'กลุ่มเชื้อเพลิงตามภาษี', formula: r.govTaxFuelGroup },
    { label: 'วิธีคำนวณภาษี', formula: TAX_METHOD_LABELS[r.taxMethod] },
    {
      label: 'ภาษีพื้นฐาน',
      formula:
        r.taxMethod === 'ENGINE_CC_RY1'
          ? `${r.engineCc ?? '-'} cc`
          : r.taxMethod === 'FIXED_MOTORCYCLE'
            ? 'เหมาจ่าย'
            : `${r.vehicleWeightKg ?? '-'} กก.`,
      amount: r.baseTax,
    },
    {
      label: 'ส่วนลดตามอายุรถ',
      formula: `ปีที่ ${r.vehicleYear} - ลด ${(r.ageDiscountRate * 100).toFixed(0)}%`,
      amount: -r.ageDiscountAmount,
    },
    { label: 'ภาษีหลังหักส่วนลดอายุ', amount: r.taxAfterAgeDiscount },
    {
      label: 'ตัวคูณนิติบุคคล',
      formula: `x${r.companyMultiplier}`,
      amount: r.companyAdjustmentAmount,
    },
    {
      label: r.govTaxFuelGroup === GovTaxFuelGroup.BEV ? 'มาตรการลดภาษีรถไฟฟ้า (EV)' : 'Policy เชื้อเพลิง',
      formula: `x${r.fuelMultiplier}`,
      amount: -r.fuelAdjustmentAmount,
    },
    ...(r.taxCycleCount > 1
      ? [
          {
            label: 'จำนวนรอบปีภาษีที่ค้างชำระ',
            formula: r.cycles
              .map((c) => `${formatThaiDate(c.dueDate)}: ${c.annualVehicleTax} + เงินเพิ่ม ${c.lateFee}`)
              .join(' | '),
          },
        ]
      : []),
    { label: 'ภาษีรถประจำปีสุทธิ', amount: r.annualVehicleTax },
    {
      label: 'จำนวนเดือนที่ล่าช้า',
      formula: r.taxCycleCount > 1 ? `${r.lateMonths} เดือน (รอบแรกที่ค้าง)` : `${r.lateMonths} เดือน`,
    },
    {
      label: 'เงินเพิ่มกรณีล่าช้า',
      formula: r.taxCycleCount > 1 ? '1% ต่อเดือน คิดแยกแต่ละรอบปี' : `1% x ${r.lateMonths} เดือน`,
      amount: r.lateFee,
    },
    { label: 'ค่า พ.ร.บ.', amount: r.compulsoryInsuranceFee },
    { label: 'ต้องตรวจสภาพ (ตรอ.)', formula: r.inspectionRequired ? 'ต้องตรวจ' : 'ไม่ต้องตรวจ' },
    { label: 'ค่าตรวจสภาพ', amount: r.inspectionFee },
    { label: 'ค่าบริการ', amount: r.serviceFee },
    { label: 'ค่าจัดส่ง', amount: r.deliveryFee },
    { label: 'ยอดรวมที่ต้องชำระ', amount: r.grandTotal },
    ...(r.warnings.length ? [{ label: 'คำเตือน', formula: r.warnings.join(' / ') }] : []),
  ];
}
