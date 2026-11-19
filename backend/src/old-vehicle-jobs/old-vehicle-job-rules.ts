// กฎของหน้ารวม "งานรถเก่า" (ผู้ใช้ 2026-11-18) - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล ทดสอบได้ตรงๆ
// สำเนาฝั่งหน้าเว็บ: frontend/src/lib/old-vehicle-jobs-api.ts (ชื่องาน ชื่อสถานะ เหตุผลติดขัด) - แก้ให้ตรงกันทั้งสองที่
import { requiresInspection } from '../tax-renewal/vehicle-tax-calculator.js';
import {
  TRANSPORT_VEHICLE_TYPES,
  VEHICLE_TYPES,
  isMotorcycleType,
  isTransportType,
} from '../vehicles/vehicle-reference-data.js';

export const OLD_JOB_TYPES = [
  'PLATE_SWAP',
  'TRANSFER_OWNER',
  'TRANSFER_INSPECTION',
  'TRANSFER_MOVE_IN',
  'TAX_RENEWAL',
  'USE_CANCEL',
  'MOVE_OUT',
  'PLATE_COPY',
] as const;
export type OldJobType = (typeof OLD_JOB_TYPES)[number];

export const OLD_JOB_TYPE_LABEL: Record<OldJobType, string> = {
  PLATE_SWAP: 'สลับเลข / เปลี่ยนเลข', // เปลี่ยนเลขทะเบียน = แบบ CHANGE ของงานเดียวกัน (ผู้ใช้ 2026-11-18)
  TRANSFER_OWNER: 'โอนตามผู้ถือกรรมสิทธิ์',
  TRANSFER_INSPECTION: 'โอนตรวจรถ',
  TRANSFER_MOVE_IN: 'โอนย้ายเข้า',
  TAX_RENEWAL: 'ต่อภาษี',
  USE_CANCEL: 'ยกเลิกการใช้รถ',
  MOVE_OUT: 'ย้ายออก',
  PLATE_COPY: 'คัดแผ่นป้าย',
};

export const isOldJobType = (value: unknown): value is OldJobType =>
  typeof value === 'string' && (OLD_JOB_TYPES as readonly string[]).includes(value);

// สถานะของงาน 1 งานบนหน้ารวม เรียงตามโฟลว: รับงาน -> ตรวจรถ -> ยื่น -> รับเอกสาร -> ส่งงาน (ผู้ใช้: "เสร็จคือกดส่งงานแล้ว")
export type OldJobStatus =
  | 'NEW' // รอทำ - รับงานแล้ว ยังไม่เลือกประเภทงาน
  | 'TO_INSPECT' // รอส่งตรวจ
  | 'TO_RESULT' // รอผลตรวจ
  | 'TO_SUBMIT' // รอยื่น
  | 'TO_PAY' // รอชำระภาษี (ต่อภาษีที่ยื่นแล้วยังไม่บันทึกวันชำระ)
  | 'TO_RECEIPT' // รอใบเสร็จ
  | 'TO_PLATE' // รอป้าย
  | 'TO_BOOK' // รอเล่ม
  | 'TO_DELIVER' // รอส่งงาน
  | 'DONE' // เสร็จ
  | 'CANCELLED'; // งานจริงถูกยกเลิกในหน้าของงานนั้น

export const OLD_JOB_STATUS_LABEL: Record<OldJobStatus, string> = {
  NEW: 'รอทำ',
  TO_INSPECT: 'รอส่งตรวจ',
  TO_RESULT: 'รอผลตรวจ',
  TO_SUBMIT: 'รอยื่น',
  TO_PAY: 'รอชำระภาษี',
  TO_RECEIPT: 'รอใบเสร็จ',
  TO_PLATE: 'รอป้าย',
  TO_BOOK: 'รอเล่ม',
  TO_DELIVER: 'รอส่งงาน',
  DONE: 'เสร็จ',
  CANCELLED: 'งานถูกยกเลิก',
};

export const isClosedStatus = (status: OldJobStatus) => status === 'DONE' || status === 'CANCELLED';

