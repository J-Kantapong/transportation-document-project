// Computes the government annual vehicle tax (ภาษีรถประจำปี) from a vehicle's ขนาด CC
// (Vehicle.cc) and น้ำหนักรถ (กก.) (Vehicle.weight), per the Step 4 spec: RY1 ICE/HEV/PHEV
// uses a progressive CC formula, RY1-BEV/RY2/RY3 use a weight-bracket lookup, RY12 is a flat
// rate. On top of the base amount: RY1 owned by a juristic person pays double, unless the
// vehicle is under a hire-purchase contract run as a business and the hirer is an individual
// (Master Rule from the integration spec) - RY2/RY3/RY12 never double regardless of owner.
// Pure function over plain data - the caller (TaxService) is responsible for loading only
// active+VERIFIED GovernmentTax* rows from Prisma and passing them in as `rules`; this
// function never checks status/active itself.
//
// Money math uses BigInt micro-baht (1 บาท = 1,000,000) internally so the progressive CC
// tiers (rate has up to 4 decimal places) and juristic/incentive multipliers never lose
// precision the way repeated floating-point Number multiplication could - only the final
// satang figure is rounded (half-up), matching how the reference tax-engine handles money.
import { GovTaxFuelGroup, GovTaxVehicleFamily, OwnerType } from '../generated/prisma/enums.js';
import { classifyFuelGroup, classifyVehicleFamily } from './government-tax-reference-data.js';

export interface GovernmentTaxVehicleInput {
  body: string | null | undefined; // ประเภทรถ
  fuel: string | null | undefined; // ประเภทเชื้อเพลิง
  cc: number | string | null | undefined; // ขนาด CC
  weight: number | string | null | undefined; // น้ำหนักรถ (กก.)
  firstRegistrationDate: Date | null | undefined;
}

export interface GovernmentTaxOwnerInput {
  ownerType: OwnerType;
  isHirePurchaseBusiness: boolean;
  hirerType: OwnerType | null;
}

export interface GovernmentTaxCcBracketRow {
  fuelGroup: GovTaxFuelGroup;
  ccFrom: number | string;
  ccTo: number | string | null;
  ratePerCc: number | string;
}

export interface GovernmentTaxWeightBracketRow {
  vehicleFamily: GovTaxVehicleFamily;
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
  baseAmount: number | null; // ภาษีก่อนคูณเจ้าของนิติบุคคลและหักมาตรการ EV
  discountPercent: number | null; // % ที่ลด (ถ้ามีมาตรการ EV ที่ใช้ได้ ณ firstRegistrationDate)
  juristicMultiplier: 1 | 2;
  juristicReason: string;
  amount: number | null; // ภาษี/ปี สุทธิ - null แปลว่ายังคำนวณไม่ได้ (ดู reason), ห้ามแสดง 0 บาทแทน
  amountSatang: number | null; // amount x 100 แบบ integer - เอาไว้เก็บ snapshot แม่นยำ
  reason: string | null; // เหตุผลที่คำนวณไม่ได้ (ข้อมูลรถ/เจ้าของไม่ครบ หรือยังไม่มีตารางอัตราที่ยืนยันแล้ว)
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// บาท (ทศนิยมไม่เกิน 6 ตำแหน่งพอ ในทางปฏิบัติข้อมูลจริงมีแค่ 2-4 ตำแหน่ง) -> micro-baht (BigInt)
// Math.round ที่นี่ปัดเศษภายในช่วง float ที่ยังแม่นยำอยู่มาก (ไม่ใช่จุดที่ทำให้เพี้ยน) เพราะ
// ตัวเลขต้นทาง (cc/rate/weight/amount) มีทศนิยมจำกัดตายตัวจาก Decimal column อยู่แล้ว
function toMicroBaht(value: number | string | null | undefined): bigint | null {
  const n = toNumber(value);
  if (n === null) return null;
  return BigInt(Math.round(n * 1_000_000));
}

function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator < 0n) return roundHalfUp(-numerator, -denominator);
  const sign = numerator < 0n ? -1n : 1n;
  const abs = numerator < 0n ? -numerator : numerator;
  return sign * ((abs * 2n + denominator) / (denominator * 2n));
}

function microBahtToResult(microBaht: bigint): { amount: number; amountSatang: number } {
  const satang = roundHalfUp(microBaht, 10_000n); // 1 สตางค์ = 10,000 micro-baht
  return { amount: Number(satang) / 100, amountSatang: Number(satang) };
}

