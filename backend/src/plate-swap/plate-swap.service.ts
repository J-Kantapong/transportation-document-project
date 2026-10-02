import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type AuditChanges, diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { assertKindInScope, currentVehicleScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { hasWrongSwapPlate, NEW_VEHICLE_SUBMITTED_ERROR, newVehicleLinkBlockReason, OPEN_PLATE_SWAP_WHERE } from '../document-submission/plate-swap-link.js';
import { ACTIVE_SUBMISSION_STATUSES } from '../document-submission/submission-eligibility.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PlateSwapKind, PlateSwapNumberSource } from '../generated/prisma/enums.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtractor } from '../receipts/receipt-extractor.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { DUPLICATE_UPLOAD_ERROR, contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { calculatePlateSwapCarFees, calculatePlateSwapMotoFees, type FeeItem } from './plate-swap-fee.js';

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ผู้ใช้ 2026-09-22
// ขั้นตอน: บันทึก/ยื่น (POST) -> ลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (บังคับ) -> รับเอกสารกลับ (วันที่ + รูปใบเสร็จอย่างน้อย 1 รูป)
// รถใหม่รับ "ทะเบียนเก่า" ของรถเก่า ส่วน "ทะเบียนใหม่" คือเลขที่รถเก่าได้รับ (ผู้ใช้ยืนยัน 2026-09-27)
// สิทธิ์: เป็นงานยื่นเอกสาร/รับใบเสร็จของรถยนต์ จึงใช้กลุ่ม STAFF_CAR (ขอบเขต 'car' ใน vehicle-scope) - ดู access-policy.ts
// แก้/ยกเลิก (ผู้ใช้ 2026-09-27): ADMIN + STAFF_CAR ต้องระบุเหตุผลเสมอ บันทึกประวัติลง AuditLog และยกเลิกแบบไม่ลบแถว
// (cancelledAt) - งานที่ยกเลิกแล้วไม่แสดงในรายการ ยอดรวม ภาพรวม และไม่ล็อกการยื่นเอกสารของรถใหม่

export interface PlateSwapReceipt {
  id: string;
  createdAt: string;
}

// เจ้าของงาน = ลูกค้าที่ส่งงานนี้มาให้เรา (ผู้ใช้ 2026-09-28) - ใช้ตอนส่งงาน/วางบิลให้วางถูกราย
// คนละคนกับ oldOwnerName (เจ้าของรถเก่าตามทะเบียน) ห้ามอนุมานจากกัน - กฎเดียวกับ Vehicle.customerId กับ Vehicle.ownerId
export interface PlateSwapCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface PlateSwapNewVehicle {
  id: string;
  chassis: string;
  brandName: string;
  customerName: string;
  plateCategory: string | null;
  plateNumber: string | null;
  // รายการยื่นเอกสารที่ยังมีผลล่าสุด (PENDING / RECEIPT_RECEIVED) - null = ยังไม่ยื่น / ยื่นไม่ผ่าน / ยกเลิกการยื่น
  // หน้างานสลับเลขใช้บอกว่าทะเบียนที่เติมผิดฝั่ง (F20) แก้ได้ที่ไหน (พบ 2026-09-27)
  activeSubmissionStatus: string | null;
}

// ผลค้นรถใหม่ - linkBlockedReason ไม่ว่าง = ผูกไม่ได้ (หน้าเว็บปิดปุ่มเลือกและแสดงเหตุผล)
export interface PlateSwapVehicleHit extends PlateSwapNewVehicle {
  linkBlockedReason: string | null;
}

export interface PlateSwapRow {
  id: string;
  kind: PlateSwapKind;
  vehicleClass: PlateSwapVehicleClass; // CAR | MOTO (ผู้ใช้ 2026-09-28)
  urgent: boolean; // งานด่วน - มีเฉพาะมอเตอร์ไซค์
  // งานคู่ของเคสรถเก่า-รถเก่า (ผู้ใช้ 2026-09-28) - null = งาน OLD_NEW ซึ่งไม่มีคู่
  pairId: string | null;
  // เจ้าของงาน - null = งานที่บันทึกไว้ก่อน 2026-09-28 (ยังไม่มีลูกค้า) งานใหม่บังคับกรอกเสมอ
  customer: PlateSwapCustomer | null;
  oldOwnerName: string;
  oldEngine: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string | null;
  newPlateNumber: string | null;
  newVehicle: PlateSwapNewVehicle | null;
  // ผู้ใช้ 2026-09-27: รถใหม่ที่ลิงก์ถูกเติมทะเบียนเป็น "ทะเบียนใหม่ของรถเก่า" (ขั้นยื่นเอกสารเคยเติมผิดฝั่ง) - ให้ตรวจ
  linkedPlateIsNewPlate: boolean;
  submitDate: string; // YYYY-MM-DD
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: string;
  noBillTotal: string;
  returnedDate: string | null; // YYYY-MM-DD
  receipts: PlateSwapReceipt[];
  // แยกขั้นรับเอกสารกลับเป็น 3 ขั้น (ผู้ใช้ 2026-09-28) - เฉพาะฝั่งรถเก่าของงานนี้เอง ไม่ผูกกับ returnedDate/กฎใดๆ
  // รับใบเสร็จ: เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ (เฉพาะตอนช่องยังว่างทั้ง 3) แก้เองทีหลังได้เสมอ
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD
  receiptAmount: string | null;
  // รับป้าย/รับเล่ม: ไม่ใช้ AI (เหมือน Step 6/7 ปัจจุบัน) - platePhotoId/bookPhotoId ใช้ดูรูปที่ GET .../plate-photo/image, .../book-photo/image
  plateReceivedDate: string | null; // YYYY-MM-DD
  platePhotoId: string | null;
  bookReceivedDate: string | null; // YYYY-MM-DD
  bookPhotoId: string | null;
  createdAt: string;
  // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดฟอร์มอยู่ = 409 (พบ 2026-09-27)
  updatedAt: string;
}

// Wire shape - ทุกช่องมาจาก JSON ที่ยังไม่ตรวจ จึงเป็น unknown ให้ service ตรวจเอง
export interface CreatePlateSwapDto {
  vehicleClass?: unknown; // CAR (ค่าเริ่มต้น) | MOTO - ผู้ใช้ 2026-09-28
  urgent?: unknown; // งานด่วน (มีเฉพาะมอเตอร์ไซค์)
  customerId?: unknown; // เจ้าของงาน (บังคับตั้งแต่ 2026-09-28) - ต้องเป็น id ของลูกค้าที่มีอยู่จริง
  oldOwnerName?: unknown;
  oldEngine?: unknown;
  oldChassis?: unknown;
  oldBrand?: unknown;
  oldPlateCategory?: unknown;
  oldPlateNumber?: unknown;
  newPlateCategory?: unknown;
  newPlateNumber?: unknown;
  newVehicleId?: unknown;
  submitDate?: unknown;
  numberSource?: unknown;
  buyNormalPlate?: unknown;
  buyAuctionPlate?: unknown;
}

// รถเก่า 1 คันในเคส "รถเก่า กับ รถเก่า" - ไม่มี newPlate เพราะระบบเติมให้เองจากทะเบียนของอีกคัน
export interface PlateSwapPairCarDto {
  oldOwnerName?: unknown;
  oldEngine?: unknown;
  oldChassis?: unknown;
  oldBrand?: unknown;
  oldPlateCategory?: unknown;
  oldPlateNumber?: unknown;
}

// ยื่นงาน "รถเก่า กับ รถเก่า" (ผู้ใช้ 2026-09-28) - กรอก 2 คันในคำขอเดียว ระบบสร้างเป็น 2 งานที่ผูกกันด้วย pairId
// เจ้าของงาน วันที่ยื่น และตัวเลือกค่าใช้จ่ายใช้ร่วมกันทั้งคู่ ส่วนค่าใช้จ่ายคิดแยกคันละชุด (ราคาเท่าเคสรถเก่า-รถใหม่)
export interface CreatePlateSwapPairDto {
  vehicleClass?: unknown;
  urgent?: unknown;
  customerId?: unknown;
  submitDate?: unknown;
  numberSource?: unknown;
  buyNormalPlate?: unknown;
  buyAuctionPlate?: unknown;
  carA?: PlateSwapPairCarDto;
  carB?: PlateSwapPairCarDto;
}

// แก้งาน (PATCH /api/plate-swaps/:id) - ช่องที่ไม่ส่งมา (undefined) = ไม่แก้ / remark บังคับ
// returnedDate แก้ได้เฉพาะงานที่รับเอกสารกลับแล้ว (ยังไม่รับกลับใช้ปุ่มยืนยันรับกลับ)
export interface UpdatePlateSwapDto {
  customerId?: unknown;
  urgent?: unknown; // งานด่วน (มีเฉพาะมอเตอร์ไซค์) - คิดค่าใช้จ่ายใหม่เมื่อเปลี่ยน // เปลี่ยนเจ้าของงาน (ผู้ใช้ 2026-09-28) - ส่งมาแล้วต้องเป็นลูกค้าที่มีอยู่จริง ล้างให้ว่างไม่ได้
  oldOwnerName?: unknown;
  oldEngine?: unknown;
  oldChassis?: unknown;
  oldBrand?: unknown;
  oldPlateCategory?: unknown;
  oldPlateNumber?: unknown;
  submitDate?: unknown;
  numberSource?: unknown;
  buyNormalPlate?: unknown;
  buyAuctionPlate?: unknown;
  returnedDate?: unknown;
  remark?: unknown;
  // updatedAt (ISO) ของงานตอนเปิดฟอร์ม - ไม่ตรงกับในระบบ = มีคนแก้/รับกลับไปก่อน -> 409 ไม่ทับของเขา (ไม่ส่ง = เทียบกับค่าที่อ่านในคำขอนี้)
  expectedUpdatedAt?: unknown;
}

const isValidMonthParam = (value: string) => /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));
export const toUtcDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
export const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

// วันที่ ค.ศ. YYYY-MM-DD ที่มีอยู่จริง (2026-02-31 ไม่ผ่าน) - null = ไม่ถูกต้อง
export function parseIsoDate(value: unknown): Date | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = toUtcDate(raw);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === raw ? date : null;
}

export function requiredText(value: unknown, label: string, max = 200): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BadRequestException({ error: `กรุณากรอก${label}` });
  if (text.length > max) throw new BadRequestException({ error: `${label}ยาวเกิน ${max} ตัวอักษร` });
  return text;
}

