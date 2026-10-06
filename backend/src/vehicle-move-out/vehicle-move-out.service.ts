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
import { calculateMoveOutFees, moveOutPricedFor } from './vehicle-move-out-fee.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtractor } from '../receipts/receipt-extractor.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';

// ย้ายออก (หมวด "อื่นๆ", ผู้ใช้ 2026-10-06) - เก็บข้อมูลแบบเดียวกับงานยกเลิกการใช้รถทุกอย่าง (กรอกข้อมูลรถ ไม่มีทะเบียนใหม่) ค่าใช้จ่ายตายตัวเฉพาะมอเตอร์ไซค์ (vehicle-move-out-fee.ts) รถยนต์ยังไม่มีอัตรา รถยนต์ + มอเตอร์ไซค์
// ขั้นตอน: ยื่น (POST) -> รับใบเสร็จกลับ (วันที่ + รูปใบเสร็จอย่างน้อย 1 รูป, อ่าน OCR เติมเลขที่/วันที่/ยอดเงินให้)
// สิทธิ์: กลุ่มยื่นเอกสาร (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO) เหมือนงานสลับเลข - ดู access-policy.ts
// แก้/ยกเลิกต้องระบุเหตุผลเสมอ บันทึกประวัติลง AuditLog ('VehicleMoveOut') และยกเลิกแบบไม่ลบแถว (cancelledAt)

export type MoveOutVehicleClass = 'CAR' | 'MOTO';

export interface MoveOutCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface VehicleMoveOutRow {
  id: string;
  vehicleClass: MoveOutVehicleClass;
  customer: MoveOutCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  urgent: boolean; // งานด่วน
  billTotal: string;
  noBillTotal: string; // ไม่รวมค่าอากร
  dutyAmount: string; // ค่าอากร - แยกต่างหากจาก billTotal / noBillTotal
  returnedDate: string | null; // YYYY-MM-DD
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD
  receiptAmount: string | null;
  createdAt: string;
  // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดฟอร์มอยู่ = 409
  updatedAt: string;
}

// Wire shape - ทุกช่องมาจาก JSON ที่ยังไม่ตรวจ จึงเป็น unknown ให้ service ตรวจเอง
export interface CreateVehicleMoveOutDto {
  vehicleClass?: unknown; // CAR (ค่าเริ่มต้น) | MOTO
  customerId?: unknown; // เจ้าของงาน (บังคับ)
  ownerName?: unknown;
  engine?: unknown;
  chassis?: unknown;
  brand?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  submitDate?: unknown;
  urgent?: unknown; // งานด่วน (มอเตอร์ไซค์เท่านั้น)
}

export interface UpdateVehicleMoveOutDto {
  customerId?: unknown;
  ownerName?: unknown;
  engine?: unknown;
  chassis?: unknown;
  brand?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  submitDate?: unknown;
  urgent?: unknown;
  returnedDate?: unknown; // เฉพาะงานที่รับกลับแล้ว
  remark?: unknown;
  expectedUpdatedAt?: unknown;
}


