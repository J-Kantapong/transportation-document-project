import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { assertKindInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PlateSwapKind, PlateSwapNumberSource } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { calculatePlateSwapCarFees, type FeeItem } from './plate-swap-fee.js';

// การสลับเลข รถเก่า <-> รถใหม่ (รถยนต์) - ผู้ใช้ 2026-09-22
// ขั้นตอน: บันทึก/ยื่น (POST) -> ลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (ไม่บังคับ) -> รับเอกสารกลับ (วันที่ + รูปใบเสร็จอย่างน้อย 1 รูป)
// สิทธิ์: เป็นงานยื่นเอกสาร/รับใบเสร็จของรถยนต์ จึงใช้กลุ่ม STAFF_CAR (ขอบเขต 'car' ใน vehicle-scope) - ดู access-policy.ts

export interface PlateSwapReceipt {
  id: string;
  createdAt: string;
}

export interface PlateSwapNewVehicle {
  id: string;
  chassis: string;
  brandName: string;
  customerName: string;
  plateCategory: string | null;
  plateNumber: string | null;
}

export interface PlateSwapRow {
  id: string;
  kind: PlateSwapKind;
  oldOwnerName: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateNumber: string;
  newPlateNumber: string;
  newVehicle: PlateSwapNewVehicle | null;
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
  createdAt: string;
}

// Wire shape - ทุกช่องมาจาก JSON ที่ยังไม่ตรวจ จึงเป็น unknown ให้ service ตรวจเอง
export interface CreatePlateSwapDto {
  oldOwnerName?: unknown;
  oldChassis?: unknown;
  oldBrand?: unknown;
  oldPlateNumber?: unknown;
  newPlateNumber?: unknown;
  newVehicleId?: unknown;
  submitDate?: unknown;
  numberSource?: unknown;
  buyNormalPlate?: unknown;
  buyAuctionPlate?: unknown;
}

const isValidDateParam = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
const isValidMonthParam = (value: string) => /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));
const toUtcDate = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const isoDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function requiredText(value: unknown, label: string, max = 200): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new BadRequestException({ error: `กรุณากรอก${label}` });
  if (text.length > max) throw new BadRequestException({ error: `${label}ยาวเกิน ${max} ตัวอักษร` });
  return text;
}

const isNumberSource = (value: unknown): value is PlateSwapNumberSource =>
  value === PlateSwapNumberSource.NEW_UNUSED || value === PlateSwapNumberSource.AUCTION_RESERVED;

const newVehicleSelect = {
  id: true,
  chassis: true,
  plateCategory: true,
  plateNumber: true,
  brand: { select: { name: true } },
  customer: { select: { name: true } },
} as const;

const swapInclude = {
  newVehicle: { select: newVehicleSelect },
  receipts: { orderBy: { createdAt: 'asc' as const }, select: { id: true, createdAt: true } },
} satisfies Prisma.PlateSwapInclude;

interface NewVehicleRecord {
  id: string;
  chassis: string;
  plateCategory: string | null;
  plateNumber: string | null;
  brand: { name: string };
  customer: { name: string };
}

export interface SwapRecord {
  id: string;
  kind: PlateSwapKind;
  oldOwnerName: string;
  oldChassis: string;
  oldBrand: string;
  oldPlateNumber: string;
  newPlateNumber: string;
  submitDate: Date;
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
  billItems: unknown;
  noBillItems: unknown;
  billTotal: unknown;
  noBillTotal: unknown;
  returnedDate: Date | null;
  createdAt: Date;
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
});

