import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import {
  assertVehicleInScope,
  currentDeliveryScope,
  currentVehicleScope,
  currentWriteScope,
  isVehicleInScope,
  vehicleTypeWhere,
} from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ส่งงานลูกค้า (พนักงาน): ติ๊กคันที่ส่งแล้ว + วันที่ส่ง + ผู้รับ แล้วกดบันทึกครั้งเดียวทั้งชุด - พนักงานไม่เห็นราคา เรื่องบิลอยู่ที่ backend/src/billing
// กติกา (ผู้ใช้ 2026-09-21): ปกติส่งเล่ม + ป้ายพร้อมกัน แต่บางคันป้ายยังไม่ออก -> ส่งเล่มไปก่อนได้ แล้วป้ายตามทีหลัง
// ดังนั้นรถเข้าคิวส่งเมื่อ "ได้รับใบเสร็จแล้ว + รับเล่มแล้ว" (ไม่ต้องรอป้าย) และรถที่ส่งแล้วแต่ป้ายค้างจะกลับมาในคิวเป็นงานส่งป้ายอย่างเดียว
// ใบเสร็จไม่ได้ไปกับงานแล้ว ไปพร้อมใบวางบิล (ผู้ใช้ 2026-09-26) - ต้องได้ใบเสร็จกลับมาก่อนจึงเข้าคิวเหมือนเดิม
export type DeliveryKind =
  | 'FULL' // ส่งเล่ม + ป้าย
  | 'NO_PLATE' // ส่งเล่ม (ป้ายยังไม่ออก ส่งตามทีหลัง)
  | 'PLATE_ONLY' // ส่งเล่มไปแล้ว ป้ายเพิ่งมา -> ส่งป้ายอย่างเดียว
  | 'WAITING_PLATE' // ส่งเล่มไปแล้ว ป้ายยังไม่ออก -> ยังติ๊กไม่ได้
  | 'DONE'; // ส่งเล่มและป้ายครบแล้ว - บันทึกส่งซ้ำไม่ได้ (พบ 2026-09-27: หน้าที่เปิดค้างไว้บันทึกซ้ำแล้วได้ใบส่งป้ายซ้อน)

// ชนิดงานที่หน้า Delivery ส่งมาได้ (คันที่ติ๊กได้)
const DELIVERABLE_KINDS: DeliveryKind[] = ['FULL', 'NO_PLATE', 'PLATE_ONLY'];
const SLIP_LIMIT = 500; // รายงานส่งงานแสดงได้ครั้งละกี่ใบ (ใบล่าสุดก่อน)

const NOT_VOID = { invoice: { status: { not: 'VOID' } } };
// เงื่อนไขของ updateMany: รถยังไม่อยู่ในบิลที่ใช้อยู่ - กันแก้/ยกเลิกใบส่งเล่มพร้อมกับที่บัญชีออกบิล (พบ 2026-09-27)
const NOT_BILLED = { invoiceLines: { none: NOT_VOID } };

type Tx = Prisma.TransactionClient;

const VEHICLE_INCLUDE = {
  customer: { select: { id: true, name: true, company: true } },
  brand: { select: { name: true } },
  // submitDate + urgent + createdAt = ใบยื่น (lot) ที่รถคันนี้อยู่ - หน้า Delivery จัดการ์ดตามใบยื่นแบบหน้ารับป้าย (ผู้ใช้ 2026-09-26)
  documentSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { status: true, receiptNo: true, submitDate: true, urgent: true, createdAt: true },
  },
  invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } },
  // ใบส่งเล่มที่ยังไม่ยกเลิก - รายงานส่งงานใช้กับปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ของรถที่ป้ายค้างส่ง (ผู้ใช้ 2026-09-27)
  deliverySlipItems: {
    where: { book: true, cancelledAt: null },
    orderBy: { slip: { slipNo: 'desc' as const } },
    take: 1,
    select: { slip: { select: { id: true, slipNo: true, date: true } } },
  },
} as const;

const USER_NAME = { select: { name: true, displayName: true } } as const;

const SLIP_INCLUDE = {
  customer: { select: { id: true, name: true, company: true, branch: true, address: true, phone: true } },
  createdBy: USER_NAME,
  cancelledBy: USER_NAME,
  items: {
    include: {
      cancelledBy: USER_NAME,
      // วางบิลแล้ว = ห้ามยกเลิก / เปลี่ยนวันที่ส่ง (บิลเก็บวันที่ส่งไว้แล้ว)
      vehicle: {
        select: {
          invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } },
          // ชื่อเจ้าของบนใบส่งงาน (ผู้ใช้ 2026-09-26) - อ่านสดจาก VehicleOwner
          owner: { select: { name: true, hirerName: true } },
        },
      },
    },
  },
} as const;

// ชื่อเจ้าของบนใบส่งงาน: ติดไฟแนนซ์ = ชื่อผู้ครอบครอง (ไม่ใส่ชื่อไฟแนนซ์ - ผู้ใช้ 2026-09-26) ไม่ติด = ผู้ถือกรรมสิทธิ์
const ownerNameOf = (o: { name: string | null; hirerName: string | null } | null) => o?.hirerName || o?.name || null;

const userName = (u: { name: string; displayName: string | null } | null) => (u ? u.displayName || u.name : null);

const bad = (error: string) => new BadRequestException({ error });
const conflict = (error: string) => new ConflictException({ error });
const slipNoLabel = (slipNo: number) => `DL-${String(slipNo).padStart(5, '0')}`;

const plateTextOf = (v: { plateCategory: string | null; plateNumber: string | null }) =>
  v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : '';