export function parseVehicleClass(value: unknown): MoveOutVehicleClass {
  if (value === undefined || value === null || value === '') return 'CAR';
  if (value === 'CAR' || value === 'MOTO') return value;
  throw new BadRequestException({ error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR หรือ MOTO' });
}

// ติ๊ก (boolean) จาก JSON - ไม่ส่ง/ว่าง = false / ค่าอื่นที่ไม่ใช่ true/false = 400
function parseFlag(value: unknown, label: string): boolean {
  if (value === undefined || value === null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw new BadRequestException({ error: `${label} ต้องเป็น true หรือ false` });
}

// งานด่วนมีอัตราเฉพาะมอเตอร์ไซค์ (ผู้ใช้ 2026-10-06) - รถยนต์ยังไม่มีข้อมูล เลือกด่วนไม่ได้เพื่อไม่ให้ยอดผิด
function urgentFor(vehicleClass: MoveOutVehicleClass, raw: unknown): boolean {
  const urgent = parseFlag(raw, 'งานด่วน');
  if (urgent && !moveOutPricedFor(vehicleClass)) {
    throw new BadRequestException({ error: 'งานย้ายออกรถยนต์ยังไม่มีอัตรางานด่วน' });
  }
  return urgent;
}

const isValidMonthParam = (value: string) => /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));


const customerSelect = { id: true, name: true, company: true } as const;

const moveOutInclude = {
  customer: { select: customerSelect },
  receipts: { orderBy: { createdAt: 'asc' as const }, select: { id: true, createdAt: true } },
} satisfies Prisma.VehicleMoveOutInclude;

interface MoveOutRecord {
  id: string;
  vehicleClass: string;
  customerId?: string | null;
  customer?: MoveOutCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: Date;
  urgent: boolean;
  billTotal: Prisma.Decimal | number;
  noBillTotal: Prisma.Decimal | number;
  dutyAmount: Prisma.Decimal | number;
  returnedDate: Date | null;
  receiptNo: string | null;
  receiptDate: Date | null;
  receiptAmount: Prisma.Decimal | number | null;
  createdAt: Date;
  updatedAt: Date;
  receipts: { id: string; createdAt: Date }[];
}

export function serializeMoveOut(row: MoveOutRecord): VehicleMoveOutRow {
  return {
    id: row.id,
    vehicleClass: parseVehicleClass(row.vehicleClass),
    customer: row.customer ?? null,
    ownerName: row.ownerName,
    engine: row.engine,
    chassis: row.chassis,
    brand: row.brand,
    plateCategory: row.plateCategory,
    plateNumber: row.plateNumber,
    submitDate: row.submitDate.toISOString().slice(0, 10),
    urgent: row.urgent,
    billTotal: String(row.billTotal),
    noBillTotal: String(row.noBillTotal),
    dutyAmount: String(row.dutyAmount),
    returnedDate: isoDate(row.returnedDate),
    receipts: row.receipts.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() })),
    receiptNo: row.receiptNo ?? null,
    receiptDate: isoDate(row.receiptDate ?? null),
    receiptAmount: row.receiptAmount === null || row.receiptAmount === undefined ? null : String(row.receiptAmount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// มีคนแก้/ยกเลิก/รับกลับงานนี้ไปก่อน (update แบบมีเงื่อนไขไม่เจอแถว = Prisma P2025) -> 409 ให้หน้าเว็บโหลดใหม่
const STALE_ERROR = 'งานย้ายออกนี้ถูกแก้ ยกเลิก หรือรับกลับไปก่อนแล้ว - โหลดรายการใหม่';
function staleIfMissing(err: unknown): never {
  if ((err as { code?: string } | null)?.code === 'P2025') throw new ConflictException({ error: STALE_ERROR });
  throw err;
}

const RECEIPT_REQUIRED_ERROR = 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ';
const LAST_RECEIPT_ERROR = 'งานที่รับเอกสารกลับแล้วต้องมีรูปใบเสร็จอย่างน้อย 1 รูป - แนบรูปที่ถูกต้องก่อนแล้วจึงลบรูปนี้';

type Tx = Prisma.TransactionClient;

@Injectable()
export class VehicleMoveOutService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // ขอบเขตการแก้ตามประเภทรถของงาน (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO) - เหมือนงานสลับเลข
  private assertClassScope(vehicleClass: MoveOutVehicleClass) {
    assertKindInScope(vehicleClass === 'MOTO' ? 'moto' : 'car');
  }

  // ดูรายการใช้ขอบเขตการอ่าน - ACCOUNTANT ที่ถือ STAFF_MOTO ด้วยยังอ่านงานรถยนต์ได้ (แก้ไม่ได้)
  private assertClassReadable(vehicleClass: MoveOutVehicleClass) {
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

  async create(dto: CreateVehicleMoveOutDto): Promise<{ moveOut: VehicleMoveOutRow }> {
    const vehicleClass = parseVehicleClass(dto?.vehicleClass);
    this.assertClassScope(vehicleClass);
    const customerId = await this.resolveCustomerId(dto?.customerId);
    const ownerName = requiredText(dto?.ownerName, 'ชื่อเจ้าของรถ');
    const engine = requiredText(dto?.engine, 'เลขเครื่อง', 100);
    const chassis = requiredText(dto?.chassis, 'เลขตัวถัง', 100);
    const brand = await this.resolveBrandName(dto?.brand);
    const plateCategory = requiredText(dto?.plateCategory, 'หมวดทะเบียน', 10);
    const plateNumber = requiredText(dto?.plateNumber, 'เลขทะเบียน', 10);
    const submitDate = parseIsoDate(dto?.submitDate);
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });

    // ค่าใช้จ่ายตายตัว (ผู้ใช้ 2026-10-06) เก็บเป็น snapshot - ไม่รับยอดจากหน้าเว็บ รับเฉพาะติ๊กงานด่วน
    const urgent = urgentFor(vehicleClass, dto?.urgent);
    const fees = calculateMoveOutFees(vehicleClass, urgent);
    const row = await this.prisma.vehicleMoveOut.create({
      data: { vehicleClass, customerId, ownerName, engine, chassis, brand, plateCategory, plateNumber, submitDate, urgent, ...fees },
      include: moveOutInclude,
    });
    return { moveOut: serializeMoveOut(row) };
  }

  // status: pending = ยังไม่รับเอกสารกลับ | returned = รับกลับแล้ว | all - month (YYYY-MM) กรองตามวันที่ยื่น
  // งานที่ยกเลิกแล้วไม่แสดง
  async list(statusParam = 'all', monthParam?: string, classParam?: unknown): Promise<{ moveOuts: VehicleMoveOutRow[] }> {
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
    const rows = await this.prisma.vehicleMoveOut.findMany({
      where: {
        vehicleClass,
        cancelledAt: null,
        ...(statusParam === 'pending' ? { returnedDate: null } : statusParam === 'returned' ? { returnedDate: { not: null } } : {}),
        ...(submitDate ? { submitDate } : {}),
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: moveOutInclude,
    });
    return { moveOuts: rows.map(serializeMoveOut) };
  }

  // งานที่จะแก้ - ยกเลิกแล้วแก้ต่อไม่ได้ (409 ให้หน้าเว็บโหลดใหม่)
  private async findOrThrow(id: string): Promise<MoveOutRecord> {
    const row = await this.prisma.vehicleMoveOut.findUnique({ where: { id }, include: moveOutInclude });
    if (!row) throw new NotFoundException({ error: 'ไม่พบงานย้ายออก' });
    // เช็คสิทธิ์ตามประเภทรถของงานนั้นจริงๆ (อ่านแถวก่อน) - STAFF_MOTO แก้ได้เฉพาะงานมอเตอร์ไซค์ และกลับกัน
    this.assertClassScope(parseVehicleClass(row.vehicleClass));
    if (row.cancelledAt) throw new ConflictException({ error: 'งานย้ายออกนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return row;
  }

  // ล็อกแถวงาน (FOR UPDATE) แล้วอ่านสถานะล่าสุดใน transaction เดียวกับการเขียน - กันรับกลับพร้อมกับลบรูปสุดท้าย
  // สถานะรับกลับไม่ตรงกับตอนตรวจ (มีคนรับกลับ/ยกเลิกรับกลับ/ยกเลิกงานไปก่อน) = 409 ให้โหลดใหม่
  private async lockRow(tx: Tx, id: string, expectedReturnedDate: Date | null) {
    await tx.$queryRaw`SELECT "id" FROM "VehicleMoveOut" WHERE "id" = ${id} FOR UPDATE`;
    const live = await tx.vehicleMoveOut.findFirst({
      where: { id, cancelledAt: null },
      select: { returnedDate: true, _count: { select: { receipts: true } } },
    });
    if (!live) throw new ConflictException({ error: STALE_ERROR });
    if (!sameTime(live.returnedDate, expectedReturnedDate)) throw new ConflictException({ error: STALE_ERROR });
    return live;
  }

  private async reload(id: string): Promise<{ moveOut: VehicleMoveOutRow }> {
    const row = await this.prisma.vehicleMoveOut.findUniqueOrThrow({ where: { id }, include: moveOutInclude });
    return { moveOut: serializeMoveOut(row) };
  }

  // รับเอกสารกลับ - ต้องมีรูปใบเสร็จแนบอย่างน้อย 1 รูป / วันที่อยู่ระหว่างวันที่ยื่นถึงวันนี้ (เวลาไทย)
  async markReturned(id: string, returnedDateRaw: unknown): Promise<{ moveOut: VehicleMoveOutRow }> {
    const existing = await this.findOrThrow(id);
    const returnedDate = parseIsoDate(returnedDateRaw);
    if (!returnedDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับเอกสารกลับให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว' });
    assertDateInRange('วันที่รับเอกสารกลับ', returnedDate, existing.submitDate);
    if (existing.receipts.length === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
    await this.prisma.$transaction(async (tx) => {
      // นับรูปหลังล็อกแถว - ลบรูปสุดท้ายที่บันทึกแทรกกลางต้องไม่หลุดเข้ามา
      const live = await this.lockRow(tx, id, null);
      if (live._count.receipts === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
      await tx.vehicleMoveOut.update({ where: { id, cancelledAt: null, returnedDate: null }, data: { returnedDate } }).catch(staleIfMissing);
    });
    return this.reload(id);
  }

  // แก้ข้อมูลงาน: เจ้าของงาน ข้อมูลรถ วันที่ยื่น และวันที่รับกลับ (งานที่รับกลับแล้ว) ต้องมีเหตุผลเสมอ
  // บันทึกเฉพาะช่องที่เปลี่ยนลง AuditLog
  async update(id: string, dto: UpdateVehicleMoveOutDto): Promise<{ moveOut: VehicleMoveOutRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้งานย้ายออก');
    const expectedUpdatedAt = parseExpectedUpdatedAt(dto.expectedUpdatedAt);
    const existing = await this.findOrThrow(id);
    // ฟอร์มส่งข้อมูลทุกช่องจากตอนเปิด - เปิดค้างไว้ขณะที่อีกคนแก้/รับกลับไปก่อน = 409 ไม่เอาค่าเก่าไปทับ
    if (expectedUpdatedAt && !sameTime(expectedUpdatedAt, existing.updatedAt)) throw new ConflictException({ error: STALE_ERROR });
    const has = (key: keyof UpdateVehicleMoveOutDto) => dto[key] !== undefined;

    const submitDate = has('submitDate') ? parseIsoDate(dto.submitDate) : existing.submitDate;
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });

    const urgent = has('urgent') ? urgentFor(parseVehicleClass(existing.vehicleClass), dto.urgent) : existing.urgent;

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
    if (returnedDate && returnedChanged) assertDateInRange('วันที่รับเอกสารกลับ', returnedDate, submitDate);
    else if (returnedDate && returnedDate < submitDate) {
      throw new BadRequestException({ error: 'วันที่ยื่นต้องไม่หลังวันที่รับเอกสารกลับ' });
    }

    const next = {
      customerId: has('customerId') ? await this.resolveCustomerId(dto.customerId) : (existing.customerId ?? null),
      ownerName: has('ownerName') ? requiredText(dto.ownerName, 'ชื่อเจ้าของรถ') : existing.ownerName,
      engine: has('engine') ? requiredText(dto.engine, 'เลขเครื่อง', 100) : existing.engine,
      chassis: has('chassis') ? requiredText(dto.chassis, 'เลขตัวถัง', 100) : existing.chassis,
      brand: has('brand') ? await this.resolveBrandName(dto.brand) : existing.brand,
      plateCategory: has('plateCategory') ? requiredText(dto.plateCategory, 'หมวดทะเบียน', 10) : existing.plateCategory,
      plateNumber: has('plateNumber') ? requiredText(dto.plateNumber, 'เลขทะเบียน', 10) : existing.plateNumber,
      submitDate,
      urgent,
      // ติ๊กด่วนเปลี่ยนเท่านั้นที่คิดยอดใหม่ - แก้อย่างอื่นคงยอด snapshot เดิม (กันอัตราใหม่ในอนาคตทำให้งานเก่าเปลี่ยน)
      noBillTotal: urgent === existing.urgent ? Number(existing.noBillTotal) : calculateMoveOutFees(parseVehicleClass(existing.vehicleClass), urgent).noBillTotal,
      returnedDate,
    };
    const changes: AuditChanges = diffChanges(existing, next);
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleMoveOut
        .update({
          // เงื่อนไข updatedAt ที่ฟอร์มโหลดมา: อีกคนแก้/รับกลับไปก่อน -> 409 ไม่ทับของเขา
          where: { id, cancelledAt: null, updatedAt: expectedUpdatedAt ?? existing.updatedAt },
          data: next,
        })
        .catch(staleIfMissing);
      await writeAudit(tx, { entity: 'VehicleMoveOut', entityId: id, action: 'update', remark, changes });
    });
    return this.reload(id);
  }

  // ยกเลิกการรับเอกสารกลับที่กดผิด - งานกลับไปรอรับเอกสาร
  async undoReturn(id: string, remarkRaw: unknown): Promise<{ moveOut: VehicleMoveOutRow }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกรับเอกสารกลับ');
    const existing = await this.findOrThrow(id);
    if (!existing.returnedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่รับเอกสารกลับ' });
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleMoveOut
        .update({ where: { id, cancelledAt: null, returnedDate: existing.returnedDate }, data: { returnedDate: null } })
        .catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'VehicleMoveOut',
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
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกงานย้ายออก');
    const existing = await this.findOrThrow(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleMoveOut
        .update({ where: { id, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null } })
        .catch(staleIfMissing);
      await tx.receiptImage.updateMany({ where: { vehicleMoveOutId: id }, data: { contentHash: null } });
      await writeAudit(tx, {
        entity: 'VehicleMoveOut',
        entityId: id,
        action: 'cancel',
        remark,
        changes: {
          customer: existing.customer ? (existing.customer.company ?? existing.customer.name) : null,
          ownerName: existing.ownerName,
          chassis: existing.chassis,
          plate: `${existing.plateCategory} ${existing.plateNumber}`,
          submitDate: existing.submitDate,
          urgent: existing.urgent,
          returnedDate: existing.returnedDate,
          billTotal: existing.billTotal,
          noBillTotal: existing.noBillTotal,
          dutyAmount: existing.dutyAmount,
          receiptIds: existing.receipts.map((r) => r.id),
        },
      });
    });
    return { id };
  }

  // แนบรูปใบเสร็จ - อ่าน OCR เหมือนใบเสร็จงานสลับเลข เก็บผลลง ReceiptImage.extraction/extractionSource
  // หลังรับเอกสารกลับแนบเพิ่มได้ แต่ต้องมีเหตุผลและบันทึกประวัติ
  async addReceipt(id: string, file: UploadedReceiptFile | undefined, remarkRaw?: unknown): Promise<{ moveOut: VehicleMoveOutRow }> {
    const existing = await this.findOrThrow(id);
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
            vehicleMoveOutId: existing.id,
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
            await tx.vehicleMoveOut.updateMany({
              where: { id, receiptNo: null, receiptDate: null, receiptAmount: null },
              data: { receiptNo: receiptNo || undefined, receiptDate: readDate, receiptAmount: total !== null ? total : undefined },
            });
          }
        }
        if (remark) {
          await writeAudit(tx, {
            entity: 'VehicleMoveOut',
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
  ): Promise<{ moveOut: VehicleMoveOutRow }> {
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
      await this.prisma.vehicleMoveOut.update({ where, data: next }).catch(staleIfMissing);
      return this.reload(id);
    }
    const remark = requireRemark(dto?.remark, 'งานนี้รับเอกสารกลับแล้ว - แก้ข้อมูลใบเสร็จต้องระบุเหตุผล');
    await this.prisma.$transaction(async (tx) => {
      await tx.vehicleMoveOut.update({ where, data: next }).catch(staleIfMissing);
      await writeAudit(tx, { entity: 'VehicleMoveOut', entityId: id, action: 'update-receipt-fields', remark, changes });
    });
    return this.reload(id);
  }

  // ลบรูปก่อนยืนยันรับกลับได้เลย - หลังรับกลับต้องมีเหตุผล (บันทึกประวัติ) และต้องเหลือรูปอย่างน้อย 1 รูปเสมอ
  // หลังรับกลับรูปเป็นหลักฐาน: ถอดแถวออก (รูปเดิมแนบใหม่ได้) แต่ไม่ลบไฟล์ใน storage - storageKey อยู่ในประวัติ
  async removeReceipt(id: string, receiptId: string, remarkRaw?: unknown): Promise<{ moveOut: VehicleMoveOutRow }> {
    const existing = await this.findOrThrow(id);
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - ลบรูปใบเสร็จต้องระบุเหตุผล') : null;
    const receipt = await this.prisma.receiptImage.findFirst({
      where: { id: receiptId, vehicleMoveOutId: id },
      select: { id: true, storageKey: true },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (remark && existing.receipts.length <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
    await this.prisma.$transaction(async (tx) => {
      // นับรูปใหม่หลังล็อกแถวงาน - ลบสองรูปพร้อมกัน หรือรับกลับแทรกกลาง ต้องไม่ทำให้งานที่รับกลับแล้วเหลือ 0 รูป
      const live = await this.lockRow(tx, id, existing.returnedDate);
      if (remark && live._count.receipts <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
      const { count } = await tx.receiptImage.deleteMany({ where: { id: receipt.id, vehicleMoveOutId: id } });
      if (count === 0) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' }); // อีกคนลบรูปนี้ไปก่อน
      if (remark) {
        await writeAudit(tx, {
          entity: 'VehicleMoveOut',
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

