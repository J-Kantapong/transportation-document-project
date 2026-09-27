import { BadRequestException, Injectable } from '@nestjs/common';
import { vehicleTypeWhere } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { vehicleListWhere } from '../vehicles/vehicle-list-filter.js';

export const RECEIVING_STEPS = ['plate', 'book', 'delivery'] as const;
export type ReceivingStep = (typeof RECEIVING_STEPS)[number];
type VehicleKindParam = 'car' | 'moto';

const DONE_DATE_FIELD = {
  plate: 'plateReceivedDate',
  book: 'bookReceivedDate',
  delivery: 'deliveredDate',
} as const;

// ตาราง "ดำเนินการแล้ว" แสดงทีละ 100 คัน (ผู้ใช้กด "โหลดเพิ่ม" ได้)
export const COMPLETED_PAGE_SIZE = 100;
// limit สูงสุด - หน้าเว็บโหลดรายการใหม่หลังแนบ/แก้ ด้วยจำนวนที่เปิดอยู่ (กด "โหลดเพิ่ม" ไว้แล้วไม่หดกลับเหลือ 100 - พบ 2026-09-27)
export const COMPLETED_MAX_LIMIT = 1000;

function parseStep(raw: string): ReceivingStep {
  if (!(RECEIVING_STEPS as readonly string[]).includes(raw)) {
    throw new BadRequestException({ error: 'step ต้องเป็น plate, book หรือ delivery' });
  }
  return raw as ReceivingStep;
}

// หน้ารับป้าย/รับเล่มแยกรถยนต์กับจักรยานยนต์ (/car, /moto) - กรองในฐานข้อมูลก่อนตัด 100 คัน
// (พบ 2026-09-27: เดิมตัด 100 คันรวมทั้งสองประเภทแล้วค่อยกรองในเบราว์เซอร์ รายการของอีกประเภทเบียดจนคันที่เพิ่งแนบหายไป)
function parseKind(raw: unknown): VehicleKindParam | undefined {
  const kind = typeof raw === 'string' ? raw.trim() : '';
  if (!kind) return undefined;
  if (kind !== 'car' && kind !== 'moto') throw new BadRequestException({ error: 'kind ต้องเป็น car หรือ moto' });
  return kind;
}

function parseOffset(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() || '0' : '0';
  if (!/^\d{1,6}$/.test(text)) throw new BadRequestException({ error: 'offset ต้องเป็นจำนวนเต็มตั้งแต่ 0' });
  return Number(text);
}

function parseLimit(raw: unknown): number {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return COMPLETED_PAGE_SIZE;
  const limit = /^\d{1,4}$/.test(text) ? Number(text) : 0;
  if (limit < 1 || limit > COMPLETED_MAX_LIMIT) throw new BadRequestException({ error: `limit ต้องเป็นจำนวนเต็ม 1-${COMPLETED_MAX_LIMIT}` });
  return limit;
}

const VEHICLE_INCLUDE = {
  // id = กุญแจใบยื่น (วันที่ยื่น + กลุ่ม + รหัสลูกค้า ทุกหน้าเหมือนกัน - ผู้ใช้ 2026-09-27) ชื่อซ้ำกันได้ จึงใช้ชื่อแค่แสดง
  // company/branch = แยกลูกค้าที่ชื่อซ้ำกันในการ์ดใบยื่น/ตัวกรองเจ้าของงาน
  customer: { select: { id: true, name: true, company: true, branch: true } },
  brand: { select: { name: true } },
  // แถวล่าสุดแถวเดียวพอ - ใช้เช็คว่าได้รับใบเสร็จแล้วหรือยัง (ขั้น plate/book ต้องมีใบเสร็จก่อน)
  // submitDate + urgent = ใบยื่นที่รถคันนี้อยู่ (หน้ารับป้าย/รับเล่มจัดกลุ่มตามใบยื่น ผู้ใช้ 2026-09-26)
  // receiptDate = วันที่ในใบเสร็จ - วันที่รับป้าย/เล่มต้องไม่ก่อนวันนี้ (หน้าเว็บตรวจก่อนอัปโหลด พบ 2026-09-27)
  documentSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { status: true, receiptNo: true, submitDate: true, receiptDate: true, urgent: true, createdAt: true },
  },
} as const;