// เหตุผลติดขัด (ผู้ใช้ 2026-11-18: "ให้เลือกและพิมพ์เอง") - รายการตั้งต้นเป็นข้อเสนอของ Claude ผู้ใช้ยังไม่ได้แก้
export const BLOCK_REASONS = [
  ['WAIT_CUSTOMER_DOC', 'รอเอกสารจากลูกค้า'],
  ['DOC_INVALID', 'เอกสารหมดอายุ หรือไม่ถูกต้อง'],
  ['WAIT_FINANCE', 'รอไฟแนนซ์'],
  ['WAIT_VEHICLE', 'รอลูกค้านำรถมาตรวจ'],
  ['INSPECTION_FAILED', 'ตรวจรถไม่ผ่าน รอแก้ไข'],
  ['WAIT_DLT', 'รอขนส่ง'],
  ['OTHER', 'อื่นๆ'],
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number][0];
export const BLOCK_REASON_LABEL = Object.fromEntries(BLOCK_REASONS) as Record<BlockReason, string>;
export const isBlockReason = (value: unknown): value is BlockReason =>
  typeof value === 'string' && value in BLOCK_REASON_LABEL;
// ติดขัดเกินกี่วันจึงขึ้นเตือนในภาพรวมผู้บริหาร (ผู้ใช้ 2026-11-18: "เกิน 3 วัน" นับเป็นวันปฏิทิน)
export const BLOCKED_ALERT_DAYS = 3;

// จำนวน "วันทำการ" (จันทร์-ศุกร์) ที่ผ่านไปหลังวัน from จนถึงวัน to (ผู้ใช้ 2026-11-18: ติดขัดนับวันทำการ) - ระบบไม่รู้วันหยุดนักขัตฤกษ์
// รับวันที่ ค.ศ. YYYY-MM-DD (เวลาไทย) ทั้งคู่ · ติดขัดวันศุกร์ ถึงวันจันทร์ = 1 วัน
export function workingDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00.000Z`);
  const to = new Date(`${toIso}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return 0;
  const totalDays = Math.round((to.getTime() - from.getTime()) / 86_400_000);
  const fullWeeks = Math.floor(totalDays / 7);
  let count = fullWeeks * 5;
  for (let i = 1; i <= totalDays % 7; i++) {
    const day = new Date(from.getTime() + (fullWeeks * 7 + i) * 86_400_000).getUTCDay();
    if (day !== 0 && day !== 6) count++;
  }
  return count;
}

// ประเภทรถตอนรับงาน = รย. 14 ประเภทของงานจดใหม่ + ขส. 4 ประเภทของงานต่อภาษี (ผู้ใช้ 2026-11-18)
export const OLD_VEHICLE_TYPES: readonly string[] = [...VEHICLE_TYPES, ...TRANSPORT_VEHICLE_TYPES];
export const isOldVehicleType = (value: unknown): value is string =>
  typeof value === 'string' && OLD_VEHICLE_TYPES.includes(value);
export const vehicleClassOfType = (vehicleType: string | null | undefined): 'CAR' | 'MOTO' =>
  isMotorcycleType(vehicleType) ? 'MOTO' : 'CAR';

// เลขตัวถัง: เก็บตัวพิมพ์ใหญ่ ตัดช่องว่าง / กุญแจกันซ้ำตัดขีดและจุดออกด้วย (พิมพ์มี/ไม่มีขีดถือเป็นคันเดียวกัน)
export const cleanChassis = (raw: string) => raw.toUpperCase().replace(/\s+/g, '');
export const chassisKeyOf = (raw: string) => cleanChassis(raw).replace(/[-.]/g, '');

// เลขตรวจสอบของ VIN 17 หลัก (ISO 3779) - ใช้เตือนเท่านั้น รถบางยี่ห้อ/รถเก่าไม่ใช้เลขตรวจสอบ
const VIN_VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
export function vinCheckDigitOk(vin: string): boolean {
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    const ch = vin[i];
    const value = /\d/.test(ch) ? Number(ch) : VIN_VALUES[ch];
    if (value === undefined) return false;
    sum += value * VIN_WEIGHTS[i];
  }
  const check = sum % 11;
  return vin[8] === (check === 10 ? 'X' : String(check));
}

