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
  requiredIsoDateField,
  requiredText,
  sameTime,
  toUtcDate,
} from '../plate-swap/plate-swap.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtractor } from '../receipts/receipt-extractor.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { PLATE_COPY_DUTY_FEE, PLATE_COPY_NO_BILL_FEE, PLATE_COPY_TYPES, type PlateCopyType, plateCopyBillFee } from './plate-copy-fee.js';

// คัดแผ่นป้ายทะเบียน (หมวด "อื่นๆ", ผู้ใช้ 2026-10-02) - ทำเหมือนยกเลิกการใช้รถ: กรอกข้อมูลรถเหมือนการสลับเลข (ไม่มีทะเบียนใหม่)
// แต่ "รถยนต์เท่านั้น" (จักรยานยนต์ยังไม่เปิด) และมีขั้นรับป้ายต่อท้าย
// ขั้นตอน: ยื่น (POST) -> รับใบเสร็จกลับ (วันที่ + รูปใบเสร็จอย่างน้อย 1 รูป, อ่าน OCR เติมเลขที่/วันที่/ยอดเงินให้)
//          -> รับป้าย (แนบรูปป้ายที่ได้รับ + วันที่รับ บันทึกทันที - ไม่ผูกกับรับใบเสร็จ ไม่ใช้ AI เหมือนรับป้ายอื่นของระบบ)
// ค่าใช้จ่ายตายตัว Bill 205 / No Bill 100 / ค่าอากร 10 แยกต่างหาก (plate-copy-fee.ts) - ยังไม่ผูกกับการวางบิล/ภาพรวม
// สิทธิ์: กลุ่มยื่นเอกสารรถยนต์ (STAFF_CAR) เหมือนงานสลับเลข - ดู access-policy.ts
// แก้/ยกเลิกต้องระบุเหตุผลเสมอ บันทึกประวัติลง AuditLog ('PlateCopy') และยกเลิกแบบไม่ลบแถว (cancelledAt)

export type PlateCopyVehicleClass = 'CAR'; // ตอนนี้รถยนต์เท่านั้น (ผู้ใช้ 2026-10-02) - ค่า MOTO ถูกปฏิเสธใน parseVehicleClass

export interface PlateCopyCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface PlateCopyRow {
  id: string;
  vehicleClass: PlateCopyVehicleClass;
  customer: PlateCopyCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: string; // YYYY-MM-DD
  copyType: PlateCopyType;
  billTotal: string;
  noBillTotal: string;
  dutyAmount: string; // ค่าอากร - แยกต่างหากจาก billTotal / noBillTotal
  returnedDate: string | null; // YYYY-MM-DD
  // ส่งงานลูกค้า (ใบ DL จากหน้า Delivery ผู้ใช้ 2026-10-08) - ส่งแล้วจึงวางบิลได้
  deliveredDate: string | null;
  deliveryRecipient: string | null;
  plateReceivedDate: string | null; // YYYY-MM-DD - วันที่รับป้าย (ตั้งพร้อมรูป)
  platePhotoId: string | null; // ดูรูปที่ GET /api/plate-copies/:id/plate-photo/image
  receipts: { id: string; createdAt: string }[];
  receiptNo: string | null;
  receiptDate: string | null; // YYYY-MM-DD
  receiptAmount: string | null;
  createdAt: string;
  // ฟอร์ม ✎ แก้ส่งกลับเป็น expectedUpdatedAt - มีคนแก้/รับกลับไปก่อนระหว่างที่เปิดฟอร์มอยู่ = 409
  updatedAt: string;
}

// Wire shape - ทุกช่องมาจาก JSON ที่ยังไม่ตรวจ จึงเป็น unknown ให้ service ตรวจเอง
export interface CreatePlateCopyDto {
  vehicleClass?: unknown; // CAR (ค่าเริ่มต้น) - จักรยานยนต์ยังไม่เปิด
  customerId?: unknown; // เจ้าของงาน (บังคับ)
  ownerName?: unknown;
  engine?: unknown;
  chassis?: unknown;
  brand?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  copyType?: unknown; // BOTH (ค่าเริ่มต้น = คัดคู่ปกติ) | SINGLE_NORMAL | BOTH_AUCTION | SINGLE_AUCTION
  submitDate?: unknown;
}

