import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { assertVehicleInScope, currentWriteScope, isVehicleInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { DUPLICATE_UPLOAD_ERROR, contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { isMotorcycle } from '../document-submission/document-fee-calculator.js';
import {
  type DetachedPhoto,
  assertNotDeliveredYet,
  assertReceivedDateInRange,
  isoDay,
  parseFixRemark,
  parseReceivedDate,
  staleReceivedRow,
} from '../receiving/received-date.js';

// รูปป้ายทะเบียน (Step 6): พนักงานแนบรูปป้ายให้รถทีละคันจากคิวรอรับป้าย แล้วบันทึกรับป้ายทันที
// (ผู้ใช้ 2026-09-26 ยกเลิก AI อ่าน/จับคู่รูป - เดิมอัปโหลดเข้าถาด AI อ่านทะเบียนแล้วพนักงานกดยืนยัน)
// ยังบังคับมีรูปทุกคันเหมือนเดิม (ผู้ใช้ 2026-09-21) และกันไฟล์เดิมซ้ำด้วย contentHash
@Injectable()
export class PlatePhotosService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // เงื่อนไขเดียวกับคิวรับป้ายใน ReceivingService: ยังไม่รับป้าย + การยื่นเอกสารล่าสุด = RECEIPT_RECEIVED
  // ...vehicleTypeWhere(): STAFF_CAR / STAFF_MOTO รับป้ายได้เฉพาะประเภทรถของตัวเอง
  private async pendingVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null, plateReceivedDate: null, ...vehicleTypeWhere(currentWriteScope()) },
      select: {
        id: true,
        chassis: true,
        body: true,
        deliveredDate: true,
        plateDeliveredDate: true,
        customer: { select: { name: true } },
        documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, submitDate: true, receiptDate: true } },
      },
    });
    if (!vehicle || vehicle.documentSubmissions[0]?.status !== 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'รถคันนี้ไม่อยู่ในคิวรอรับป้าย (รับป้ายไปแล้ว หรือยังไม่ได้รับใบเสร็จ)' });
    }
    return vehicle;
  }

  // updateMany + plateReceivedDate: null กันกดพร้อมกันสองเครื่องแล้วทับรูปกัน
  private async linkVehicle(tx: Prisma.TransactionClient, vehicleId: string, date: Date, photoId: string) {
    const { count } = await tx.vehicle.updateMany({
      where: { id: vehicleId, plateReceivedDate: null },
      data: { plateReceivedDate: date, platePhotoId: photoId },
    });
    if (count === 0) throw new BadRequestException({ error: 'รถคันนี้รับป้ายไปแล้ว' });
  }

  // multipart: file + vehicleId + date (YYYY-MM-DD) -> เก็บรูป แล้วตั้ง plateReceivedDate + platePhotoId ของรถคันนั้น
  async attach(file: UploadedReceiptFile | undefined, vehicleIdRaw: unknown, dateRaw: unknown) {
    const date = parseReceivedDate(dateRaw);
    const vehicleId = typeof vehicleIdRaw === 'string' ? vehicleIdRaw : '';
    const vehicle = await this.pendingVehicle(vehicleId);
    assertReceivedDateInRange('วันที่รับป้าย', date, vehicle.documentSubmissions[0]);
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const kind = isMotorcycle(vehicle.body) ? 'moto' : 'car';
    const contentHash = contentHashOf(file.buffer);
    const existing = await this.prisma.platePhoto.findUnique({
      where: { contentHash },
      select: { id: true, vehicles: { take: 1, select: { chassis: true, body: true } } },
    });
    const now = new Date();
    if (existing?.vehicles[0]) {
      // บอกว่ารูปไปอยู่กับรถคันไหน (เฉพาะคันที่ผู้ใช้เห็นได้) - แนบผิดคันจะได้รู้ (พบ 2026-09-27)
      const holder = existing.vehicles[0];
      throw duplicateUpload(isVehicleInScope(holder.body) ? `${DUPLICATE_UPLOAD_ERROR} (เป็นรูปป้ายของรถเลขตัวถัง ${holder.chassis})` : undefined);
    }
    if (existing) {
      // รูปที่อัปโหลดเข้าถาด AI เดิม (ก่อน 2026-09-26) แล้วไม่ได้ผูกกับรถคันไหน ยังถือ contentHash ไว้และลบไม่ได้แล้ว
      // (พบ 2026-09-27: แนบไฟล์เดิมแล้วได้ 409) -> ใช้แถวเดิม ไม่ต้องเก็บไฟล์ซ้ำเพราะไฟล์เดียวกันอยู่ในที่เก็บแล้ว
      await this.prisma.$transaction(async (tx) => {
        // แก้แถวรูปก่อน = ล็อกแถวไว้ คำขอที่ใช้รูปเดียวกันพร้อมกันต้องรอ แล้วการนับด้านล่างจะเห็นรถของคำขอก่อน
        await tx.platePhoto.update({ where: { id: existing.id }, data: { closedAt: now, kind, readPending: false } });
        await this.linkVehicle(tx, vehicle.id, date, existing.id);
        if ((await tx.vehicle.count({ where: { platePhotoId: existing.id } })) > 1) throw duplicateUpload();
      });
      return this.attachResult(vehicle, date);
    }

    const storageKey = `plates/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        const photo = await tx.platePhoto.create({
          data: {
            storageKey,
            contentHash,
            kind,
            mimeType: type.mimeType,
            sizeBytes: file.size,
            originalName: file.originalname ? file.originalname.slice(0, 200) : null,
            closedAt: now,
          },
          select: { id: true },
        });
        await this.linkVehicle(tx, vehicle.id, date, photo.id);
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return this.attachResult(vehicle, date);
  }

  // alreadyDelivered: ส่งเล่มให้ลูกค้าไปแล้วแต่ป้ายยังไม่ได้ส่ง -> รถกลับเข้าคิว Delivery เป็น "ส่งป้ายอย่างเดียว"
  // (พบ 2026-09-27: แนบรูปป้ายทีหลังแล้วพนักงานนึกว่าข้อมูลไม่อัพเดท) หน้าเว็บให้เลือก: ป้ายไปพร้อมเล่มจริง (แนบรูปช้า)
  // = กด "ป้ายไปพร้อมเล่มแล้ว" ที่ใบส่งเล่มในหน้ารายงานส่งงาน (ผู้ใช้ 2026-09-27) หรือยังไม่ได้ส่ง = ส่งป้ายอย่างเดียวที่หน้า Delivery
  // bookDeliveredDate + bookSlipNo = วันที่/เลข DL ของใบส่งเล่ม ไว้บอกพนักงานและเทียบกับวันที่รับป้าย
  private async attachResult(
    vehicle: { id: string; chassis: string; deliveredDate: Date | null; plateDeliveredDate: Date | null; customer: { name: string } },
    date: Date,
  ) {
    const alreadyDelivered = !!vehicle.deliveredDate && !vehicle.plateDeliveredDate;
    // รูปบันทึกไปแล้ว - หาเลขใบส่งเล่มไม่ได้ก็แค่ไม่บอกเลข (ห้ามตอบ error ไม่งั้นพนักงานแนบซ้ำแล้วได้ 409)
    const bookItem = alreadyDelivered
      ? await this.prisma.deliverySlipItem
          .findFirst({
            where: { vehicleId: vehicle.id, book: true, cancelledAt: null },
            orderBy: { slip: { slipNo: 'desc' } },
            select: { slip: { select: { slipNo: true } } },
          })
          .catch(() => null)
      : null;
    return {
      vehicleId: vehicle.id,
      chassis: vehicle.chassis,
      date: isoDay(date),
      alreadyDelivered,
      customerName: vehicle.customer.name,
      bookDeliveredDate: alreadyDelivered && vehicle.deliveredDate ? isoDay(vehicle.deliveredDate) : null,
      bookSlipNo: bookItem?.slip.slipNo ?? null,
    };
  }

  // รถที่รับป้ายแล้วและยังไม่ได้ส่งป้ายให้ลูกค้า - ใช้ก่อนแก้วันที่รับ/ถอดรูป (ขอบเขตการแก้ของผู้ใช้: ADMIN ทุกคัน,
  // STAFF_CAR / STAFF_MOTO เฉพาะประเภทรถของตัวเอง - access-policy.ts กันบทบาทอื่นไว้แล้ว)
  private async receivedVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null },
      select: {
        id: true,
        chassis: true,
        body: true,
        plateReceivedDate: true,
        platePhotoId: true,
        plateDeliveredDate: true,
        documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { submitDate: true, receiptDate: true } },
      },
    });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertVehicleInScope(vehicle.body);
    const { plateReceivedDate } = vehicle;
    if (!plateReceivedDate) throw new BadRequestException({ error: 'รถคันนี้ยังไม่ได้รับป้าย' });
    assertNotDeliveredYet('ป้าย', vehicle.plateDeliveredDate);
    return { ...vehicle, plateReceivedDate };
  }

  // แก้วันที่รับป้ายที่พิมพ์ผิด (ผู้ใช้ 2026-09-27) - ต้องมีเหตุผล, ช่วงวันที่เดียวกับตอนแนบ, ก่อนส่งป้ายเท่านั้น
  async updateReceivedDate(vehicleId: string, dto: { date?: unknown; remark?: unknown }) {
    const remark = parseFixRemark(dto?.remark, 'แก้วันที่รับป้าย');
    const date = parseReceivedDate(dto?.date);
    const vehicle = await this.receivedVehicle(vehicleId);
    assertReceivedDateInRange('วันที่รับป้าย', date, vehicle.documentSubmissions[0]);
    const before = isoDay(vehicle.plateReceivedDate);
    if (before === isoDay(date)) throw new BadRequestException({ error: 'วันที่ไม่ได้เปลี่ยน' });
    await this.prisma.$transaction(async (tx) => {
      // เงื่อนไขรูป/วันที่เดิม + ยังไม่ส่งป้าย กันแก้ทับการถอดรูปหรือการบันทึกส่งงานจากอีกเครื่อง
      const { count } = await tx.vehicle.updateMany({
        where: { id: vehicle.id, platePhotoId: vehicle.platePhotoId, plateReceivedDate: vehicle.plateReceivedDate, plateDeliveredDate: null },
        data: { plateReceivedDate: date },
      });
      if (count === 0) throw staleReceivedRow();
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: vehicle.id,
          remark,
          changes: JSON.stringify({ plateReceivedDate: { from: before, to: isoDay(date) } }),
          editedById: currentUser()?.id ?? null,
        },
      });
    });
    return { vehicleId: vehicle.id, chassis: vehicle.chassis, date: isoDay(date) };
  }

  // ถอดรูปป้ายที่แนบผิดคัน/ผิดรูป (ผู้ใช้ 2026-09-27): ล้างวันที่รับป้าย + รูป รถกลับเข้าคิวรอรับป้าย - ต้องมีเหตุผล, ก่อนส่งป้ายเท่านั้น
  // ลบแถวรูปด้วยให้ contentHash ว่าง (แนบไฟล์เดิมให้คันที่ถูกได้) ยกเว้นรูปเก่าจากถาด AI ที่ยังผูกกับรถคันอื่นอยู่
  // ไฟล์ในที่เก็บลบหลัง transaction สำเร็จ (ลบก่อนแล้ว transaction ล้ม = รถยังชี้ไปที่ไฟล์ที่หายไปแล้ว)
  // photo บอกหน้าเว็บว่ารูปถูกลบจริงไหม (shared = แนบไฟล์เดิมให้คันอื่นไม่ได้ ต้องถ่ายใหม่ - พบ 2026-09-27)
  async detach(vehicleId: string, dto: { remark?: unknown }): Promise<{ vehicleId: string; chassis: string; photo: DetachedPhoto }> {
    const remark = parseFixRemark(dto?.remark, 'ถอดรูปป้าย');
    const vehicle = await this.receivedVehicle(vehicleId);
    const photoId = vehicle.platePhotoId;
    const { removed, photo } = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicle.updateMany({
        where: { id: vehicle.id, platePhotoId: photoId, plateReceivedDate: { not: null }, plateDeliveredDate: null },
        data: { plateReceivedDate: null, platePhotoId: null },
      });
      if (count === 0) throw staleReceivedRow();
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: vehicle.id,
          remark,
          changes: JSON.stringify({
            plateReceivedDate: { from: isoDay(vehicle.plateReceivedDate), to: null },
            platePhotoId: { from: photoId, to: null },
          }),
          editedById: currentUser()?.id ?? null,
        },
      });
      if (!photoId) return { removed: null, photo: 'none' as const };
      if ((await tx.vehicle.count({ where: { platePhotoId: photoId } })) > 0) return { removed: null, photo: 'shared' as const };
      return { removed: await tx.platePhoto.delete({ where: { id: photoId }, select: { storageKey: true } }), photo: 'deleted' as const };
    });
    if (removed) await this.storage.delete(removed.storageKey).catch(() => undefined);
    return { vehicleId: vehicle.id, chassis: vehicle.chassis, photo };
  }

  // ดูรูปได้เมื่อรูปผูกกับรถในขอบเขตประเภทรถของผู้ใช้ หรือยังไม่ผูกกับรถคันไหน (รูปค้างในถาด AI เดิม)
  // (พบ 2026-09-27: เดิมไม่ตรวจประเภทรถ STAFF_CAR เปิดรูปป้ายจักรยานยนต์ได้ถ้ารู้ id)
  async getImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const photo = await this.prisma.platePhoto.findFirst({
      where: { id, OR: [{ vehicles: { none: {} } }, { vehicles: { some: vehicleTypeWhere() } }] },
      select: { storageKey: true, mimeType: true },
    });
    if (!photo) throw new NotFoundException({ error: 'ไม่พบรูปป้ายทะเบียน' });
    try {
      return { data: await this.storage.get(photo.storageKey), mimeType: photo.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียนในที่เก็บ' });
    }
  }
}
