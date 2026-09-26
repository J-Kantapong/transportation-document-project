import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { assertVehicleInScope, isVehicleInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ส่งงานลูกค้า (พนักงาน): ติ๊กคันที่ส่งแล้ว + วันที่ส่ง + ผู้รับ แล้วกดบันทึกครั้งเดียวทั้งชุด - พนักงานไม่เห็นราคา เรื่องบิลอยู่ที่ backend/src/billing
// กติกา (ผู้ใช้ 2026-09-21): ปกติส่งใบเสร็จ + เล่ม + ป้ายพร้อมกัน แต่บางคันป้ายยังไม่ออก -> ส่งใบเสร็จ + เล่มไปก่อนได้ แล้วป้ายตามทีหลัง
// ดังนั้นรถเข้าคิวส่งเมื่อ "ได้รับใบเสร็จแล้ว + รับเล่มแล้ว" (ไม่ต้องรอป้าย) และรถที่ส่งแล้วแต่ป้ายค้างจะกลับมาในคิวเป็นงานส่งป้ายอย่างเดียว
export type DeliveryKind =
  | 'FULL' // ส่งใบเสร็จ + เล่ม + ป้าย
  | 'NO_PLATE' // ส่งใบเสร็จ + เล่ม (ป้ายยังไม่ออก ส่งตามทีหลัง)
  | 'PLATE_ONLY' // ส่งเล่มไปแล้ว ป้ายเพิ่งมา -> ส่งป้ายอย่างเดียว
  | 'WAITING_PLATE'; // ส่งเล่มไปแล้ว ป้ายยังไม่ออก -> ยังติ๊กไม่ได้

const NOT_VOID = { invoice: { status: { not: 'VOID' } } };

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
      vehicle: { select: { invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } } } },
    },
  },
} as const;

const userName = (u: { name: string; displayName: string | null } | null) => (u ? u.displayName || u.name : null);