// Progressive: อัตราของแต่ละขั้นคิดเฉพาะส่วนของ cc ที่อยู่เหนือเกณฑ์ของขั้นนั้น (ccFrom เป็นเกณฑ์
// ต่อเนื่อง ไม่ใช่จุดเริ่มนับแบบจำนวนเต็ม) เช่น cc=1000 กับขั้น [0,600,0.5]/[600,1800,1.5] ได้
// 600*0.5 + (1000-600)*1.5 = 900 บาท ตรงกับสูตรที่ให้มา
function calcCcProgressiveMicroBaht(cc: number, brackets: GovernmentTaxCcBracketRow[], fuelGroup: GovTaxFuelGroup): bigint | null {
  const rows = brackets
    .filter((b) => b.fuelGroup === fuelGroup)
    .map((b) => ({ ccFrom: toNumber(b.ccFrom), ccTo: toNumber(b.ccTo), rateMicro: toMicroBaht(b.ratePerCc) }))
    .filter((b): b is { ccFrom: number; ccTo: number | null; rateMicro: bigint } => b.ccFrom !== null && b.rateMicro !== null)
    .sort((a, b) => a.ccFrom - b.ccFrom);
  if (!rows.length) return null;

  let totalMicro = 0n;
  for (const row of rows) {
    const upper = row.ccTo ?? cc;
    const portion = Math.max(0, Math.min(cc, upper) - row.ccFrom);
    if (portion <= 0) continue;
    // portion มีทศนิยมไม่เกิน 2 ตำแหน่งเสมอ (Vehicle.cc คือ Decimal(10,2)) จึง *1e4 ได้ค่าจำนวนเต็มพอดี
    const portionMicroScale = BigInt(Math.round(portion * 10_000));
    totalMicro += (portionMicroScale * row.rateMicro) / 10_000n;
  }
  return totalMicro;
}

// ต้องกรองด้วย vehicleFamily ด้วย - รย.2 กับ รย.3 ต่างก็ fuelGroup = null เหมือนกัน ถ้ากรองแค่
// fuelGroup ตาราง รย.3 จะไม่ถูกใช้เลย (รถบรรทุกโดนคิดด้วยอัตรา รย.2 แทน)
// เรียงตาม weightFrom แล้วเอาช่วงแรกที่ตรง: ขอบล่าง-บนใช้ค่าเดียวกัน (0-500, 500-750, ...) น้ำหนักตรงขอบ
// พอดีจึงต้องได้ช่วงล่างเสมอ (500 กก. = "≤500") ไม่ขึ้นกับลำดับแถวที่ DB คืนมา
function findWeightBracket(
  weight: number,
  brackets: GovernmentTaxWeightBracketRow[],
  vehicleFamily: GovTaxVehicleFamily,
  fuelGroup: GovTaxFuelGroup | null,
) {
  return brackets
    .filter((b) => b.vehicleFamily === vehicleFamily && b.fuelGroup === fuelGroup)
    .map((b) => ({ row: b, from: toNumber(b.weightFrom), to: toNumber(b.weightTo) }))
    .filter((b): b is { row: GovernmentTaxWeightBracketRow; from: number; to: number | null } => b.from !== null)
    .sort((a, b) => a.from - b.from)
    .find((b) => weight >= b.from && (b.to === null || weight <= b.to))?.row;
}

function findActiveEvIncentive(date: Date, incentives: GovernmentTaxEvIncentiveRow[]) {
  return incentives.find((i) => date >= i.effectiveFrom && (!i.effectiveTo || date <= i.effectiveTo));
}

// RY1 + นิติบุคคล + ไม่ใช่กรณี "ธุรกิจเช่าซื้อที่ผู้เช่าซื้อเป็นบุคคลธรรมดา" => x2, นอกนั้น x1
// RY2/RY3/RY12 ไม่คูณ 2 แม้เจ้าของเป็นนิติบุคคล (ตาม Master Rule ในไฟล์ต้นแบบ)
function juristicMultiplierFor(
  vehicleFamily: GovTaxVehicleFamily,
  owner: GovernmentTaxOwnerInput | null | undefined,
): { multiplier: 1 | 2; reason: string; missingOwner: boolean } {
  if (vehicleFamily !== GovTaxVehicleFamily.RY1) {
    return { multiplier: 1, reason: 'ใช้กับ รย.1 เท่านั้น - กลุ่มรถนี้ไม่คูณสอง', missingOwner: false };
  }
  if (!owner) {
    return { multiplier: 1, reason: 'ยังไม่ระบุประเภทเจ้าของรถ', missingOwner: true };
  }
  if (owner.ownerType === OwnerType.INDIVIDUAL) {
    return { multiplier: 1, reason: 'เจ้าของเป็นบุคคลธรรมดา', missingOwner: false };
  }
  if (owner.isHirePurchaseBusiness && owner.hirerType === OwnerType.INDIVIDUAL) {
    return { multiplier: 1, reason: 'นิติบุคคลประกอบธุรกิจเช่าซื้อ และผู้เช่าซื้อเป็นบุคคลธรรมดา (ข้อยกเว้น)', missingOwner: false };
  }
  return { multiplier: 2, reason: 'เจ้าของเป็นนิติบุคคล (รย.1) คูณสอง', missingOwner: false };
}

