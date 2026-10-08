import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { type AuditChanges, diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { assertKindInScope, currentVehicleScope } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import {
  assertDateInRange,
  dateInRange,
  isoDate,
  optionalAmount,
  optionalIsoDateField,
  optionalText,
  parseExpectedUpdatedAt,
  parseIsoDate,
  requiredText,
  sameTime,
  toUtcDate,
} from '../plate-swap/plate-swap.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtractor } from '../receipts/receipt-extractor.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { calculateTransferCarNoBill, calculateTransferMotoFees } from './vehicle-transfer-fee.js';

// งานโอน (งานหลัก, ผู้ใช้ 2026-10-02) - หน้าตา/ขั้นตอนเหมือนยกเลิกการใช้รถ กรอกข้อมูลรถเอง (ไม่ผูกตาราง Vehicle) รถยนต์ + มอเตอร์ไซค์รวมกัน
// 2 แบบ: OWNER = โอนตามผู้ถือกรรมสิทธิ์ (ไม่มีตรวจรถ) / INSPECTION = โอนตรวจรถ (ตรวจรถแยกจากคิวตรวจรถของรถจดใหม่)
// ขั้นตอน OWNER: ยื่น -> รับใบเสร็จกลับ | INSPECTION: ยื่น -> ส่งตรวจ -> ผลตรวจ (ผ่านเท่านั้น) -> รับใบเสร็จกลับ
// ทุกงานมีผู้โอน + ผู้รับโอน และ Bill / No Bill (ผู้ใช้ 2026-10-02): มอเตอร์ไซค์คิดตามอัตราใน vehicle-transfer-fee.ts (โอนปกติ/โอนขอใช้ + ด่วน + ค่าปรับ)
// รถยนต์: No Bill คิดเอง (ลงขัน 100 + ด่วน 100) ส่วน Bill ยังไม่มีอัตรา พนักงานกรอกเองตอนยื่น
// สิทธิ์: กลุ่มยื่นเอกสาร (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO) - ดู access-policy.ts
// แก้/ยกเลิกต้องระบุเหตุผลเสมอ บันทึกประวัติลง AuditLog ('VehicleTransfer') และยกเลิกแบบไม่ลบแถว (cancelledAt)

export type TransferType = 'OWNER' | 'INSPECTION';
export type TransferVehicleClass = 'CAR' | 'MOTO';
export type InspectionResult = 'PASS' | 'FAIL';

export interface TransferCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface VehicleTransferRow {
  id: string;
  transferType: TransferType;
  vehicleClass: TransferVehicleClass;
  customer: TransferCustomer | null;
  transferorName: string;
  transfereeName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  billTotal: string;
  noBillTotal: string; // ไม่รวมค่าอากร
  dutyAmount: string; // ค่าอากร - แยกต่างหาก ไม่รวมใน No Bill และไม่นับในยอดรวม
  useRequest: boolean; // โอนขอใช้ (มอเตอร์ไซค์)
  urgent: boolean; // งานด่วน
  fineAmount: string; // ค่าปรับ (อยู่ใน billTotal แล้ว)
  inspectionSentDate: string | null;
  inspectionResult: InspectionResult | null;
  inspectionResultDate: string | null;
  returnedDate: string | null; // YYYY-MM-DD
  // ส่งงานลูกค้า (ใบ DL จากหน้า Delivery ผู้ใช้ 2026-10-08) - ส่งแล้วจึงวางบิลได้
  deliveredDate: string | null;
  deliveryRecipient: string | null;
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD
  receiptAmount: string | null;
  createdAt: string;
  // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดฟอร์มอยู่ = 409
  updatedAt: string;
}

// Wire shape - ทุกช่องมาจาก JSON ที่ยังไม่ตรวจ จึงเป็น unknown ให้ service ตรวจเอง
export interface CreateVehicleTransferDto {
  transferType?: unknown; // OWNER | INSPECTION (บังคับ)
  vehicleClass?: unknown; // CAR | MOTO (บังคับ)
  customerId?: unknown; // เจ้าของงาน (บังคับ)
  transferorName?: unknown;
  transfereeName?: unknown;
  engine?: unknown;
  chassis?: unknown;
  brand?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  submitDate?: unknown;
  useRequest?: unknown; // โอนขอใช้ (มอเตอร์ไซค์ - ค่าเริ่มต้น false = โอนปกติ)
  urgent?: unknown; // งานด่วน (ทั้งสองประเภทรถ)
  fineAmount?: unknown; // ค่าปรับ (มอเตอร์ไซค์ - ว่าง = 0)
  billTotal?: unknown; // Bill - รถยนต์เท่านั้น (บังคับ) มอเตอร์ไซค์ backend คิดเอง / No Bill ทั้งสองประเภท backend คิดเอง ไม่รับยอดจากหน้าเว็บ
}

export interface UpdateVehicleTransferDto {
  vehicleClass?: unknown;
  customerId?: unknown;
  transferorName?: unknown;
  transfereeName?: unknown;
  engine?: unknown;
  chassis?: unknown;
  brand?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  submitDate?: unknown;
  useRequest?: unknown;
  urgent?: unknown;
  fineAmount?: unknown;
  billTotal?: unknown;
  noBillTotal?: unknown;
  returnedDate?: unknown; // เฉพาะงานที่รับกลับแล้ว
  remark?: unknown;
  expectedUpdatedAt?: unknown;
}

export const LIST_STATUSES = ['all', 'pending', 'returned', 'to-send', 'to-result', 'inspected'] as const;
type ListStatus = (typeof LIST_STATUSES)[number];

export function parseTransferType(value: unknown, required = true): TransferType | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException({ error: 'กรุณาเลือกแบบงานโอน (โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ)' });
    return undefined;
  }
  if (value === 'OWNER' || value === 'INSPECTION') return value;
  throw new BadRequestException({ error: 'transferType ต้องเป็น OWNER หรือ INSPECTION' });
}