export interface UpdatePlateCopyDto {
  customerId?: unknown;
  ownerName?: unknown;
  engine?: unknown;
  chassis?: unknown;
  brand?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  copyType?: unknown;
  submitDate?: unknown;
  returnedDate?: unknown; // เฉพาะงานที่รับกลับแล้ว
  remark?: unknown;
  expectedUpdatedAt?: unknown;
}


export function parseCopyType(value: unknown): PlateCopyType {
  if (value === undefined || value === null || value === '') return 'BOTH';
  if (PLATE_COPY_TYPES.includes(value as PlateCopyType)) return value as PlateCopyType;
  throw new BadRequestException({ error: 'ชนิดการคัดป้ายต้องเป็น BOTH, SINGLE_NORMAL, BOTH_AUCTION หรือ SINGLE_AUCTION' });
}

export function parseVehicleClass(value: unknown): PlateCopyVehicleClass {
  if (value === undefined || value === null || value === '') return 'CAR';
  if (value === 'CAR') return value;
  if (value === 'MOTO') throw new BadRequestException({ error: 'คัดแผ่นป้ายทะเบียนใช้ได้เฉพาะรถยนต์ (จักรยานยนต์ยังไม่เปิดให้ใช้)' });
  throw new BadRequestException({ error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR' });
}

const isValidMonthParam = (value: string) => /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));


const customerSelect = { id: true, name: true, company: true } as const;

const plateCopyInclude = {
  customer: { select: customerSelect },
  receipts: { orderBy: { createdAt: 'asc' as const }, select: { id: true, createdAt: true } },
} satisfies Prisma.PlateCopyInclude;

interface PlateCopyRecord {
  deliveredDate?: Date | null; // ส่งงานลูกค้าแล้ว (ใบ DL จากหน้า Delivery ผู้ใช้ 2026-10-08)
  deliveryRecipient?: string | null;
  id: string;
  vehicleClass: string;
  customerId?: string | null;
  customer?: PlateCopyCustomer | null;
  ownerName: string;
  engine: string;
  chassis: string;
  brand: string;
  plateCategory: string;
  plateNumber: string;
  submitDate: Date;
  copyType?: string;
  billTotal: Prisma.Decimal | number;
  noBillTotal: Prisma.Decimal | number;
  dutyAmount: Prisma.Decimal | number;
  returnedDate: Date | null;
  plateReceivedDate: Date | null;
  platePhotoId: string | null;
  receiptNo: string | null;
  receiptDate: Date | null;
  receiptAmount: Prisma.Decimal | number | null;
  createdAt: Date;
  updatedAt: Date;
  receipts: { id: string; createdAt: Date }[];
}

