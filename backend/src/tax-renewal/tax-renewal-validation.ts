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
  // Date.parse ยอม 2026-02-31 (เลื่อนไป 3 มี.ค.) และปี พ.ศ. 2569 - ต้องแปลงกลับได้วันเดิมและอยู่ในช่วงปี ค.ศ. (พบ 2026-09-27)
  const date = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  const year = Number(String(raw).slice(0, 4));
  if (!date || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw || year < 1900 || year > 2100) {
    throw new BadRequestException({ error: `${field}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง` });
  }
  return date;
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

// เจ้าของที่ใช้คิดตัวคูณนิติบุคคล (รย.1) - ต้องมีเรื่องเช่าซื้อด้วย ไม่งั้นรถติดไฟแนนซ์ที่ผู้เช่าซื้อเป็นบุคคลธรรมดาโดนคูณสอง
export interface RenewalOwner {
  ownerType: OwnerType;
  isHirePurchaseBusiness: boolean;
  hirerType: OwnerType | null;
}

// ฟอร์มกรอกเอง: ประเภทเจ้าของรถ + ติ๊ก "ติดไฟแนนซ์" แบบเดียวกับหน้าเพิ่มข้อมูลรถ (VehiclesService.ownerDataFor)
// ติดไฟแนนซ์ = ไฟแนนซ์เป็นเจ้าของตามทะเบียน (นิติบุคคลที่ประกอบธุรกิจเช่าซื้อ) ส่วนประเภทที่เลือกคือผู้เช่าซื้อ (พบ 2026-09-27)
export function parseRenewalOwner(body: Record<string, unknown>): RenewalOwner {
  const chosen = parseOwnerType(body.ownerType);
  if (body.financed === true) return { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: true, hirerType: chosen };
  return { ownerType: chosen, isHirePurchaseBusiness: false, hirerType: null };
}

// เจ้าของที่เก็บไว้ใน TaxRenewal.taxBreakdown.owner (ยังไม่มีคอลัมน์ของตัวเอง) - ค่าเสีย/ไม่มี = null
export function storedRenewalOwner(taxBreakdown: unknown): RenewalOwner | null {
  const owner = (taxBreakdown as { owner?: Partial<Record<keyof RenewalOwner, unknown>> } | null)?.owner;
  const isOwnerType = (v: unknown): v is OwnerType => v === OwnerType.INDIVIDUAL || v === OwnerType.JURISTIC;
  if (!owner || !isOwnerType(owner.ownerType)) return null;
  return {
    ownerType: owner.ownerType,
    isHirePurchaseBusiness: owner.isHirePurchaseBusiness === true,
    hirerType: isOwnerType(owner.hirerType) ? owner.hirerType : null,
  };
}