// ช่องที่ยังไม่รู้ตอนยื่นได้ (เลขทะเบียนใหม่) - ว่างเก็บเป็น null ไม่ใช่สตริงว่าง
export function optionalText(value: unknown, label: string, max = 200): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  if (text.length > max) throw new BadRequestException({ error: `${label}ยาวเกิน ${max} ตัวอักษร` });
  return text;
}

// วันที่ในใบเสร็จ (รับใบเสร็จ) - ไม่ส่งมา/ว่าง = ไม่รู้ (null) ส่งมาแล้วต้องเป็นวันที่จริง
export function optionalIsoDateField(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = parseIsoDate(value);
  if (!date) throw new BadRequestException({ error: `${label}ไม่ถูกต้อง (ค.ศ. YYYY-MM-DD)` });
  return date;
}

// วันที่รับป้าย/รับเล่ม - บังคับกรอกเสมอ (ต่างจากวันที่ใบเสร็จซึ่งยังไม่รู้ได้)
function requiredIsoDateField(value: unknown, label: string): Date {
  const date = parseIsoDate(value);
  if (!date) throw new BadRequestException({ error: `${label}ไม่ถูกต้อง (ค.ศ. YYYY-MM-DD)` });
  return date;
}

// ช่วงวันที่ของวันที่รับเอกสารกลับ/รับป้าย/รับเล่ม - ต้องไม่ก่อนวันที่ยื่น และไม่เกินวันนี้ (เวลาไทย)
// อยู่ระหว่างวันที่ยื่นถึงวันนี้ (เวลาไทย) - ใช้ทั้งตอนตรวจของที่พนักงานกรอก และตอนกรองวันที่ที่ AI อ่านมา
export function dateInRange(date: Date, submitDate: Date): boolean {
  return date >= submitDate && isoDate(date)! <= bangkokToday();
}

export function assertDateInRange(label: string, date: Date, submitDate: Date): void {
  if (date < submitDate) throw new BadRequestException({ error: `${label}ต้องไม่ก่อนวันที่ยื่น` });
  if (isoDate(date)! > bangkokToday()) throw new BadRequestException({ error: `${label}ต้องไม่เกินวันนี้` });
}

// ยอดเงินในใบเสร็จ - เก็บทศนิยม 2 ตำแหน่ง ไม่ส่งมา/ว่าง = ไม่รู้ (null)
export function optionalAmount(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === '') return null;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) throw new BadRequestException({ error: `${label}ไม่ถูกต้อง` });
  return Math.round(num * 100) / 100;
}

// ทะเบียนใหม่ = หมวด + เลข ต้องมาครบคู่ หรือไม่มีเลย (ยังไม่รู้ตอนยื่น) - ห้ามมีแค่ครึ่งเดียว
function newPlateParts(categoryRaw: unknown, numberRaw: unknown): { category: string | null; number: string | null } {
  const category = optionalText(categoryRaw, 'หมวดทะเบียนใหม่', 10);
  const number = optionalText(numberRaw, 'เลขทะเบียนใหม่', 10);
  if ((category && !number) || (!category && number)) {
    throw new BadRequestException({ error: 'กรุณากรอกทะเบียนใหม่ให้ครบทั้งหมวดทะเบียนและเลขทะเบียน (หรือเว้นว่างทั้งคู่)' });
  }
  return { category, number };
}

// ประเภทรถของงานสลับเลข - ใช้คอลัมน์ vehicleClass ที่มีอยู่แล้ว (ผู้ใช้ให้อัตรามอเตอร์ไซค์ 2026-09-28)
export type PlateSwapVehicleClass = 'CAR' | 'MOTO';
const CLASS_LABEL: Record<PlateSwapVehicleClass, string> = { CAR: 'รถยนต์', MOTO: 'รถจักรยานยนต์' };

function parseVehicleClass(value: unknown): PlateSwapVehicleClass {
  if (value === undefined || value === null || value === '') return 'CAR';
  if (value === 'CAR' || value === 'MOTO') return value;
  throw new BadRequestException({ error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR หรือ MOTO' });
}

// ค่าใช้จ่ายตามประเภทรถ - รถยนต์เลือกที่มาของเลขได้ ส่วนมอเตอร์ไซค์ใช้เลขที่ไม่เคยออกเสมอ แต่มีตัวเลือกงานด่วน
function feesFor(
  vehicleClass: PlateSwapVehicleClass,
  options: { numberSource: PlateSwapNumberSource; buyNormalPlate: boolean; buyAuctionPlate: boolean; urgent: boolean },
) {
  return vehicleClass === 'MOTO'
    ? calculatePlateSwapMotoFees({ buyNormalPlate: options.buyNormalPlate, urgent: options.urgent })
    : calculatePlateSwapCarFees(options);
}

// เคสของงานที่จะแสดงในรายการ - ไม่ส่งมา = OLD_NEW เหมือนเดิม (หน้าเดิมไม่ต้องแก้ และงานคนละเคสไม่ปนกันในคิว)
function parseKind(value: unknown): PlateSwapKind {
  if (value === undefined || value === null || value === '') return PlateSwapKind.OLD_NEW;
  if (value === PlateSwapKind.OLD_NEW || value === PlateSwapKind.OLD_OLD) return value;
  throw new BadRequestException({ error: 'พารามิเตอร์ kind ต้องเป็น OLD_NEW หรือ OLD_OLD' });
}

// ทะเบียนแบบเทียบกันได้ (ไม่สนช่องว่าง/ตัวพิมพ์) - ใช้เช็คว่า 2 คันในเคสคู่ไม่ได้กรอกทะเบียนเดียวกัน
const plateKey = (p: { oldPlateCategory: string; oldPlateNumber: string }) =>
  `${p.oldPlateCategory}${p.oldPlateNumber}`.replace(/\s/g, '').toUpperCase();

const isNumberSource = (value: unknown): value is PlateSwapNumberSource =>
  value === PlateSwapNumberSource.NEW_UNUSED || value === PlateSwapNumberSource.AUCTION_RESERVED;

const NUMBER_SOURCE_ERROR = 'กรุณาเลือกที่มาของเลขทะเบียนใหม่ (เลขที่ไม่เคยออก / เลขประมูลหรือชุดสงวน)';
const AUCTION_PLATE_ERROR = 'ค่าแผ่นป้ายประมูลมีเฉพาะเลขประมูลหรือชุดสงวน';

const newVehicleSelect = {
  id: true,
  chassis: true,
  plateCategory: true,
  plateNumber: true,
  brand: { select: { name: true } },
  customer: { select: { name: true } },
} as const;

// รายการยื่นเอกสารที่ยังมีผลล่าสุดของรถ - ใช้ทั้งกฎผูกรถ (F51) และบอกที่แก้ทะเบียนที่เติมผิดฝั่ง (F20)
const activeSubmissionSelect = {
  where: { status: { in: ACTIVE_SUBMISSION_STATUSES } },
  orderBy: { createdAt: 'desc' as const },
  take: 1,
  select: { status: true },
};

// เจ้าของงาน - ชื่อกับบริษัทพอสำหรับหน้าจอ (ตารางแสดง company ถ้ามี ไม่งั้นใช้ name เหมือนหน้าลูกค้าอื่น)
const customerSelect = { id: true, name: true, company: true } as const;

const swapInclude = {
  customer: { select: customerSelect },
  newVehicle: { select: { ...newVehicleSelect, documentSubmissions: activeSubmissionSelect } },
  receipts: { orderBy: { createdAt: 'asc' as const }, select: { id: true, createdAt: true } },
} satisfies Prisma.PlateSwapInclude;

interface NewVehicleRecord {
  id: string;
  chassis: string;
  plateCategory: string | null;
  plateNumber: string | null;
  brand: { name: string };
  customer: { name: string };
  documentSubmissions?: Array<{ status: string }>;
}

export interface SwapRecord {
  id: string;
  kind: PlateSwapKind;
  vehicleClass?: string;
  urgent?: boolean;
  pairId?: string | null;
  customerId?: string | null;
  customer?: PlateSwapCustomer | null;
  oldOwnerName: string;
  oldEngine: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string | null;
  newPlateNumber: string | null;
  newVehicleId?: string | null;
  submitDate: Date;
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
  billItems: unknown;
  noBillItems: unknown;
  billTotal: unknown;
  noBillTotal: unknown;
  returnedDate: Date | null;
  receiptNo: string | null;
  receiptDate: Date | null;
  receiptAmount: Prisma.Decimal | number | null;
  plateReceivedDate: Date | null;
  platePhotoId: string | null;
  bookReceivedDate: Date | null;
  bookPhotoId: string | null;
  cancelledAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
  newVehicle: NewVehicleRecord | null;
  receipts: { id: string; createdAt: Date }[];
}

const toNewVehicle = (v: NewVehicleRecord): PlateSwapNewVehicle => ({
  id: v.id,
  chassis: v.chassis,
  brandName: v.brand.name,
  customerName: v.customer.name,
  plateCategory: v.plateCategory,
  plateNumber: v.plateNumber,
  activeSubmissionStatus: v.documentSubmissions?.[0]?.status ?? null,
});

// F20 (ผู้ใช้ 2026-09-27): รถใหม่ต้องได้ "ทะเบียนเก่า" ของรถเก่า แต่ก่อนแก้ ขั้นยื่นเอกสารเติม "ทะเบียนใหม่" (เลขที่รถเก่าได้)
// ให้รถใหม่ - true = ทะเบียนที่บันทึกในรถใหม่ตรงกับทะเบียนใหม่ของรถเก่าและไม่ใช่ทะเบียนเก่า -> หน้างานสลับเลขขึ้น ⚠ ให้ตรวจ
// ใช้เงื่อนไขเดียวกับฝั่งยื่นเอกสาร (hasWrongSwapPlate ใน document-submission/plate-swap-link.ts)
export function linkedPlateIsNewPlate(row: {
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string | null;
  newPlateNumber: string | null;
  newVehicle: { plateCategory: string | null; plateNumber: string | null } | null;
}): boolean {
  return row.newVehicle ? hasWrongSwapPlate(row, row.newVehicle) : false;
}

export function serializePlateSwap(row: SwapRecord): PlateSwapRow {
  return {
    id: row.id,
    kind: row.kind,
    vehicleClass: parseVehicleClass(row.vehicleClass ?? 'CAR'),
    urgent: row.urgent ?? false,
    pairId: row.pairId ?? null,
    customer: row.customer ?? null,
    oldOwnerName: row.oldOwnerName,
    oldEngine: row.oldEngine,
    oldChassis: row.oldChassis,
    oldBrand: row.oldBrand,
    oldPlateCategory: row.oldPlateCategory,
    oldPlateNumber: row.oldPlateNumber,
    newPlateCategory: row.newPlateCategory,
    newPlateNumber: row.newPlateNumber,
    newVehicle: row.newVehicle ? toNewVehicle(row.newVehicle) : null,
    linkedPlateIsNewPlate: linkedPlateIsNewPlate(row),
    submitDate: row.submitDate.toISOString().slice(0, 10),
    numberSource: row.numberSource,
    buyNormalPlate: row.buyNormalPlate,
    buyAuctionPlate: row.buyAuctionPlate,
    billItems: row.billItems as FeeItem[],
    noBillItems: row.noBillItems as FeeItem[],
    billTotal: String(row.billTotal),
    noBillTotal: String(row.noBillTotal),
    returnedDate: isoDate(row.returnedDate),
    receipts: row.receipts.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() })),
    receiptNo: row.receiptNo ?? null,
    receiptDate: isoDate(row.receiptDate ?? null),
    receiptAmount: row.receiptAmount === null || row.receiptAmount === undefined ? null : String(row.receiptAmount),
    plateReceivedDate: isoDate(row.plateReceivedDate ?? null),
    platePhotoId: row.platePhotoId ?? null,
    bookReceivedDate: isoDate(row.bookReceivedDate ?? null),
    bookPhotoId: row.bookPhotoId ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// --- กฎผูกรถใหม่ (F51 ผู้ใช้ 2026-09-27) ---------------------------------------------------------
// งานที่ "ยังเปิดอยู่" = ยังไม่รับเอกสารกลับและไม่ถูกยกเลิก (OPEN_PLATE_SWAP_WHERE ตัวเดียวกับขั้นยื่นเอกสาร)
// รถหนึ่งคันผูกงานที่ยังเปิดอยู่ได้งานเดียว - excludeSwapId = งานที่กำลังเปลี่ยนคัน/ยกเลิกรับกลับ (ไม่นับตัวเอง)
export function openSwapWhere(excludeSwapId?: string): Prisma.PlateSwapWhereInput {
  return { ...OPEN_PLATE_SWAP_WHERE, ...(excludeSwapId ? { id: { not: excludeSwapId } } : {}) };
}

export interface PlateSwapLinkStatus {
  documentSubmissions: Array<{ status: string }>; // รายการยื่นที่ยังมีผล (PENDING / RECEIPT_RECEIVED) ล่าสุด
  plateSwapsAsNew: Array<{ id: string; oldOwnerName: string; oldPlateCategory: string; oldPlateNumber: string }>; // งานอื่นที่ยังเปิดอยู่
}

const linkStatusSelect = (excludeSwapId?: string) => ({
  documentSubmissions: activeSubmissionSelect,
  plateSwapsAsNew: {
    where: openSwapWhere(excludeSwapId),
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { id: true, oldOwnerName: true, oldPlateCategory: true, oldPlateNumber: true },
  },
});

// กฎเดียวที่ใช้ทุกที่: ตอนค้น (ปิดปุ่มเลือก) ตอนบันทึก/เปลี่ยนคัน และตอนยกเลิกรับกลับ (งานกลับมาเปิดอีกครั้ง)
// - รถที่ยื่นเอกสารจดทะเบียนแล้ว (รอใบเสร็จ/ได้ใบเสร็จ) ใช้เลขจากงานสลับเลขไม่ได้แล้ว (ขั้นที่ 4 ล็อกเฉพาะก่อนยื่น)
// - รถที่ผูกกับงานอื่นที่ยังเปิดอยู่ ผูกซ้ำไม่ได้ (เดิมขั้นที่ 4 ดูแค่งานล่าสุด ส่วนหน้าค้นหารถ/ภาพรวมดูทุกงาน จึงขัดกัน)
// ตัดสินด้วย newVehicleLinkBlockReason (document-submission/plate-swap-link.ts) ที่นี่แค่เติมรายละเอียดในข้อความ
export function plateSwapLinkBlockReason(status: PlateSwapLinkStatus, mode: 'link' | 'reopen' = 'link'): string | null {
  const submission = status.documentSubmissions?.[0]?.status ?? null;
  const other = status.plateSwapsAsNew?.[0];
  const rule = newVehicleLinkBlockReason({ activeSubmissionStatus: submission, hasOtherOpenSwap: Boolean(other) });
  if (!rule) return null;
  const subject = mode === 'link' ? 'รถคันนี้' : 'รถใหม่ที่ผูกไว้';
  const blocked = mode === 'link' ? 'ผูกกับงานสลับเลขไม่ได้' : 'ยกเลิกรับเอกสารกลับไม่ได้';
  if (rule === NEW_VEHICLE_SUBMITTED_ERROR) {
    if (submission === 'RECEIPT_RECEIVED') return `${subject}ได้ใบเสร็จจดทะเบียนแล้ว - ${blocked}`;
    return `${subject}ยื่นเอกสารจดทะเบียนไปแล้ว (รอใบเสร็จ) - ${blocked} ถ้าจะใช้เลขจากงานสลับเลขต้องยกเลิกการยื่นในหน้ารายการที่ยื่นก่อน`;
  }
  const owner = other ? `ของ ${other.oldOwnerName} (${other.oldPlateCategory} ${other.oldPlateNumber}) ` : '';
  return `${subject}ผูกกับงานสลับเลข${owner}ที่ยังไม่รับเอกสารกลับอยู่แล้ว - ${blocked} (รถหนึ่งคันผูกงานที่ยังเปิดอยู่ได้งานเดียว)`;
}

// ผู้ใช้ 2026-09-22: ต้องลิงก์รถใหม่ทุกงาน (บังคับตั้งแต่ตอนยื่น เปลี่ยนคันได้แต่ยกเลิกลิงก์ไม่ได้)
function requireVehicleId(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new BadRequestException({ error: 'กรุณาลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (ค้นด้วยเลขตัวถัง)' });
  }
  return raw.trim();
}

