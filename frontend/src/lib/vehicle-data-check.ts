// คำเตือนข้อมูลรถน่าจะคีย์ผิด (ผู้ใช้ 2026-10-13) - กฎทั้งหมดอยู่ที่ backend/src/vehicles/vehicle-data-check.ts
// ฝั่งหน้าจอมีแค่ส่วนของเลขตัวถัง (นับหลักให้เห็นตอนพิมพ์) และรูปแบบคำตอบ 409 needsConfirm ของ POST /api/vehicles

import { ApiError } from "./api";

export const VIN_LENGTH = 17;
export const MODEL_PREFIX_LENGTH = 8;

export interface DataWarning {
  code: string;
  message: string;
  short: string;
  key: string; // ส่งคืนใน confirmedWarnings ตอนยืนยัน
}

export interface RowDataWarnings {
  row: number; // ลำดับในชุดที่ส่งไป (เริ่ม 1)
  chassis: string;
  warnings: DataWarning[];
}

// รุ่นที่รู้จัก: รถในระบบที่เลขตัวถัง 8 ตัวแรกเหมือนกัน - ช่องที่ยังไม่มีค่าที่เชื่อได้เป็น null
export interface KnownModel {
  prefix: string;
  count: number;
  brand: { id: string; name: string } | null;
  cc: number | null;
  body: string | null;
}

export const normalizeChassis = (chassis: string) => chassis.toUpperCase().replace(/\s+/g, "");

export function modelPrefix(chassis: string): string {
  const value = normalizeChassis(chassis);
  return value.length >= MODEL_PREFIX_LENGTH ? value.slice(0, MODEL_PREFIX_LENGTH) : "";
}

// ตัวอักษรที่ปกติไม่ใช้ในเลขตัวถัง (I O Q และเครื่องหมาย) - ว่าง = ไม่มี
export function oddChassisChars(chassis: string): string[] {
  return Array.from(new Set(normalizeChassis(chassis).match(/[IOQ]|[^A-Z0-9]/g) ?? []));
}

// คำเตือนรายแถวจาก error ของ api.createVehicles - ไม่ใช่ 409 needsConfirm = null (error อื่นแสดงข้อความตามปกติ)
export function rowWarningsOf(error: unknown): RowDataWarnings[] | null {
  if (!(error instanceof ApiError) || error.status !== 409 || error.details?.needsConfirm !== true) return null;
  return Array.isArray(error.details.warnings) ? (error.details.warnings as RowDataWarnings[]) : null;
}

export const warningKeys = (rows: RowDataWarnings[]) => rows.flatMap((row) => row.warnings.map((w) => w.key));