export function serializePlateCopy(row: PlateCopyRecord): PlateCopyRow {
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
    copyType: parseCopyType(row.copyType),
    billTotal: String(row.billTotal),
    noBillTotal: String(row.noBillTotal),
    dutyAmount: String(row.dutyAmount),
    returnedDate: isoDate(row.returnedDate),
    deliveredDate: isoDate(row.deliveredDate ?? null),
    deliveryRecipient: row.deliveryRecipient ?? null,
    plateReceivedDate: isoDate(row.plateReceivedDate),
    platePhotoId: row.platePhotoId ?? null,
    receipts: row.receipts.map((r) => ({ id: r.id, createdAt: r.createdAt.toISOString() })),
    receiptNo: row.receiptNo ?? null,
    receiptDate: isoDate(row.receiptDate ?? null),
    receiptAmount: row.receiptAmount === null || row.receiptAmount === undefined ? null : String(row.receiptAmount),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// มีคนแก้/ยกเลิก/รับกลับงานนี้ไปก่อน (update แบบมีเงื่อนไขไม่เจอแถว = Prisma P2025) -> 409 ให้หน้าเว็บโหลดใหม่
const STALE_ERROR = 'งานคัดแผ่นป้ายทะเบียนนี้ถูกแก้ ยกเลิก หรือรับกลับไปก่อนแล้ว - โหลดรายการใหม่';
function staleIfMissing(err: unknown): never {
  if ((err as { code?: string } | null)?.code === 'P2025') throw new ConflictException({ error: STALE_ERROR });
  throw err;
}

const RECEIPT_REQUIRED_ERROR = 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ';
const LAST_RECEIPT_ERROR = 'งานที่รับเอกสารกลับแล้วต้องมีรูปใบเสร็จอย่างน้อย 1 รูป - แนบรูปที่ถูกต้องก่อนแล้วจึงลบรูปนี้';

type Tx = Prisma.TransactionClient;

@Injectable()
export class PlateCopyService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // รถยนต์เท่านั้น - แก้ได้เฉพาะกลุ่มยื่นรถยนต์ (STAFF_CAR / ADMIN) เหมือนงานสลับเลขรถยนต์
  private assertCarScope() {
    assertKindInScope('car');
  }

  // ดูรายการใช้ขอบเขตการอ่าน - ACCOUNTANT ที่ถือ STAFF_MOTO ด้วยยังอ่านงานรถยนต์ได้ (แก้ไม่ได้)
  private assertCarReadable() {
    const scope = currentVehicleScope();
    if (scope === 'ALL' || scope === 'CAR') return;
    this.assertCarScope();
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

  async create(dto: CreatePlateCopyDto): Promise<{ plateCopy: PlateCopyRow }> {
    const vehicleClass = parseVehicleClass(dto?.vehicleClass);
    this.assertCarScope();
    const customerId = await this.resolveCustomerId(dto?.customerId);
    const ownerName = requiredText(dto?.ownerName, 'ชื่อเจ้าของรถ');
    const engine = requiredText(dto?.engine, 'เลขเครื่อง', 100);
    const chassis = requiredText(dto?.chassis, 'เลขตัวถัง', 100);
    const brand = await this.resolveBrandName(dto?.brand);
    const plateCategory = requiredText(dto?.plateCategory, 'หมวดทะเบียน', 10);
    const plateNumber = requiredText(dto?.plateNumber, 'เลขทะเบียน', 10);
    const copyType = parseCopyType(dto?.copyType);
    const submitDate = parseIsoDate(dto?.submitDate);
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });

    // ค่าใช้จ่ายตายตัว (ผู้ใช้ 2026-10-02: Bill 25 / No Bill 100 / ค่าอากร 10 แยกต่างหาก) เก็บเป็น snapshot - ไม่รับยอดจากหน้าเว็บ และแก้ภายหลังไม่ได้
    const row = await this.prisma.plateCopy.create({
      data: { vehicleClass, customerId, ownerName, engine, chassis, brand, plateCategory, plateNumber, submitDate, copyType, billTotal: plateCopyBillFee(copyType), noBillTotal: PLATE_COPY_NO_BILL_FEE, dutyAmount: PLATE_COPY_DUTY_FEE },
      include: plateCopyInclude,
    });
    return { plateCopy: serializePlateCopy(row) };
  }

  // status: pending = ยังไม่รับเอกสารกลับ | returned = รับกลับแล้ว | all - month (YYYY-MM) กรองตามวันที่ยื่น
  // งานที่ยกเลิกแล้วไม่แสดง
  async list(statusParam = 'all', monthParam?: string, classParam?: unknown): Promise<{ plateCopies: PlateCopyRow[] }> {
    const vehicleClass = parseVehicleClass(classParam);
    this.assertCarReadable();
    if (!['pending', 'returned', 'all'].includes(statusParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ status ต้องเป็น pending, returned หรือ all' });
    }
    let submitDate: { gte: Date; lt: Date } | undefined;
    if (monthParam) {
      if (!isValidMonthParam(monthParam)) throw new BadRequestException({ error: 'พารามิเตอร์ month ต้องเป็น ค.ศ. YYYY-MM ที่ถูกต้อง' });
      const start = toUtcDate(`${monthParam}-01`);
      submitDate = { gte: start, lt: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)) };
    }
    const rows = await this.prisma.plateCopy.findMany({
      where: {
        vehicleClass,
        cancelledAt: null,
        ...(statusParam === 'pending' ? { returnedDate: null } : statusParam === 'returned' ? { returnedDate: { not: null } } : {}),
        ...(submitDate ? { submitDate } : {}),
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: plateCopyInclude,
    });
    return { plateCopies: rows.map(serializePlateCopy) };
  }

  // งานที่จะแก้ - ยกเลิกแล้วแก้ต่อไม่ได้ (409 ให้หน้าเว็บโหลดใหม่)
  private async findOrThrow(id: string): Promise<PlateCopyRecord> {
    const row = await this.prisma.plateCopy.findUnique({ where: { id }, include: plateCopyInclude });
    if (!row) throw new NotFoundException({ error: 'ไม่พบงานคัดแผ่นป้ายทะเบียน' });
    // รถยนต์เท่านั้น - STAFF_MOTO แก้ไม่ได้
    this.assertCarScope();
    if (row.cancelledAt) throw new ConflictException({ error: 'งานคัดแผ่นป้ายทะเบียนนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return row;
  }

  // ล็อกแถวงาน (FOR UPDATE) แล้วอ่านสถานะล่าสุดใน transaction เดียวกับการเขียน - กันรับกลับพร้อมกับลบรูปสุดท้าย
  // สถานะรับกลับไม่ตรงกับตอนตรวจ (มีคนรับกลับ/ยกเลิกรับกลับ/ยกเลิกงานไปก่อน) = 409 ให้โหลดใหม่
  // 'skip' = งานนั้นไม่เกี่ยวกับใบเสร็จ (แนบ/แก้/ถอดรูปป้าย) - รับป้ายกับรับใบเสร็จเป็นคนละขั้น ทำพร้อมกันได้
  private async lockRow(tx: Tx, id: string, expectedReturnedDate: Date | null | 'skip') {
    await tx.$queryRaw`SELECT "id" FROM "PlateCopy" WHERE "id" = ${id} FOR UPDATE`;
    const live = await tx.plateCopy.findFirst({
      where: { id, cancelledAt: null },
      select: { returnedDate: true, _count: { select: { receipts: true } } },
    });
    if (!live) throw new ConflictException({ error: STALE_ERROR });
    if (expectedReturnedDate !== 'skip' && !sameTime(live.returnedDate, expectedReturnedDate)) throw new ConflictException({ error: STALE_ERROR });
    return live;
  }

  private async reload(id: string): Promise<{ plateCopy: PlateCopyRow }> {
    const row = await this.prisma.plateCopy.findUniqueOrThrow({ where: { id }, include: plateCopyInclude });
    return { plateCopy: serializePlateCopy(row) };
  }

  // รับเอกสารกลับ - ต้องมีรูปใบเสร็จแนบอย่างน้อย 1 รูป / วันที่อยู่ระหว่างวันที่ยื่นถึงวันนี้ (เวลาไทย)
  async markReturned(id: string, returnedDateRaw: unknown): Promise<{ plateCopy: PlateCopyRow }> {
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
      await tx.plateCopy.update({ where: { id, cancelledAt: null, returnedDate: null }, data: { returnedDate } }).catch(staleIfMissing);
    });
    return this.reload(id);
  }

  // แก้ข้อมูลงาน: เจ้าของงาน ข้อมูลรถ วันที่ยื่น และวันที่รับกลับ (งานที่รับกลับแล้ว) ต้องมีเหตุผลเสมอ
  // บันทึกเฉพาะช่องที่เปลี่ยนลง AuditLog
  async update(id: string, dto: UpdatePlateCopyDto): Promise<{ plateCopy: PlateCopyRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้งานคัดแผ่นป้ายทะเบียน');
    const expectedUpdatedAt = parseExpectedUpdatedAt(dto.expectedUpdatedAt);
    const existing = await this.findOrThrow(id);
    // ฟอร์มส่งข้อมูลทุกช่องจากตอนเปิด - เปิดค้างไว้ขณะที่อีกคนแก้/รับกลับไปก่อน = 409 ไม่เอาค่าเก่าไปทับ
    if (expectedUpdatedAt && !sameTime(expectedUpdatedAt, existing.updatedAt)) throw new ConflictException({ error: STALE_ERROR });
    const has = (key: keyof UpdatePlateCopyDto) => dto[key] !== undefined;

    const submitDate = has('submitDate') ? parseIsoDate(dto.submitDate) : existing.submitDate;
    if (!submitDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });

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
      copyType: has('copyType') ? parseCopyType(dto.copyType) : parseCopyType(existing.copyType),
      submitDate,
      returnedDate,
    };
    // เปลี่ยนชนิดการคัดป้าย = คิด Bill ใหม่ตามชนิด (ชนิดเดิมคง snapshot เดิม)
    const billTotal = next.copyType !== parseCopyType(existing.copyType) ? plateCopyBillFee(next.copyType) : Number(existing.billTotal);
    const changes: AuditChanges = diffChanges({ ...existing, copyType: parseCopyType(existing.copyType), billTotal: Number(existing.billTotal) }, { ...next, billTotal });
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });

    await this.prisma.$transaction(async (tx) => {
      await tx.plateCopy
        .update({
          // เงื่อนไข updatedAt ที่ฟอร์มโหลดมา: อีกคนแก้/รับกลับไปก่อน -> 409 ไม่ทับของเขา
          where: { id, cancelledAt: null, updatedAt: expectedUpdatedAt ?? existing.updatedAt },
          data: billTotal === Number(existing.billTotal) ? next : { ...next, billTotal },
        })
        .catch(staleIfMissing);
      await writeAudit(tx, { entity: 'PlateCopy', entityId: id, action: 'update', remark, changes });
    });
    return this.reload(id);
  }

  // ยกเลิกการรับเอกสารกลับที่กดผิด - งานกลับไปรอรับเอกสาร
  async undoReturn(id: string, remarkRaw: unknown): Promise<{ plateCopy: PlateCopyRow }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกรับเอกสารกลับ');
    const existing = await this.findOrThrow(id);
    if (!existing.returnedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่รับเอกสารกลับ' });
    // ส่งงานลูกค้าแล้ว (ใบ DL) - ต้องยกเลิกใบส่งงานก่อน ไม่งั้นใบ DL ค้างชี้งานที่ย้อนสถานะ/ยกเลิกไปแล้ว (ผู้ใช้ 2026-10-08)
    if (existing.deliveredDate) throw new BadRequestException({ error: 'งานนี้ส่งงานลูกค้าแล้ว - ยกเลิกใบส่งงาน (DL) ที่หน้ารายงานส่งงานก่อน' });
    await this.prisma.$transaction(async (tx) => {
      await tx.plateCopy
        .update({ where: { id, cancelledAt: null, returnedDate: existing.returnedDate }, data: { returnedDate: null } })
        .catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'PlateCopy',
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
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกงานคัดแผ่นป้ายทะเบียน');
    const existing = await this.findOrThrow(id);
    // ส่งงานลูกค้าแล้ว (ใบ DL) - ต้องยกเลิกใบส่งงานก่อน ไม่งั้นใบ DL ค้างชี้งานที่ย้อนสถานะ/ยกเลิกไปแล้ว (ผู้ใช้ 2026-10-08)
    if (existing.deliveredDate) throw new BadRequestException({ error: 'งานนี้ส่งงานลูกค้าแล้ว - ยกเลิกใบส่งงาน (DL) ที่หน้ารายงานส่งงานก่อน' });
    await this.prisma.$transaction(async (tx) => {
      await tx.plateCopy
        .update({ where: { id, cancelledAt: null }, data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null } })
        .catch(staleIfMissing);
      await tx.receiptImage.updateMany({ where: { plateCopyId: id }, data: { contentHash: null } });
      // รูปป้ายที่แนบไว้ก็ปล่อย hash เหมือนใบเสร็จ - แนบรูปเดิมกับงานที่คีย์ใหม่ได้ (รูปเก็บไว้ในประวัติ)
      if (existing.platePhotoId) await tx.platePhoto.updateMany({ where: { id: existing.platePhotoId }, data: { contentHash: null } });
      await writeAudit(tx, {
        entity: 'PlateCopy',
        entityId: id,
        action: 'cancel',
        remark,
        changes: {
          customer: existing.customer ? (existing.customer.company ?? existing.customer.name) : null,
          ownerName: existing.ownerName,
          chassis: existing.chassis,
          plate: `${existing.plateCategory} ${existing.plateNumber}`,
          submitDate: existing.submitDate,
          returnedDate: existing.returnedDate,
          plateReceivedDate: existing.plateReceivedDate,
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
  async addReceipt(id: string, file: UploadedReceiptFile | undefined, remarkRaw?: unknown): Promise<{ plateCopy: PlateCopyRow }> {
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
            plateCopyId: existing.id,
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
            await tx.plateCopy.updateMany({
              where: { id, receiptNo: null, receiptDate: null, receiptAmount: null },
              data: { receiptNo: receiptNo || undefined, receiptDate: readDate, receiptAmount: total !== null ? total : undefined },
            });
          }
        }
        if (remark) {
          await writeAudit(tx, {
            entity: 'PlateCopy',
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
  ): Promise<{ plateCopy: PlateCopyRow }> {
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
      await this.prisma.plateCopy.update({ where, data: next }).catch(staleIfMissing);
      return this.reload(id);
    }
    const remark = requireRemark(dto?.remark, 'งานนี้รับเอกสารกลับแล้ว - แก้ข้อมูลใบเสร็จต้องระบุเหตุผล');
    await this.prisma.$transaction(async (tx) => {
      await tx.plateCopy.update({ where, data: next }).catch(staleIfMissing);
      await writeAudit(tx, { entity: 'PlateCopy', entityId: id, action: 'update-receipt-fields', remark, changes });
    });
    return this.reload(id);
  }

  // ลบรูปก่อนยืนยันรับกลับได้เลย - หลังรับกลับต้องมีเหตุผล (บันทึกประวัติ) และต้องเหลือรูปอย่างน้อย 1 รูปเสมอ
  // หลังรับกลับรูปเป็นหลักฐาน: ถอดแถวออก (รูปเดิมแนบใหม่ได้) แต่ไม่ลบไฟล์ใน storage - storageKey อยู่ในประวัติ
  async removeReceipt(id: string, receiptId: string, remarkRaw?: unknown): Promise<{ plateCopy: PlateCopyRow }> {
    const existing = await this.findOrThrow(id);
    const remark = existing.returnedDate ? requireRemark(remarkRaw, 'งานนี้รับเอกสารกลับแล้ว - ลบรูปใบเสร็จต้องระบุเหตุผล') : null;
    const receipt = await this.prisma.receiptImage.findFirst({
      where: { id: receiptId, plateCopyId: id },
      select: { id: true, storageKey: true },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (remark && existing.receipts.length <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
    await this.prisma.$transaction(async (tx) => {
      // นับรูปใหม่หลังล็อกแถวงาน - ลบสองรูปพร้อมกัน หรือรับกลับแทรกกลาง ต้องไม่ทำให้งานที่รับกลับแล้วเหลือ 0 รูป
      const live = await this.lockRow(tx, id, existing.returnedDate);
      if (remark && live._count.receipts <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
      const { count } = await tx.receiptImage.deleteMany({ where: { id: receipt.id, plateCopyId: id } });
      if (count === 0) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' }); // อีกคนลบรูปนี้ไปก่อน
      if (remark) {
        await writeAudit(tx, {
          entity: 'PlateCopy',
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

  // --- รับป้าย (ผู้ใช้ 2026-10-02: คัดแผ่นป้ายต้องมีรับป้ายกลับมาด้วย และถ่ายรูปป้ายในการ์ดยืนยันรับป้าย) ---------------------
  // แนบรูปป้ายที่ได้รับ + วันที่รับ บันทึกทันที - ไม่ใช้ AI ไม่ผูกกับ returnedDate (แนบได้แม้ยังไม่รับใบเสร็จ) เหมือนรับป้ายงานสลับเลข
  // รูปเก็บในตาราง PlatePhoto เดียวกับป้ายรถจดใหม่ (hash กันอัปโหลดซ้ำ) / วันที่รับอยู่ระหว่างวันที่ยื่นถึงวันนี้ (เวลาไทย)
  async attachPlatePhoto(id: string, file: UploadedReceiptFile | undefined, dateRaw: unknown): Promise<{ plateCopy: PlateCopyRow }> {
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
        await this.lockRow(tx, id, 'skip');
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
        const { count } = await tx.plateCopy.updateMany({ where: { id, platePhotoId: null }, data: { plateReceivedDate: date, platePhotoId: photo.id } });
        if (count === 0) throw new BadRequestException({ error: 'งานนี้รับป้ายไปแล้ว' });
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return this.reload(id);
  }

  // งานที่รับป้ายแล้ว (มีรูปและวันที่) - ใช้แก้วันที่/ถอดรูป
  private async findReceivedForPlate(id: string) {
    const existing = await this.findOrThrow(id);
    if (!existing.plateReceivedDate) throw new BadRequestException({ error: 'งานนี้ยังไม่รับป้าย' });
    return existing;
  }

  // แก้วันที่รับป้ายที่พิมพ์ผิด - ต้องมีเหตุผล ช่วงวันที่เดียวกับตอนแนบ
  async updatePlateReceivedDate(id: string, dto: { date?: unknown; remark?: unknown }): Promise<{ plateCopy: PlateCopyRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้วันที่รับป้าย');
    const existing = await this.findReceivedForPlate(id);
    const date = requiredIsoDateField(dto?.date, 'วันที่รับป้าย');
    assertDateInRange('วันที่รับป้าย', date, existing.submitDate);
    const before = existing.plateReceivedDate;
    if (isoDate(before) === isoDate(date)) throw new BadRequestException({ error: 'วันที่ไม่ได้เปลี่ยน' });
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.plateCopy.updateMany({
        where: { id, cancelledAt: null, plateReceivedDate: before, platePhotoId: existing.platePhotoId },
        data: { plateReceivedDate: date },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, {
        entity: 'PlateCopy',
        entityId: id,
        action: 'update-plate-date',
        remark,
        changes: { plateReceivedDate: { from: before, to: date } },
      });
    });
    return this.reload(id);
  }

  // ถอดรูปป้ายที่แนบผิด - ต้องมีเหตุผล ล้างวันที่รับป้าย + รูป งานกลับเข้าคิวรอรับป้าย แล้วลบแถวรูป (ไม่มีใครอ้างอิงแล้ว)
  // ลบไฟล์หลัง transaction สำเร็จ
  async detachPlatePhoto(id: string, dto: { remark?: unknown }): Promise<{ plateCopy: PlateCopyRow }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ถอดรูปป้าย');
    const existing = await this.findReceivedForPlate(id);
    const photoId = existing.platePhotoId;
    const before = existing.plateReceivedDate;
    const removed = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.plateCopy.updateMany({
        where: { id, cancelledAt: null, plateReceivedDate: before, platePhotoId: photoId },
        data: { plateReceivedDate: null, platePhotoId: null },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, {
        entity: 'PlateCopy',
        entityId: id,
        action: 'detach-plate-photo',
        remark,
        changes: { plateReceivedDate: { from: before, to: null }, platePhotoId: { from: photoId, to: null } },
      });
      if (!photoId) return null;
      const stillUsed = (await tx.plateCopy.count({ where: { platePhotoId: photoId } })) + (await tx.vehicle.count({ where: { platePhotoId: photoId } }));
      if (stillUsed > 0) return null;
      return tx.platePhoto.delete({ where: { id: photoId }, select: { storageKey: true } });
    });
    if (removed) await this.storage.delete(removed.storageKey).catch(() => undefined);
    return this.reload(id);
  }

  // ดูรูปป้ายของงาน - เช็คสิทธิ์ผ่านแถว PlateCopy เอง (scope check ของ PlatePhotosService ผูกกับ Vehicle)
  async getPlatePhotoImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const row = await this.prisma.plateCopy.findFirst({
      where: { id, platePhotoId: { not: null } },
      select: { platePhoto: { select: { storageKey: true, mimeType: true } } },
    });
    if (!row?.platePhoto) throw new NotFoundException({ error: 'ไม่พบรูปป้ายทะเบียน' });
    this.assertCarReadable();
    try {
      return { data: await this.storage.get(row.platePhoto.storageKey), mimeType: row.platePhoto.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียนในที่เก็บ' });
    }
  }

  // รายการสำหรับหน้ารับป้าย - status: pending = ยังไม่รับป้าย | received = รับป้ายแล้ว | all (ไม่มี month เหมือนหน้ารับใบเสร็จ)
  // รอรับป้ายเรียงงานเก่าก่อน (ป้ายปกติออกภายใน 15 วัน - งานที่ค้างนานต้องอยู่บน)
  async listByPlateStatus(statusParam = 'all', classParam?: unknown): Promise<{ plateCopies: PlateCopyRow[] }> {
    parseVehicleClass(classParam);
    this.assertCarReadable();
    if (!['pending', 'received', 'all'].includes(statusParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ status ต้องเป็น pending, received หรือ all' });
    }
    const rows = await this.prisma.plateCopy.findMany({
      where: {
        vehicleClass: 'CAR',
        cancelledAt: null,
        ...(statusParam === 'pending' ? { plateReceivedDate: null } : statusParam === 'received' ? { plateReceivedDate: { not: null } } : {}),
      },
      orderBy: [{ submitDate: statusParam === 'pending' ? 'asc' : 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: plateCopyInclude,
    });
    return { plateCopies: rows.map(serializePlateCopy) };
  }
}
