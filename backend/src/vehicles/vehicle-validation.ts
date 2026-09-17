// Ported from prototype/sites-reference/shared/vehicle-data.js (normalizeVehicle / vehicleErrors).

import { FUEL_TYPES, PROVINCES, VEHICLE_COLUMNS, VEHICLE_TYPES, VehicleColumnKey } from './vehicle-reference-data.js';

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

export function getVehicleRowErrors(row: NormalizedVehicleRow): string[] {
  const errors: string[] = [];

  if (row.body && !(VEHICLE_TYPES as readonly string[]).includes(row.body)) {
    errors.push('กรุณาเลือกประเภทรถจากรายการที่กำหนด');
  }
  if (row.fuel && !(FUEL_TYPES as readonly string[]).includes(row.fuel)) {
    errors.push('กรุณาเลือกประเภทเชื้อเพลิงจากรายการที่กำหนด');
  }
  if (!isValidDate(row.date)) {
    errors.push('วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง');
  }
  if (!row.customerId) errors.push('กรุณาเลือกลูกค้า');
  if (!row.chassis) errors.push('กรุณากรอกเลขตัวถัง');
  if (!row.brandId) errors.push('กรุณาเลือกยี่ห้อ');

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