// คำเตือนของเลขตัวถัง (กดผ่านได้ ไม่ห้ามบันทึก)
export function chassisWarnings(raw: string): string[] {
  const chassis = chassisKeyOf(raw);
  const warnings: string[] = [];
  if (chassis.length === 17 && /^[A-Z0-9]+$/.test(chassis)) {
    if (/[IOQ]/.test(chassis)) warnings.push('เลขตัวถัง 17 หลักไม่ใช้ตัว I, O, Q - ตรวจว่าไม่ได้พิมพ์สลับกับเลข 1 หรือ 0');
    else if (!vinCheckDigitOk(chassis)) warnings.push('เลขตรวจสอบของเลขตัวถัง (หลักที่ 9) ไม่ตรง - ตรวจเลขตัวถังอีกครั้ง');
  }
  return warnings;
}

// รหัสทะเบียนของประเภทรถ ที่ใช้ถามกฎตรวจสภาพชุดเดียวกับงานต่อภาษี (requiresInspection)
function registrationCodeOf(vehicleType: string): string | null {
  if (isTransportType(vehicleType)) return 'ขส.';
  if (isMotorcycleType(vehicleType)) return 'รย.12'; // รย.17 ใช้เกณฑ์มอเตอร์ไซค์ชุดเดียวกับ รย.12
  const code = vehicleType.split('-')[0];
  return ['รย.1', 'รย.2', 'รย.3'].includes(code) ? code : null;
}

export interface InspectionRuleInput {
  jobType: OldJobType;
  vehicleType: string | null;
  firstRegistrationDate: Date | null; // ต่อภาษีเท่านั้น
  taxExpiryDate: Date | null; // ต่อภาษีเท่านั้น
  today: Date; // เที่ยงคืน UTC ของวันนี้ตามเวลาไทย
}

// ระบบตัดสินเองว่างานนี้ต้องตรวจรถก่อนยื่นไหม (ผู้ใช้ 2026-11-18):
// โอนตรวจรถ + โอนย้ายเข้า = ทุกคัน / ต่อภาษี = รถ ขส. ทุกครั้ง และรถที่ค้างภาษีเกิน 1 ปี / งานอื่นไม่ตรวจ
// ต่อภาษีตามอายุรถ (รถยนต์ครบ 7 ปี / มอเตอร์ไซค์ครบ 5 ปี) ไม่ผ่านคิวนี้ (ผู้ใช้ 2026-11-20: "ตรอ. ไม่เกี่ยวกับตรวจรถในระบบ"):
// ใบตรวจ ตรอ. และ พ.ร.บ. เป็นเอกสารที่ต้องมีเพื่อต่อภาษี และติ๊ก "ตรวจ ตรอ." ในใบต่อภาษีเอง
// แต่ขาดภาษีนานเกิน 1 ปีต้องพารถไปตรวจจริง จึงยังเข้าคิวตรวจรถ (ผู้ใช้ 2026-11-20)
export function inspectionRequiredFor(input: InspectionRuleInput): boolean {
  if (input.jobType === 'TRANSFER_INSPECTION' || input.jobType === 'TRANSFER_MOVE_IN') return true;
  if (input.jobType !== 'TAX_RENEWAL') return false;
  if (!input.vehicleType) return false;
  const code = registrationCodeOf(input.vehicleType);
  if (!code) return false;
  if (code === 'ขส.') return true;
  if (!input.taxExpiryDate) return false;
  const overdueDays = Math.max(0, (input.today.getTime() - input.taxExpiryDate.getTime()) / 86_400_000);
  return requiresInspection(code, 0, overdueDays / 365); // อายุรถส่ง 0 = ไม่ใช้เกณฑ์อายุ
}