export function parseTransferClass(value: unknown, required = true): TransferVehicleClass | undefined {
  if (value === undefined || value === null || value === '') {
    if (required) throw new BadRequestException({ error: 'กรุณาเลือกประเภทรถ (รถยนต์ / รถจักรยานยนต์)' });
    return undefined;
  }
  if (value === 'CAR' || value === 'MOTO') return value;
  throw new BadRequestException({ error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR หรือ MOTO' });
}

// Bill / No Bill ที่พนักงานกรอก - บังคับกรอก (0 ได้) ไม่ติดลบ ปัดทศนิยม 2 ตำแหน่ง
function requiredAmount(value: unknown, label: string): number {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    throw new BadRequestException({ error: `กรุณากรอก ${label}` });
  }
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) throw new BadRequestException({ error: `${label} ไม่ถูกต้อง` });
  return Math.round(num * 100) / 100;
}

// ติ๊ก (boolean) จาก JSON - ไม่ส่ง/ว่าง = false / ค่าอื่นที่ไม่ใช่ true/false = 400
function parseFlag(value: unknown, label: string): boolean {
  if (value === undefined || value === null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new BadRequestException({ error: `${label} ต้องเป็น true หรือ false` });
}

// ค่าปรับ - ว่าง = 0
function parseFine(value: unknown): number {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return 0;
  return requiredAmount(value, 'ค่าปรับ');
}

interface FeeSnapshot {
  billTotal: number;
  noBillTotal: number;
  dutyAmount: number;
  useRequest: boolean;
  urgent: boolean;
  fineAmount: number;
}

interface FeeInput {
  useRequest: boolean;
  urgent: boolean;
  fineAmount: number;
  billTotal?: unknown; // รถยนต์เท่านั้น
}

// ค่าใช้จ่ายที่จะเก็บเป็น snapshot - ไม่รับยอดจากหน้าเว็บสำหรับมอเตอร์ไซค์ (คิดจากอัตราของผู้ใช้เสมอ)
// รถยนต์: No Bill คิดเอง / Bill พนักงานกรอก / ขอใช้และค่าปรับยังไม่มีอัตราให้คิด จึงใช้ไม่ได้
const CAR_NO_RATE_ERROR = 'รถยนต์ยังไม่มีอัตราโอนขอใช้/ค่าปรับ - กรอก Bill เอง';

export function feeSnapshotFor(vehicleClass: TransferVehicleClass, input: FeeInput): FeeSnapshot {
  if (vehicleClass === 'MOTO') {
    const fees = calculateTransferMotoFees({ useRequest: input.useRequest, urgent: input.urgent, fine: input.fineAmount });
    return {
      billTotal: fees.billTotal,
      noBillTotal: fees.noBillTotal,
      dutyAmount: fees.dutyTotal,
      useRequest: input.useRequest,
      urgent: input.urgent,
      fineAmount: input.fineAmount,
    };
  }
  if (input.useRequest || input.fineAmount > 0) throw new BadRequestException({ error: CAR_NO_RATE_ERROR });
  return {
    billTotal: requiredAmount(input.billTotal, 'Bill'),
    noBillTotal: calculateTransferCarNoBill({ urgent: input.urgent }).noBillTotal,
    dutyAmount: 0,
    useRequest: false,
    urgent: input.urgent,
    fineAmount: 0,
  };
}

const isValidMonthParam = (value: string) => /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));

const customerSelect = { id: true, name: true, company: true } as const;

const transferInclude = {
  customer: { select: customerSelect },
  receipts: { orderBy: { createdAt: 'asc' as const }, select: { id: true, createdAt: true } },
} satisfies Prisma.VehicleTransferInclude;

interface TransferRecord {
  deliveredDate?: Date | null; // ส่งงานลูกค้าแล้ว (ใบ DL จากหน้า Delivery ผู้ใช้ 2026-10-08)
  deliveryRecipient?: string | null;
  id: string;
  transferType: string;
  vehicleClass: string;
  customerId?: string | null;
  customer?: TransferCustomer | null;
  transferorName: string;
  transfereeName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: Date;
  billTotal: Prisma.Decimal | number;
  noBillTotal: Prisma.Decimal | number;
  dutyAmount: Prisma.Decimal | number;
  useRequest: boolean;
  urgent: boolean;
  fineAmount: Prisma.Decimal | number;
  inspectionSentDate: Date | null;
  inspectionResult: string | null;
  inspectionResultDate: Date | null;
  returnedDate: Date | null;
  receiptNo: string | null;
  receiptDate: Date | null;
  receiptAmount: Prisma.Decimal | number | null;
  createdAt: Date;
  updatedAt: Date;
  receipts: { id: string; createdAt: Date }[];
}

