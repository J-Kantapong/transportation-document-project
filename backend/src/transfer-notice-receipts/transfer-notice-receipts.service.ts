// ใบเสร็จแจ้งย้ายของรถจดใหม่ ขั้น 2 (ผู้ใช้ 2026-10-08)
// - รถจดต่างจังหวัด (สถานะ "แจ้งย้าย") ต้องแนบใบเสร็จแจ้งย้ายก่อนติ๊กดำเนินการแล้ว (บังคับใน VehiclesService.updateTransferNotice)
// - ใบเสร็จ 1 ใบผูกได้หลายคัน (ขนส่งออกใบเดียวหลายคันได้): แนบครั้งเดียว กรอกยอดรวมครั้งเดียว ระบบหารเท่ากันต่อคัน
//   (เศษสตางค์ลงคันสุดท้าย) หรือส่งยอดรายคันมาเองได้ แต่ผลรวมต้องเท่ายอดใบ
// - ยอดของแต่ละคัน (Vehicle.transferBillCost) คือส่วน Bill ของขั้น 2 แยกจาก No bill (Vehicle.transferCost) และตอนวางบิล
//   ระบบบวกเข้าค่าธรรมเนียมราชการของบิล (InvoiceLine.transferReceiptAmount)
// - ไฟล์เดิมอัปโหลดซ้ำไม่ได้ (contentHash) · แก้ยอด/ถอดคันต้องมีเหตุผล เก็บลง VehicleEditLog · รถที่อยู่ในบิลแล้วแก้ไม่ได้ (บิลเก็บยอดไว้แล้ว)
import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { assertTransferNoticeInScope } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { MAX_RECEIPT_BYTES } from '../receipts/receipts.service.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { detectAttachmentType } from '../yamaha-relocation/yamaha-relocation.service.js';

export interface TransferNoticeReceiptFile {
  buffer: Buffer;
  size: number;
  originalname?: string;
}

export const MAX_VEHICLES_PER_RECEIPT = 200;
const DUPLICATE_ERROR = 'ไฟล์ใบเสร็จแจ้งย้ายนี้อัพโหลดไปแล้ว';
const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;

const bad = (error: string) => new BadRequestException({ error });
const toSatang = (amount: number) => Math.round(amount * 100);

function parseAmount(raw: unknown, label: string): number {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) throw bad(`${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 (ทศนิยมไม่เกิน 2 ตำแหน่ง)`);
  return Number(text);
}

// multipart ส่งมาเป็นข้อความ: vehicleIds = "id1,id2" หรือ JSON array
function parseVehicleIds(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text.startsWith('[')) {
      try {
        list = JSON.parse(text);
      } catch {
        throw bad('รายการรถไม่ถูกต้อง');
      }
    } else {
      list = text.split(',');
    }
  }
  if (!Array.isArray(list)) throw bad('ต้องเลือกรถอย่างน้อย 1 คัน');
  const ids = list.map((id) => (typeof id === 'string' ? id.trim() : '')).filter(Boolean);
  if (ids.length === 0) throw bad('ต้องเลือกรถอย่างน้อย 1 คัน');
  if (new Set(ids).size !== ids.length) throw bad('มีรถซ้ำในรายการ');
  if (ids.length > MAX_VEHICLES_PER_RECEIPT) throw bad(`ใบเสร็จ 1 ใบผูกได้ไม่เกิน ${MAX_VEHICLES_PER_RECEIPT} คัน`);
  return ids;
}

// ยอดรายคัน { vehicleId: amount } - ไม่ส่ง = หารเท่ากัน
function parseAmounts(raw: unknown): Map<string, number> | null {
  if (raw === undefined || raw === null || raw === '') return null;
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      throw bad('ยอดรายคันไม่ถูกต้อง');
    }
  }
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw bad('ยอดรายคันไม่ถูกต้อง');
  return new Map(Object.entries(obj).map(([id, amount]) => [id, parseAmount(amount, 'ยอดรายคัน')]));
}

// หารยอดใบเสร็จเท่ากันต่อคัน (หน่วยสตางค์) เศษลงคันสุดท้าย - ผลรวมเท่ายอดใบเสมอ
export function splitEvenly(total: number, count: number): number[] {
  const satang = toSatang(total);
  const base = Math.floor(satang / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? satang - base * (count - 1) : base) / 100);
}