// มีคนแก้/ยกเลิก/รับกลับงานนี้ไปก่อน (update แบบมีเงื่อนไขไม่เจอแถว = Prisma P2025) -> 409 ให้หน้าเว็บโหลดใหม่
const STALE_ERROR = 'งานสลับเลขนี้ถูกแก้ ยกเลิก หรือรับกลับไปก่อนแล้ว - โหลดรายการใหม่';
function staleIfMissing(err: unknown): never {
  if ((err as { code?: string } | null)?.code === 'P2025') throw new ConflictException({ error: STALE_ERROR });
  throw err;
}

// updatedAt ที่ฟอร์มโหลดมา (ISO) - ไม่ส่ง = null / ส่งมาแต่อ่านเป็นวันเวลาไม่ได้ = 400
export function parseExpectedUpdatedAt(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const date = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new BadRequestException({ error: 'expectedUpdatedAt ต้องเป็นวันเวลา ISO' });
  return date;
}

export const sameTime = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null);

const RECEIPT_REQUIRED_ERROR = 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ';
const LAST_RECEIPT_ERROR = 'งานที่รับเอกสารกลับแล้วต้องมีรูปใบเสร็จอย่างน้อย 1 รูป - แนบรูปที่ถูกต้องก่อนแล้วจึงลบรูปนี้';

type Tx = Prisma.TransactionClient;

