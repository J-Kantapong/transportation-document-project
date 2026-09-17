// Computes the government annual vehicle tax (ภาษีรถประจำปี) from a vehicle's ขนาด CC
// (Vehicle.cc) and น้ำหนักรถ (กก.) (Vehicle.weight), per the Step 4 spec: RY1 ICE/HEV/PHEV
// uses a progressive CC formula, RY1-BEV/RY2/RY3 use a weight-bracket lookup, RY12 is a flat
// rate. Pure function over plain data - the caller (a Nest service) is responsible for
// loading the GovernmentTax* rows from Prisma and passing them in as `rules`.
import { GovTaxFuelGroup, GovTaxVehicleFamily } from '../generated/prisma/enums.js';
import { classifyFuelGroup, classifyVehicleFamily } from './government-tax-reference-data.js';

export interface GovernmentTaxVehicleInput {
  body: string | null | undefined; // ประเภทรถ
  fuel: string | null | undefined; // ประเภทเชื้อเพลิง
  cc: number | string | null | undefined; // ขนาด CC
  weight: number | string | null | undefined; // น้ำหนักรถ (กก.)
  firstRegistrationDate: Date | null | undefined;
}

export interface GovernmentTaxCcBracketRow {
  fuelGroup: GovTaxFuelGroup;
  ccFrom: number | string;
  ccTo: number | string | null;
  ratePerCc: number | string;
}

export interface GovernmentTaxWeightBracketRow {
  fuelGroup: GovTaxFuelGroup | null;
  weightFrom: number | string;
  weightTo: number | string | null;
  amount: number | string | null;
}

export interface GovernmentTaxEvIncentiveRow {
  effectiveFrom: Date;
  effectiveTo: Date | null;
  discountPercent: number | string | null;
}

export interface GovernmentTaxMotorcycleFlatRow {
  fuelGroup: GovTaxFuelGroup;
  amount: number | string | null;
}

export interface GovernmentTaxRuleSet {
  ccBrackets: GovernmentTaxCcBracketRow[];
  weightBrackets: GovernmentTaxWeightBracketRow[];
  evIncentives: GovernmentTaxEvIncentiveRow[];
  motorcycleFlat: GovernmentTaxMotorcycleFlatRow[];
}

