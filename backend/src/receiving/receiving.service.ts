import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

export const RECEIVING_STEPS = ['plate', 'book', 'delivery'] as const;
export type ReceivingStep = (typeof RECEIVING_STEPS)[number];

const DONE_DATE_FIELD = {
  plate: 'plateReceivedDate',
  book: 'bookReceivedDate',
  delivery: 'deliveredDate',
} as const;

function parseStep(raw: string): ReceivingStep {
  if (!(RECEIVING_STEPS as readonly string[]).includes(raw)) {
    throw new BadRequestException({ error: 'step ต้องเป็น plate, book หรือ delivery' });
  }
  return raw as ReceivingStep;
}

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

function optionalText(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw new BadRequestException({ error: 'ข้อมูลต้องเป็นข้อความ' });
  return raw.trim() || null;
}

const VEHICLE_INCLUDE = {
  customer: { select: { name: true } },
  brand: { select: { name: true } },
  // แถวล่าสุดแถวเดียวพอ - ใช้เช็คว่าได้รับใบเสร็จแล้วหรือยัง (ขั้น plate/book ต้องมีใบเสร็จก่อน)
  documentSubmissions: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { status: true } },
} as const;

// รับป้ายทะเบียน/รับเล่มทะเบียน เข้าคิวเมื่อได้รับใบเสร็จแล้ว (ยื่นเอกสารครั้งล่าสุด = RECEIPT_RECEIVED)
// ส่วน Delivery เข้าคิวเมื่อรับทั้งป้ายและเล่มแล้ว - ลำดับป้าย/เล่มไม่บังคับ ทำสลับกันได้
@Injectable()
export class ReceivingService {
  constructor(private readonly prisma: PrismaService) {}

  private pendingWhere(step: ReceivingStep) {
    if (step === 'delivery') {
      return { plateReceivedDate: { not: null }, bookReceivedDate: { not: null }, deliveredDate: null };
    }
    return { [DONE_DATE_FIELD[step]]: null, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } } };
  }

  private mapRow(
    step: ReceivingStep,
    vehicle: {
      id: string;
      date: Date;
      chassis: string;
      body: string | null;
      plateCategory: string | null;
      plateNumber: string | null;
      plateReceivedDate: Date | null;
      bookReceivedDate: Date | null;
      deliveredDate: Date | null;
      deliveryRecipient: string | null;
      deliveryNote: string | null;
      customer: { name: string };
      brand: { name: string };
    },
  ) {
    const doneDate = vehicle[DONE_DATE_FIELD[step]];
    return {
      id: vehicle.id,
      date: vehicle.date.toISOString().slice(0, 10),
      customerName: vehicle.customer.name,
      chassis: vehicle.chassis,
      brandName: vehicle.brand.name,
      body: vehicle.body,
      plateCategory: vehicle.plateCategory,
      plateNumber: vehicle.plateNumber,
      doneDate: doneDate?.toISOString().slice(0, 10) ?? null,
      recipient: step === 'delivery' ? vehicle.deliveryRecipient : null,
      note: step === 'delivery' ? vehicle.deliveryNote : null,
    };
  }

  async listPending(stepRaw: string) {
    const step = parseStep(stepRaw);
    const vehicles = await this.prisma.vehicle.findMany({
      where: this.pendingWhere(step),
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    // some(RECEIPT_RECEIVED) ยังนับรถที่เคยได้รับใบเสร็จแล้วยื่นใหม่ค้าง PENDING - กรองให้เหลือเฉพาะที่ล่าสุดรับแล้วจริง
    const eligible = step === 'delivery' ? vehicles : vehicles.filter((v) => v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED');
    return eligible.map((v) => this.mapRow(step, v));
  }

  async listCompleted(stepRaw: string) {
    const step = parseStep(stepRaw);
    const field = DONE_DATE_FIELD[step];
    const vehicles = await this.prisma.vehicle.findMany({
      where: { [field]: { not: null } },
      orderBy: [{ [field]: 'desc' }, { updatedAt: 'desc' }],
      take: 100,
      include: VEHICLE_INCLUDE,
    });
    return vehicles.map((v) => this.mapRow(step, v));
  }

  async markDone(id: string, stepRaw: string, dto: { date?: unknown; recipient?: unknown; note?: unknown }) {
    const step = parseStep(stepRaw);
    const date = parseIsoDate(dto?.date);
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id }, include: VEHICLE_INCLUDE });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    if (step === 'delivery') {
      if (!vehicle.plateReceivedDate || !vehicle.bookReceivedDate) {
        throw new BadRequestException({ error: 'ต้องรับป้ายทะเบียนและเล่มทะเบียนให้ครบก่อนจึงจะ Delivery ได้' });
      }
    } else if (vehicle.documentSubmissions[0]?.status !== 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'ต้องได้รับใบเสร็จก่อนจึงจะรับป้าย/เล่มทะเบียนได้' });
    }

    const data =
      step === 'delivery'
        ? { deliveredDate: date, deliveryRecipient: optionalText(dto.recipient), deliveryNote: optionalText(dto.note) }
        : { [DONE_DATE_FIELD[step]]: date };
    const updated = await this.prisma.vehicle.update({ where: { id }, data, include: VEHICLE_INCLUDE });
    return this.mapRow(step, updated);
  }
}