export function serializePlateSwap(row: SwapRecord): PlateSwapRow {
  return {
    id: row.id,
    kind: row.kind,
    oldOwnerName: row.oldOwnerName,
    oldChassis: row.oldChassis,
    oldBrand: row.oldBrand,
    oldPlateNumber: row.oldPlateNumber,
    newPlateNumber: row.newPlateNumber,
    newVehicle: row.newVehicle ? toNewVehicle(row.newVehicle) : null,
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
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class PlateSwapService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // ตอนนี้รับเฉพาะรถยนต์ - STAFF_MOTO ที่ไม่ได้ถือ STAFF_CAR เข้าไม่ได้
  private assertCarScope() {
    assertKindInScope('car');
  }

  // ค้นรถใหม่ในฐานข้อมูลรถจดใหม่เพื่อลิงก์ (contains, ไม่สนตัวพิมพ์, สูงสุด 10 คัน) - เฉพาะรถยนต์
  async searchNewVehicles(raw: string): Promise<PlateSwapNewVehicle[]> {
    this.assertCarScope();
    const chassis = raw.trim();
    if (!chassis) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถัง' });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { chassis: { contains: chassis, mode: 'insensitive' }, ...vehicleTypeWhere('CAR') },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: newVehicleSelect,
    });
    return vehicles.map(toNewVehicle);
  }

  // ผู้ใช้ 2026-09-22: ต้องลิงก์รถใหม่ทุกงาน (บังคับตั้งแต่ตอนยื่น เปลี่ยนคันได้แต่ยกเลิกลิงก์ไม่ได้)
  private async resolveNewVehicleId(raw: unknown): Promise<string> {
    if (typeof raw !== 'string' || !raw.trim()) {
      throw new BadRequestException({ error: 'กรุณาลิงก์รถใหม่จากฐานข้อมูลรถจดใหม่ (ค้นด้วยเลขตัวถัง)' });
    }
    const vehicle = await this.prisma.vehicle.findFirst({ where: { id: raw, ...vehicleTypeWhere('CAR') }, select: { id: true } });
    if (!vehicle) throw new BadRequestException({ error: 'ไม่พบรถใหม่ที่ลิงก์ในฐานข้อมูลรถจดใหม่ (รถยนต์)' });
    return vehicle.id;
  }

  // ยี่ห้อรถเก่าเลือกจาก dropdown ยี่ห้อในฐานข้อมูล (ผู้ใช้ 2026-09-22) - เก็บเป็นชื่อตามที่อยู่ในตาราง Brand
  private async resolveBrandName(raw: unknown): Promise<string> {
    const name = requiredText(raw, 'ยี่ห้อ', 100);
    const brand = await this.prisma.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { name: true } });
    if (!brand) throw new BadRequestException({ error: 'กรุณาเลือกยี่ห้อจากรายการ' });
    return brand.name;
  }

  async create(dto: CreatePlateSwapDto): Promise<{ swap: PlateSwapRow }> {
    this.assertCarScope();
    const oldOwnerName = requiredText(dto?.oldOwnerName, 'ชื่อเจ้าของรถ');
    const oldChassis = requiredText(dto?.oldChassis, 'เลขตัวถัง/เลขเครื่อง', 100);
    const oldBrand = await this.resolveBrandName(dto?.oldBrand);
    const oldPlateNumber = requiredText(dto?.oldPlateNumber, 'เลขทะเบียนเก่า', 50);
    const newPlateNumber = requiredText(dto?.newPlateNumber, 'เลขทะเบียนใหม่', 50);
    const submitDateRaw = typeof dto?.submitDate === 'string' ? dto.submitDate.trim() : '';
    if (!isValidDateParam(submitDateRaw)) throw new BadRequestException({ error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (!isNumberSource(dto?.numberSource)) {
      throw new BadRequestException({ error: 'กรุณาเลือกที่มาของเลขทะเบียนใหม่ (เลขที่ไม่เคยออก / เลขประมูลหรือชุดสงวน)' });
    }
    const buyNormalPlate = dto.buyNormalPlate === true;
    const buyAuctionPlate = dto.buyAuctionPlate === true;
    if (buyAuctionPlate && dto.numberSource !== PlateSwapNumberSource.AUCTION_RESERVED) {
      throw new BadRequestException({ error: 'ค่าแผ่นป้ายประมูลมีเฉพาะเลขประมูลหรือชุดสงวน' });
    }
    const newVehicleId = await this.resolveNewVehicleId(dto.newVehicleId);
    const fees = calculatePlateSwapCarFees({ numberSource: dto.numberSource, buyNormalPlate, buyAuctionPlate });

    const swap = await this.prisma.plateSwap.create({
      data: {
        kind: PlateSwapKind.OLD_NEW,
        vehicleClass: 'CAR',
        oldOwnerName,
        oldChassis,
        oldBrand,
        oldPlateNumber,
        newPlateNumber,
        newVehicleId,
        submitDate: toUtcDate(submitDateRaw),
        numberSource: dto.numberSource,
        buyNormalPlate,
        buyAuctionPlate,
        billItems: JSON.parse(JSON.stringify(fees.billItems)),
        noBillItems: JSON.parse(JSON.stringify(fees.noBillItems)),
        billTotal: fees.billTotal,
        noBillTotal: fees.noBillTotal,
      },
      include: swapInclude,
    });
    return { swap: serializePlateSwap(swap) };
  }

  // status: pending = ยังไม่รับเอกสารกลับ | returned = รับกลับแล้ว | all - month (YYYY-MM) กรองตามวันที่ยื่น
  async list(statusParam = 'all', monthParam?: string): Promise<{ swaps: PlateSwapRow[] }> {
    this.assertCarScope();
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
        kind: PlateSwapKind.OLD_NEW,
        vehicleClass: 'CAR',
        ...(statusParam === 'pending' ? { returnedDate: null } : statusParam === 'returned' ? { returnedDate: { not: null } } : {}),
        ...(submitDate ? { submitDate } : {}),
      },
      orderBy: [{ submitDate: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: swapInclude,
    });
    return { swaps: rows.map(serializePlateSwap) };
  }

  private async findOrThrow(id: string): Promise<SwapRecord> {
    this.assertCarScope();
    const swap = await this.prisma.plateSwap.findUnique({ where: { id }, include: swapInclude });
    if (!swap) throw new NotFoundException({ error: 'ไม่พบงานสลับเลข' });
    return swap;
  }

  private async reload(id: string): Promise<{ swap: PlateSwapRow }> {
    const swap = await this.prisma.plateSwap.findUniqueOrThrow({ where: { id }, include: swapInclude });
    return { swap: serializePlateSwap(swap) };
  }

  // เปลี่ยน/ยกเลิกรถใหม่ที่ลิงก์ (ทำได้ตลอด - เป็นข้อมูลอ้างอิงว่าเลขไปอยู่คันไหน)
  async linkNewVehicle(id: string, newVehicleIdRaw: unknown): Promise<{ swap: PlateSwapRow }> {
    await this.findOrThrow(id);
    const newVehicleId = await this.resolveNewVehicleId(newVehicleIdRaw);
    await this.prisma.plateSwap.update({ where: { id }, data: { newVehicleId } });
    return this.reload(id);
  }

  // รับเอกสารกลับ - ต้องมีรูปใบเสร็จแนบอย่างน้อย 1 รูปก่อน (ผู้ใช้: "รับเอกสารกลับ ... พร้อมถ่ายใบเสร็จแนบ")
  async markReturned(id: string, returnedDateRaw: unknown): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    const dateRaw = typeof returnedDateRaw === 'string' ? returnedDateRaw.trim() : '';
    if (!isValidDateParam(dateRaw)) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับเอกสารกลับให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว' });
    if (toUtcDate(dateRaw) < existing.submitDate) throw new BadRequestException({ error: 'วันที่รับเอกสารกลับต้องไม่ก่อนวันที่ยื่น' });
    if (existing.receipts.length === 0) throw new BadRequestException({ error: 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ' });
    await this.prisma.plateSwap.update({ where: { id }, data: { returnedDate: toUtcDate(dateRaw) } });
    return this.reload(id);
  }

  // แนบรูปใบเสร็จ (ไม่ใช้ AI อ่าน - ใบเสร็จสลับเลขคนละแบบกับใบเสร็จจดทะเบียน) เก็บใน ReceiptImage เดิม ผ่าน plateSwapId
  // ตัวรูปโหลดผ่าน GET /api/receipts/:id/image เหมือนใบเสร็จอื่น
  async addReceipt(id: string, file: UploadedReceiptFile | undefined): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว แนบรูปเพิ่มไม่ได้' });
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปใบเสร็จ' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const now = new Date();
    const storageKey = `receipts/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.receiptImage.create({
        data: {
          plateSwapId: existing.id,
          storageKey,
          mimeType: type.mimeType,
          sizeBytes: file.size,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
        },
      });
    } catch (err) {
      // บันทึกลงฐานข้อมูลไม่สำเร็จ - ลบไฟล์ทิ้งไม่ให้ค้างโดยไม่มีแถวอ้างถึง
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
    return this.reload(id);
  }

  // ลบรูปได้เฉพาะก่อนยืนยันรับเอกสารกลับ - หลังจากนั้นรูปเป็นหลักฐาน
  async removeReceipt(id: string, receiptId: string): Promise<{ swap: PlateSwapRow }> {
    const existing = await this.findOrThrow(id);
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว ลบรูปใบเสร็จไม่ได้' });
    const receipt = await this.prisma.receiptImage.findFirst({ where: { id: receiptId, plateSwapId: id }, select: { id: true, storageKey: true } });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    await this.prisma.receiptImage.delete({ where: { id: receipt.id } });
    await this.storage.delete(receipt.storageKey).catch(() => undefined);
    return this.reload(id);
  }

  // ลบงานที่บันทึกผิด - เฉพาะที่ยังไม่รับเอกสารกลับ (รูปที่แนบไว้ถูกลบตาม)
  async remove(id: string): Promise<{ id: string }> {
    const existing = await this.findOrThrow(id);
    if (existing.returnedDate) throw new BadRequestException({ error: 'งานนี้รับเอกสารกลับแล้ว ลบไม่ได้' });
    const receipts = await this.prisma.receiptImage.findMany({ where: { plateSwapId: id }, select: { storageKey: true } });
    await this.prisma.plateSwap.delete({ where: { id } }); // แถว ReceiptImage ลบตาม (onDelete: Cascade)
    await Promise.all(receipts.map((r) => this.storage.delete(r.storageKey).catch(() => undefined)));
    return { id };
  }
}