export function calculateGovernmentTax(
  vehicle: GovernmentTaxVehicleInput,
  owner: GovernmentTaxOwnerInput | null | undefined,
  rules: GovernmentTaxRuleSet,
): GovernmentTaxResult {
  const vehicleFamily = classifyVehicleFamily(vehicle.body);
  const fuelGroup = classifyFuelGroup(vehicle.fuel);
  const empty = { baseAmount: null, discountPercent: null, amount: null, amountSatang: null, juristicMultiplier: 1 as const, juristicReason: '-' };

  if (!vehicleFamily) {
    return { vehicleFamily: null, fuelGroup, ...empty, reason: 'ไม่สามารถระบุกลุ่มรถ (รย.) จากประเภทรถได้' };
  }
  if (!fuelGroup) {
    return { vehicleFamily, fuelGroup: null, ...empty, reason: 'ไม่สามารถระบุประเภทเชื้อเพลิงได้' };
  }

  const juristic = juristicMultiplierFor(vehicleFamily, owner);
  if (juristic.missingOwner) {
    return { vehicleFamily, fuelGroup, ...empty, juristicReason: juristic.reason, reason: 'ต้องระบุประเภทเจ้าของรถ (บุคคลธรรมดา/นิติบุคคล) ก่อนคำนวณภาษี รย.1' };
  }

  if (vehicleFamily === GovTaxVehicleFamily.RY12) {
    const row = rules.motorcycleFlat.find((r) => r.fuelGroup === fuelGroup);
    const baseMicro = row ? toMicroBaht(row.amount) : null;
    if (baseMicro === null) {
      return { vehicleFamily, fuelGroup, ...empty, reason: 'ยังไม่มีอัตราภาษีรถจักรยานยนต์สำหรับเชื้อเพลิงนี้ (ยังไม่ยืนยัน)' };
    }
    const { amount, amountSatang } = microBahtToResult(baseMicro);
    return { vehicleFamily, fuelGroup, baseAmount: amount, discountPercent: null, juristicMultiplier: 1, juristicReason: juristic.reason, amount, amountSatang, reason: null };
  }

  if (vehicleFamily === GovTaxVehicleFamily.RY1 && fuelGroup !== GovTaxFuelGroup.BEV) {
    const cc = toNumber(vehicle.cc);
    if (cc === null) return { vehicleFamily, fuelGroup, ...empty, juristicReason: juristic.reason, reason: 'ไม่มีข้อมูลขนาด CC ของรถคันนี้' };
    const baseMicro = calcCcProgressiveMicroBaht(cc, rules.ccBrackets, fuelGroup);
    if (baseMicro === null) {
      return { vehicleFamily, fuelGroup, ...empty, juristicReason: juristic.reason, reason: 'ยังไม่มีตารางอัตราภาษีตาม CC สำหรับกลุ่มนี้ (ยังไม่ยืนยัน)' };
    }
    const base = microBahtToResult(baseMicro);
    const finalMicro = baseMicro * BigInt(juristic.multiplier);
    const final = microBahtToResult(finalMicro);
    return {
      vehicleFamily,
      fuelGroup,
      baseAmount: base.amount,
      discountPercent: null,
      juristicMultiplier: juristic.multiplier,
      juristicReason: juristic.reason,
      amount: final.amount,
      amountSatang: final.amountSatang,
      reason: null,
    };
  }

  // ที่เหลือคำนวณจากน้ำหนัก: RY1-BEV, RY2, RY3
  const weight = toNumber(vehicle.weight);
  if (weight === null) return { vehicleFamily, fuelGroup, ...empty, juristicReason: juristic.reason, reason: 'ไม่มีข้อมูลน้ำหนักรถของรถคันนี้' };

  const weightFuelGroup = vehicleFamily === GovTaxVehicleFamily.RY1 ? fuelGroup : null;
  const bracket = findWeightBracket(weight, rules.weightBrackets, vehicleFamily, weightFuelGroup);
  const baseMicro = bracket ? toMicroBaht(bracket.amount) : null;
  if (baseMicro === null) {
    return {
      vehicleFamily,
      fuelGroup,
      ...empty,
      juristicReason: juristic.reason,
      reason: 'ยังไม่มีตารางอัตราภาษีตามน้ำหนักสำหรับกลุ่มนี้ (รอข้อมูลจากผู้ใช้)',
    };
  }
  const base = microBahtToResult(baseMicro);

  let discountPercent: number | null = null;
  let discountBps = 0n;
  if (vehicleFamily === GovTaxVehicleFamily.RY1 && fuelGroup === GovTaxFuelGroup.BEV && vehicle.firstRegistrationDate) {
    const incentive = findActiveEvIncentive(vehicle.firstRegistrationDate, rules.evIncentives);
    discountPercent = incentive ? toNumber(incentive.discountPercent) : null;
    if (discountPercent !== null) discountBps = BigInt(Math.round(discountPercent * 100));
  }

  const preIncentiveMicro = baseMicro * BigInt(juristic.multiplier);
  const finalMicro = roundHalfUp(preIncentiveMicro * (10_000n - discountBps), 10_000n);
  const final = microBahtToResult(finalMicro);

  return {
    vehicleFamily,
    fuelGroup,
    baseAmount: base.amount,
    discountPercent,
    juristicMultiplier: juristic.multiplier,
    juristicReason: juristic.reason,
    amount: final.amount,
    amountSatang: final.amountSatang,
    reason: null,
  };
}
