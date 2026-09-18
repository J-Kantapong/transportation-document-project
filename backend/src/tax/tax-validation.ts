// Hand-rolled validation for the tax endpoints, matching the convention in
// vehicles/vehicle-validation.ts (plain functions + Thai error messages, no class-validator).
import { BadRequestException } from '@nestjs/common';
import { OwnerType } from '../generated/prisma/enums.js';
import type { GovernmentTaxOwnerInput, GovernmentTaxVehicleInput } from './government-tax-calculator.js';
import type { TaxPreviewDto } from './dto/tax-preview.dto.js';

const OWNER_TYPES = [OwnerType.INDIVIDUAL, OwnerType.JURISTIC] as const;

function parseOwnerType(value: unknown, field: string): OwnerType {
  if (!OWNER_TYPES.includes(value as OwnerType)) {
    throw new BadRequestException({ error: `${field} ต้องเป็น INDIVIDUAL หรือ JURISTIC` });
  }
  return value as OwnerType;
}

export function parseOwnerInput(raw: unknown): GovernmentTaxOwnerInput | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new BadRequestException({ error: 'owner ต้องเป็น object หรือ null' });
  const value = raw as Record<string, unknown>;
  const ownerType = parseOwnerType(value.ownerType, 'owner.ownerType');
  const isHirePurchaseBusiness = Boolean(value.isHirePurchaseBusiness);
  const hirerTypeRaw = value.hirerType;
  if (ownerType === OwnerType.INDIVIDUAL && isHirePurchaseBusiness) {
    throw new BadRequestException({ error: 'บุคคลธรรมดาไม่สามารถระบุว่าประกอบธุรกิจเช่าซื้อได้' });
  }
  const hirerType = hirerTypeRaw === null || hirerTypeRaw === undefined ? null : parseOwnerType(hirerTypeRaw, 'owner.hirerType');
  return { ownerType, isHirePurchaseBusiness, hirerType };
}

export function parseTaxDate(raw: unknown, field: string): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: `${field} ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง` });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

function parseNumericField(raw: unknown, field: string): number | string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) throw new BadRequestException({ error: `${field} ต้องเป็นตัวเลขตั้งแต่ 0` });
    return raw;
  }
  if (typeof raw === 'string' && /^\d+(\.\d+)?$/.test(raw)) return raw;
  throw new BadRequestException({ error: `${field} ต้องเป็นตัวเลขตั้งแต่ 0` });
}

export function parseTaxPreviewInput(body: TaxPreviewDto): { vehicle: GovernmentTaxVehicleInput; owner: GovernmentTaxOwnerInput | null } {
  if (!body || typeof body !== 'object') throw new BadRequestException({ error: 'กรุณาระบุข้อมูลรถ' });
  const bodyType = typeof body.body === 'string' && body.body ? body.body : null;
  const fuel = typeof body.fuel === 'string' && body.fuel ? body.fuel : null;
  const cc = parseNumericField(body.cc, 'ขนาด CC');
  const weight = parseNumericField(body.weight, 'น้ำหนักรถ');
  const firstRegistrationDate = parseTaxDate(body.firstRegistrationDate, 'firstRegistrationDate');
  const owner = parseOwnerInput(body.owner);
  return { vehicle: { body: bodyType, fuel, cc, weight, firstRegistrationDate }, owner };
}