export interface GovernmentTaxResult {
  vehicleFamily: GovTaxVehicleFamily | null;
  fuelGroup: GovTaxFuelGroup | null;
  baseAmount: number | null; // ภาษีก่อนหักมาตรการ EV
  discountPercent: number | null; // % ที่ลด (ถ้ามีมาตรการ EV ที่ใช้ได้ ณ firstRegistrationDate)
  amount: number | null; // ภาษี/ปี สุทธิ - null แปลว่ายังคำนวณไม่ได้ (ดู reason)
  reason: string | null; // เหตุผลที่คำนวณไม่ได้ (ข้อมูลรถไม่ครบ หรือยังไม่มีตารางอัตรา)
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// Progressive: อัตราของแต่ละขั้นคิดเฉพาะส่วนของ cc ที่อยู่เหนือเกณฑ์ของขั้นนั้น (ccFrom เป็นเกณฑ์
// ต่อเนื่อง ไม่ใช่จุดเริ่มนับแบบจำนวนเต็ม) เช่น cc=1000 กับขั้น [0,600,0.5]/[600,1800,1.5] ได้
// 600*0.5 + (1000-600)*1.5 = 300 + 600 = 900 บาท ตรงกับสูตรที่ให้มา
function calcCcProgressive(cc: number, brackets: GovernmentTaxCcBracketRow[], fuelGroup: GovTaxFuelGroup): number | null {
  const rows = brackets
    .filter((b) => b.fuelGroup === fuelGroup)
    .map((b) => ({ ccFrom: toNumber(b.ccFrom), ccTo: toNumber(b.ccTo), ratePerCc: toNumber(b.ratePerCc) }))
    .filter((b): b is { ccFrom: number; ccTo: number | null; ratePerCc: number } => b.ccFrom !== null && b.ratePerCc !== null)
    .sort((a, b) => a.ccFrom - b.ccFrom);
  if (!rows.length) return null;

  let tax = 0;
  for (const row of rows) {
    const upper = row.ccTo ?? cc;
    const portion = Math.max(0, Math.min(cc, upper) - row.ccFrom);
    tax += portion * row.ratePerCc;
  }
  return tax;
}

function findWeightBracket(weight: number, brackets: GovernmentTaxWeightBracketRow[], fuelGroup: GovTaxFuelGroup | null) {
  return brackets.find((b) => {
    if (b.fuelGroup !== fuelGroup) return false;
    const from = toNumber(b.weightFrom);
    const to = toNumber(b.weightTo);
    if (from === null) return false;
    return weight >= from && (to === null || weight <= to);
  });
}

function findActiveEvIncentive(date: Date, incentives: GovernmentTaxEvIncentiveRow[]) {
  return incentives.find((i) => date >= i.effectiveFrom && (!i.effectiveTo || date <= i.effectiveTo));
}

export function calculateGovernmentTax(vehicle: GovernmentTaxVehicleInput, rules: GovernmentTaxRuleSet): GovernmentTaxResult {
  const vehicleFamily = classifyVehicleFamily(vehicle.body);
  const fuelGroup = classifyFuelGroup(vehicle.fuel);
  const empty = { baseAmount: null, discountPercent: null, amount: null };

  if (!vehicleFamily) {
    return { vehicleFamily: null, fuelGroup, ...empty, reason: 'ไม่สามารถระบุกลุ่มรถ (รย.) จากประเภทรถได้' };
  }
  if (!fuelGroup) {
    return { vehicleFamily, fuelGroup: null, ...empty, reason: 'ไม่สามารถระบุประเภทเชื้อเพลิงได้' };
  }

  if (vehicleFamily === GovTaxVehicleFamily.RY12) {
    const row = rules.motorcycleFlat.find((r) => r.fuelGroup === fuelGroup);
    const amount = toNumber(row?.amount ?? null);
    return { vehicleFamily, fuelGroup, baseAmount: amount, discountPercent: null, amount, reason: amount === null ? 'ยังไม่มีอัตราภาษีรถจักรยานยนต์สำหรับเชื้อเพลิงนี้' : null };
  }

  if (vehicleFamily === GovTaxVehicleFamily.RY1 && fuelGroup !== GovTaxFuelGroup.BEV) {
    const cc = toNumber(vehicle.cc);
    if (cc === null) return { vehicleFamily, fuelGroup, ...empty, reason: 'ไม่มีข้อมูลขนาด CC ของรถคันนี้' };
    const amount = calcCcProgressive(cc, rules.ccBrackets, fuelGroup);
    return { vehicleFamily, fuelGroup, baseAmount: amount, discountPercent: null, amount, reason: amount === null ? 'ยังไม่มีตารางอัตราภาษีตาม CC สำหรับกลุ่มนี้' : null };
  }

  // ที่เหลือคำนวณจากน้ำหนัก: RY1-BEV, RY2, RY3
  const weight = toNumber(vehicle.weight);
  if (weight === null) return { vehicleFamily, fuelGroup, ...empty, reason: 'ไม่มีข้อมูลน้ำหนักรถของรถคันนี้' };

  const weightFuelGroup = vehicleFamily === GovTaxVehicleFamily.RY1 ? fuelGroup : null;
  const bracket = findWeightBracket(weight, rules.weightBrackets, weightFuelGroup);
  const baseAmount = toNumber(bracket?.amount ?? null);

  let discountPercent: number | null = null;
  if (vehicleFamily === GovTaxVehicleFamily.RY1 && fuelGroup === GovTaxFuelGroup.BEV && vehicle.firstRegistrationDate) {
    const incentive = findActiveEvIncentive(vehicle.firstRegistrationDate, rules.evIncentives);
    discountPercent = toNumber(incentive?.discountPercent ?? null);
  }

  const amount = baseAmount === null ? null : discountPercent ? baseAmount * (1 - discountPercent / 100) : baseAmount;

  return {
    vehicleFamily,
    fuelGroup,
    baseAmount,
    discountPercent,
    amount,
    reason: baseAmount === null ? 'ยังไม่มีตารางอัตราภาษีตามน้ำหนักสำหรับกลุ่มนี้ (รอข้อมูลจากผู้ใช้)' : null,
  };
}