// รับป้ายทะเบียน/รับเล่มทะเบียน เข้าคิวเมื่อได้รับใบเสร็จแล้ว (ยื่นเอกสารครั้งล่าสุด = RECEIPT_RECEIVED)
// ส่วน Delivery เข้าคิวเมื่อรับทั้งป้ายและเล่มแล้ว - ลำดับป้าย/เล่มไม่บังคับ ทำสลับกันได้
// บันทึกรับป้าย/เล่มทำที่ POST /api/plate-photos/attach, /api/book-photos/attach (ต้องมีรูปทุกคัน)
// ส่วน Delivery บันทึกที่ POST /api/delivery (ออกใบส่งงาน) - PATCH /api/vehicles/:id/receiving/:step เดิมถูกถอดออกแล้ว
// (พบ 2026-09-27: ยังบันทึกส่งงานได้โดยไม่มีใบส่งงาน หน้าเว็บเลิกเรียกไปนานแล้ว)
@Injectable()
export class ReceivingService {
  constructor(private readonly prisma: PrismaService) {}

  private pendingWhere(step: ReceivingStep) {
    if (step === 'delivery') {
      return { plateReceivedDate: { not: null }, bookReceivedDate: { not: null }, deliveredDate: null };
    }
    return { [DONE_DATE_FIELD[step]]: null, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } } };
  }

  // ขอบเขตประเภทรถของผู้ใช้ (STAFF_CAR / STAFF_MOTO เห็นเฉพาะประเภทของตัวเอง) + ประเภทของหน้า (?kind=)
  private scopeWhere(kind: VehicleKindParam | undefined): Prisma.VehicleWhereInput[] {
    return [vehicleTypeWhere(), ...(kind ? [vehicleTypeWhere(kind === 'moto' ? 'MOTO' : 'CAR')] : [])];
  }

  // ตาราง "ดำเนินการแล้ว" เรียงตามเวลาที่แนบรูป (ล่าสุดก่อน) ไม่ใช่วันที่รับที่พิมพ์ - แนบวันย้อนหลังแล้วยังเห็นอยู่บนสุด
  // (พบ 2026-09-27) รถที่รับก่อนมีรูป (ติ๊กเองก่อน 2026-09-21) ไม่มีรูป -> ไว้ท้ายสุด เรียงตามวันที่รับ
  private completedOrder(step: ReceivingStep): Prisma.VehicleOrderByWithRelationInput[] {
    if (step === 'plate') {
      return [{ platePhoto: { closedAt: { sort: 'desc', nulls: 'last' } } }, { plateReceivedDate: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }];
    }
    if (step === 'book') {
      return [{ bookPhoto: { closedAt: { sort: 'desc', nulls: 'last' } } }, { bookReceivedDate: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }];
    }
    return [{ deliveredDate: 'desc' }, { updatedAt: 'desc' }, { id: 'asc' }];
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
      platePhotoId: string | null;
      bookPhotoId: string | null;
      bookReceivedDate: Date | null;
      deliveredDate: Date | null;
      plateDeliveredDate: Date | null;
      deliveryRecipient: string | null;
      deliveryNote: string | null;
      customer: { id: string; name: string; company: string | null; branch: string | null };
      brand: { name: string };
      documentSubmissions: Array<{ receiptNo?: string | null; submitDate?: Date; receiptDate?: Date | null; urgent?: boolean; createdAt?: Date }>;
    },
  ) {
    const doneDate = vehicle[DONE_DATE_FIELD[step]];
    // วันที่ส่งของชิ้นนี้ให้ลูกค้าแล้ว (ป้าย = plateDeliveredDate, เล่ม = deliveredDate) - ส่งแล้วแก้วันที่รับ/ถอดรูปไม่ได้
    const itemDeliveredDate = step === 'plate' ? vehicle.plateDeliveredDate : step === 'book' ? vehicle.deliveredDate : null;
    return {
      id: vehicle.id,
      date: vehicle.date.toISOString().slice(0, 10),
      customerId: vehicle.customer.id, // กุญแจใบยื่น (ผู้ใช้ 2026-09-27) - ชื่อ/บริษัท/สาขาใช้แสดงเท่านั้น
      customerName: vehicle.customer.name,
      customerCompany: vehicle.customer.company,
      customerBranch: vehicle.customer.branch,
      chassis: vehicle.chassis,
      brandName: vehicle.brand.name,
      body: vehicle.body,
      plateCategory: vehicle.plateCategory,
      plateNumber: vehicle.plateNumber,
      receiptNo: vehicle.documentSubmissions[0]?.receiptNo ?? null, // เลขที่ใบเสร็จของการยื่นครั้งล่าสุด - เรียงไปห้องรับป้าย
      submitDate: vehicle.documentSubmissions[0]?.submitDate?.toISOString().slice(0, 10) ?? null, // วันที่ยื่นของใบยื่นล่าสุด
      receiptDate: vehicle.documentSubmissions[0]?.receiptDate?.toISOString().slice(0, 10) ?? null, // วันที่ในใบเสร็จ
      urgent: vehicle.documentSubmissions[0]?.urgent ?? false,
      // ลำดับที่บันทึกยื่น (= ลำดับในใบส่งงานที่ปริ้น) - หน้ารับป้าย/รับเล่มเรียงตามนี้เป็นค่าเริ่มต้น
      submittedAt: vehicle.documentSubmissions[0]?.createdAt?.toISOString() ?? null,
      platePhotoId: step === 'plate' ? vehicle.platePhotoId : null, // รูปป้ายที่ใช้ยืนยันการรับป้าย (หลักฐาน)
      bookPhotoId: step === 'book' ? vehicle.bookPhotoId : null, // รูปเล่มที่ใช้ยืนยันการรับเล่ม (หลักฐาน)
      doneDate: doneDate?.toISOString().slice(0, 10) ?? null,
      itemDeliveredDate: itemDeliveredDate?.toISOString().slice(0, 10) ?? null,
      // รับป้าย: ส่งเล่มให้ลูกค้าไปก่อนแล้ว - หน้ารับป้ายเตือนว่าถ้าป้ายไปพร้อมเล่ม (แนบรูปช้า) วันที่รับป้ายต้องไม่หลังวันนี้
      // ("ป้ายไปพร้อมเล่มแล้ว" ตั้งวันที่ส่งป้าย = วันที่ในใบส่งเล่ม - พบ 2026-09-27)
      bookDeliveredDate: step === 'plate' ? (vehicle.deliveredDate?.toISOString().slice(0, 10) ?? null) : null,
      recipient: step === 'delivery' ? vehicle.deliveryRecipient : null,
      note: step === 'delivery' ? vehicle.deliveryNote : null,
    };
  }

  async listPending(stepRaw: string, kindRaw?: unknown) {
    const step = parseStep(stepRaw);
    const kind = parseKind(kindRaw);
    const vehicles = await this.prisma.vehicle.findMany({
      where: { ...this.pendingWhere(step), deletedAt: null, AND: this.scopeWhere(kind) },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    // some(RECEIPT_RECEIVED) ยังนับรถที่เคยได้รับใบเสร็จแล้วยื่นใหม่ค้าง PENDING - กรองให้เหลือเฉพาะที่ล่าสุดรับแล้วจริง
    const eligible = step === 'delivery' ? vehicles : vehicles.filter((v) => v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED');
    return eligible.map((v) => this.mapRow(step, v));
  }

  // q = ค้นเลขตัวถัง / เลขเครื่อง / ทะเบียน / ชื่อลูกค้า (กฎเดียวกับหน้าค้นหารถ) หรือเลขที่ใบเสร็จ
  // limit (ไม่ส่ง = 100) = โหลดใหม่ด้วยจำนวนที่เปิดอยู่
  async listCompleted(stepRaw: string, query: { kind?: unknown; q?: unknown; offset?: unknown; limit?: unknown } = {}) {
    const step = parseStep(stepRaw);
    const kind = parseKind(query.kind);
    const offset = parseOffset(query.offset);
    const limit = parseLimit(query.limit);
    const q = typeof query.q === 'string' ? query.q.trim() : '';
    const search: Prisma.VehicleWhereInput[] = q
      ? [{ OR: [vehicleListWhere({ q }), { documentSubmissions: { some: { receiptNo: { contains: q, mode: 'insensitive' } } } }] }]
      : [];
    const vehicles = await this.prisma.vehicle.findMany({
      where: { [DONE_DATE_FIELD[step]]: { not: null }, deletedAt: null, AND: [...this.scopeWhere(kind), ...search] },
      orderBy: this.completedOrder(step),
      skip: offset,
      take: limit + 1, // เกินมา 1 คัน = ยังมีหน้าถัดไป
      include: VEHICLE_INCLUDE,
    });
    return { vehicles: vehicles.slice(0, limit).map((v) => this.mapRow(step, v)), hasMore: vehicles.length > limit };
  }
}