const bad = (error: string) => new BadRequestException({ error });
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
        ...vehicleTypeWhere(), // STAFF_CAR / STAFF_MOTO เห็นเฉพาะประเภทรถของตัวเอง
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
        ...vehicleTypeWhere(),
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
      where: { deliveredDate: { not: null }, ...vehicleTypeWhere() },
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
    for (const v of vehicles) assertVehicleInScope(v.body); // STAFF_CAR / STAFF_MOTO ส่งงานได้เฉพาะประเภทรถของตัวเอง
    // บันทึก 1 ครั้ง = ใบส่งงาน 1 ใบของลูกค้ารายเดียว (ผู้รับคนเดียว)
    if (new Set(vehicles.map((v) => v.customer.id)).size > 1) throw bad('ส่งงานได้ครั้งละ 1 ลูกค้า');

    const dateText = dmy(date);
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
    // ใบส่งงาน: บอกแยกรายคันว่ารอบนี้ส่งอะไร (ผู้ใช้ 2026-09-25)
    const slip = this.prisma.deliverySlip.create({
      data: {
        customerId: vehicles[0].customer.id,
        date,
        recipient,
        note,
        createdById: currentUser()?.id ?? null,
        items: {
          create: vehicles.map((v) => {
            const kind = deliveryKind(v);
            return {
              vehicleId: v.id,
              receipt: kind !== 'PLATE_ONLY',
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
    const results = await this.prisma.$transaction([...updates, slip]);
    const created = results[results.length - 1] as { id: string; slipNo: number };

    const kinds = vehicles.map((v) => deliveryKind(v));
    return {
      slipId: created.id,
      slipNo: created.slipNo,
      delivered: kinds.filter((k) => k === 'FULL' || k === 'NO_PLATE').length,
      plateOnly: kinds.filter((k) => k === 'PLATE_ONLY').length,
      platePending: kinds.filter((k) => k === 'NO_PLATE').length,
    };
  }

  // รายงานส่งงานย้อนหลัง: ใบส่งงานตามช่วงวันที่ส่ง (และลูกค้า) - STAFF_CAR / STAFF_MOTO เห็นเฉพาะคันในขอบเขตของตัวเอง
  async slips(query: { from?: unknown; to?: unknown; customerId?: unknown }) {
    const from = parseOptionalIsoDate(query?.from, 'วันที่เริ่ม');
    const to = parseOptionalIsoDate(query?.to, 'วันที่สิ้นสุด');
    if (from && to && from > to) throw bad('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
    const customerId = typeof query?.customerId === 'string' && query.customerId ? query.customerId : undefined;
    const slips = await this.prisma.deliverySlip.findMany({
      where: {
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(customerId ? { customerId } : {}),
      },
      orderBy: [{ date: 'desc' }, { slipNo: 'desc' }],
      take: 500,
      include: SLIP_INCLUDE,
    });
    return slips.map((s) => this.mapSlip(s)).filter((s) => s.items.length > 0);
  }

  async slip(id: string) {
    const found = await this.prisma.deliverySlip.findUnique({ where: { id }, include: SLIP_INCLUDE });
    const slip = found && this.mapSlip(found);
    if (!slip || slip.items.length === 0) throw new NotFoundException({ error: 'ไม่พบใบส่งงาน' });
    return slip;
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
      select: { id: true, deliveredDate: true, plateDeliveredDate: true, deliveryRecipient: true },
    });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const ops = [];
    for (const i of items) {
      const v = byId.get(i.vehicleId);
      if (!v) continue;
      const invoiceNo = i.vehicle.invoiceLines[0]?.invoice.invoiceNo;
      if (dateChanged && invoiceNo) throw bad(`รถ ${i.chassis} วางบิลแล้ว (${invoiceNo}) เปลี่ยนวันที่ส่งไม่ได้ - แก้ได้เฉพาะชื่อผู้รับ`);
      const data: { deliveredDate?: Date; deliveryRecipient?: string; plateDeliveredDate?: Date } = {};
      if (i.receipt) {
        // ใบนี้ส่งใบเสร็จ + เล่ม - ถ้าส่งป้ายตามไปทีหลังแล้ว วันที่ใหม่ต้องไม่หลังวันส่งป้าย
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
      if (!i.receipt && slip.recipient !== recipient) changes['deliverySlip.recipient'] = { from: slip.recipient, to: recipient };
      ops.push(this.prisma.vehicle.update({ where: { id: v.id }, data }));
      ops.push(this.editLog(v.id, `แก้ใบส่งงาน ${slipNoLabel(slip.slipNo)}: ${remark}`, changes));
    }
    await this.prisma.$transaction([...ops, this.prisma.deliverySlip.update({ where: { id }, data: { recipient, date } })]);
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
      where: { vehicleId: { in: [...ids] }, slipId: { not: id }, cancelledAt: null, receipt: false, plate: true },
      select: { vehicleId: true, slip: { select: { slipNo: true } } },
    });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, deliveredDate: true, plateDeliveredDate: true, deliveryNote: true },
    });
    const byId = new Map(vehicles.map((v) => [v.id, v]));
    const now = new Date();
    const cancelledById = currentUser()?.id ?? null;
    const ops = [];
    for (const i of chosen) {
      this.assertItemInScope(i.body, `รถ ${i.chassis} `);
      const invoiceNo = i.vehicle.invoiceLines[0]?.invoice.invoiceNo;
      if (invoiceNo) throw bad(`รถ ${i.chassis} วางบิลแล้ว (${invoiceNo}) ต้องยกเลิกบิลก่อนจึงจะยกเลิกการส่งได้`);
      const v = byId.get(i.vehicleId);
      if (!v) continue;
      const changes: Record<string, { from: string | null; to: string | null }> = {
        'deliverySlip.cancelled': { from: `${slipNoLabel(slip.slipNo)} ${dmy(slip.date)} ผู้รับ ${slip.recipient}`, to: 'ยกเลิกการส่ง' },
      };
      if (i.receipt) {
        const plate = laterPlate.find((p) => p.vehicleId === i.vehicleId);
        if (plate) throw bad(`รถ ${i.chassis} ส่งป้ายตามไปแล้วในใบ ${slipNoLabel(plate.slip.slipNo)} ต้องยกเลิกใบนั้นก่อน`);
        if (v.deliveredDate) changes.deliveredDate = { from: isoDay(v.deliveredDate), to: null };
        if (v.plateDeliveredDate) changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: null };
        ops.push(
          this.prisma.vehicle.update({
            where: { id: v.id },
            data: { deliveredDate: null, deliveryRecipient: null, deliveryNote: null, plateDeliveredDate: null, deliveryConfirmedAt: null },
          }),
        );
      } else {
        if (v.plateDeliveredDate) changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: null };
        ops.push(
          this.prisma.vehicle.update({ where: { id: v.id }, data: { plateDeliveredDate: null, deliveryNote: stripPlateNote(v.deliveryNote) } }),
        );
      }
      ops.push(this.prisma.deliverySlipItem.update({ where: { id: i.id }, data: { cancelledAt: now, cancelReason: remark, cancelledById } }));
      ops.push(this.editLog(v.id, remark, changes));
    }
    // ครบทุกคัน = ยกเลิกทั้งใบ
    if (slip.items.every((i) => i.cancelledAt || ids.has(i.vehicleId))) {
      ops.push(this.prisma.deliverySlip.update({ where: { id }, data: { cancelledAt: now, cancelReason: remark, cancelledById } }));
    }
    await this.prisma.$transaction(ops);
    return this.slip(id);
  }

  private async findActiveSlip(id: string) {
    const slip = await this.prisma.deliverySlip.findUnique({ where: { id }, include: SLIP_INCLUDE });
    if (!slip) throw new NotFoundException({ error: 'ไม่พบใบส่งงาน' });
    if (slip.cancelledAt) throw bad('ใบส่งงานนี้ถูกยกเลิกไปแล้ว');
    return slip;
  }

  private assertItemInScope(body: string | null, what: string) {
    if (!isVehicleInScope(body)) throw new ForbiddenException({ error: `${what}มีรถประเภทที่บัญชีของคุณไม่ได้ดูแล` });
  }

  private editLog(vehicleId: string, remark: string, changes: Record<string, unknown>) {
    return this.prisma.vehicleEditLog.create({
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
      vehicle: { invoiceLines: Array<{ invoice: { invoiceNo: string } }> };
    }>;
  }) {
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
      // ใบยื่นล่าสุด = lot ของรถคันนี้ (วันที่ยื่น + กลุ่ม รย./ด่วน + ลูกค้า)
      submitDate: v.documentSubmissions[0]?.submitDate.toISOString().slice(0, 10) ?? null,
      urgent: v.documentSubmissions[0]?.urgent ?? false,
      submittedAt: v.documentSubmissions[0]?.createdAt.toISOString() ?? null,
      submissionStatus: v.documentSubmissions[0]?.status ?? null,
      receiptReceived: v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED',
      bookReceived: v.bookReceivedDate !== null,
    };
  }
}