// ยอดของแต่ละคันตามลำดับ ids - ส่งยอดรายคันมา = ต้องครบทุกคันและรวมเท่ายอดใบ
export function sharesFor(ids: string[], total: number, amounts: Map<string, number> | null): number[] {
  if (!amounts) return splitEvenly(total, ids.length);
  if (amounts.size !== ids.length || ids.some((id) => !amounts.has(id))) throw bad('ยอดรายคันต้องมีครบทุกคันที่ผูกกับใบเสร็จนี้');
  const shares = ids.map((id) => amounts.get(id) as number);
  if (shares.reduce((sum, a) => sum + toSatang(a), 0) !== toSatang(total)) throw bad('ยอดรายคันรวมกันต้องเท่ากับยอดรวมของใบเสร็จ');
  return shares;
}

export function needsTransferReceipt(registrationProvince: string | null | undefined): boolean {
  return !!registrationProvince && registrationProvince !== 'กรุงเทพมหานคร';
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class TransferNoticeReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  private async lockVehicles(tx: Tx, ids: string[]) {
    const sorted = [...ids].sort();
    await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ANY(${sorted}::text[]) ORDER BY "id" FOR UPDATE`;
    return tx.vehicle.findMany({
      where: { id: { in: sorted }, deletedAt: null },
      select: {
        id: true,
        chassis: true,
        body: true,
        registrationProvince: true,
        transferDone: true,
        transferReceiptId: true,
        transferBillCost: true,
        invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } }, take: 1 },
      },
    });
  }

  private log(tx: Tx, vehicleId: string, remark: string, changes: Record<string, { from: unknown; to: unknown }>) {
    return tx.vehicleEditLog.create({ data: { vehicleId, remark, changes: JSON.stringify(changes), editedById: currentUser()?.id ?? null } });
  }

  // แนบใบเสร็จ 1 ไฟล์กับรถ 1 คันหรือหลายคัน - ทำได้ทั้งก่อนและหลังติ๊กดำเนินการแล้ว (รถเก่าที่ทำขั้น 2 ไปก่อนมีช่องนี้แนบย้อนหลังได้)
  async attach(file: TransferNoticeReceiptFile | undefined, body: { vehicleIds?: unknown; totalAmount?: unknown; amounts?: unknown } = {}) {
    if (!file?.buffer?.length) throw bad('กรุณาแนบไฟล์ใบเสร็จแจ้งย้าย');
    if (file.size > MAX_RECEIPT_BYTES) throw bad('ไฟล์ใหญ่เกิน 8MB');
    const type = detectAttachmentType(file.buffer);
    if (!type) throw bad('ไฟล์ใบเสร็จต้องเป็นรูป (JPG/PNG/WEBP) หรือ PDF');
    const ids = parseVehicleIds(body.vehicleIds);
    const total = parseAmount(body.totalAmount, 'ยอดรวมของใบเสร็จ');
    const shares = sharesFor(ids, total, parseAmounts(body.amounts));

    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.transferNoticeReceipt.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload(DUPLICATE_ERROR);

    const now = new Date();
    const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const storageKey = `transfer-notice/${ym}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const vehicles = await this.lockVehicles(tx, ids);
        const byId = new Map(vehicles.map((v) => [v.id, v]));
        for (const id of ids) {
          const v = byId.get(id);
          if (!v) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถบางคัน กรุณาโหลดรายการใหม่' });
          assertTransferNoticeInScope(v.body);
          if (!needsTransferReceipt(v.registrationProvince)) throw bad(`รถ ${v.chassis} ไม่ใช่งานแจ้งย้าย (จดกรุงเทพฯ = ตัดบัญชี ไม่มีใบเสร็จ)`);
          if (v.transferReceiptId) throw new ConflictException({ error: `รถ ${v.chassis} มีใบเสร็จแจ้งย้ายแล้ว - ถอดออกจากใบเดิมก่อน` });
          if (v.invoiceLines.length) throw bad(`รถ ${v.chassis} อยู่ในบิล ${v.invoiceLines[0].invoice.invoiceNo} แล้ว - แนบใบเสร็จแจ้งย้ายเพิ่มไม่ได้`);
        }
        const receipt = await tx.transferNoticeReceipt.create({
          data: {
            storageKey,
            mimeType: type.mimeType,
            sizeBytes: file.size,
            originalName: file.originalname?.slice(0, 200) ?? null,
            contentHash,
            totalAmount: total,
            createdById: currentUser()?.id ?? null,
          },
        });
        for (const [i, id] of ids.entries()) {
          await tx.vehicle.update({ where: { id }, data: { transferReceiptId: receipt.id, transferBillCost: shares[i] } });
          await this.log(tx, id, 'แนบใบเสร็จแจ้งย้าย', { transferBillCost: { from: null, to: shares[i].toFixed(2) } });
        }
        return { id: receipt.id, totalAmount: total, vehicles: ids.map((id, i) => ({ id, amount: shares[i] })) };
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined); // บันทึกไม่สำเร็จ = ไม่ทิ้งไฟล์ค้างใน storage
      if (isContentHashConflict(err)) throw duplicateUpload(DUPLICATE_ERROR);
      throw err;
    }
  }

  async get(id: string) {
    const receipt = await this.prisma.transferNoticeReceipt.findUnique({
      where: { id },
      include: {
        vehicles: {
          where: { deletedAt: null },
          orderBy: { chassis: 'asc' },
          select: { id: true, chassis: true, transferBillCost: true, transferDone: true, customer: { select: { name: true } } },
        },
      },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบใบเสร็จแจ้งย้าย' });
    return {
      id: receipt.id,
      totalAmount: Number(receipt.totalAmount),
      mimeType: receipt.mimeType,
      originalName: receipt.originalName,
      createdAt: receipt.createdAt.toISOString(),
      vehicles: receipt.vehicles.map((v) => ({
        id: v.id,
        chassis: v.chassis,
        customerName: v.customer.name,
        transferDone: v.transferDone,
        amount: v.transferBillCost === null ? null : Number(v.transferBillCost),
      })),
    };
  }

  async getFile(id: string) {
    const receipt = await this.prisma.transferNoticeReceipt.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบใบเสร็จแจ้งย้าย' });
    const ext = receipt.storageKey.slice(receipt.storageKey.lastIndexOf('.') + 1);
    return { data: await this.storage.get(receipt.storageKey), mimeType: receipt.mimeType, fileName: `transfer-notice-receipt.${ext}` };
  }

  // รถของใบเสร็จนี้ใต้ล็อก พร้อมตรวจสิทธิ์และ "ยังไม่อยู่ในบิล" (บิลเก็บยอดไว้แล้ว แก้ที่นี่จะไม่ตรงกับบิล)
  private async lockReceiptVehicles(tx: Tx, receiptId: string) {
    const linked = await tx.vehicle.findMany({ where: { transferReceiptId: receiptId }, select: { id: true } });
    if (linked.length === 0) throw new NotFoundException({ error: 'ไม่พบใบเสร็จแจ้งย้าย' });
    const vehicles = (await this.lockVehicles(tx, linked.map((v) => v.id))).filter((v) => v.transferReceiptId === receiptId);
    for (const v of vehicles) {
      assertTransferNoticeInScope(v.body);
      if (v.invoiceLines.length) {
        throw bad(`รถ ${v.chassis} อยู่ในบิล ${v.invoiceLines[0].invoice.invoiceNo} แล้ว - แก้ใบเสร็จแจ้งย้ายไม่ได้ (ยกเลิกบิลก่อน)`);
      }
    }
    return vehicles.sort((a, b) => a.chassis.localeCompare(b.chassis));
  }

  // แก้ยอดรวม / ยอดรายคันของใบเสร็จ - เหตุผลบังคับ
  async update(id: string, body: { totalAmount?: unknown; amounts?: unknown; remark?: unknown } = {}) {
    const remark = typeof body.remark === 'string' ? body.remark.trim() : '';
    if (!remark) throw bad('กรุณาระบุเหตุผลที่แก้ใบเสร็จแจ้งย้าย');
    const total = parseAmount(body.totalAmount, 'ยอดรวมของใบเสร็จ');
    const amounts = parseAmounts(body.amounts);
    return this.prisma.$transaction(async (tx) => {
      const vehicles = await this.lockReceiptVehicles(tx, id);
      const ids = vehicles.map((v) => v.id);
      const shares = sharesFor(ids, total, amounts);
      let changed = 0;
      for (const [i, v] of vehicles.entries()) {
        const before = v.transferBillCost === null ? null : Number(v.transferBillCost);
        if (before === shares[i]) continue;
        changed += 1;
        await tx.vehicle.update({ where: { id: v.id }, data: { transferBillCost: shares[i] } });
        await this.log(tx, v.id, `แก้ใบเสร็จแจ้งย้าย: ${remark}`, {
          transferBillCost: { from: before === null ? null : before.toFixed(2), to: shares[i].toFixed(2) },
        });
      }
      const receipt = await tx.transferNoticeReceipt.findUnique({ where: { id }, select: { totalAmount: true } });
      if (changed === 0 && receipt && Number(receipt.totalAmount) === total) throw bad('ยอดไม่ได้เปลี่ยน');
      await tx.transferNoticeReceipt.update({ where: { id }, data: { totalAmount: total } });
      return { id, totalAmount: total, vehicles: ids.map((vehicleId, i) => ({ id: vehicleId, amount: shares[i] })) };
    });
  }

  // ถอดรถ 1 คันออกจากใบเสร็จ (ติ๊กผิดคัน) - ได้เฉพาะคันที่ยังไม่ติ๊กดำเนินการแล้ว (คันที่ดำเนินการแล้วต้องยกเลิกสถานะก่อน เพราะงานแจ้งย้าย
  // ที่เสร็จแล้วต้องมีใบเสร็จ) ยอดรวมของใบคงเดิม หารใหม่เท่ากันให้คันที่เหลือ · ถอดคันสุดท้าย = ลบใบเสร็จและไฟล์ (แนบไฟล์เดิมใหม่ได้)
  async detach(id: string, body: { vehicleId?: unknown; remark?: unknown } = {}) {
    const remark = typeof body.remark === 'string' ? body.remark.trim() : '';
    if (!remark) throw bad('กรุณาระบุเหตุผลที่ถอดรถออกจากใบเสร็จแจ้งย้าย');
    const vehicleId = typeof body.vehicleId === 'string' ? body.vehicleId : '';
    const result = await this.prisma.$transaction(async (tx) => {
      const vehicles = await this.lockReceiptVehicles(tx, id);
      const target = vehicles.find((v) => v.id === vehicleId);
      if (!target) throw bad('รถคันนี้ไม่ได้ผูกกับใบเสร็จนี้ กรุณาโหลดรายการใหม่');
      if (target.transferDone) throw bad(`รถ ${target.chassis} ติ๊กดำเนินการแจ้งย้ายแล้ว - ยกเลิกสถานะที่ปุ่ม "✎ แก้" ก่อนจึงถอดใบเสร็จได้`);
      const receipt = await tx.transferNoticeReceipt.findUnique({ where: { id }, select: { totalAmount: true, storageKey: true } });
      if (!receipt) throw new NotFoundException({ error: 'ไม่พบใบเสร็จแจ้งย้าย' });

      await tx.vehicle.update({ where: { id: target.id }, data: { transferReceiptId: null, transferBillCost: null } });
      await this.log(tx, target.id, `ถอดออกจากใบเสร็จแจ้งย้าย: ${remark}`, {
        transferBillCost: { from: target.transferBillCost === null ? null : Number(target.transferBillCost).toFixed(2), to: null },
      });
      const rest = vehicles.filter((v) => v.id !== target.id);
      if (rest.length === 0) {
        await tx.transferNoticeReceipt.delete({ where: { id } });
        return { id, deleted: true, storageKey: receipt.storageKey, vehicles: [] as Array<{ id: string; amount: number }> };
      }
      const shares = splitEvenly(Number(receipt.totalAmount), rest.length);
      for (const [i, v] of rest.entries()) {
        const before = v.transferBillCost === null ? null : Number(v.transferBillCost);
        if (before === shares[i]) continue;
        await tx.vehicle.update({ where: { id: v.id }, data: { transferBillCost: shares[i] } });
        await this.log(tx, v.id, `หารยอดใบเสร็จแจ้งย้ายใหม่ (ถอดรถ ${target.chassis} ออกจากใบ): ${remark}`, {
          transferBillCost: { from: before === null ? null : before.toFixed(2), to: shares[i].toFixed(2) },
        });
      }
      return { id, deleted: false, storageKey: null as string | null, vehicles: rest.map((v, i) => ({ id: v.id, amount: shares[i] })) };
    });
    if (result.deleted && result.storageKey) await this.storage.delete(result.storageKey).catch(() => undefined);
    return { id: result.id, deleted: result.deleted, vehicles: result.vehicles };
  }
}
