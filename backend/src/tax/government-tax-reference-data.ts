import { isMotorcycleType } from '../vehicles/vehicle-reference-data.js';
// Classifies a Vehicle row into the government annual-tax dimensions
// (GovTaxVehicleFamily / GovTaxFuelGroup) used by the GovernmentTax* tables in
// schema.prisma. Kept separate from vehicle-reference-data.ts (VEHICLE_TYPES) because the
// รย.12-<cc range> entries there are company service-fee tiers, not the tax family/fuel
// grouping the government uses - see the schema.prisma comment above the GovernmentTax*
// models for why those must not be conflated.
import {
  GovTaxFuelGroup,
  GovTaxVehicleFamily,
} from '../generated/prisma/enums.js';

const ICE_FUELS = new Set(['เบนซิน', 'ดีเซล', 'LPG', 'NGV']);

export function classifyFuelGroup(
  fuel: string | null | undefined,
): GovTaxFuelGroup | null {
  if (!fuel) return null;
  if (ICE_FUELS.has(fuel)) return GovTaxFuelGroup.ICE;
  if (fuel === 'ไฮบริด (HEV)') return GovTaxFuelGroup.HEV;
  if (fuel === 'ปลั๊กอินไฮบริด (PHEV)') return GovTaxFuelGroup.PHEV;
  if (fuel === 'ไฟฟ้า (BEV)') return GovTaxFuelGroup.BEV;
  return null;
}

export function classifyVehicleFamily(
  body: string | null | undefined,
): GovTaxVehicleFamily | null {
  if (!body) return null;
  // รย.17 (จักรยานยนต์สาธารณะ, ผู้ใช้ 2026-10-08) ใช้อัตราภาษีมอเตอร์ไซค์ชุดเดียวกับ รย.12
  if (isMotorcycleType(body)) return GovTaxVehicleFamily.RY12;
  if (body.startsWith('รย.1-')) return GovTaxVehicleFamily.RY1;
  if (body.startsWith('รย.2-')) return GovTaxVehicleFamily.RY2;
  if (body.startsWith('รย.3-')) return GovTaxVehicleFamily.RY3;
  return TRANSPORT_FAMILY_BY_TYPE[body] ?? null;
}

// รถตาม พ.ร.บ.ขนส่ง (ผู้ใช้ 2026-11-09) - ชื่อประเภทรถของงานต่อภาษี (TRANSPORT_VEHICLE_TYPES) -> คอลัมน์ตารางอัตรา
// เทียบทั้งชื่อ ไม่ใช่ prefix เพราะแต่ละชื่อคือคนละคอลัมน์ ชื่อที่ไม่รู้จัก = คำนวณไม่ได้ (null) เหมือนประเภทอื่นที่ไม่รู้จัก
export const TRANSPORT_FAMILY_BY_TYPE: Record<string, GovTaxVehicleFamily> = {
  'ขส.-ส่วนบุคคล': GovTaxVehicleFamily.TRANSPORT_PRIVATE,
  'ขส.-ไม่ประจำทาง': GovTaxVehicleFamily.TRANSPORT_NON_FIXED,
  'ขส.-ประจำทาง': GovTaxVehicleFamily.TRANSPORT_FIXED,
  'ขส.-รถขนาดเล็ก': GovTaxVehicleFamily.TRANSPORT_SMALL,
};

export const TRANSPORT_FAMILIES: ReadonlySet<GovTaxVehicleFamily> = new Set(Object.values(TRANSPORT_FAMILY_BY_TYPE));

export function vehicleAgeYears(
  firstRegistrationDate: Date,
  asOf: Date = new Date(),
): number {
  let age = asOf.getFullYear() - firstRegistrationDate.getFullYear();
  const beforeAnniversary =
    asOf.getMonth() < firstRegistrationDate.getMonth() ||
    (asOf.getMonth() === firstRegistrationDate.getMonth() &&
      asOf.getDate() < firstRegistrationDate.getDate());
  if (beforeAnniversary) age -= 1;
  return Math.max(age, 0);
}
