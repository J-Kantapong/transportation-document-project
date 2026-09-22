import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

// ส่งงานลูกค้า (พนักงาน): ติ๊กคันที่ส่งแล้ว + วันที่ส่ง + ผู้รับ แล้วกดบันทึกครั้งเดียวทั้งชุด - พนักงานไม่เห็นราคา เรื่องบิลอยู่ที่ backend/src/billing
// กติกา (ผู้ใช้ 2026-09-21): ปกติส่งใบเสร็จ + เล่ม + ป้ายพร้อมกัน แต่บางคันป้ายยังไม่ออก -> ส่งใบเสร็จ + เล่มไปก่อนได้ แล้วป้ายตามทีหลัง
// ดังนั้นรถเข้าคิวส่งเมื่อ "ได้รับใบเสร็จแล้ว + รับเล่มแล้ว" (ไม่ต้องรอป้าย) และรถที่ส่งแล้วแต่ป้ายค้างจะกลับมาในคิวเป็นงานส่งป้ายอย่างเดียว
export type DeliveryKind =
  | 'FULL' // ส่งใบเสร็จ + เล่ม + ป้าย
  | 'NO_PLATE' // ส่งใบเสร็จ + เล่ม (ป้ายยังไม่ออก ส่งตามทีหลัง)
  | 'PLATE_ONLY' // ส่งเล่มไปแล้ว ป้ายเพิ่งมา -> ส่งป้ายอย่างเดียว
  | 'WAITING_PLATE'; // ส่งเล่มไปแล้ว ป้ายยังไม่ออก -> ยังติ๊กไม่ได้

const VEHICLE_INCLUDE = {
  customer: { select: { id: true, name: true, company: true } },
  brand: { select: { name: true } },
  documentSubmissions: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { status: true, receiptNo: true } },
  invoiceLines: { where: { invoice: { status: { not: 'VOID' } } }, select: { invoice: { select: { invoiceNo: true } } } },
} as const;

const bad = (error: string) => new BadRequestException({ error });

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad('วันที่ส่งต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง');
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

export function deliveryKind(v: { deliveredDate: Date | null; plateReceivedDate: Date | null }): DeliveryKind {
  if (v.deliveredDate) return v.plateReceivedDate ? 'PLATE_ONLY' : 'WAITING_PLATE';
  return v.plateReceivedDate ? 'FULL' : 'NO_PLATE';
}

@Injectable()
export class DeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  async queue() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        OR: [
          { deliveredDate: null, bookReceivedDate: { not: null }, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } } },
          { deliveredDate: { not: null }, plateDeliveredDate: null },
        ],
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    // some(RECEIPT_RECEIVED) ยังนับรถที่เคยได้ใบเสร็จแล้วยื่นใหม่ค้าง PENDING - เอาเฉพาะที่การยื่นล่าสุดได้ใบเสร็จจริง
    return vehicles.filter((v) => v.deliveredDate || v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED').map((v) => this.mapRow(v));
  }

  async recent() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deliveredDate: { not: null } },
      orderBy: [{ deliveredDate: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
      include: VEHICLE_INCLUDE,
    });
    return vehicles.map((v) => this.mapRow(v));
  }

  async submit(dto: { vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    const date = parseIsoDate(dto?.date);
    if (typeof dto.recipient !== 'string' || !dto.recipient.trim()) throw bad('ต้องใส่ชื่อผู้รับงาน');
    const recipient = dto.recipient.trim();
    if (dto.note !== undefined && dto.note !== null && typeof dto.note !== 'string') throw bad('หมายเหตุต้องเป็นข้อความ');
    const note = (dto.note as string | null | undefined)?.trim() || null;
    if (!Array.isArray(dto.vehicleIds) || dto.vehicleIds.length === 0 || dto.vehicleIds.some((id) => typeof id !== 'string')) {
      throw bad('ต้องติ๊กรถที่ส่งแล้วอย่างน้อย 1 คัน');
    }
    const ids = [...new Set(dto.vehicleIds as string[])];

    const vehicles = await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, include: VEHICLE_INCLUDE });
    if (vehicles.length !== ids.length) throw bad('ไม่พบข้อมูลรถบางคัน');

    const dateText = `${String(date.getUTCDate()).padStart(2, '0')}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${date.getUTCFullYear()}`;
    const updates = vehicles.map((v) => {
      const kind = deliveryKind(v);
      if (kind === 'WAITING_PLATE') throw bad(`รถ ${v.chassis} ส่งเล่มไปแล้ว และป้ายยังไม่ออก`);
      if (kind === 'PLATE_ONLY') {
        // ผู้รับ/หมายเหตุของการส่งเล่มเก็บไว้ตามเดิม - บันทึกการส่งป้ายต่อท้ายหมายเหตุ
        const plateNote = `ส่งป้าย ${dateText} ผู้รับ ${recipient}${note ? ` (${note})` : ''}`;
        return this.prisma.vehicle.update({
          where: { id: v.id },
          data: { plateDeliveredDate: date, deliveryNote: v.deliveryNote ? `${v.deliveryNote} · ${plateNote}` : plateNote },
        });
      }
      if (!v.bookReceivedDate || v.documentSubmissions[0]?.status !== 'RECEIPT_RECEIVED') {
        throw bad(`รถ ${v.chassis} ต้องได้รับใบเสร็จและเล่มทะเบียนก่อนจึงจะส่งงานได้`);
      }
      return this.prisma.vehicle.update({
        where: { id: v.id },
        data: { deliveredDate: date, deliveryRecipient: recipient, deliveryNote: note, plateDeliveredDate: kind === 'FULL' ? date : null },
      });
    });
    await this.prisma.$transaction(updates);

    const kinds = vehicles.map((v) => deliveryKind(v));
    return {
      delivered: kinds.filter((k) => k === 'FULL' || k === 'NO_PLATE').length,
      plateOnly: kinds.filter((k) => k === 'PLATE_ONLY').length,
      platePending: kinds.filter((k) => k === 'NO_PLATE').length,
    };
  }

  private mapRow(v: {
    id: string;
    chassis: string;
    body: string | null;
    plateCategory: string | null;
    plateNumber: string | null;
    plateReceivedDate: Date | null;
    deliveredDate: Date | null;
    plateDeliveredDate: Date | null;
    deliveryRecipient: string | null;
    deliveryNote: string | null;
    customer: { id: string; name: string; company: string | null };
    brand: { name: string };
    documentSubmissions: Array<{ receiptNo: string | null }>;
    invoiceLines: Array<{ invoice: { invoiceNo: string } }>;
  }) {
    return {
      id: v.id,
      customerId: v.customer.id,
      customerName: v.customer.company || v.customer.name,
      chassis: v.chassis,
      brandName: v.brand.name,
      body: v.body,
      plateCategory: v.plateCategory,
      plateNumber: v.plateNumber,
      receiptNo: v.documentSubmissions[0]?.receiptNo ?? null,
      kind: deliveryKind(v),
      plateReceived: v.plateReceivedDate !== null,
      deliveredDate: v.deliveredDate?.toISOString().slice(0, 10) ?? null,
      plateDeliveredDate: v.plateDeliveredDate?.toISOString().slice(0, 10) ?? null,
      recipient: v.deliveryRecipient,
      note: v.deliveryNote,
      invoiceNo: v.invoiceLines[0]?.invoice.invoiceNo ?? null,
    };
  }
}
