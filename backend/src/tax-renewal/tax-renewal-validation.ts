// Hand-rolled validation ตามแบบ tax/tax-validation.ts (ฟังก์ชันธรรมดา + ข้อความไทย ไม่ใช้ class-validator)
import { BadRequestException } from '@nestjs/common';
import { OwnerType } from '../generated/prisma/enums.js';
import { FUEL_TYPES, VEHICLE_TYPES } from '../vehicles/vehicle-reference-data.js';

export function parseDate(raw: unknown, field: string, required: true): Date;
export function parseDate(raw: unknown, field: string, required?: false): Date | null;
export function parseDate(raw: unknown, field: string, required = false): Date | null {
  if (raw === null || raw === undefined || raw === '') {
    if (required) throw new BadRequestException({ error: `กรุณาระบุ${field}` });
    return null;
  }
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: `${field}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง` });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

export function parseText(raw: unknown, field: string, required: boolean, max = 250): string | null {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    if (required) throw new BadRequestException({ error: `กรุณาระบุ${field}` });
    return null;
  }
  if (typeof raw !== 'string') throw new BadRequestException({ error: `${field}ไม่ถูกต้อง` });
  const value = raw.trim();
  if (value.length > max) throw new BadRequestException({ error: `${field}ยาวเกิน ${max} ตัวอักษร` });
  return value;
}

export function parseDecimal(raw: unknown, field: string): number | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new BadRequestException({ error: `${field}ต้องเป็นตัวเลขมากกว่า 0` });
  return n;
}

export function parseVehicleType(raw: unknown): string {
  const value = parseText(raw, 'ประเภทรถ', true);
  if (!(VEHICLE_TYPES as readonly string[]).includes(value!)) {
    throw new BadRequestException({ error: 'ประเภทรถไม่อยู่ในรายการที่กำหนด' });
  }
  return value!;
}

export function parseFuel(raw: unknown): string {
  const value = parseText(raw, 'ประเภทเชื้อเพลิง', true);
  if (!(FUEL_TYPES as readonly string[]).includes(value!)) {
    throw new BadRequestException({ error: 'ประเภทเชื้อเพลิงไม่อยู่ในรายการที่กำหนด' });
  }
  return value!;
}

export function parseOwnerType(raw: unknown): OwnerType {
  // บังคับกรอกเสมอ (ผู้ใช้กำหนด 2026-09-23) - ไม่มีค่าเริ่มต้นเป็นบุคคลธรรมดา
  if (raw === null || raw === undefined || raw === '') {
    throw new BadRequestException({ error: 'กรุณาระบุประเภทเจ้าของรถ' });
  }
  if (raw !== OwnerType.INDIVIDUAL && raw !== OwnerType.JURISTIC) {
    throw new BadRequestException({ error: 'ประเภทเจ้าของรถต้องเป็น INDIVIDUAL หรือ JURISTIC' });
  }
  return raw;
}
