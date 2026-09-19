// Mirrors backend/src/vehicles/vehicle-validation.ts — client-side validation gives the
// user immediate feedback; the backend re-validates everything as the final authority.

import { FUEL_TYPES, PROVINCES, VEHICLE_COLUMNS, VEHICLE_TYPES, VehicleColumnKey } from './vehicle-reference-data';

export type NormalizedVehicleRow = Record<VehicleColumnKey, string>;

export function normalizeVehicleRow(input: Record<string, unknown>): NormalizedVehicleRow {
  const row = {} as NormalizedVehicleRow;
  for (const [key] of VEHICLE_COLUMNS) {
    row[key] = String(input?.[key] ?? '').trim();
  }
  return row;
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  if (new Date(value).toISOString().slice(0, 10) !== value) return false;
  const year = Number(value.slice(0, 4));
  return year >= 1900 && year <= 2100;
}

function isValidNumeric(value: string): boolean {
  return /^\d+(\.\d+)?$/.test(value) && Number.isFinite(Number(value)) && Number(value) >= 0;
}

// ขนาด CC / น้ำหนักรถ บังคับกรอกตามที่ใช้คำนวณภาษีประจำปี (backend/src/tax/government-tax-calculator.ts):
// รย.1 เชื้อเพลิงที่ไม่ใช่ไฟฟ้า (BEV) คิดตาม CC, รย.1 ไฟฟ้า (BEV) / รย.2 / รย.3 คิดตามน้ำหนัก
// รย.12 (มอเตอร์ไซค์) ภาษีเป็นอัตราคงที่ แต่ผู้ใช้กำหนดให้บังคับกรอก CC เสมอ - ยังไม่เลือกประเภทรถ/เชื้อเพลิง = ยังบอกไม่ได้
export function requiredSizeField(body: string, fuel: string): 'cc' | 'weight' | null {
  if (!body || !fuel) return null;
  if (body.startsWith('รย.12-')) return 'cc';
  if (body.startsWith('รย.1-')) return fuel === 'ไฟฟ้า (BEV)' ? 'weight' : 'cc';
  if (body.startsWith('รย.2-') || body.startsWith('รย.3-')) return 'weight';
  return null;
}

export function getVehicleRowErrors(row: NormalizedVehicleRow): string[] {
  const errors: string[] = [];

  if (row.body && !(VEHICLE_TYPES as readonly string[]).includes(row.body)) {
    errors.push('กรุณาเลือกประเภทรถจากรายการที่กำหนด');
  }
  if (row.fuel && !(FUEL_TYPES as readonly string[]).includes(row.fuel)) {
    errors.push('กรุณาเลือกประเภทเชื้อเพลิงจากรายการที่กำหนด');
  }
  if (!isValidDate(row.date)) {
    errors.push('วันที่ต้องเป็น DD-MM-YYYY ที่ถูกต้อง');
  }
  if (!row.customerId) errors.push('กรุณาเลือกลูกค้า');
  if (!row.chassis) errors.push('กรุณากรอกเลขตัวถัง');
  if (!row.brandId) errors.push('กรุณาเลือกยี่ห้อ');
  // ช่องที่ขั้นตอนถัดไปต้องใช้ (ค่าแจ้งย้าย/ตัดบัญชี, ค่าตรวจรถ, ค่าธรรมเนียม, ภาษี) - ขาดแล้วคำนวณราคาไม่ได้
  if (!row.engine) errors.push('กรุณากรอกเลขเครื่อง');
  if (!row.fuel) errors.push('กรุณาเลือกประเภทเชื้อเพลิง');
  if (!row.body) errors.push('กรุณาเลือกประเภทรถ');
  if (!row.registrationProvince) errors.push('กรุณาเลือกจังหวัดที่จดทะเบียน');
  if (!row.ownerProvince) errors.push('กรุณาเลือกจังหวัดเจ้าของรถ');
  const sizeField = requiredSizeField(row.body, row.fuel);
  if (sizeField === 'cc' && !row.cc) {
    errors.push(`กรุณากรอกขนาด CC (จำเป็นสำหรับ ${row.body} ${row.fuel})`);
  }
  if (sizeField === 'weight' && !row.weight) {
    errors.push(`กรุณากรอกน้ำหนักรถ (จำเป็นสำหรับ ${row.body} ${row.fuel})`);
  }

  for (const [key, label] of VEHICLE_COLUMNS) {
    if (row[key].length > 250) errors.push(`${label}ยาวเกิน 250 ตัวอักษร`);
  }

  for (const key of ['cc', 'weight'] as const) {
    if (row[key] !== '' && !isValidNumeric(row[key])) {
      errors.push(key === 'cc' ? 'ขนาด CC ต้องเป็นตัวเลขตั้งแต่ 0' : 'น้ำหนักรถต้องเป็นตัวเลขตั้งแต่ 0');
    }
  }

  for (const key of ['registrationProvince', 'ownerProvince'] as const) {
    if (row[key] && !(PROVINCES as readonly string[]).includes(row[key])) {
      errors.push(key === 'registrationProvince' ? 'จังหวัดที่จดทะเบียนไม่ถูกต้อง' : 'จังหวัดเจ้าของรถไม่ถูกต้อง');
    }
  }

  return errors;
}