export function serializeTransfer(row: TransferRecord): VehicleTransferRow {
  return {
    id: row.id,
    transferType: parseTransferType(row.transferType) as TransferType,
    vehicleClass: parseTransferClass(row.vehicleClass) as TransferVehicleClass,
    customer: row.customer ?? null,
    transferorName: row.transferorName,
    transfereeName: row.transfereeName,
    engine: row.engine,
    chassis: row.chassis,
    brand: row.brand,
    plateCategory: row.plateCategory,
    plateNumber: row.plateNumber,
    submitDate: row.submitDate.toISOString().slice(0, 10),
    billTotal: String(row.billTotal),
    noBillTotal: String(row.noBillTotal),
    dutyAmount: String(row.dutyAmount),
    useRequest: row.useRequest,
    urgent: row.urgent,
    fineAmount: String(row.fineAmount),
    inspectionSentDate: isoDate(row.inspectionSentDate),
    inspectionResult: row.inspectionResult === 'PASS' || row.inspectionResult === 'FAIL' ? row.inspectionResult : null,
    inspectionResultDate: isoDate(row.inspectionResultDate),
    returnedDate: isoDate(row.returnedDate),
    deliveredDate: isoDate(row.deliveredDate ?? null),
    deliveryRecipient: row.deliveryRecipient ?? null,
    receipts: row.receipts.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() })),
    receiptNo: row.receiptNo ?? null,
    receiptDate: isoDate(row.receiptDate ?? null),
    receiptAmount: row.receiptAmount === null || row.receiptAmount === undefined ? null : String(row.receiptAmount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// มีคนแก้/ยกเลิก/รับกลับงานนี้ไปก่อน (update แบบมีเงื่อนไขไม่เจอแถว = Prisma P2025) -> 409 ให้หน้าเว็บโหลดใหม่
const STALE_ERROR = 'งานโอนนี้ถูกแก้ ยกเลิก หรือเปลี่ยนสถานะไปก่อนแล้ว - โหลดรายการใหม่';
function staleIfMissing(err: unknown): never {
  if ((err as { code?: string } | null)?.code === 'P2025') throw new ConflictException({ error: STALE_ERROR });
  throw err;
}

const RECEIPT_REQUIRED_ERROR = 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ';
const LAST_RECEIPT_ERROR = 'งานที่รับเอกสารกลับแล้วต้องมีรูปใบเสร็จอย่างน้อย 1 รูป - แนบรูปที่ถูกต้องก่อนแล้วจึงลบรูปนี้';
const INSPECTION_NOT_PASSED_ERROR = 'งานโอนตรวจรถต้องตรวจรถผ่านก่อนจึงรับใบเสร็จได้';

type Tx = Prisma.TransactionClient;

@Injectable()
export class VehicleTransferService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // ขอบเขตการแก้ตามประเภทรถของงาน (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO) - เหมือนงานสลับเลข
  private assertClassScope(vehicleClass: TransferVehicleClass) {
    assertKindInScope(vehicleClass === 'MOTO' ? 'moto' : 'car');
  }

  // ดูรายการใช้ขอบเขตการอ่าน - ACCOUNTANT ที่ถือ STAFF_MOTO ด้วยยังอ่านงานรถยนต์ได้ (แก้ไม่ได้)
  private assertClassReadable(vehicleClass: TransferVehicleClass) {
    const scope = currentVehicleScope();
    if (scope === 'ALL' || scope === vehicleClass) return;
    this.assertClassScope(vehicleClass);
  }

  // เจ้าของงานเลือกจาก dropdown ลูกค้าในฐานข้อมูล - บังคับกรอก
  private async resolveCustomerId(raw: unknown): Promise<string> {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) throw new BadRequestException({ error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' });
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) throw new BadRequestException({ error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' });
    return customer.id;
  }

  // ยี่ห้อเลือกจาก dropdown ยี่ห้อในฐานข้อมูล - เก็บเป็นชื่อตามที่อยู่ในตาราง Brand
  private async resolveBrandName(raw: unknown): Promise<string> {
    const name = requiredText(raw, 'ยี่ห้อ', 100);
    const brand = await this.prisma.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { name: true } });
    if (!brand) throw new BadRequestException({ error: 'กรุณาเลือกยี่ห้อจากรายการ' });
    return brand.name;
  }

  async create(dto: CreateVehicleTransferDto): Promise<{ transfer: VehicleTransferRow }> {
    const transferType = parseTransferType(dto?.transferType) as TransferType;
    const vehicleClass = parseTransferClass(dto?.vehicleClass) as TransferVehicleClass;
    this.assertClassScope(vehicleClass);
    const customerId = await this.resolveCustomerId(dto?.customerId);
    const transferorName = requiredText(dto?.transferorName, 'ผู้โอน');
    const transfereeName = requiredText(dto?.transfereeName, 'ผู้รับโอน');
    const engine = requiredText(dto?.engine, 'เลขเครื่อง', 100);
    const chassis = requiredText(dto?.chassis, 'เลขตัวถัง', 100);
    const brand = await this.resolveBrandName(dto?.brand);
    const plateCategory = requiredText(dto?.plateCategory, 'หมวดทะเบียน', 10);
    const plateNumber = requiredText(dto?.plateNumber, 'เลขทะเบียน', 10);
    const submitDate = parseIsoDate(dto?.submitDate);
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    const fees = feeSnapshotFor(vehicleClass, {
      useRequest: parseFlag(dto?.useRequest, 'โอนขอใช้'),
      urgent: parseFlag(dto?.urgent, 'งานด่วน'),
      fineAmount: parseFine(dto?.fineAmount),
      billTotal: dto?.billTotal,
    });

    const row = await this.prisma.vehicleTransfer.create({
      data: { transferType, vehicleClass, customerId, transferorName, transfereeName, engine, chassis, brand, plateCategory, plateNumber, submitDate, ...fees },
      include: transferInclude,
    });
    return { transfer: serializeTransfer(row) };
  }

  // status: pending = ยังไม่รับเอกสารกลับ (งานโอนตรวจรถต้องตรวจผ่านแล้วถึงนับ) | returned = รับกลับแล้ว | all
  //   to-send = รอส่งตรวจ | to-result = ส่งตรวจแล้วรอผล | inspected = มีผลตรวจแล้วและยังไม่รับกลับ (ทั้งสามเฉพาะโอนตรวจรถ)
  // month (YYYY-MM) กรองตามวันที่ยื่น / งานที่ยกเลิกแล้วไม่แสดง / ไม่ระบุประเภทรถ = ทุกประเภทที่ผู้ใช้มีสิทธิ์อ่าน
  async list(
    statusParam = 'all',
    monthParam?: string,
    typeParam?: unknown,
    classParam?: unknown,
  ): Promise<{ transfers: VehicleTransferRow[] }> {
    if (!(LIST_STATUSES as readonly string[]).includes(statusParam)) {
      throw new BadRequestException({ error: `พารามิเตอร์ status ต้องเป็น ${LIST_STATUSES.join(', ')}` });
    }
    const status = statusParam as ListStatus;
    const transferType = parseTransferType(typeParam, false);
    const requestedClass = parseTransferClass(classParam, false);
    if (requestedClass) this.assertClassReadable(requestedClass);
    const scope = currentVehicleScope();
    const vehicleClass = requestedClass ?? (scope === 'CAR' || scope === 'MOTO' ? scope : undefined);
    if (scope === 'NONE') this.assertClassScope('CAR'); // ไม่มีสิทธิ์ทั้งสองประเภท = 403

    let submitDate: { gte: Date; lt: Date } | undefined;
    if (monthParam) {
      if (!isValidMonthParam(monthParam)) throw new BadRequestException({ error: 'พารามิเตอร์ month ต้องเป็น ค.ศ. YYYY-MM ที่ถูกต้อง' });
      const start = toUtcDate(`${monthParam}-01`);
      submitDate = { gte: start, lt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
    }

    const statusWhere: Prisma.VehicleTransferWhereInput =
      status === 'pending'
        ? { returnedDate: null, OR: [{ transferType: 'OWNER' }, { inspectionResult: 'PASS' }] }
        : status === 'returned'
          ? { returnedDate: { not: null } }
          : status === 'to-send'
            ? { transferType: 'INSPECTION', returnedDate: null, inspectionSentDate: null }
            : status === 'to-result'
              ? { transferType: 'INSPECTION', returnedDate: null, inspectionSentDate: { not: null }, inspectionResult: null }
              : status === 'inspected'
                ? { transferType: 'INSPECTION', returnedDate: null, inspectionResult: { not: null } }
                : {};

    const rows = await this.prisma.vehicleTransfer.findMany({
      where: {
        cancelledAt: null,
        ...(transferType ? { transferType } : {}),
        ...(vehicleClass ? { vehicleClass } : {}),
        ...(submitDate ? { submitDate } : {}),
        ...statusWhere,
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: transferInclude,
    });
    return { transfers: rows.map(serializeTransfer) };
  }

  // งานที่จะแก้ - ยกเลิกแล้วแก้ต่อไม่ได้ (409 ให้หน้าเว็บโหลดใหม่)
  private async findOrThrow(id: string): Promise<TransferRecord> {
    const row = await this.prisma.vehicleTransfer.findUnique({ where: { id }, include: transferInclude });
    if (!row) throw new NotFoundException({ error: 'ไม่พบงานโอน' });
    // เช็คสิทธิ์ตามประเภทรถของงานนั้นจริงๆ (อ่านแถวก่อน) - STAFF_MOTO แก้ได้เฉพาะงานมอเตอร์ไซค์ และกลับกัน
    this.assertClassScope(parseTransferClass(row.vehicleClass) as TransferVehicleClass);
    if (row.cancelledAt) throw new ConflictException({ error: 'งานโอนนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return row;
  }

  // ล็อกแถวงาน (FOR UPDATE) แล้วอ่านสถานะล่าสุดใน transaction เดียวกับการเขียน - กันรับกลับพร้อมกับลบรูปสุดท้าย
  // สถานะรับกลับไม่ตรงกับตอนตรวจ (มีคนรับกลับ/ยกเลิกรับกลับ/ยกเลิกงานไปก่อน) = 409 ให้โหลดใหม่
  private async lockRow(tx: Tx, id: string, expectedReturnedDate: Date | null) {
    await tx.$queryRaw`SELECT "id" FROM "VehicleTransfer" WHERE "id" = ${id} FOR UPDATE`;
    const live = await tx.vehicleTransfer.findFirst({
      where: { id, cancelledAt: null },
      select: { returnedDate: true, transferType: true, inspectionResult: true, _count: { select: { receipts: true } } },
    });
    if (!live) throw new ConflictException({ error: STALE_ERROR });
    if (!sameTime(live.returnedDate, expectedReturnedDate)) throw new ConflictException({ error: STALE_ERROR });
    return live;
  }

  private async reload(id: string): Promise<{ transfer: VehicleTransferRow }> {
    const row = await this.prisma.vehicleTransfer.findUniqueOrThrow({ where: { id }, include: transferInclude });
    return { transfer: serializeTransfer(row) };
  }

  // ---- ตรวจรถ (เฉพาะโอนตรวจรถ) -------------------------------------------------------------

  private assertInspectionJob(row: TransferRecord) {
    if (row.transferType !== 'INSPECTION') throw new BadRequestException({ error: 'งานโอนตามผู้ถือกรรมสิทธิ์ไม่มีขั้นตรวจรถ' });
    if (row.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว - ยกเลิกรับกลับก่อนจึงแก้ขั้นตรวจรถได้' });
  }

  // บันทึกวันที่ส่งตรวจ - ไม่ก่อนวันที่ยื่น ไม่เกินวันนี้ (เวลาไทย)
  async markInspectionSent(id: string, sentDateRaw: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const existing = await this.findOrThrow(id);
    this.assertInspectionJob(existing);
    if (existing.inspectionSentDate) throw new BadRequestException({ error: 'งานนี้ส่งตรวจแล้ว' });
    const sentDate = parseIsoDate(sentDateRaw);
    if (!sentDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ส่งตรวจให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    assertDateInRange('วันที่ส่งตรวจ', sentDate, existing.submitDate);
    await this.prisma.vehicleTransfer
      .update({ where: { id, cancelledAt: null, returnedDate: null, inspectionSentDate: null }, data: { inspectionSentDate: sentDate } })
      .catch(staleIfMissing);
    return this.reload(id);
  }

  // บันทึกผลตรวจ PASS | FAIL + วันที่ผลออก - ต้องส่งตรวจแล้ว วันที่ไม่ก่อนวันส่งตรวจและไม่เกินวันนี้
  async recordInspectionResult(id: string, resultRaw: unknown, resultDateRaw: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const existing = await this.findOrThrow(id);
    this.assertInspectionJob(existing);
    if (!existing.inspectionSentDate) throw new BadRequestException({ error: 'ยังไม่ได้บันทึกวันที่ส่งตรวจ' });
    if (existing.inspectionResult) throw new BadRequestException({ error: 'งานนี้บันทึกผลตรวจแล้ว' });
    if (resultRaw !== 'PASS' && resultRaw !== 'FAIL') throw new BadRequestException({ error: 'ผลตรวจต้องเป็น ผ่าน หรือ ไม่ผ่าน' });
    const resultDate = parseIsoDate(resultDateRaw);
    if (!resultDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ผลตรวจให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    assertDateInRange('วันที่ผลตรวจ', resultDate, existing.inspectionSentDate);
    await this.prisma.vehicleTransfer
      .update({
        where: { id, cancelledAt: null, returnedDate: null, inspectionSentDate: existing.inspectionSentDate, inspectionResult: null },
        data: { inspectionResult: resultRaw, inspectionResultDate: resultDate },
      })
      .catch(staleIfMissing);
    return this.reload(id);
  }

  // ถอยหนึ่งขั้นของขั้นตรวจรถ (บันทึกผิด / ตรวจใหม่หลังไม่ผ่าน): มีผลตรวจ = ล้างผล, ไม่มีผลแต่ส่งตรวจแล้ว = ล้างวันที่ส่งตรวจ - ต้องมีเหตุผล
  async undoInspection(id: string, remarkRaw: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกขั้นตรวจรถ');
    const existing = await this.findOrThrow(id);
    this.assertInspectionJob(existing);
    if (existing.inspectionResult) {
      await this.prisma.$transaction(async (tx) => {
        await tx.vehicleTransfer
          .update({
            where: { id, cancelledAt: null, returnedDate: null, inspectionResult: existing.inspectionResult },
            data: { inspectionResult: null, inspectionResultDate: null },
          })
          .catch(staleIfMissing);
        await writeAudit(tx, {
          entity: 'VehicleTransfer',
          entityId: id,
          action: 'undo-inspection-result',
          remark,
          changes: { inspectionResult: { from: existing.inspectionResult, to: null }, inspectionResultDate: { from: existing.inspectionResultDate, to: null } },
        });
      });
    } else if (existing.inspectionSentDate) {
      await this.prisma.$transaction(async (tx) => {
        await tx.vehicleTransfer
          .update({
            where: { id, cancelledAt: null, returnedDate: null, inspectionSentDate: existing.inspectionSentDate, inspectionResult: null },
            data: { inspectionSentDate: null },
          })
          .catch(staleIfMissing);
        await writeAudit(tx, {
          entity: 'VehicleTransfer',
          entityId: id,
          action: 'undo-inspection-sent',
          remark,
          changes: { inspectionSentDate: { from: existing.inspectionSentDate, to: null } },
        });
      });
    } else {
      throw new BadRequestException({ error: 'งานนี้ยังไม่ได้ส่งตรวจ' });
    }
    return this.reload(id);
  }

  // ---- รับใบเสร็จกลับ --------------------------------------------------------------------

  // รับเอกสารกลับ - ต้องมีรูปใบเสร็จแนบอย่างน้อย 1 รูป / วันที่อยู่ระหว่างวันที่ยื่นถึงวันนี้ (เวลาไทย) / โอนตรวจรถต้องตรวจผ่านแล้ว
  async markReturned(id: string, returnedDateRaw: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const existing = await this.findOrThrow(id);
    const returnedDate = parseIsoDate(returnedDateRaw);
    if (!returnedDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับเอกสารกลับให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว' });
    if (existing.transferType === 'INSPECTION' && existing.inspectionResult !== 'PASS') {
      throw new BadRequestException({ error: INSPECTION_NOT_PASSED_ERROR });
    }
    // วันที่รับกลับต้องไม่ก่อนวันที่ผลตรวจออก (งานโอนตรวจรถ) ไม่งั้นก่อนวันที่ยื่น
    assertDateInRange('วันที่รับเอกสารกลับ', returnedDate, existing.inspectionResultDate ?? existing.submitDate);
    if (existing.receipts.length === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
    await this.prisma.$transaction(async (tx) => {
      // นับรูปหลังล็อกแถว - ลบรูปสุดท้ายที่บันทึกแทรกกลางต้องไม่หลุดเข้ามา
      const live = await this.lockRow(tx, id, null);
      if (live._count.receipts === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
      if (live.transferType === 'INSPECTION' && live.inspectionResult !== 'PASS') throw new ConflictException({ error: STALE_ERROR });
      await tx.vehicleTransfer.update({ where: { id, cancelledAt: null, returnedDate: null }, data: { returnedDate } }).catch(staleIfMissing);
    });
    return this.reload(id);
  }

  // แก้ข้อมูลงาน: เจ้าของงาน ข้อมูลรถ ผู้โอน/ผู้รับโอน วันที่ยื่น และวันที่รับกลับ (งานที่รับกลับแล้ว) ต้องมีเหตุผลเสมอ
  // บันทึกเฉพาะช่องที่เปลี่ยนลง AuditLog / แบบงานโอนเปลี่ยนไม่ได้ (ยกเลิกแล้วคีย์ใหม่)
  async update(id: string, dto: UpdateVehicleTransferDto): Promise<{ transfer: VehicleTransferRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้งานโอน');
    const expectedUpdatedAt = parseExpectedUpdatedAt(dto.expectedUpdatedAt);
    const existing = await this.findOrThrow(id);
    // ฟอร์มส่งข้อมูลทุกช่องจากตอนเปิด - เปิดค้างไว้ขณะที่อีกคนแก้/รับกลับไปก่อน = 409 ไม่เอาค่าเก่าไปทับ
    if (expectedUpdatedAt && !sameTime(expectedUpdatedAt, existing.updatedAt)) throw new ConflictException({ error: STALE_ERROR });
    const has = (key: keyof UpdateVehicleTransferDto) => dto[key] !== undefined;

    const vehicleClass = has('vehicleClass') ? (parseTransferClass(dto.vehicleClass) as TransferVehicleClass) : (existing.vehicleClass as TransferVehicleClass);
    if (vehicleClass !== existing.vehicleClass) this.assertClassScope(vehicleClass); // ย้ายไปอีกประเภทรถต้องมีสิทธิ์ทั้งสองฝั่ง

    const submitDate = has('submitDate') ? parseIsoDate(dto.submitDate) : existing.submitDate;
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (existing.inspectionSentDate && submitDate > existing.inspectionSentDate) {
      throw new BadRequestException({ error: 'วันที่ยื่นต้องไม่หลังวันที่ส่งตรวจ' });
    }

    let returnedDate = existing.returnedDate;
    if (has('returnedDate')) {
      if (!existing.returnedDate) {
        throw new BadRequestException({ error: 'งานนี้ยังไม่รับเอกสารกลับ - ใช้ปุ่มยืนยันรับกลับในหน้ารับใบเสร็จ' });
      }
      returnedDate = parseIsoDate(dto.returnedDate);
      if (!returnedDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับเอกสารกลับให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    }
    // ตรวจช่วงวันที่เฉพาะเมื่อแก้วันที่ - แก้ชื่อผิดอย่างเดียวไม่โดนขวางเพราะวันที่รับกลับเดิม
    const returnedChanged = returnedDate?.getTime() !== existing.returnedDate?.getTime();
    const returnedFloor = existing.inspectionResultDate ?? submitDate;
    if (returnedDate && returnedChanged) assertDateInRange('วันที่รับเอกสารกลับ', returnedDate, returnedFloor);
    else if (returnedDate && returnedDate < returnedFloor) {
      throw new BadRequestException({ error: 'วันที่ยื่นต้องไม่หลังวันที่รับเอกสารกลับ' });
    }

    const next = {
      vehicleClass,
      customerId: has('customerId') ? await this.resolveCustomerId(dto.customerId) : (existing.customerId ?? null),
      transferorName: has('transferorName') ? requiredText(dto.transferorName, 'ผู้โอน') : existing.transferorName,
      transfereeName: has('transfereeName') ? requiredText(dto.transfereeName, 'ผู้รับโอน') : existing.transfereeName,
      engine: has('engine') ? requiredText(dto.engine, 'เลขเครื่อง', 100) : existing.engine,
      chassis: has('chassis') ? requiredText(dto.chassis, 'เลขตัวถัง', 100) : existing.chassis,
      brand: has('brand') ? await this.resolveBrandName(dto.brand) : existing.brand,
      plateCategory: has('plateCategory') ? requiredText(dto.plateCategory, 'หมวดทะเบียน', 10) : existing.plateCategory,
      plateNumber: has('plateNumber') ? requiredText(dto.plateNumber, 'เลขทะเบียน', 10) : existing.plateNumber,
      submitDate,
      ...this.updatedFees(existing, vehicleClass, dto, has),
      returnedDate,
    };
    const changes: AuditChanges = diffChanges(existing, next);
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleTransfer
        .update({
          // เงื่อนไข updatedAt ที่ฟอร์มโหลดมา: อีกคนแก้/รับกลับไปก่อน -> 409 ไม่ทับของเขา
          where: { id, cancelledAt: null, updatedAt: expectedUpdatedAt ?? existing.updatedAt },
          data: next,
        })
        .catch(staleIfMissing);
      await writeAudit(tx, { entity: 'VehicleTransfer', entityId: id, action: 'update', remark, changes });
    });
    return this.reload(id);
  }

  // ค่าใช้จ่ายหลังแก้: ไม่ได้แตะประเภทรถ/ขอใช้/ด่วน/ค่าปรับ/ยอดที่กรอก = เก็บ snapshot เดิม (แก้ชื่อผิดต้องไม่ทำให้ยอดเก่าเปลี่ยนตามอัตราใหม่)
  private updatedFees(
    existing: TransferRecord,
    vehicleClass: TransferVehicleClass,
    dto: UpdateVehicleTransferDto,
    has: (key: keyof UpdateVehicleTransferDto) => boolean,
  ): FeeSnapshot {
    const snapshot: FeeSnapshot = {
      billTotal: Number(existing.billTotal),
      noBillTotal: Number(existing.noBillTotal),
      dutyAmount: Number(existing.dutyAmount),
      useRequest: existing.useRequest,
      urgent: existing.urgent,
      fineAmount: Number(existing.fineAmount),
    };
    const classChanged = vehicleClass !== existing.vehicleClass;
    const useRequest = has('useRequest') ? parseFlag(dto.useRequest, 'โอนขอใช้') : snapshot.useRequest;
    const urgent = has('urgent') ? parseFlag(dto.urgent, 'งานด่วน') : snapshot.urgent;
    const fineAmount = has('fineAmount') ? parseFine(dto.fineAmount) : snapshot.fineAmount;
    if (vehicleClass === 'MOTO') {
      const same = useRequest === snapshot.useRequest && urgent === snapshot.urgent && fineAmount === snapshot.fineAmount;
      return !classChanged && same ? snapshot : feeSnapshotFor('MOTO', { useRequest, urgent, fineAmount });
    }
    // รถยนต์: ขอใช้/ค่าปรับยังไม่มีอัตรา / No Bill (ลงขัน 100 + ด่วน 100) คิดใหม่เมื่อย้ายมาจากมอเตอร์ไซค์หรือเปลี่ยนติ๊กด่วนเท่านั้น
    // ย้ายมาจากมอเตอร์ไซค์ต้องกรอก Bill ใหม่เอง / แก้เฉพาะ Bill ที่กรอก No Bill เดิมคงไว้
    if ((has('useRequest') && useRequest) || (has('fineAmount') && fineAmount > 0)) throw new BadRequestException({ error: CAR_NO_RATE_ERROR });
    if (!classChanged && urgent === snapshot.urgent) {
      return has('billTotal') ? { ...snapshot, billTotal: requiredAmount(dto.billTotal, 'Bill') } : snapshot;
    }
    return feeSnapshotFor('CAR', {
      useRequest: false,
      urgent,
      fineAmount: 0,
      billTotal: has('billTotal') ? dto.billTotal : classChanged ? undefined : snapshot.billTotal,
    });
  }

  // ยกเลิกการรับเอกสารกลับที่กดผิด - งานกลับไปรอรับเอกสาร
  async undoReturn(id: string, remarkRaw: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกรับเอกสารกลับ');
    const existing = await this.findOrThrow(id);
    if (!existing.returnedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่รับเอกสารกลับ' });
    // ส่งงานลูกค้าแล้ว (ใบ DL) - ต้องยกเลิกใบส่งงานก่อน ไม่งั้นใบ DL ค้างชี้งานที่ย้อนสถานะ/ยกเลิกไปแล้ว (ผู้ใช้ 2026-10-08)
    if (existing.deliveredDate) throw new BadRequestException({ error: 'งานนี้ส่งงานลูกค้าแล้ว - ยกเลิกใบส่งงาน (DL) ที่หน้ารายงานส่งงานก่อน' });
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleTransfer
        .update({ where: { id, cancelledAt: null, returnedDate: existing.returnedDate }, data: { returnedDate: null } })
        .catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'VehicleTransfer',
        entityId: id,
        action: 'undo-return',
        remark,
        changes: { returnedDate: { from: existing.returnedDate, to: null } },
      });
    });
    return this.reload(id);
  }

  // ยกเลิกงาน (ไม่ลบแถว) ได้ทุกสถานะ ต้องมีเหตุผล เก็บ snapshot ลง AuditLog
  // รูปใบเสร็จของงานยังอยู่ แต่ล้าง contentHash ให้แนบรูปเดิมกับงานที่คีย์ใหม่ได้
  async cancel(id: string, remarkRaw: unknown): Promise<{ id: string }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกงานโอน');
    const existing = await this.findOrThrow(id);
    // ส่งงานลูกค้าแล้ว (ใบ DL) - ต้องยกเลิกใบส่งงานก่อน ไม่งั้นใบ DL ค้างชี้งานที่ย้อนสถานะ/ยกเลิกไปแล้ว (ผู้ใช้ 2026-10-08)
    if (existing.deliveredDate) throw new BadRequestException({ error: 'งานนี้ส่งงานลูกค้าแล้ว - ยกเลิกใบส่งงาน (DL) ที่หน้ารายงานส่งงานก่อน' });
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleTransfer
        .update({ where: { id, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null } })
        .catch(staleIfMissing);
      await tx.receiptImage.updateMany({ where: { vehicleTransferId: id }, data: { contentHash: null } });
      await writeAudit(tx, {
        entity: 'VehicleTransfer',
        entityId: id,
        action: 'cancel',
        remark,
        changes: {
          transferType: existing.transferType,
          customer: existing.customer ? (existing.customer.company ?? existing.customer.name) : null,
          transferorName: existing.transferorName,
          transfereeName: existing.transfereeName,
          chassis: existing.chassis,
          plate: `${existing.plateCategory} ${existing.plateNumber}`,
          submitDate: existing.submitDate,
          billTotal: existing.billTotal,
          noBillTotal: existing.noBillTotal,
          dutyAmount: existing.dutyAmount,
          useRequest: existing.useRequest,
          urgent: existing.urgent,
          fineAmount: existing.fineAmount,
          inspectionSentDate: existing.inspectionSentDate,
          inspectionResult: existing.inspectionResult,
          inspectionResultDate: existing.inspectionResultDate,
          returnedDate: existing.returnedDate,
          receiptIds: existing.receipts.map((r) => r.id),
        },
      });
    });
    return { id };
  }

  // แนบรูปใบเสร็จ - อ่าน OCR เหมือนใบเสร็จงานสลับเลข เก็บผลลง ReceiptImage.extraction/extractionSource
  // หลังรับเอกสารกลับแนบเพิ่มได้ แต่ต้องมีเหตุผลและบันทึกประวัติ / โอนตรวจรถแนบได้เมื่อตรวจผ่านแล้วเท่านั้น
  async addReceipt(id: string, file: UploadedReceiptFile | undefined, remarkRaw?: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const existing = await this.findOrThrow(id);
    if (existing.transferType === 'INSPECTION' && existing.inspectionResult !== 'PASS') {
      throw new BadRequestException({ error: INSPECTION_NOT_PASSED_ERROR });
    }
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - แนบรูปเพิ่มต้องระบุเหตุผล') : null;
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปใบเสร็จ' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    // ตาราง ReceiptImage เดียวกับใบเสร็จอื่น - รูปที่ใช้เป็นใบเสร็จที่ไหนแล้วก็ใช้ซ้ำไม่ได้
    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.receiptImage.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    // อ่านก่อนเก็บไฟล์/บันทึกแถว - ไม่มี ANTHROPIC_API_KEY = extraction เป็น null เสมอ
    const extraction = await this.extractor.extract(file.buffer, type.mimeType);

    const now = new Date();
    const storageKey = `receipts/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockRow(tx, id, existing.returnedDate);
        const created = await tx.receiptImage.create({
          data: {
            vehicleTransferId: existing.id,
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
          // AI อ่านปีผิดได้ - วันที่นอกช่วงวันที่ยื่นถึงวันนี้ไม่เติมให้ ปล่อยว่างให้พนักงานกรอกเอง
          const readDate = date && dateInRange(toUtcDate(date), existing.submitDate) ? toUtcDate(date) : undefined;
          if (receiptNo || readDate || total !== null) {
            await tx.vehicleTransfer.updateMany({
              where: { id, receiptNo: null, receiptDate: null, receiptAmount: null },
              data: { receiptNo: receiptNo || undefined, receiptDate: readDate, receiptAmount: total !== null ? total : undefined },
            });
          }
        }
        if (remark) {
          await writeAudit(tx, {
            entity: 'VehicleTransfer',
            entityId: id,
            action: 'add-receipt',
            remark,
            changes: { receipt: { from: null, to: created.id } },
          });
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

  // แก้/กรอกเองเลขที่ใบเสร็จ/วันที่/ยอดเงิน - ต้องมีเหตุผลเมื่องานรับเอกสารกลับแล้ว
  async updateReceiptFields(
    id: string,
    dto: { receiptNo?: unknown; receiptDate?: unknown; receiptAmount?: unknown; remark?: unknown },
  ): Promise<{ transfer: VehicleTransferRow }> {
    const existing = await this.findOrThrow(id);
    const receiptNo = optionalText(dto?.receiptNo, 'เลขที่ใบเสร็จ', 100);
    const receiptDate = optionalIsoDateField(dto?.receiptDate, 'วันที่ใบเสร็จ');
    if (receiptDate) assertDateInRange('วันที่ใบเสร็จ', receiptDate, existing.submitDate);
    const receiptAmount = optionalAmount(dto?.receiptAmount, 'ยอดเงินตามใบเสร็จ');
    const next = { receiptNo, receiptDate, receiptAmount };
    const changes = diffChanges(existing, next);
    if (Object.keys(changes).length === 0) return this.reload(id);
    // เงื่อนไข returnedDate เท่ากับตอนตรวจ - มีคนยืนยัน/ยกเลิกรับกลับแทรกกลาง -> 409
    const where = { id, cancelledAt: null, returnedDate: existing.returnedDate };
    if (!existing.returnedDate) {
      await this.prisma.vehicleTransfer.update({ where, data: next }).catch(staleIfMissing);
      return this.reload(id);
    }
    const remark = requireRemark(dto?.remark, 'งานนี้รับเอกสารกลับแล้ว - แก้ข้อมูลใบเสร็จต้องระบุเหตุผล');
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleTransfer.update({ where, data: next }).catch(staleIfMissing);
      await writeAudit(tx, { entity: 'VehicleTransfer', entityId: id, action: 'update-receipt-fields', remark, changes });
    });
    return this.reload(id);
  }

  // ลบรูปก่อนยืนยันรับกลับได้เลย - หลังรับกลับต้องมีเหตุผล (บันทึกประวัติ) และต้องเหลือรูปอย่างน้อย 1 รูปเสมอ
  // หลังรับกลับรูปเป็นหลักฐาน: ถอดแถวออก (รูปเดิมแนบใหม่ได้) แต่ไม่ลบไฟล์ใน storage - storageKey อยู่ในประวัติ
  async removeReceipt(id: string, receiptId: string, remarkRaw?: unknown): Promise<{ transfer: VehicleTransferRow }> {
    const existing = await this.findOrThrow(id);
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - ลบรูปใบเสร็จต้องระบุเหตุผล') : null;
    const receipt = await this.prisma.receiptImage.findFirst({
      where: { id: receiptId, vehicleTransferId: id },
      select: { id: true, storageKey: true },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (remark && existing.receipts.length <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
    await this.prisma.$transaction(async (tx) => {
      // นับรูปใหม่หลังล็อกแถวงาน - ลบสองรูปพร้อมกัน หรือรับกลับแทรกกลาง ต้องไม่ทำให้งานที่รับกลับแล้วเหลือ 0 รูป
      const live = await this.lockRow(tx, id, existing.returnedDate);
      if (remark && live._count.receipts <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
      const { count } = await tx.receiptImage.deleteMany({ where: { id: receipt.id, vehicleTransferId: id } });
      if (count === 0) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' }); // อีกคนลบรูปนี้ไปก่อน
      if (remark) {
        await writeAudit(tx, {
          entity: 'VehicleTransfer',
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
