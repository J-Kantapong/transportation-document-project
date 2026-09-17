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
  if (body.startsWith('รย.12-')) return GovTaxVehicleFamily.RY12;
  if (body.startsWith('รย.1-')) return GovTaxVehicleFamily.RY1;
  if (body.startsWith('รย.2-')) return GovTaxVehicleFamily.RY2;
  if (body.startsWith('รย.3-')) return GovTaxVehicleFamily.RY3;
  return null;
}

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