// ค่าตรวจตั้งต้นตอนส่งตรวจนอก ตามประเภทรถ (ผู้ใช้ 2026-11-20: ราคานี้ใช้กับงานตรวจรถของงานรถเก่าทุกแบบ ประเภทที่ไม่มีในตารางให้กรอกเอง)
// มาจากชีต 'Rate โอน' คอลัมน์ "ค่าตรวจ" ใน Google Sheet "ขนส่ง" (สูตร VLOOKUP ของคอลัมน์ค่าตรวจรถ) - สำเนาฝั่งหน้าเว็บ: frontend/src/lib/old-vehicle-jobs-api.ts
// ไม่มีในตาราง = รย.3 กระบะมีหลังคาแหนบ, รย.17, รถ ขส. (ทั้งหมดกรอกเอง; รถ ขส. เดิมตั้งต้น 1,000 ถูกเอาออกตามคำตอบนี้)
export const INSPECTION_COST_BY_TYPE: Record<string, number> = {
  'รย.1-เก๋ง 2 ตอน': 200,
  'รย.1-นั่ง 2 ตอน': 300,
  'รย.1-นั่ง 3 ตอน': 300,
  'รย.2-นั่ง 2 แถว': 500,
  'รย.2-นั่ง 4 ตอน': 500,
  'รย.3-กระบะบรรทุก': 300,
  'รย.3-กระบะบรรทุกมีหลังคา': 1000,
  'รย.3-ตู้บรรทุก': 1000,
  'รย.12-น้อยกว่า 300cc': 100,
  'รย.12-300-799cc': 300,
  'รย.12-800-999cc': 500,
  'รย.12-1000cc ขึ้นไป': 1000,
};
export const defaultInspectionCost = (vehicleType: string | null | undefined): number | null =>
  (vehicleType ? INSPECTION_COST_BY_TYPE[vehicleType] : undefined) ?? null;

// สถานะของงานที่ยังไม่ยื่น (ยังไม่มีแถวในตารางงานจริง)
export interface IntakeState {
  jobType: string | null;
  inspectionRequired: boolean;
  inspectionSentDate: Date | null;
  inspectionResult: string | null;
}
export function intakeStatus(job: IntakeState): OldJobStatus {
  if (!job.jobType) return 'NEW';
  if (!job.inspectionRequired) return 'TO_SUBMIT';
  // ตรวจไม่ผ่าน = ต้องส่งตรวจใหม่
  if (!job.inspectionSentDate || job.inspectionResult === 'FAIL') return 'TO_INSPECT';
  if (job.inspectionResult !== 'PASS') return 'TO_RESULT';
  return 'TO_SUBMIT';
}

// สถานะของงานที่ยื่นแล้ว - อ่านจากแถวในตารางงานจริง (ช่องที่งานนั้นไม่มีส่งมาเป็น undefined)
export interface LinkedJobState {
  cancelledAt: Date | null;
  hasInspection?: boolean; // งานโอนที่มีขั้นตรวจรถในตารางของตัวเอง
  inspectionSentDate?: Date | null;
  inspectionResult?: string | null;
  paymentDate?: Date | null; // ต่อภาษี: undefined = งานนี้ไม่มีขั้นชำระ
  returnedDate: Date | null; // ต่อภาษีใช้ receivedDate
  needsPlate?: boolean; // สลับเลขที่ซื้อป้าย / คัดแผ่นป้าย
  plateReceivedDate?: Date | null;
  plateDeliveredDate?: Date | null; // สลับเลข: ส่งเล่มก่อน ป้ายตามทีหลัง (undefined = งานนี้ไม่มีช่องนี้)
  needsBook?: boolean; // สลับเลข
  bookReceivedDate?: Date | null;
  deliveredDate: Date | null;
}
export function linkedStatus(job: LinkedJobState): OldJobStatus {
  if (job.cancelledAt) return 'CANCELLED';
  if (job.deliveredDate) {
    // ส่งเล่มไปแล้วแต่ป้ายยังค้าง: ยังไม่ได้รับป้าย = รอป้าย / รับป้ายแล้วยังไม่ส่ง = รอส่งงาน (ป้ายอย่างเดียว)
    if (job.needsPlate && !job.plateReceivedDate) return 'TO_PLATE';
    if (job.needsPlate && job.plateDeliveredDate === null) return 'TO_DELIVER';
    return 'DONE';
  }
  if (job.hasInspection && !job.returnedDate) {
    if (!job.inspectionSentDate || job.inspectionResult === 'FAIL') return 'TO_INSPECT';
    if (job.inspectionResult !== 'PASS') return 'TO_RESULT';
  }
  if (job.paymentDate === null) return 'TO_PAY';
  if (!job.returnedDate) return 'TO_RECEIPT';
  if (job.needsPlate && !job.plateReceivedDate) return 'TO_PLATE';
  if (job.needsBook && !job.bookReceivedDate) return 'TO_BOOK';
  return 'TO_DELIVER';
}