@Injectable()
export class PlateSwapService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // ขอบเขตการแก้ตามประเภทรถของงาน (ผู้ใช้ 2026-09-28: มอเตอร์ไซค์เป็นงานของ STAFF_MOTO เหมือนขั้นยื่นเอกสาร)
  private assertClassScope(vehicleClass: PlateSwapVehicleClass) {
    assertKindInScope(vehicleClass === 'MOTO' ? 'moto' : 'car');
  }

  // ดูรายการใช้ขอบเขตการอ่าน - ACCOUNTANT ที่ถือ STAFF_MOTO ด้วยยังอ่านงานสลับเลขรถยนต์ได้ (แก้ไม่ได้ - พบ 2026-09-27)
  private assertClassReadable(vehicleClass: PlateSwapVehicleClass) {
    const scope = currentVehicleScope();
    if (scope === 'ALL' || scope === vehicleClass) return;
    this.assertClassScope(vehicleClass);
  }

  // ค้นรถใหม่ในฐานข้อมูลรถจดใหม่เพื่อลิงก์ (contains, ไม่สนตัวพิมพ์, สูงสุด 10 คัน) - เฉพาะประเภทรถของงาน
  // ส่งเหตุผลที่ผูกไม่ได้กลับไปด้วย (F51) - excludeSwapId = งานที่กำลังเปลี่ยนคัน (รถที่ผูกกับงานนี้เองไม่นับว่าซ้ำ)
  async searchNewVehicles(raw: string, excludeSwapId?: string, vehicleClass: PlateSwapVehicleClass = 'CAR'): Promise<PlateSwapVehicleHit[]> {
    this.assertClassScope(vehicleClass);
    const chassis = raw.trim();
    if (!chassis) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถัง' });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, chassis: { contains: chassis, mode: 'insensitive' }, ...vehicleTypeWhere(vehicleClass) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: { ...newVehicleSelect, ...linkStatusSelect(excludeSwapId?.trim() || undefined) },
    });
    return vehicles.map((v) => ({ ...toNewVehicle(v), linkBlockedReason: plateSwapLinkBlockReason(v) }));
  }

  // ล็อกแถวรถใหม่ (FOR UPDATE) แล้วตรวจกฎผูกใน transaction เดียวกับการบันทึก - กันสองคำขอผูกรถคันเดียวกันพร้อมกัน
  // และกันยื่นเอกสารที่ล็อกแถวรถเดียวกันแทรกกลาง (DocumentSubmissionService.submit ล็อกแถว Vehicle เหมือนกัน)
  private async lockNewVehicle(
    tx: Tx,
    vehicleId: string,
    excludeSwapId: string | undefined,
    mode: 'link' | 'reopen',
    vehicleClass: PlateSwapVehicleClass = 'CAR',
  ) {
    await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${vehicleId} FOR UPDATE`;
    const vehicle = await tx.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null, ...vehicleTypeWhere(vehicleClass) },
      select: { id: true, chassis: true, ...linkStatusSelect(excludeSwapId) },
    });
    if (!vehicle) {
      throw new BadRequestException({
        error:
          mode === 'link'
            ? `ไม่พบรถใหม่ที่ลิงก์ในฐานข้อมูลรถจดใหม่ (${CLASS_LABEL[vehicleClass]})`
            : 'ไม่พบรถใหม่ที่ผูกไว้ในฐานข้อมูลรถจดใหม่',
      });
    }
    const reason = plateSwapLinkBlockReason(vehicle, mode);
    if (reason) throw new BadRequestException({ error: reason });
    return vehicle;
  }

  // เจ้าของงานเลือกจาก dropdown ลูกค้าในฐานข้อมูล (ผู้ใช้ 2026-09-28) - บังคับกรอกสำหรับงานที่บันทึกใหม่
  // คอลัมน์เป็น NULL ได้เฉพาะงานเก่าที่บันทึกไว้ก่อนวันนั้น (ห้ามเดาย้อนหลังจาก oldOwnerName ซึ่งเป็นเจ้าของรถตามทะเบียน)
  private async resolveCustomerId(raw: unknown): Promise<string> {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) throw new BadRequestException({ error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' });
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) throw new BadRequestException({ error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' });
    return customer.id;
  }

  // ยี่ห้อรถเก่าเลือกจาก dropdown ยี่ห้อในฐานข้อมูล (ผู้ใช้ 2026-09-22) - เก็บเป็นชื่อตามที่อยู่ในตาราง Brand
  private async resolveBrandName(raw: unknown): Promise<string> {
    const name = requiredText(raw, 'ยี่ห้อ', 100);
    const brand = await this.prisma.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { name: true } });
    if (!brand) throw new BadRequestException({ error: 'กรุณาเลือกยี่ห้อจากรายการ' });
    return brand.name;
  }

  async create(dto: CreatePlateSwapDto): Promise<{ swap: PlateSwapRow }> {
    const vehicleClass = parseVehicleClass(dto?.vehicleClass);
    this.assertClassScope(vehicleClass);
    const customerId = await this.resolveCustomerId(dto?.customerId);
    const oldOwnerName = requiredText(dto?.oldOwnerName, 'ชื่อเจ้าของรถ');
    const oldEngine = requiredText(dto?.oldEngine, 'เลขเครื่อง', 100);
    const oldChassis = requiredText(dto?.oldChassis, 'เลขตัวถัง', 100);
    const oldBrand = await this.resolveBrandName(dto?.oldBrand);
    const oldPlateCategory = requiredText(dto?.oldPlateCategory, 'หมวดทะเบียนเก่า', 10);
    const oldPlateNumber = requiredText(dto?.oldPlateNumber, 'เลขทะเบียนเก่า', 10);
    // ทะเบียนใหม่ยังไม่รู้ตอนยื่นได้ - ต้องมาทั้งคู่หรือไม่มีเลย
    const { category: newPlateCategory, number: newPlateNumber } = newPlateParts(dto?.newPlateCategory, dto?.newPlateNumber);
    const submitDate = parseIsoDate(dto?.submitDate);
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (!isNumberSource(dto?.numberSource)) throw new BadRequestException({ error: NUMBER_SOURCE_ERROR });
    const numberSource = dto.numberSource;
    const buyNormalPlate = dto.buyNormalPlate === true;
    const buyAuctionPlate = dto.buyAuctionPlate === true;
    if (buyAuctionPlate && numberSource !== PlateSwapNumberSource.AUCTION_RESERVED) {
      throw new BadRequestException({ error: AUCTION_PLATE_ERROR });
    }
    const vehicleId = requireVehicleId(dto.newVehicleId);
    const urgent = dto.urgent === true;
    const fees = feesFor(vehicleClass, { numberSource, buyNormalPlate, buyAuctionPlate, urgent });

    const swap = await this.prisma.$transaction(async (tx) => {
      const vehicle = await this.lockNewVehicle(tx, vehicleId, undefined, 'link', vehicleClass);
      return tx.plateSwap.create({
        data: {
          kind: PlateSwapKind.OLD_NEW,
          vehicleClass,
          customerId,
          oldOwnerName,
          oldEngine,
          oldChassis,
          oldBrand,
          oldPlateCategory,
          oldPlateNumber,
          newPlateCategory,
          newPlateNumber,
          newVehicleId: vehicle.id,
          submitDate,
          numberSource,
          buyNormalPlate,
          buyAuctionPlate,
          urgent,
          billItems: JSON.parse(JSON.stringify(fees.billItems)),
          noBillItems: JSON.parse(JSON.stringify(fees.noBillItems)),
          billTotal: fees.billTotal,
          noBillTotal: fees.noBillTotal,
        },
        include: swapInclude,
      });
    });
    return { swap: serializePlateSwap(swap) };
  }

  // ยื่นงาน "รถเก่า กับ รถเก่า" (ผู้ใช้ 2026-09-28): กรอก 2 คันในหน้าเดียว แต่เก็บ "แยกเป็น 2 งานในระบบ" คันละแถว
  // ผูกกันด้วย pairId เดียวกัน - ทะเบียนไขว้กันตั้งแต่ตอนยื่น (A ได้ทะเบียนของ B, B ได้ทะเบียนของ A) ต่างจากเคส
  // รถเก่า-รถใหม่ ที่ยังไม่รู้เลขใหม่ตอนยื่น และไม่มีการลิงก์ฐานข้อมูลรถจดใหม่เพราะทั้งคู่เป็นรถเก่า
  // ค่าใช้จ่ายคิดคันละชุดด้วยสูตรเดียวกับเคสเดิม (ผู้ใช้: "ราคาเท่ากันให้อิงตามยอดรถเก่าเลย")
  async createPair(dto: CreatePlateSwapPairDto): Promise<{ swaps: PlateSwapRow[] }> {
    const vehicleClass = parseVehicleClass(dto?.vehicleClass);
    this.assertClassScope(vehicleClass);
    const customerId = await this.resolveCustomerId(dto?.customerId);
    const submitDate = parseIsoDate(dto?.submitDate);
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (!isNumberSource(dto?.numberSource)) throw new BadRequestException({ error: NUMBER_SOURCE_ERROR });
    const numberSource = dto.numberSource;
    const buyNormalPlate = dto.buyNormalPlate === true;
    const buyAuctionPlate = dto.buyAuctionPlate === true;
    if (buyAuctionPlate && numberSource !== PlateSwapNumberSource.AUCTION_RESERVED) {
      throw new BadRequestException({ error: AUCTION_PLATE_ERROR });
    }
    const carA = await this.readPairCar(dto?.carA, 'คันที่ 1');
    const carB = await this.readPairCar(dto?.carB, 'คันที่ 2');
    // สลับเลขกับตัวเองไม่ได้ และทะเบียนซ้ำกันแปลว่ากรอกผิด (ไม่มีอะไรให้สลับ)
    if (carA.oldChassis.toUpperCase() === carB.oldChassis.toUpperCase()) {
      throw new BadRequestException({ error: 'เลขตัวถังของรถทั้งสองคันซ้ำกัน - กรุณาตรวจสอบ' });
    }
    if (plateKey(carA) === plateKey(carB)) {
      throw new BadRequestException({ error: 'ทะเบียนของรถทั้งสองคันซ้ำกัน - กรุณาตรวจสอบ' });
    }

    const urgent = dto.urgent === true;
    const fees = feesFor(vehicleClass, { numberSource, buyNormalPlate, buyAuctionPlate, urgent });
    const pairId = randomUUID();
    const shared = {
      kind: PlateSwapKind.OLD_OLD,
      vehicleClass,
      pairId,
      customerId,
      submitDate,
      numberSource,
      buyNormalPlate,
      buyAuctionPlate,
      urgent,
      billItems: JSON.parse(JSON.stringify(fees.billItems)) as Prisma.InputJsonValue,
      noBillItems: JSON.parse(JSON.stringify(fees.noBillItems)) as Prisma.InputJsonValue,
      billTotal: fees.billTotal,
      noBillTotal: fees.noBillTotal,
    };

    const swaps = await this.prisma.$transaction(async (tx) => [
      await tx.plateSwap.create({
        data: { ...shared, ...carA, newPlateCategory: carB.oldPlateCategory, newPlateNumber: carB.oldPlateNumber },
        include: swapInclude,
      }),
      await tx.plateSwap.create({
        data: { ...shared, ...carB, newPlateCategory: carA.oldPlateCategory, newPlateNumber: carA.oldPlateNumber },
        include: swapInclude,
      }),
    ]);
    return { swaps: swaps.map(serializePlateSwap) };
  }

  // อ่าน/ตรวจข้อมูลรถเก่า 1 คันของเคสคู่ - label บอกว่าคันไหนผิด เพราะฟอร์มเดียวมี 2 คัน
  private async readPairCar(raw: PlateSwapPairCarDto | undefined, label: string) {
    return {
      oldOwnerName: requiredText(raw?.oldOwnerName, `ชื่อเจ้าของรถ (${label})`),
      oldEngine: requiredText(raw?.oldEngine, `เลขเครื่อง (${label})`, 100),
      oldChassis: requiredText(raw?.oldChassis, `เลขตัวถัง (${label})`, 100),
      oldBrand: await this.resolveBrandName(raw?.oldBrand),
      oldPlateCategory: requiredText(raw?.oldPlateCategory, `หมวดทะเบียน (${label})`, 10),
      oldPlateNumber: requiredText(raw?.oldPlateNumber, `เลขทะเบียน (${label})`, 10),
    };
  }

  // status: pending = ยังไม่รับเอกสารกลับ | returned = รับกลับแล้ว | all - month (YYYY-MM) กรองตามวันที่ยื่น
  // งานที่ยกเลิกแล้วไม่แสดง (ผู้ใช้ 2026-09-27)
  async list(statusParam = 'all', monthParam?: string, kindParam?: unknown, classParam?: unknown): Promise<{ swaps: PlateSwapRow[] }> {
    const kind = parseKind(kindParam);
    const vehicleClass = parseVehicleClass(classParam);
    this.assertClassReadable(vehicleClass);
    if (!['pending', 'returned', 'all'].includes(statusParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ status ต้องเป็น pending, returned หรือ all' });
    }
    let submitDate: { gte: Date; lt: Date } | undefined;
    if (monthParam) {
      if (!isValidMonthParam(monthParam)) throw new BadRequestException({ error: 'พารามิเตอร์ month ต้องเป็น ค.ศ. YYYY-MM ที่ถูกต้อง' });
      const start = toUtcDate(`${monthParam}-01`);
      submitDate = { gte: start, lt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
    }
    const rows = await this.prisma.plateSwap.findMany({
      where: {
        kind,
        vehicleClass,
        cancelledAt: null,
        ...(statusParam === 'pending' ? { returnedDate: null } : statusParam === 'returned' ? { returnedDate: { not: null } } : {}),
        ...(submitDate ? { submitDate } : {}),
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: swapInclude,
    });
    return { swaps: rows.map(serializePlateSwap) };
  }

  // งานที่จะแก้ - ยกเลิกแล้วแก้ต่อไม่ได้ (409 ให้หน้าเว็บโหลดใหม่)
  private async findOrThrow(id: string): Promise<SwapRecord> {
    const swap = await this.prisma.plateSwap.findUnique({ where: { id }, include: swapInclude });
    if (!swap) throw new NotFoundException({ error: 'ไม่พบงานสลับเลข' });
    // เช็คสิทธิ์ตามประเภทรถของงานนั้นจริงๆ (อ่านแถวก่อน) - STAFF_MOTO แก้ได้เฉพาะงานมอเตอร์ไซค์ และกลับกัน
    this.assertClassScope(parseVehicleClass(swap.vehicleClass));
    if (swap.cancelledAt) throw new ConflictException({ error: 'งานสลับเลขนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return swap;
  }

  // ล็อกแถวงาน (FOR UPDATE) แล้วอ่านสถานะล่าสุดใน transaction เดียวกับการเขียน (พบ 2026-09-27: เดิมตรวจสถานะรับกลับ/จำนวนรูป
  // นอก transaction - รับกลับพร้อมกับลบรูปสุดท้าย หรือลบสองรูปพร้อมกัน ทำให้งานที่รับกลับแล้วเหลือ 0 รูป และแนบรูปเข้างานที่เพิ่ง
  // รับกลับได้โดยไม่มีเหตุผล) - สถานะรับกลับไม่ตรงกับตอนตรวจ (มีคนรับกลับ/ยกเลิกรับกลับ/ยกเลิกงานไปก่อน) = 409 ให้โหลดใหม่
  // 'skip' = งานนั้นไม่เกี่ยวกับใบเสร็จ (แนบรูปป้าย/เล่ม) - ตั้งแต่แยกรับเอกสารกลับเป็น 3 ขั้น (ผู้ใช้ 2026-09-28)
  // รับใบเสร็จกับรับป้าย/รับเล่มเป็นคนละงานกัน ทำพร้อมกันได้ ไม่ต้องเด้ง 409 ให้โหลดใหม่
  private async lockSwap(tx: Tx, id: string, expectedReturnedDate: Date | null | 'skip') {
    await tx.$queryRaw`SELECT "id" FROM "PlateSwap" WHERE "id" = ${id} FOR UPDATE`;
    const live = await tx.plateSwap.findFirst({
      where: { id, cancelledAt: null },
      select: { returnedDate: true, newPlateCategory: true, newPlateNumber: true, _count: { select: { receipts: true } } },
    });
    if (!live) throw new ConflictException({ error: STALE_ERROR });
    if (expectedReturnedDate !== 'skip' && !sameTime(live.returnedDate, expectedReturnedDate)) throw new ConflictException({ error: STALE_ERROR });
    return live;
  }

  private async reload(id: string): Promise<{ swap: PlateSwapRow }> {
    const swap = await this.prisma.plateSwap.findUniqueOrThrow({ where: { id }, include: swapInclude });
    return { swap: serializePlateSwap(swap) };
  }

  // เปลี่ยนรถใหม่ที่ลิงก์ (ยกเลิกลิงก์ไม่ได้) - ต้องผ่านกฎผูกรถ (F51) ทุกครั้ง
  // งานที่รับเอกสารกลับแล้ว = แก้ข้อมูลงานที่ปิดแล้ว ต้องมีเหตุผลและบันทึกประวัติ (ผู้ใช้ 2026-09-27)
  async linkNewVehicle(id: string, newVehicleIdRaw: unknown, remarkRaw?: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const vehicleId = requireVehicleId(newVehicleIdRaw);
    const currentId = existing.newVehicleId ?? existing.newVehicle?.id ?? null;
    if (vehicleId === currentId) return this.reload(id);
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - เปลี่ยนรถใหม่ต้องระบุเหตุผล') : null;

    await this.prisma.$transaction(async (tx) => {
      const vehicle = await this.lockNewVehicle(tx, vehicleId, id, 'link', parseVehicleClass(existing.vehicleClass));
      await tx.plateSwap
        .update({ where: { id, cancelledAt: null, returnedDate: existing.returnedDate }, data: { newVehicleId: vehicle.id } })
        .catch(staleIfMissing);
      if (remark) {
        await writeAudit(tx, {
          entity: 'PlateSwap',
          entityId: id,
          action: 'relink',
          remark,
          changes: { newVehicle: { from: existing.newVehicle?.chassis ?? currentId, to: vehicle.chassis } },
        });
      }
    });
    return this.reload(id);
  }

  // กรอก/แก้เลขทะเบียนใหม่ทีหลัง (ผู้ใช้ 2026-09-23: ตอนยื่นบางทียังไม่รู้เลข ได้มาตอนงานเรียบร้อย)
  // ก่อนรับกลับแก้ได้เลย - หลังรับกลับต้องมีเลขเสมอ และการแก้ต้องมีเหตุผล + ประวัติ (ผู้ใช้ 2026-09-27)
  async setNewPlate(id: string, categoryRaw: unknown, numberRaw: unknown, remarkRaw?: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const { category: newPlateCategory, number: newPlateNumber } = newPlateParts(categoryRaw, numberRaw);
    if (!newPlateNumber && existing.returnedDate) {
      throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว ต้องมีทะเบียนใหม่' });
    }
    const data = { newPlateCategory, newPlateNumber };
    // เงื่อนไข returnedDate เท่ากับตอนตรวจ: มีคนยืนยันรับกลับแทรกกลาง -> 409 ไม่ให้แก้/ล้างเลขของงานที่รับกลับแล้วโดยไม่มีเหตุผล
    // (พบ 2026-09-27) - ทางที่รับกลับแล้วก็กันยกเลิกรับกลับ/แก้วันที่รับกลับแทรกกลางด้วย
    const where = { id, cancelledAt: null, returnedDate: existing.returnedDate };
    if (!existing.returnedDate) {
      await this.prisma.plateSwap.update({ where, data }).catch(staleIfMissing);
      return this.reload(id);
    }
    const changes = diffChanges(existing, data);
    if (Object.keys(changes).length === 0) return this.reload(id);
    const remark = requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - แก้ทะเบียนใหม่ต้องระบุเหตุผล');
    await this.prisma.$transaction(async (tx) => {
      await tx.plateSwap.update({ where, data }).catch(staleIfMissing);
      await writeAudit(tx, { entity: 'PlateSwap', entityId: id, action: 'update', remark, changes });
    });
    return this.reload(id);
  }

  // รับเอกสารกลับ - ต้องมีรูปใบเสร็จแนบอย่างน้อย 1 รูป และรู้เลขทะเบียนใหม่แล้ว (ส่งมาพร้อมกันได้)
  // วันที่รับกลับอยู่ระหว่างวันที่ยื่นถึงวันนี้ (เวลาไทย) - พิมพ์ปีผิดเป็นอนาคตไม่ได้ (พบ 2026-09-27)
  async markReturned(id: string, returnedDateRaw: unknown, newPlateCategoryRaw?: unknown, newPlateNumberRaw?: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const returnedDate = parseIsoDate(returnedDateRaw);
    if (!returnedDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับเอกสารกลับให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว' });
    this.assertReturnedDateInRange(returnedDate, existing.submitDate);
    if (existing.receipts.length === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
    const parts = newPlateParts(newPlateCategoryRaw, newPlateNumberRaw);
    await this.prisma.$transaction(async (tx) => {
      // นับรูปและอ่านทะเบียนใหม่หลังล็อกแถว - ลบรูปสุดท้าย/แก้เลขที่บันทึกแทรกกลางต้องไม่หลุดเข้ามา (พบ 2026-09-27)
      const live = await this.lockSwap(tx, id, null);
      if (live._count.receipts === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
      const newPlateCategory = parts.category ?? live.newPlateCategory;
      const newPlateNumber = parts.number ?? live.newPlateNumber;
      if (!newPlateCategory || !newPlateNumber) {
        throw new BadRequestException({ error: 'กรุณากรอกทะเบียนใหม่ที่ได้รับ (หมวดทะเบียนและเลขทะเบียน) ก่อนยืนยันรับเอกสารกลับ' });
      }
      await tx.plateSwap
        .update({ where: { id, cancelledAt: null, returnedDate: null }, data: { returnedDate, newPlateCategory, newPlateNumber } })
        .catch(staleIfMissing);
    });
    return this.reload(id);
  }

  private assertReturnedDateInRange(returnedDate: Date, submitDate: Date) {
    assertDateInRange('วันที่รับเอกสารกลับ', returnedDate, submitDate);
  }

  // แก้ข้อมูลงาน (F34 ผู้ใช้ 2026-09-27): ข้อมูลรถเก่า วันที่ยื่น ที่มาของเลข/ป้าย (คิดค่าใช้จ่ายใหม่) และวันที่รับกลับ
  // ได้ทั้งก่อนและหลังรับเอกสารกลับ ต้องมีเหตุผลเสมอ บันทึกเฉพาะช่องที่เปลี่ยนลง AuditLog
  // ค่าใช้จ่ายคิดใหม่เฉพาะเมื่อเปลี่ยนตัวเลือกค่าใช้จ่าย - แก้ชื่อผิดอย่างเดียวไม่ทำให้ snapshot เดิมเปลี่ยนตามอัตราใหม่
  async update(id: string, dto: UpdatePlateSwapDto): Promise<{ swap: PlateSwapRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้งานสลับเลข');
    const expectedUpdatedAt = parseExpectedUpdatedAt(dto.expectedUpdatedAt);
    const existing = await this.findOrThrow(id);
    // ฟอร์มส่งข้อมูลรถเก่าทุกช่องจากตอนเปิด - เปิดค้างไว้ขณะที่อีกคนแก้/รับกลับไปก่อน = 409 ไม่เอาค่าเก่าไปทับ (พบ 2026-09-27:
    // เดิมเทียบกับ updatedAt ที่อ่านในคำขอนี้เอง จึงกันได้แค่ช่วงไม่กี่มิลลิวินาที)
    if (expectedUpdatedAt && !sameTime(expectedUpdatedAt, existing.updatedAt)) throw new ConflictException({ error: STALE_ERROR });
    const has = (key: keyof UpdatePlateSwapDto) => dto[key] !== undefined;

    const submitDate = has('submitDate') ? parseIsoDate(dto.submitDate) : existing.submitDate;
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (has('numberSource') && !isNumberSource(dto.numberSource)) throw new BadRequestException({ error: NUMBER_SOURCE_ERROR });
    const numberSource = has('numberSource') ? (dto.numberSource as PlateSwapNumberSource) : existing.numberSource;
    const buyNormalPlate = has('buyNormalPlate') ? dto.buyNormalPlate === true : existing.buyNormalPlate;
    const buyAuctionPlate = has('buyAuctionPlate') ? dto.buyAuctionPlate === true : existing.buyAuctionPlate;
    const vehicleClass = parseVehicleClass(existing.vehicleClass);
    // งานเก่าที่บันทึกก่อนมีคอลัมน์นี้อ่านได้เป็น undefined - นับเป็นไม่ด่วน
    const urgent = has('urgent') ? dto.urgent === true : (existing.urgent ?? false);
    if (buyAuctionPlate && numberSource !== PlateSwapNumberSource.AUCTION_RESERVED) {
      throw new BadRequestException({ error: AUCTION_PLATE_ERROR });
    }

    let returnedDate = existing.returnedDate;
    if (has('returnedDate')) {
      if (!existing.returnedDate) {
        throw new BadRequestException({ error: 'งานนี้ยังไม่รับเอกสารกลับ - ใช้ปุ่มยืนยันรับกลับในหน้ารับเอกสารกลับ' });
      }
      returnedDate = parseIsoDate(dto.returnedDate);
      if (!returnedDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับเอกสารกลับให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    }
    // ตรวจช่วงวันที่เฉพาะเมื่อแก้วันที่ - แก้ชื่อผิดอย่างเดียวไม่โดนขวางเพราะวันที่รับกลับเดิม (ก่อนมีกฎ "ไม่เกินวันนี้")
    const returnedChanged = returnedDate?.getTime() !== existing.returnedDate?.getTime();
    if (returnedDate && returnedChanged) this.assertReturnedDateInRange(returnedDate, submitDate);
    else if (returnedDate && returnedDate < submitDate) {
      throw new BadRequestException({ error: 'วันที่ยื่นต้องไม่หลังวันที่รับเอกสารกลับ' });
    }

    const next = {
      // เจ้าของงาน (ผู้ใช้ 2026-09-28) - ไม่ส่งมา = ไม่แก้ (งานเก่าที่ยังไม่มีเจ้าของงานคงค่า null ไว้เหมือนเดิม)
      // ส่งมาแล้วต้องเป็นลูกค้าที่มีอยู่จริง จึงล้างกลับเป็นว่างไม่ได้ - ตั้งเจ้าของงานให้งานเก่าย้อนหลังใช้ทางนี้ได้
      customerId: has('customerId') ? await this.resolveCustomerId(dto.customerId) : (existing.customerId ?? null),
      oldOwnerName: has('oldOwnerName') ? requiredText(dto.oldOwnerName, 'ชื่อเจ้าของรถ') : existing.oldOwnerName,
      oldEngine: has('oldEngine') ? requiredText(dto.oldEngine, 'เลขเครื่อง', 100) : existing.oldEngine,
      oldChassis: has('oldChassis') ? requiredText(dto.oldChassis, 'เลขตัวถัง', 100) : existing.oldChassis,
      oldBrand: has('oldBrand') ? await this.resolveBrandName(dto.oldBrand) : existing.oldBrand,
      oldPlateCategory: has('oldPlateCategory') ? requiredText(dto.oldPlateCategory, 'หมวดทะเบียนเก่า', 10) : existing.oldPlateCategory,
      oldPlateNumber: has('oldPlateNumber') ? requiredText(dto.oldPlateNumber, 'เลขทะเบียนเก่า', 10) : existing.oldPlateNumber,
      submitDate,
      numberSource,
      buyNormalPlate,
      buyAuctionPlate,
      returnedDate,
      // งานเก่าที่บันทึกก่อนมีคอลัมน์นี้อ่านได้เป็น undefined - ใส่ลง next เฉพาะตอนค่าเปลี่ยนจริง
      // ไม่งั้น diffChanges เห็น undefined -> false เป็น "การเปลี่ยนแปลง" ทำให้แก้ชื่อเฉยๆ ก็คิดค่าใช้จ่ายใหม่
      ...(urgent === (existing.urgent ?? false) ? {} : { urgent }),
    };
    const feesChanged =
      numberSource !== existing.numberSource ||
      buyNormalPlate !== existing.buyNormalPlate ||
      buyAuctionPlate !== existing.buyAuctionPlate ||
      urgent !== (existing.urgent ?? false);
    const fees = feesChanged ? feesFor(vehicleClass, { numberSource, buyNormalPlate, buyAuctionPlate, urgent }) : null;
    const feeData = fees
      ? {
          billItems: JSON.parse(JSON.stringify(fees.billItems)) as Prisma.InputJsonValue,
          noBillItems: JSON.parse(JSON.stringify(fees.noBillItems)) as Prisma.InputJsonValue,
          billTotal: fees.billTotal,
          noBillTotal: fees.noBillTotal,
        }
      : {};

    const changes: AuditChanges = {
      ...diffChanges(existing, next),
      ...(fees ? diffChanges(existing, { billTotal: fees.billTotal, noBillTotal: fees.noBillTotal }) : {}),
    };
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });

    // เคสรถเก่า-รถเก่า: ทะเบียนใหม่ของคู่คือทะเบียนเก่าของงานนี้ แก้ข้างนี้แล้วอีกข้างต้องตามไปด้วย
    // ไม่งั้นคู่ที่เก็บไว้จะขัดกันเอง (ผู้ใช้ 2026-09-28)
    const plateChanged =
      next.oldPlateCategory !== existing.oldPlateCategory || next.oldPlateNumber !== existing.oldPlateNumber;
    const partner = plateChanged ? await this.findPartner(existing) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.plateSwap
        .update({
          // เงื่อนไข updatedAt ที่ฟอร์มโหลดมา: อีกคนแก้/รับกลับไปก่อน (รวมช่วงระหว่างอ่านกับเขียนในคำขอนี้) -> 409 ไม่ทับของเขา
          where: { id, cancelledAt: null, updatedAt: expectedUpdatedAt ?? existing.updatedAt },
          data: { ...next, ...feeData },
        })
        .catch(staleIfMissing);
      if (partner) {
        await tx.plateSwap.update({
          where: { id: partner.id, cancelledAt: null },
          data: { newPlateCategory: next.oldPlateCategory, newPlateNumber: next.oldPlateNumber },
        });
        await writeAudit(tx, {
          entity: 'PlateSwap',
          entityId: partner.id,
          action: 'update',
          remark,
          changes: {
            newPlate: {
              from: `${existing.oldPlateCategory} ${existing.oldPlateNumber}`,
              to: `${next.oldPlateCategory} ${next.oldPlateNumber}`,
            },
            followedPair: id, // ตามการแก้ทะเบียนเก่าของงานคู่ ไม่ได้แก้เดี่ยวๆ
          },
        });
      }
      await writeAudit(tx, { entity: 'PlateSwap', entityId: id, action: 'update', remark, changes });
    });
    return this.reload(id);
  }

  // ยกเลิกการรับเอกสารกลับที่กดผิด (F34 ผู้ใช้ 2026-09-27) - งานกลับไปรอรับเอกสาร รถใหม่ถูกล็อกการยื่นอีกครั้ง
  // ต้องผ่านกฎเดียวกับการผูก: รถใหม่ที่ยื่นเอกสารไปแล้ว หรือผูกกับงานอื่นที่ยังเปิดอยู่ ยกเลิกรับกลับไม่ได้
  async undoReturn(id: string, remarkRaw: unknown): Promise<{ swap: PlateSwapRow }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกรับเอกสารกลับ');
    const existing = await this.findOrThrow(id);
    if (!existing.returnedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่รับเอกสารกลับ' });
    const vehicleId = existing.newVehicleId ?? existing.newVehicle?.id ?? null;

    await this.prisma.$transaction(async (tx) => {
      if (vehicleId) await this.lockNewVehicle(tx, vehicleId, id, 'reopen', parseVehicleClass(existing.vehicleClass));
      await tx.plateSwap
        .update({ where: { id, cancelledAt: null, returnedDate: existing.returnedDate }, data: { returnedDate: null } })
        .catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'PlateSwap',
        entityId: id,
        action: 'undo-return',
        remark,
        changes: { returnedDate: { from: existing.returnedDate, to: null } },
      });
    });
    return this.reload(id);
  }

  // ยกเลิกงาน (แทนการลบเดิม - ผู้ใช้ 2026-09-27 ห้ามลบแถว) ได้ทุกสถานะ ต้องมีเหตุผล เก็บ snapshot ลง AuditLog
  // รูปใบเสร็จของงานยังอยู่ แต่ล้าง contentHash ให้แนบรูปเดิมกับงานที่คีย์ใหม่ได้ (เหมือนตอนลบงานแล้วรูปถูกลบตาม)
  async cancel(id: string, remarkRaw: unknown): Promise<{ id: string; cancelledIds: string[] }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกงานสลับเลข');
    const existing = await this.findOrThrow(id);
    // เคสรถเก่า-รถเก่าเป็นการยื่นครั้งเดียวที่แยกเก็บเป็น 2 งาน - ยกเลิกคันเดียวจะเหลืออีกคันที่สลับกับงานที่ไม่มีแล้ว
    // จึงยกเลิกทั้งคู่พร้อมกันด้วยเหตุผลเดียว (ผู้ใช้ 2026-09-28)
    const partner = await this.findPartner(existing);
    const cancelledIds = [id, ...(partner ? [partner.id] : [])];
    await this.prisma.$transaction(async (tx) => {
      for (const target of cancelledIds) {
        await tx.plateSwap
          .update({
            where: { id: target, cancelledAt: null },
            data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null },
          })
          .catch(staleIfMissing);
        await tx.receiptImage.updateMany({ where: { plateSwapId: target }, data: { contentHash: null } });
      }
      if (partner) {
        await writeAudit(tx, {
          entity: 'PlateSwap',
          entityId: partner.id,
          action: 'cancel',
          remark,
          changes: {
            oldOwnerName: partner.oldOwnerName,
            oldChassis: partner.oldChassis,
            oldPlate: `${partner.oldPlateCategory} ${partner.oldPlateNumber}`,
            cancelledWithPair: id, // ยกเลิกตามคู่ ไม่ได้ถูกยกเลิกเดี่ยวๆ
          },
        });
      }
      await writeAudit(tx, {
        entity: 'PlateSwap',
        entityId: id,
        action: 'cancel',
        remark,
        changes: {
          ...(partner ? { cancelledWithPair: partner.id } : {}),
          customer: existing.customer ? (existing.customer.company ?? existing.customer.name) : null, // เจ้าของงาน (ผู้ใช้ 2026-09-28)
          oldOwnerName: existing.oldOwnerName,
          oldChassis: existing.oldChassis,
          oldPlate: `${existing.oldPlateCategory} ${existing.oldPlateNumber}`,
          newPlate: existing.newPlateCategory && existing.newPlateNumber ? `${existing.newPlateCategory} ${existing.newPlateNumber}` : null,
          newVehicle: existing.newVehicle?.chassis ?? null,
          submitDate: existing.submitDate,
          returnedDate: existing.returnedDate,
          billTotal: existing.billTotal,
          noBillTotal: existing.noBillTotal,
          receiptIds: existing.receipts.map((r) => r.id),
        },
      });
    });
    return { id, cancelledIds };
  }

  // งานคู่ของเคสรถเก่า-รถเก่า (null = งาน OLD_NEW หรือคู่ถูกยกเลิกไปแล้ว)
  private async findPartner(swap: { id: string; pairId?: string | null }) {
    if (!swap.pairId) return null;
    return this.prisma.plateSwap.findFirst({
      where: { pairId: swap.pairId, id: { not: swap.id }, cancelledAt: null },
      select: { id: true, oldOwnerName: true, oldChassis: true, oldPlateCategory: true, oldPlateNumber: true },
    });
  }

  // แนบรูปใบเสร็จ - อ่าน OCR จริงเหมือน Step 5 (ผู้ใช้ 2026-09-28) เก็บผลลง ReceiptImage.extraction/extractionSource
  // เก็บใน ReceiptImage เดิม ผ่าน plateSwapId - ตัวรูปโหลดผ่าน GET /api/receipts/:id/image เหมือนใบเสร็จอื่น
  // หลังรับเอกสารกลับแนบเพิ่มได้ (ผู้ใช้ 2026-09-27) แต่ต้องมีเหตุผลและบันทึกประวัติ
  async addReceipt(id: string, file: UploadedReceiptFile | undefined, remarkRaw?: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - แนบรูปเพิ่มต้องระบุเหตุผล') : null;
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปใบเสร็จ' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    // ตาราง ReceiptImage เดียวกับใบเสร็จ Step 5 - รูปที่ใช้เป็นใบเสร็จที่ไหนแล้วก็ใช้ซ้ำไม่ได้
    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.receiptImage.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    // อ่านก่อนเก็บไฟล์/บันทึกแถว (เหมือน receipts.service.ts) - ไม่มี ANTHROPIC_API_KEY = extraction เป็น null เสมอ
    const extraction = await this.extractor.extract(file.buffer, type.mimeType);

    const now = new Date();
    const storageKey = `receipts/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        // งานถูกยกเลิก หรือถูกยืนยันรับกลับ/ยกเลิกรับกลับระหว่างอัปโหลด -> 409 (งานที่เพิ่งรับกลับต้องแนบพร้อมเหตุผล - พบ 2026-09-27)
        await this.lockSwap(tx, id, existing.returnedDate);
        const created = await tx.receiptImage.create({
          data: {
            plateSwapId: existing.id,
            storageKey,
            contentHash,
            mimeType: type.mimeType,
            sizeBytes: file.size,
            originalName: file.originalname ? file.originalname.slice(0, 200) : null,
            extractionSource: this.extractor.source,
            ...(extraction ? { extraction: extraction as object } : {}),
          },
          select: { id: true },
        });
        // เติมเลขที่ใบเสร็จ/วันที่/ยอดเงินจาก OCR ครั้งแรกที่อ่านสำเร็จ - เฉพาะตอนช่องยังว่างทั้ง 3 ช่อง (กันทับของที่พนักงานแก้ไปแล้ว)
        if (extraction && 'reading' in extraction) {
          const { receiptNo, date, total } = extraction.reading;
          // AI อ่านปีผิดได้ (ใบเสร็จเป็น พ.ศ.) - วันที่นอกช่วงวันที่ยื่นถึงวันนี้ไม่เติมให้ ปล่อยว่างให้พนักงานกรอกเอง
          // ดีกว่าเก็บวันที่ผิดไว้เงียบๆ และใช้กฎเดียวกับตอนพนักงานแก้เอง (assertDateInRange)
          const readDate = date && dateInRange(toUtcDate(date), existing.submitDate) ? toUtcDate(date) : undefined;
          if (receiptNo || readDate || total !== null) {
            await tx.plateSwap.updateMany({
              where: { id, receiptNo: null, receiptDate: null, receiptAmount: null },
              data: {
                receiptNo: receiptNo || undefined,
                receiptDate: readDate,
                receiptAmount: total !== null ? total : undefined,
              },
            });
          }
        }
        if (remark) {
          await writeAudit(tx, { entity: 'PlateSwap', entityId: id, action: 'add-receipt', remark, changes: { receipt: { from: null, to: created.id } } });
        }
      });
    } catch (err) {
      // บันทึกลงฐานข้อมูลไม่สำเร็จ - ลบไฟล์ทิ้งไม่ให้ค้างโดยไม่มีแถวอ้างถึง
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return this.reload(id);
  }

  // แก้/กรอกเองเลขที่ใบเสร็จ/วันที่/ยอดเงิน (รูปแบบเดียวกับ setNewPlate) - ต้องมีเหตุผลเมื่องานรับเอกสารกลับแล้ว
  async updateReceiptFields(
    id: string,
    dto: { receiptNo?: unknown; receiptDate?: unknown; receiptAmount?: unknown; remark?: unknown },
  ): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const receiptNo = optionalText(dto?.receiptNo, 'เลขที่ใบเสร็จ', 100);
    const receiptDate = optionalIsoDateField(dto?.receiptDate, 'วันที่ใบเสร็จ');
    // ใบเสร็จออกตอนยื่น จึงอยู่ระหว่างวันที่ยื่นถึงวันนี้ เหมือนวันที่รับป้าย/รับเล่ม (พบ 2026-09-28: เดิมไม่ตรวจเลย
    // พิมพ์ปีผิดเป็น 2000 ก็บันทึกผ่าน ทั้งที่ทุกช่องวันที่อื่นของระบบตรวจช่วงหมด)
    if (receiptDate) assertDateInRange('วันที่ใบเสร็จ', receiptDate, existing.submitDate);
    const receiptAmount = optionalAmount(dto?.receiptAmount, 'ยอดเงินตามใบเสร็จ');
    const next = { receiptNo, receiptDate, receiptAmount };
    const changes = diffChanges(existing, next);
    if (Object.keys(changes).length === 0) return this.reload(id);
    // เงื่อนไข returnedDate เท่ากับตอนตรวจ เหมือน setNewPlate - มีคนยืนยัน/ยกเลิกรับกลับแทรกกลาง -> 409
    const where = { id, cancelledAt: null, returnedDate: existing.returnedDate };
    if (!existing.returnedDate) {
      await this.prisma.plateSwap.update({ where, data: next }).catch(staleIfMissing);
      return this.reload(id);
    }
    const remark = requireRemark(dto?.remark, 'งานนี้รับเอกสารกลับแล้ว - แก้ข้อมูลใบเสร็จต้องระบุเหตุผล');
    await this.prisma.$transaction(async (tx) => {
      await tx.plateSwap.update({ where, data: next }).catch(staleIfMissing);
      await writeAudit(tx, { entity: 'PlateSwap', entityId: id, action: 'update-receipt-fields', remark, changes });
    });
    return this.reload(id);
  }

  // --- รับป้าย/รับเล่ม (ไม่ใช้ AI เหมือน Step 6/7 ปัจจุบัน - ผู้ใช้ 2026-09-28) --------------------------------------
  // เฉพาะฝั่งรถเก่าของงานนี้เอง ไม่ผูกกับ gating ใดๆ (ไม่ต้องรอ returnedDate) และไม่แตะรถใหม่ที่ลิงก์ไว้

  // multipart: file + date (YYYY-MM-DD, ไม่ก่อนวันที่ยื่น ไม่เกินวันนี้) -> เก็บรูปแล้วตั้ง plateReceivedDate + platePhotoId
  async attachPlatePhoto(id: string, file: UploadedReceiptFile | undefined, dateRaw: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const date = requiredIsoDateField(dateRaw, 'วันที่รับป้าย');
    assertDateInRange('วันที่รับป้าย', date, existing.submitDate);
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.platePhoto.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    const now = new Date();
    const storageKey = `plates/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockSwap(tx, id, 'skip');
        const photo = await tx.platePhoto.create({
          data: {
            storageKey,
            contentHash,
            kind: 'car',
            mimeType: type.mimeType,
            sizeBytes: file.size,
            originalName: file.originalname ? file.originalname.slice(0, 200) : null,
            closedAt: now,
          },
          select: { id: true },
        });
        // updateMany + platePhotoId: null กันแนบพร้อมกันสองเครื่องแล้วทับรูปกัน
        const { count } = await tx.plateSwap.updateMany({ where: { id, platePhotoId: null }, data: { plateReceivedDate: date, platePhotoId: photo.id } });
        if (count === 0) throw new BadRequestException({ error: 'งานนี้รับป้ายไปแล้ว' });
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return this.reload(id);
  }

  // multipart: file + date (YYYY-MM-DD, ไม่ก่อนวันที่ยื่น ไม่เกินวันนี้) -> เก็บรูปแล้วตั้ง bookReceivedDate + bookPhotoId
  async attachBookPhoto(id: string, file: UploadedReceiptFile | undefined, dateRaw: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const date = requiredIsoDateField(dateRaw, 'วันที่รับเล่ม');
    assertDateInRange('วันที่รับเล่ม', date, existing.submitDate);
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.bookPhoto.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    const now = new Date();
    const storageKey = `books/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockSwap(tx, id, 'skip');
        const photo = await tx.bookPhoto.create({
          data: {
            storageKey,
            contentHash,
            mimeType: type.mimeType,
            sizeBytes: file.size,
            originalName: file.originalname ? file.originalname.slice(0, 200) : null,
            closedAt: now,
          },
          select: { id: true },
        });
        // updateMany + bookPhotoId: null กันแนบพร้อมกันสองเครื่องแล้วทับรูปกัน
        const { count } = await tx.plateSwap.updateMany({ where: { id, bookPhotoId: null }, data: { bookReceivedDate: date, bookPhotoId: photo.id } });
        if (count === 0) throw new BadRequestException({ error: 'งานนี้รับเล่มไปแล้ว' });
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return this.reload(id);
  }

  // งานที่รับป้าย/รับเล่มแล้ว - ใช้ก่อนแก้วันที่รับ/ถอดรูป
  private async findReceivedForPlate(id: string) {
    const existing = await this.findOrThrow(id);
    if (!existing.plateReceivedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่ได้รับป้าย' });
    return existing;
  }

  private async findReceivedForBook(id: string) {
    const existing = await this.findOrThrow(id);
    if (!existing.bookReceivedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่ได้รับเล่ม' });
    return existing;
  }

  // แก้วันที่รับป้ายที่พิมพ์ผิด - ต้องมีเหตุผล ช่วงวันที่เดียวกับตอนแนบ
  async updatePlateReceivedDate(id: string, dto: { date?: unknown; remark?: unknown }): Promise<{ swap: PlateSwapRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้วันที่รับป้าย');
    const existing = await this.findReceivedForPlate(id);
    const date = requiredIsoDateField(dto?.date, 'วันที่รับป้าย');
    assertDateInRange('วันที่รับป้าย', date, existing.submitDate);
    const before = existing.plateReceivedDate;
    if (isoDate(before) === isoDate(date)) throw new BadRequestException({ error: 'วันที่ไม่ได้เปลี่ยน' });
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.plateSwap.updateMany({
        where: { id, cancelledAt: null, plateReceivedDate: before, platePhotoId: existing.platePhotoId },
        data: { plateReceivedDate: date },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, {
        entity: 'PlateSwap',
        entityId: id,
        action: 'update-plate-date',
        remark,
        changes: { plateReceivedDate: { from: before, to: date } },
      });
    });
    return this.reload(id);
  }

  // แก้วันที่รับเล่มที่พิมพ์ผิด - ต้องมีเหตุผล ช่วงวันที่เดียวกับตอนแนบ
  async updateBookReceivedDate(id: string, dto: { date?: unknown; remark?: unknown }): Promise<{ swap: PlateSwapRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้วันที่รับเล่ม');
    const existing = await this.findReceivedForBook(id);
    const date = requiredIsoDateField(dto?.date, 'วันที่รับเล่ม');
    assertDateInRange('วันที่รับเล่ม', date, existing.submitDate);
    const before = existing.bookReceivedDate;
    if (isoDate(before) === isoDate(date)) throw new BadRequestException({ error: 'วันที่ไม่ได้เปลี่ยน' });
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.plateSwap.updateMany({
        where: { id, cancelledAt: null, bookReceivedDate: before, bookPhotoId: existing.bookPhotoId },
        data: { bookReceivedDate: date },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, {
        entity: 'PlateSwap',
        entityId: id,
        action: 'update-book-date',
        remark,
        changes: { bookReceivedDate: { from: before, to: date } },
      });
    });
    return this.reload(id);
  }

  // ถอดรูปป้ายที่แนบผิด - ต้องมีเหตุผล ล้างวันที่รับป้าย + รูป งานกลับเข้าคิวรอรับป้าย
  // ลบแถวรูปเมื่อไม่มีใครอ้างอิงแล้ว (งานสลับเลขอื่น หรือ Vehicle ของรถจดใหม่) - ลบไฟล์หลัง transaction สำเร็จ
  async detachPlatePhoto(id: string, dto: { remark?: unknown }): Promise<{ swap: PlateSwapRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ถอดรูปป้าย');
    const existing = await this.findReceivedForPlate(id);
    const photoId = existing.platePhotoId;
    const before = existing.plateReceivedDate;
    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.plateSwap.updateMany({
        where: { id, cancelledAt: null, plateReceivedDate: before, platePhotoId: photoId },
        data: { plateReceivedDate: null, platePhotoId: null },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, {
        entity: 'PlateSwap',
        entityId: id,
        action: 'detach-plate-photo',
        remark,
        changes: { plateReceivedDate: { from: before, to: null }, platePhotoId: { from: photoId, to: null } },
      });
      if (!photoId) return null;
      const stillUsed = (await tx.plateSwap.count({ where: { platePhotoId: photoId } })) + (await tx.vehicle.count({ where: { platePhotoId: photoId } }));
      if (stillUsed > 0) return null;
      return tx.platePhoto.delete({ where: { id: photoId }, select: { storageKey: true } });
    });
    if (removed) await this.storage.delete(removed.storageKey).catch(() => undefined);
    return this.reload(id);
  }

  // ถอดรูปเล่มที่แนบผิด - ต้องมีเหตุผล ล้างวันที่รับเล่ม + รูป งานกลับเข้าคิวรอรับเล่ม
  async detachBookPhoto(id: string, dto: { remark?: unknown }): Promise<{ swap: PlateSwapRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ถอดรูปเล่ม');
    const existing = await this.findReceivedForBook(id);
    const photoId = existing.bookPhotoId;
    const before = existing.bookReceivedDate;
    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.plateSwap.updateMany({
        where: { id, cancelledAt: null, bookReceivedDate: before, bookPhotoId: photoId },
        data: { bookReceivedDate: null, bookPhotoId: null },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, {
        entity: 'PlateSwap',
        entityId: id,
        action: 'detach-book-photo',
        remark,
        changes: { bookReceivedDate: { from: before, to: null }, bookPhotoId: { from: photoId, to: null } },
      });
      if (!photoId) return null;
      const stillUsed = (await tx.plateSwap.count({ where: { bookPhotoId: photoId } })) + (await tx.vehicle.count({ where: { bookPhotoId: photoId } }));
      if (stillUsed > 0) return null;
      return tx.bookPhoto.delete({ where: { id: photoId }, select: { storageKey: true } });
    });
    if (removed) await this.storage.delete(removed.storageKey).catch(() => undefined);
    return this.reload(id);
  }

  // ดูรูปป้าย/เล่มของงานสลับเลข - เช็คสิทธิ์ผ่านแถว PlateSwap เอง (ไม่เรียก PlatePhotosService/BookPhotosService
  // เพราะ scope check ของสองตัวนั้นผูกกับ Vehicle)
  async getPlatePhotoImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const swap = await this.prisma.plateSwap.findFirst({
      where: { id, platePhotoId: { not: null } },
      select: { vehicleClass: true, platePhoto: { select: { storageKey: true, mimeType: true } } },
    });
    if (!swap?.platePhoto) throw new NotFoundException({ error: 'ไม่พบรูปป้ายทะเบียน' });
    // เช็คสิทธิ์ตามประเภทรถของงานนั้น (พบ 2026-09-28: ถ้าเช็คแบบรถยนต์อย่างเดียว STAFF_MOTO จะเปิดรูปงานตัวเองไม่ได้)
    this.assertClassReadable(parseVehicleClass(swap.vehicleClass));
    try {
      return { data: await this.storage.get(swap.platePhoto.storageKey), mimeType: swap.platePhoto.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียนในที่เก็บ' });
    }
  }

  async getBookPhotoImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const swap = await this.prisma.plateSwap.findFirst({
      where: { id, bookPhotoId: { not: null } },
      select: { vehicleClass: true, bookPhoto: { select: { storageKey: true, mimeType: true } } },
    });
    if (!swap?.bookPhoto) throw new NotFoundException({ error: 'ไม่พบรูปเล่มทะเบียน' });
    this.assertClassReadable(parseVehicleClass(swap.vehicleClass));
    try {
      return { data: await this.storage.get(swap.bookPhoto.storageKey), mimeType: swap.bookPhoto.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียนในที่เก็บ' });
    }
  }

  // รายการสำหรับหน้ารับป้าย/รับเล่ม - โครงเดียวกับ list() แต่กรองด้วย plateReceivedDate/bookReceivedDate ไม่มี month
  // (เหมือนหน้ารับเอกสารกลับปัจจุบันที่โชว์ทุกเดือน)
  async listByPlateStatus(statusParam = 'all', kindParam?: unknown, classParam?: unknown): Promise<{ swaps: PlateSwapRow[] }> {
    const kind = parseKind(kindParam);
    const vehicleClass = parseVehicleClass(classParam);
    this.assertClassReadable(vehicleClass);
    if (!['pending', 'received', 'all'].includes(statusParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ status ต้องเป็น pending, received หรือ all' });
    }
    const rows = await this.prisma.plateSwap.findMany({
      where: {
        kind,
        vehicleClass,
        cancelledAt: null,
        ...(statusParam === 'pending' ? { plateReceivedDate: null } : statusParam === 'received' ? { plateReceivedDate: { not: null } } : {}),
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: swapInclude,
    });
    return { swaps: rows.map(serializePlateSwap) };
  }

  async listByBookStatus(statusParam = 'all', kindParam?: unknown, classParam?: unknown): Promise<{ swaps: PlateSwapRow[] }> {
    const kind = parseKind(kindParam);
    const vehicleClass = parseVehicleClass(classParam);
    this.assertClassReadable(vehicleClass);
    if (!['pending', 'received', 'all'].includes(statusParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ status ต้องเป็น pending, received หรือ all' });
    }
    const rows = await this.prisma.plateSwap.findMany({
      where: {
        kind,
        vehicleClass,
        cancelledAt: null,
        ...(statusParam === 'pending' ? { bookReceivedDate: null } : statusParam === 'received' ? { bookReceivedDate: { not: null } } : {}),
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: swapInclude,
    });
    return { swaps: rows.map(serializePlateSwap) };
  }

  // ลบรูปก่อนยืนยันรับกลับได้เลย - หลังรับกลับต้องมีเหตุผล (บันทึกประวัติ) และต้องเหลือรูปอย่างน้อย 1 รูปเสมอ
  // หลังรับกลับรูปเป็นหลักฐาน: ถอดแถวออก (รูปเดิมแนบใหม่ได้) แต่ไม่ลบไฟล์ใน storage - storageKey อยู่ในประวัติ
  async removeReceipt(id: string, receiptId: string, remarkRaw?: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - ลบรูปใบเสร็จต้องระบุเหตุผล') : null;
    const receipt = await this.prisma.receiptImage.findFirst({ where: { id: receiptId, plateSwapId: id }, select: { id: true, storageKey: true } });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (remark && existing.receipts.length <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
    await this.prisma.$transaction(async (tx) => {
      // นับรูปใหม่หลังล็อกแถวงาน - ลบสองรูปพร้อมกัน หรือรับกลับแทรกกลาง ต้องไม่ทำให้งานที่รับกลับแล้วเหลือ 0 รูป (พบ 2026-09-27)
      const live = await this.lockSwap(tx, id, existing.returnedDate);
      if (remark && live._count.receipts <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
      const { count } = await tx.receiptImage.deleteMany({ where: { id: receipt.id, plateSwapId: id } });
      if (count === 0) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' }); // อีกคนลบรูปนี้ไปก่อน
      if (remark) {
        await writeAudit(tx, {
          entity: 'PlateSwap',
          entityId: id,
          action: 'remove-receipt',
          remark,
          changes: { receipt: { from: receipt.id, to: null }, storageKey: receipt.storageKey },
        });
      }
    });
    if (!remark) await this.storage.delete(receipt.storageKey).catch(() => undefined);
    return this.reload(id);
  }
}