function parseOptionalIsoDate(raw: unknown, label: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

const dmy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

function parseRemark(raw: unknown): string {
  const remark = typeof raw === 'string' ? raw.trim() : '';
  if (!remark) throw bad('ต้องใส่เหตุผล');
  return remark;
}

// หมายเหตุของการส่งป้ายตามทีหลังถูกต่อท้าย deliveryNote เป็น "... · ส่งป้าย วว/ดด/ปปปป ผู้รับ ..." - ยกเลิกใบส่งป้ายแล้วตัดส่วนนั้นออก
export function stripPlateNote(note: string | null): string | null {
  if (!note) return null;
  const kept = note.split(' · ').filter((part) => !part.startsWith('ส่งป้าย '));
  return kept.length ? kept.join(' · ') : null;
}

const plateNoteOf = (date: Date, recipient: string, note: string | null) =>
  `ส่งป้าย ${dmy(date)} ผู้รับ ${recipient}${note ? ` (${note})` : ''}`;

// คันที่ติ๊ก + ชนิดงานที่ผู้ใช้เห็นในป๊อปอัปยืนยัน (items) - vehicleIds อย่างเดียว = แบบเดิม ไม่ตรวจชนิดงาน
// หน้าเว็บส่งทั้งสองแบบคู่กัน backend รุ่นก่อนหน้าจึงยังรับได้ระหว่างอัปเดต
function parseDeliveryItems(dto: { items?: unknown; vehicleIds?: unknown }): Map<string, DeliveryKind | null> {
  const expected = new Map<string, DeliveryKind | null>();
  if (Array.isArray(dto.items)) {
    for (const raw of dto.items as Array<{ vehicleId?: unknown; kind?: unknown } | null>) {
      if (!raw || typeof raw.vehicleId !== 'string' || !DELIVERABLE_KINDS.includes(raw.kind as DeliveryKind)) {
        throw bad('รายการรถที่ส่งไม่ถูกต้อง');
      }
      expected.set(raw.vehicleId, raw.kind as DeliveryKind);
    }
  } else if (Array.isArray(dto.vehicleIds) && dto.vehicleIds.every((id) => typeof id === 'string')) {
    for (const id of dto.vehicleIds as string[]) expected.set(id, null);
  }
  if (expected.size === 0) throw bad('ต้องติ๊กรถที่ส่งแล้วอย่างน้อย 1 คัน');
  return expected;
}

// ทำไมชนิดงานตอนบันทึกไม่ตรงกับที่ผู้ใช้เห็น (ข้อความสั้นใน error 409)
function kindChangeText(expected: DeliveryKind | null, now: DeliveryKind): string {
  if (now === 'DONE') return 'ส่งครบแล้ว';
  if ((expected === 'FULL' || expected === 'NO_PLATE') && (now === 'PLATE_ONLY' || now === 'WAITING_PLATE')) return 'ส่งเล่มไปแล้ว';
  if (expected === 'NO_PLATE' && now === 'FULL') return 'เพิ่งรับป้ายเข้ามา';
  return 'สถานะการส่งเปลี่ยนไป';
}

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad('วันที่ส่งต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง');
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

export function deliveryKind(v: { deliveredDate: Date | null; plateReceivedDate: Date | null; plateDeliveredDate: Date | null }): DeliveryKind {
  if (v.deliveredDate && v.plateDeliveredDate) return 'DONE';
  if (v.deliveredDate) return v.plateReceivedDate ? 'PLATE_ONLY' : 'WAITING_PLATE';
  return v.plateReceivedDate ? 'FULL' : 'NO_PLATE';
}

@Injectable()
export class DeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  // คิวงานส่ง: ขอบเขตเดียวกับที่บันทึกส่งได้ (DELIVERY ทุกคัน, STAFF_CAR / STAFF_MOTO เฉพาะประเภทรถของตัวเอง
  // แม้ถือ ACCOUNTANT ด้วย - ไม่โชว์คันที่ติ๊กแล้วบันทึกไม่ได้)
  async queue() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        OR: [
          { deliveredDate: null, bookReceivedDate: { not: null }, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } } },
          { deliveredDate: { not: null }, plateDeliveredDate: null },
        ],
        deletedAt: null,
        ...vehicleTypeWhere(currentDeliveryScope()),
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    // some(RECEIPT_RECEIVED) ยังนับรถที่เคยได้ใบเสร็จแล้วยื่นใหม่ค้าง PENDING - เอาเฉพาะที่การยื่นล่าสุดได้ใบเสร็จจริง
    return vehicles.filter((v) => v.deliveredDate || v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED').map((v) => this.mapRow(v));
  }

  // รถคันอื่นในใบยื่น (lot) เดียวกับคันที่อยู่ในคิว: ยังไม่พร้อมส่ง (รอใบเสร็จ/รอเล่ม) หรือส่งครบแล้ว
  // งานเสร็จเป็น lot แต่บางทีเสร็จไม่หมด (ผู้ใช้ 2026-09-26) - หน้า Delivery แสดงทั้ง lot ให้เห็นว่าเหลือคันไหน ติ๊กได้เฉพาะคันในคิว
  async lotVehicles(rows: Array<{ id: string; customerId: string; submitDate: string | null }>) {
    const dates = [...new Set(rows.map((r) => r.submitDate).filter((d): d is string => !!d))];
    if (dates.length === 0) return [];
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        id: { notIn: rows.map((r) => r.id) },
        customerId: { in: [...new Set(rows.map((r) => r.customerId))] },
        deletedAt: null,
        documentSubmissions: { some: { submitDate: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) } } },
        ...vehicleTypeWhere(currentDeliveryScope()),
      },
      include: VEHICLE_INCLUDE,
    });
    const lotKeys = new Set(rows.map((r) => `${r.submitDate}|${r.customerId}`));
    // ใบยื่นล่าสุดของคันนั้นต้องอยู่ใน lot เดียวกัน (ยื่นใหม่ไปใบอื่นแล้ว = ไม่นับ) และไม่ใช่ยื่นไม่สำเร็จ
    return vehicles
      .map((v) => this.mapRow(v))
      .filter((r) => r.submissionStatus !== 'FAILED' && lotKeys.has(`${r.submitDate}|${r.customerId}`));
  }

  async recent() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deliveredDate: { not: null }, deletedAt: null, ...vehicleTypeWhere(currentDeliveryScope()) },
      orderBy: [{ deliveredDate: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
      include: VEHICLE_INCLUDE,
    });
    return vehicles.map((v) => this.mapRow(v));
  }

  // รายงานส่งงาน: รถที่ส่งเล่มแล้วแต่ป้ายยังค้างส่ง - ขอบเขตการอ่านเดียวกับ slips() ไม่ใช่ขอบเขตการส่งของ queue()
  // (พบ 2026-09-27: STAFF_CAR + ACCOUNTANT เห็นใบส่งงานจักรยานยนต์ แต่จักรยานยนต์หายจากรายการป้ายค้างส่งของรายงานเดียวกัน)
  async platePending() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deliveredDate: { not: null }, plateDeliveredDate: null, deletedAt: null, ...vehicleTypeWhere(currentVehicleScope()) },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    return vehicles.map((v) => this.mapRow(v));
  }

  // items = [{ vehicleId, kind }] ชนิดงานที่ผู้ใช้เห็นในป๊อปอัปยืนยัน (vehicleIds อย่างเดียว = แบบเดิม)
  async submit(dto: { items?: unknown; vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    const date = parseIsoDate(dto?.date);
    if (typeof dto.recipient !== 'string' || !dto.recipient.trim()) throw bad('ต้องใส่ชื่อผู้รับงาน');
    const recipient = dto.recipient.trim();
    if (dto.note !== undefined && dto.note !== null && typeof dto.note !== 'string') throw bad('หมายเหตุต้องเป็นข้อความ');
    const note = (dto.note as string | null | undefined)?.trim() || null;
    const expected = parseDeliveryItems(dto);
    const ids = [...expected.keys()];

    const vehicles = await this.prisma.vehicle.findMany({ where: { id: { in: ids }, deletedAt: null }, include: VEHICLE_INCLUDE });
    // ข้อความไม่บอกให้โหลดหน้าใหม่ - หน้า Delivery โหลดรายการให้เองโดยเก็บคันที่ติ๊ก/ผู้รับ/หมายเหตุไว้ กด F5 แล้วหาย (พบ 2026-09-27)
    if (vehicles.length !== ids.length) throw bad('ไม่พบข้อมูลรถบางคัน กรุณาตรวจรายการแล้วบันทึกใหม่');
    const scope = currentDeliveryScope(); // DELIVERY ส่งได้ทุกคัน, STAFF_CAR / STAFF_MOTO เฉพาะประเภทรถของตัวเอง
    for (const v of vehicles) assertVehicleInScope(v.body, scope);
    // บันทึก 1 ครั้ง = ใบส่งงาน 1 ใบของลูกค้ารายเดียว (ผู้รับคนเดียว)
    if (new Set(vehicles.map((v) => v.customer.id)).size > 1) throw bad('ส่งงานได้ครั้งละ 1 ลูกค้า');

    // สถานะรถตอนนี้ต้องตรงกับที่ผู้ใช้ยืนยันในป๊อปอัป ไม่ตรงคันเดียว = ไม่บันทึกทั้งชุด (พบ 2026-09-27: หน้าเปิดค้างไว้
    // แล้วระบบคิดใหม่เงียบๆ - ป้ายเพิ่งแนบ "เล่ม (ป้ายตามทีหลัง)" กลายเป็นส่งป้ายด้วย, คันที่ส่งครบแล้วได้ใบส่งป้ายซ้ำ)
    const kinds = new Map(vehicles.map((v) => [v.id, deliveryKind(v)]));
    const changed = vehicles.filter((v) => {
      const now = kinds.get(v.id)!;
      const want = expected.get(v.id) ?? null;
      return now === 'DONE' || (want !== null && want !== now);
    });
    if (changed.length) {
      const list = changed.map((v) => `รถ ${v.chassis} ${kindChangeText(expected.get(v.id) ?? null, kinds.get(v.id)!)}`).join(', ');
      throw conflict(`${list} (ข้อมูลเปลี่ยนไปจากตอนที่เปิดหน้า) กรุณาตรวจรายการแล้วบันทึกใหม่`);
    }
    for (const v of vehicles) {
      const kind = kinds.get(v.id)!;
      if (kind === 'WAITING_PLATE') throw bad(`รถ ${v.chassis} ส่งเล่มไปแล้ว และป้ายยังไม่ออก`);
      if (kind === 'PLATE_ONLY') {
        // กติกาเดียวกับตอนแก้ใบ (พบ 2026-09-27: บันทึกได้ แต่เปิดแก้ใบเดิมทีหลังไม่ผ่าน)
        if (v.deliveredDate && date < v.deliveredDate) {
          throw bad(`รถ ${v.chassis} ส่งเล่มเมื่อ ${dmy(v.deliveredDate)} วันที่ส่งป้ายต้องไม่ก่อนวันนั้น`);
        }
      } else if (!v.bookReceivedDate || v.documentSubmissions[0]?.status !== 'RECEIPT_RECEIVED') {
        throw bad(`รถ ${v.chassis} ต้องได้รับใบเสร็จและเล่มทะเบียนก่อนจึงจะส่งงานได้`);
      }
    }
    const ofKind = (kind: DeliveryKind) => vehicles.filter((v) => kinds.get(v.id) === kind);

    // เขียนแบบมีเงื่อนไขใน transaction เดียวกับการสร้างใบ: 2 คำขอพร้อมกันผ่านการตรวจด้านบนได้ทั้งคู่ แต่แถวรถถูกเปลี่ยนได้ครั้งเดียว
    // คำขอหลังนับได้ไม่ครบ -> throw -> ย้อนทั้งชุด ไม่มีใบส่งงานซ้ำ (พบ 2026-09-27) - timeout เผื่อชุดส่งป้ายหลายคัน (เขียนทีละคัน)
    const created = await this.prisma.$transaction(
      async (tx) => {
        for (const kind of ['FULL', 'NO_PLATE'] as const) {
          const ids = ofKind(kind).map((v) => v.id);
          if (ids.length === 0) continue;
          const { count } = await tx.vehicle.updateMany({
            where: { id: { in: ids }, deletedAt: null, deliveredDate: null },
            data: { deliveredDate: date, deliveryRecipient: recipient, deliveryNote: note, plateDeliveredDate: kind === 'FULL' ? date : null },
          });
          if (count !== ids.length) throw conflict('มีการบันทึกส่งรถบางคันในชุดนี้ไปก่อนแล้ว กรุณาตรวจรายการแล้วบันทึกใหม่');
        }
        for (const v of ofKind('PLATE_ONLY')) {
          // ผู้รับ/หมายเหตุของการส่งเล่มเก็บไว้ตามเดิม - บันทึกการส่งป้ายต่อท้ายหมายเหตุ
          const plateNote = plateNoteOf(date, recipient, note);
          const { count } = await tx.vehicle.updateMany({
            where: { id: v.id, deletedAt: null, deliveredDate: { not: null }, plateReceivedDate: { not: null }, plateDeliveredDate: null },
            data: { plateDeliveredDate: date, deliveryNote: v.deliveryNote ? `${v.deliveryNote} · ${plateNote}` : plateNote },
          });
          if (count !== 1) throw conflict(`รถ ${v.chassis} บันทึกส่งป้ายไปแล้ว กรุณาตรวจรายการแล้วบันทึกใหม่`);
        }
        // ใบส่งงาน: บอกแยกรายคันว่ารอบนี้ส่งอะไร (ผู้ใช้ 2026-09-25)
        return tx.deliverySlip.create({
          data: {
            customerId: vehicles[0].customer.id,
            date,
            recipient,
            note,
            createdById: currentUser()?.id ?? null,
            items: {
              create: vehicles.map((v) => {
                const kind = kinds.get(v.id);
                return {
                  vehicleId: v.id,
                  // ใบเสร็จส่งไปพร้อมใบวางบิล ไม่ได้ไปกับใบส่งงาน (ผู้ใช้ 2026-09-26) - ใบเก่าก่อนนี้ยังเป็น true
                  receipt: false,
                  book: kind !== 'PLATE_ONLY',
                  plate: kind !== 'NO_PLATE',
                  chassis: v.chassis,
                  brandName: v.brand.name,
                  body: v.body,
                  plateText: plateTextOf(v),
                  receiptNo: v.documentSubmissions[0]?.receiptNo ?? null,
                };
              }),
            },
          },
          select: { id: true, slipNo: true },
        });
      },
      { timeout: 30_000 },
    );

    return {
      slipId: created.id,
      slipNo: created.slipNo,
      delivered: ofKind('FULL').length + ofKind('NO_PLATE').length,
      plateOnly: ofKind('PLATE_ONLY').length,
      platePending: ofKind('NO_PLATE').length,
    };
  }

  // รายงานส่งงานย้อนหลัง: ใบส่งงานตามช่วงวันที่ส่ง (และลูกค้า) - STAFF_CAR / STAFF_MOTO เห็นเฉพาะคันในขอบเขตของตัวเอง
  // ครั้งละไม่เกิน SLIP_LIMIT ใบ (ใบล่าสุดก่อน) - เกินแล้ว truncated = true ให้หน้าเว็บเตือน (พบ 2026-09-27: เดิมตัดเงียบๆ)
  async slips(query: { from?: unknown; to?: unknown; customerId?: unknown }) {
    const from = parseOptionalIsoDate(query?.from, 'วันที่เริ่ม');
    const to = parseOptionalIsoDate(query?.to, 'วันที่สิ้นสุด');
    if (from && to && from > to) throw bad('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
    const customerId = typeof query?.customerId === 'string' && query.customerId ? query.customerId : undefined;
    const scope = currentVehicleScope();
    const found = await this.prisma.deliverySlip.findMany({
      where: {
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(customerId ? { customerId } : {}),
        // นับเพดานเฉพาะใบที่มีรถในขอบเขต - ใบของรถอีกประเภทไม่กินโควตาจนใบของตัวเองหาย (DeliverySlipItem มี body/id เหมือน Vehicle)
        ...(scope === 'ALL' ? {} : { items: { some: vehicleTypeWhere(scope) } }),
      },
      orderBy: [{ date: 'desc' }, { slipNo: 'desc' }],
      take: SLIP_LIMIT + 1,
      include: SLIP_INCLUDE,
    });
    const slips = found.slice(0, SLIP_LIMIT);
    const later = await this.platesSentLater(slips);
    return {
      slips: slips.map((s) => this.mapSlip(s, later)).filter((s) => s.items.length > 0),
      truncated: found.length > SLIP_LIMIT,
    };
  }

  async slip(id: string) {
    const found = await this.prisma.deliverySlip.findUnique({ where: { id }, include: SLIP_INCLUDE });
    const slip = found && this.mapSlip(found, await this.platesSentLater([found]));
    if (!slip || slip.items.length === 0) throw new NotFoundException({ error: 'ไม่พบใบส่งงาน' });
    return slip;
  }

  // ใบส่งเล่มที่ป้ายส่งตามไปทีหลังในใบอื่น: เลขที่/วันที่ของใบส่งป้าย (อ่านสดทุกครั้ง) ให้รายงานบอกว่าทำไมช่องป้ายของใบนี้ว่าง
  // (ผู้ใช้ 2026-09-27) - ใบส่งงานเองยังเป็น snapshot ตอนส่งเหมือนเดิม
  private async platesSentLater(slips: Array<{ items: Array<{ vehicleId: string; book: boolean; plate: boolean; cancelledAt: Date | null }> }>) {
    const vehicleIds = [...new Set(slips.flatMap((s) => s.items.filter((i) => i.book && !i.plate && !i.cancelledAt).map((i) => i.vehicleId)))];
    const later = new Map<string, { slipNo: number; date: string }>();
    if (vehicleIds.length === 0) return later;
    const items = await this.prisma.deliverySlipItem.findMany({
      where: { vehicleId: { in: vehicleIds }, book: false, plate: true, cancelledAt: null },
      select: { vehicleId: true, slip: { select: { slipNo: true, date: true } } },
    });
    for (const i of items) later.set(i.vehicleId, { slipNo: i.slip.slipNo, date: isoDay(i.slip.date) ?? '' });
    return later;
  }

  // ป้ายไปพร้อมเล่มแล้ว (ผู้ใช้ 2026-09-27): ใบส่งเล่มที่บันทึกไว้ว่าป้ายตามทีหลัง แต่จริงๆ ป้ายไปพร้อมเล่มแล้ว (แนบรูปป้ายช้า)
  // -> ติ๊กป้ายในใบเดิม + วันที่ส่งป้าย = วันที่ในใบ + บันทึกประวัติ - สิทธิ์เดียวกับแก้/ยกเลิกใบ
  // ทำกับคันที่วางบิลแล้วได้ (บิลเก็บแค่วันที่ส่งเล่ม)
  async addPlate(id: string, dto: { vehicleId?: unknown; remark?: unknown }) {
    if (typeof dto?.vehicleId !== 'string' || !dto.vehicleId) throw bad('ต้องเลือกรถ');
    if (dto.remark !== undefined && dto.remark !== null && typeof dto.remark !== 'string') throw bad('หมายเหตุต้องเป็นข้อความ');
    const vehicleId = dto.vehicleId;
    const slip = await this.findActiveSlip(id);
    const label = slipNoLabel(slip.slipNo);
    const item = slip.items.find((i) => i.vehicleId === vehicleId);
    if (!item) throw bad(`รถคันนี้ไม่อยู่ในใบ ${label}`);
    this.assertItemInScope(item.body, `รถ ${item.chassis} `);
    if (item.cancelledAt) throw bad(`รถ ${item.chassis} ถูกยกเลิกจากใบ ${label} แล้ว`);
    if (!item.book) throw bad(`ใบ ${label} เป็นใบส่งป้ายของรถ ${item.chassis} อยู่แล้ว`);
    if (item.plate) throw bad(`ใบ ${label} ส่งป้ายของรถ ${item.chassis} ไปแล้ว`);

    const v = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null },
      select: { id: true, deliveredDate: true, plateReceivedDate: true, plateDeliveredDate: true },
    });
    if (!v) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    if (!v.plateReceivedDate) throw bad(`รถ ${item.chassis} ยังไม่ได้รับป้าย - แนบรูปป้ายที่หน้ารับป้ายทะเบียนก่อน`);
    if (v.plateDeliveredDate) throw bad(`รถ ${item.chassis} บันทึกส่งป้ายไปแล้วเมื่อ ${dmy(v.plateDeliveredDate)}`);
    // รายงานส่งงานโหลดรายการใหม่ให้เองเมื่อถูกปฏิเสธ - ข้อความจึงไม่บอกให้โหลดหน้าใหม่ (พบ 2026-09-27)
    if (isoDay(v.deliveredDate) !== isoDay(slip.date)) throw bad(`รถ ${item.chassis} วันที่ส่งเล่มไม่ตรงกับใบ ${label} กรุณาตรวจรายการอีกครั้ง`);

    const note = typeof dto.remark === 'string' ? dto.remark.trim() : '';
    // ป้ายไปพร้อมเล่ม = ร้านได้ป้ายมาก่อนวันส่งเล่มแน่นอน - รูปที่แนบทีหลังมักลงวันที่วันแนบ จึงปรับวันที่รับป้ายเป็นวันส่งเล่ม
    // (พบ 2026-09-27: ไม่งั้นป้ายถูกบันทึกว่าส่งก่อนรับ และแก้วันที่รับป้ายไม่ได้อีกเพราะส่งไปแล้ว)
    const receivedLater = v.plateReceivedDate > slip.date;
    await this.prisma.$transaction(async (tx) => {
      // มีเงื่อนไขทั้งสองแถว - ยกเลิกใบ/ส่งป้ายในใบอื่นพร้อมกัน จะนับไม่ครบแล้วย้อนทั้งหมด
      const itemUpdate = await tx.deliverySlipItem.updateMany({
        where: { id: item.id, cancelledAt: null, book: true, plate: false },
        data: { plate: true },
      });
      const vehicleUpdate = await tx.vehicle.updateMany({
        where: { id: vehicleId, deletedAt: null, deliveredDate: slip.date, plateReceivedDate: v.plateReceivedDate, plateDeliveredDate: null },
        data: { plateDeliveredDate: slip.date, ...(receivedLater ? { plateReceivedDate: slip.date } : {}) },
      });
      if (itemUpdate.count !== 1 || vehicleUpdate.count !== 1) throw conflict(`ข้อมูลรถ ${item.chassis} เปลี่ยนไปแล้ว กรุณาตรวจรายการอีกครั้ง`);
      await tx.vehicleEditLog.create({
        data: {
          vehicleId,
          remark: note ? `ป้ายไปพร้อมเล่มในใบ ${label}: ${note}` : `ป้ายไปพร้อมเล่มในใบ ${label}`,
          changes: JSON.stringify({
            plateDeliveredDate: { from: null, to: isoDay(slip.date) },
            ...(receivedLater ? { plateReceivedDate: { from: isoDay(v.plateReceivedDate), to: isoDay(slip.date) } } : {}),
            'deliverySlip.plate': { from: `${label} ส่งเล่ม (ป้ายตามทีหลัง)`, to: `${label} ส่งเล่ม + ป้าย` },
          }),
          editedById: currentUser()?.id ?? null,
        },
      });
    });
    return this.slip(id);
  }

  // แก้ใบส่งงานที่คีย์ผิด (ผู้ใช้ 2026-09-26): ผู้รับ / วันที่ส่ง + เหตุผล (บันทึกลง VehicleEditLog ทุกคัน)
  // ADMIN ทุกใบ, STAFF_CAR เฉพาะใบรถยนต์, STAFF_MOTO เฉพาะใบจักรยานยนต์ (ผู้รับ/วันที่ใช้ร่วมกันทั้งใบ - ทุกคันที่ยังไม่ยกเลิกต้องอยู่ในขอบเขต)
  // วันที่ส่งของคันที่วางบิลแล้วเปลี่ยนไม่ได้ (บิลเก็บวันที่ส่งไว้แล้ว) แต่แก้ชื่อผู้รับได้
  async updateSlip(id: string, dto: { recipient?: unknown; date?: unknown; remark?: unknown }) {
    const remark = parseRemark(dto?.remark);
    if (typeof dto.recipient !== 'string' || !dto.recipient.trim()) throw bad('ต้องใส่ชื่อผู้รับงาน');
    const recipient = dto.recipient.trim();
    const date = parseIsoDate(dto.date);
    const slip = await this.findActiveSlip(id);
    const items = slip.items.filter((i) => !i.cancelledAt);
    for (const i of items) this.assertItemInScope(i.body, 'ใบนี้');
    const dateChanged = slip.date.getTime() !== date.getTime();
    if (slip.recipient === recipient && !dateChanged) throw bad('ไม่มีอะไรเปลี่ยน');

    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: items.map((i) => i.vehicleId) } },
      select: { id: true, deliveredDate: true, plateDeliveredDate: true, deliveryRecipient: true, deliveryNote: true },
    });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const writes: Array<(tx: Tx) => Promise<void>> = [];
    for (const i of items) {
      const v = byId.get(i.vehicleId);
      if (!v) continue;
      // บิลเก็บเฉพาะวันส่งเล่ม - ใบส่งป้ายตามทีหลังของรถที่วางบิลแล้วเปลี่ยนวันที่ได้ (ผู้ใช้ 2026-09-27)
      const invoiceNo = i.vehicle.invoiceLines[0]?.invoice.invoiceNo;
      const lockedByInvoice = dateChanged && i.book;
      if (lockedByInvoice && invoiceNo) throw bad(`รถ ${i.chassis} วางบิลแล้ว (${invoiceNo}) เปลี่ยนวันที่ส่งไม่ได้ - แก้ได้เฉพาะชื่อผู้รับ`);
      const data: { deliveredDate?: Date; deliveryRecipient?: string; plateDeliveredDate?: Date; deliveryNote?: string } = {};
      if (i.book) {
        // ใบนี้ส่งเล่ม - ถ้าส่งป้ายตามไปทีหลังแล้ว วันที่ใหม่ต้องไม่หลังวันส่งป้าย
        if (!i.plate && v.plateDeliveredDate && date > v.plateDeliveredDate) {
          throw bad(`รถ ${i.chassis} ส่งป้ายไปแล้วเมื่อ ${dmy(v.plateDeliveredDate)} วันที่ส่งเล่มต้องไม่หลังวันนั้น`);
        }
        data.deliveredDate = date;
        data.deliveryRecipient = recipient;
        if (i.plate) data.plateDeliveredDate = date;
      } else {
        // ใบส่งป้ายตามทีหลัง - ต้องไม่ก่อนวันส่งเล่ม
        if (v.deliveredDate && date < v.deliveredDate) {
          throw bad(`รถ ${i.chassis} ส่งเล่มเมื่อ ${dmy(v.deliveredDate)} วันที่ส่งป้ายต้องไม่ก่อนวันนั้น`);
        }
        data.plateDeliveredDate = date;
        // ผู้รับป้ายเก็บอยู่ในหมายเหตุ "ส่งป้าย วว/ดด/ปปปป ผู้รับ ..." - เขียนส่วนนั้นใหม่ตามใบที่แก้ (พบ 2026-09-27: เดิมค้างข้อความเก่า)
        data.deliveryNote = [stripPlateNote(v.deliveryNote), plateNoteOf(date, recipient, slip.note)].filter(Boolean).join(' · ');
      }
      const changes: Record<string, { from: string | null; to: string | null }> = {};
      if (data.deliveredDate && isoDay(v.deliveredDate) !== isoDay(data.deliveredDate)) {
        changes.deliveredDate = { from: isoDay(v.deliveredDate), to: isoDay(data.deliveredDate) };
      }
      if (data.deliveryRecipient && v.deliveryRecipient !== data.deliveryRecipient) {
        changes.deliveryRecipient = { from: v.deliveryRecipient, to: data.deliveryRecipient };
      }
      if (data.plateDeliveredDate && isoDay(v.plateDeliveredDate) !== isoDay(data.plateDeliveredDate)) {
        changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: isoDay(data.plateDeliveredDate) };
      }
      if (!i.book && slip.recipient !== recipient) changes['deliverySlip.recipient'] = { from: slip.recipient, to: recipient };
      writes.push(async (tx) => {
        const { count } = await tx.vehicle.updateMany({ where: { id: v.id, ...(lockedByInvoice ? NOT_BILLED : {}) }, data });
        if (count !== 1) throw conflict(`รถ ${i.chassis} เพิ่งวางบิล เปลี่ยนวันที่ส่งไม่ได้ - แก้ได้เฉพาะชื่อผู้รับ`);
        await this.editLog(v.id, `แก้ใบส่งงาน ${slipNoLabel(slip.slipNo)}: ${remark}`, changes, tx);
      });
    }
    await this.prisma.$transaction(async (tx) => {
      for (const write of writes) await write(tx);
      await tx.deliverySlip.update({ where: { id }, data: { recipient, date } });
    });
    return this.slip(id);
  }

  // ยกเลิกใบส่งงาน (ทั้งใบหรือรายคัน) ที่คีย์ผิด (ผู้ใช้ 2026-09-26): รถกลับเข้าคิว Delivery แล้วบันทึกใหม่ได้
  // ไม่ลบ - รายการ/ใบถูกทำเครื่องหมายยกเลิกพร้อมเหตุผล (ครบทุกคัน = ทั้งใบขึ้นว่ายกเลิกแล้ว) เลข DL ไม่ขาดช่วง
  // ห้ามยกเลิก: คันที่วางบิลแล้ว (แก้บิลก่อน) และใบส่งเล่มของคันที่ส่งป้ายตามไปแล้ว (ยกเลิกใบส่งป้ายก่อน)
  async cancelSlip(id: string, dto: { vehicleIds?: unknown; remark?: unknown }) {
    const remark = parseRemark(dto?.remark);
    if (!Array.isArray(dto.vehicleIds) || dto.vehicleIds.length === 0 || dto.vehicleIds.some((v) => typeof v !== 'string')) {
      throw bad('ต้องเลือกรถที่จะยกเลิกอย่างน้อย 1 คัน');
    }
    const ids = new Set(dto.vehicleIds as string[]);
    const slip = await this.findActiveSlip(id);
    const chosen = slip.items.filter((i) => ids.has(i.vehicleId));
    if (chosen.length !== ids.size || chosen.some((i) => i.cancelledAt)) throw bad('รถบางคันไม่อยู่ในใบนี้ หรือยกเลิกไปแล้ว');

    const laterPlate = await this.prisma.deliverySlipItem.findMany({
      where: { vehicleId: { in: [...ids] }, slipId: { not: id }, cancelledAt: null, book: false, plate: true },
      select: { vehicleId: true, slip: { select: { slipNo: true } } },
    });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, deliveredDate: true, plateDeliveredDate: true, deliveryNote: true },
    });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const now = new Date();
    const cancelledById = currentUser()?.id ?? null;
    const writes: Array<(tx: Tx) => Promise<void>> = [];
    for (const i of chosen) {
      this.assertItemInScope(i.body, `รถ ${i.chassis} `);
      // ล็อกเฉพาะรายการส่งเล่ม (บิลเก็บวันส่งเล่ม) - ใบส่งป้ายตามทีหลังยกเลิกได้แม้วางบิลแล้ว (ผู้ใช้ 2026-09-27)
      const invoiceNo = i.vehicle.invoiceLines[0]?.invoice.invoiceNo;
      if (i.book && invoiceNo) throw bad(`รถ ${i.chassis} วางบิลแล้ว (${invoiceNo}) ต้องยกเลิกบิลก่อนจึงจะยกเลิกการส่งได้`);
      const v = byId.get(i.vehicleId);
      if (!v) continue;
      const changes: Record<string, { from: string | null; to: string | null }> = {
        'deliverySlip.cancelled': { from: `${slipNoLabel(slip.slipNo)} ${dmy(slip.date)} ผู้รับ ${slip.recipient}`, to: 'ยกเลิกการส่ง' },
      };
      if (i.book) {
        const plate = laterPlate.find((p) => p.vehicleId === i.vehicleId);
        if (plate) throw bad(`รถ ${i.chassis} ส่งป้ายตามไปแล้วในใบ ${slipNoLabel(plate.slip.slipNo)} ต้องยกเลิกใบนั้นก่อน`);
        if (v.deliveredDate) changes.deliveredDate = { from: isoDay(v.deliveredDate), to: null };
        if (v.plateDeliveredDate) changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: null };
        writes.push(async (tx) => {
          const { count } = await tx.vehicle.updateMany({
            where: { id: v.id, ...NOT_BILLED },
            data: { deliveredDate: null, deliveryRecipient: null, deliveryNote: null, plateDeliveredDate: null, deliveryConfirmedAt: null },
          });
          if (count !== 1) throw conflict(`รถ ${i.chassis} เพิ่งวางบิล ต้องยกเลิกบิลก่อนจึงจะยกเลิกการส่งได้`);
        });
      } else {
        if (v.plateDeliveredDate) changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: null };
        writes.push(async (tx) => {
          await tx.vehicle.update({ where: { id: v.id }, data: { plateDeliveredDate: null, deliveryNote: stripPlateNote(v.deliveryNote) } });
        });
      }
      writes.push(async (tx) => {
        // ยกเลิกรายการเดียวกันพร้อมกันสองเครื่อง - เครื่องหลังต้องไม่ทับ
        const { count } = await tx.deliverySlipItem.updateMany({
          where: { id: i.id, cancelledAt: null },
          data: { cancelledAt: now, cancelReason: remark, cancelledById },
        });
        if (count !== 1) throw conflict(`รถ ${i.chassis} ถูกยกเลิกจากใบนี้ไปแล้ว`);
        await this.editLog(v.id, remark, changes, tx);
      });
    }
    await this.prisma.$transaction(async (tx) => {
      for (const write of writes) await write(tx);
      // ครบทุกคัน = ยกเลิกทั้งใบ
      if (slip.items.every((i) => i.cancelledAt || ids.has(i.vehicleId))) {
        await tx.deliverySlip.update({ where: { id }, data: { cancelledAt: now, cancelReason: remark, cancelledById } });
      }
    });
    return this.slip(id);
  }

  private async findActiveSlip(id: string) {
    const slip = await this.prisma.deliverySlip.findUnique({ where: { id }, include: SLIP_INCLUDE });
    if (!slip) throw new NotFoundException({ error: 'ไม่พบใบส่งงาน' });
    if (slip.cancelledAt) throw bad('ใบส่งงานนี้ถูกยกเลิกไปแล้ว');
    return slip;
  }

  private assertItemInScope(body: string | null, what: string) {
    if (!isVehicleInScope(body, currentWriteScope())) throw new ForbiddenException({ error: `${what}มีรถประเภทที่บัญชีของคุณไม่ได้ดูแล` });
  }

  private editLog(vehicleId: string, remark: string, changes: Record<string, unknown>, db: Pick<Tx, 'vehicleEditLog'> = this.prisma) {
    return db.vehicleEditLog.create({
      data: { vehicleId, remark, changes: JSON.stringify(changes), editedById: currentUser()?.id ?? null },
    });
  }

  private mapSlip(s: {
    id: string;
    slipNo: number;
    date: Date;
    recipient: string;
    note: string | null;
    createdAt: Date;
    cancelledAt: Date | null;
    cancelReason: string | null;
    customer: { id: string; name: string; company: string | null; branch: string | null; address: string | null; phone: string | null };
    createdBy: { name: string; displayName: string | null } | null;
    cancelledBy: { name: string; displayName: string | null } | null;
    items: Array<{
      vehicleId: string;
      receipt: boolean;
      book: boolean;
      plate: boolean;
      chassis: string;
      brandName: string;
      body: string | null;
      plateText: string;
      receiptNo: string | null;
      cancelledAt: Date | null;
      cancelReason: string | null;
      cancelledBy: { name: string; displayName: string | null } | null;
      vehicle: { invoiceLines: Array<{ invoice: { invoiceNo: string } }>; owner: { name: string | null; hirerName: string | null } | null };
    }>;
  }, later = new Map<string, { slipNo: number; date: string }>()) {
    return {
      id: s.id,
      slipNo: s.slipNo,
      date: s.date.toISOString().slice(0, 10),
      recipient: s.recipient,
      note: s.note,
      createdAt: s.createdAt.toISOString(),
      createdBy: userName(s.createdBy),
      cancelledAt: s.cancelledAt?.toISOString() ?? null,
      cancelReason: s.cancelReason,
      cancelledBy: userName(s.cancelledBy),
      customer: { ...s.customer, displayName: s.customer.company || s.customer.name },
      items: s.items
        .filter((i) => isVehicleInScope(i.body))
        .sort((a, b) => a.plateText.localeCompare(b.plateText, 'th') || a.chassis.localeCompare(b.chassis))
        .map((i) => ({
          vehicleId: i.vehicleId,
          chassis: i.chassis,
          brandName: i.brandName,
          body: i.body,
          plateText: i.plateText,
          receiptNo: i.receiptNo,
          receipt: i.receipt,
          book: i.book,
          plate: i.plate,
          cancelledAt: i.cancelledAt?.toISOString() ?? null,
          cancelReason: i.cancelReason,
          cancelledBy: userName(i.cancelledBy),
          invoiceNo: i.vehicle.invoiceLines[0]?.invoice.invoiceNo ?? null,
          ownerName: ownerNameOf(i.vehicle.owner),
          // ส่งเล่มในใบนี้ ป้ายส่งตามไปในใบอื่น (อ่านสด) - null = ป้ายไปในใบนี้แล้ว / ยังค้างส่ง
          plateSentLater: i.book && !i.plate && !i.cancelledAt ? (later.get(i.vehicleId) ?? null) : null,
        })),
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
    bookReceivedDate: Date | null;
    customer: { id: string; name: string; company: string | null };
    brand: { name: string };
    documentSubmissions: Array<{ status: string; receiptNo: string | null; submitDate: Date; urgent: boolean; createdAt: Date }>;
    invoiceLines: Array<{ invoice: { invoiceNo: string } }>;
    deliverySlipItems: Array<{ slip: { id: string; slipNo: number; date: Date } }>;
  }) {
    const bookSlip = v.deliveredDate ? v.deliverySlipItems[0]?.slip : undefined;
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
      // ใบยื่นล่าสุด = lot ของรถคันนี้ (วันที่ยื่น + กลุ่ม รย./ด่วน + ลูกค้า)
      submitDate: v.documentSubmissions[0]?.submitDate.toISOString().slice(0, 10) ?? null,
      urgent: v.documentSubmissions[0]?.urgent ?? false,
      submittedAt: v.documentSubmissions[0]?.createdAt.toISOString() ?? null,
      submissionStatus: v.documentSubmissions[0]?.status ?? null,
      receiptReceived: v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED',
      bookReceived: v.bookReceivedDate !== null,
      // ใบที่ส่งเล่มไป (เฉพาะคันที่ส่งเล่มแล้ว) - ปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ในรายงานส่งงานอ้างถึงใบนี้
      bookSlip: bookSlip ? { id: bookSlip.id, slipNo: bookSlip.slipNo, date: bookSlip.date.toISOString().slice(0, 10) } : null,
    };
  }
}
