import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { assertVehicleInScope, currentWriteScope, isVehicleInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { DUPLICATE_UPLOAD_ERROR, contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import {
  type DetachedPhoto,
  assertNotDeliveredYet,
  assertReceivedDateInRange,
  isoDay,
  parseFixRemark,
  parseReceivedDate,
  staleReceivedRow,
} from '../receiving/received-date.js';

// รูปเล่มทะเบียน (Step 7): พนักงานแนบรูปเล่มให้รถทีละคันจากคิวรอรับเล่ม แล้วบันทึกรับเล่มทันที
// (ผู้ใช้ 2026-09-26 ยกเลิก AI อ่าน/จับคู่รูป - เดิมอัปโหลดเข้าถาด AI อ่านเลขตัวรถแล้วพนักงานกดยืนยัน)
// ยังบังคับมีรูปทุกคันเหมือนเดิม และกันไฟล์เดิมซ้ำด้วย contentHash
@Injectable()
export class BookPhotosService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // เงื่อนไขเดียวกับคิวรับเล่มใน ReceivingService: ยังไม่รับเล่ม + การยื่นเอกสารล่าสุด = RECEIPT_RECEIVED
  // ...vehicleTypeWhere(): STAFF_CAR / STAFF_MOTO รับเล่มได้เฉพาะประเภทรถของตัวเอง
  private async pendingVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null, bookReceivedDate: null, ...vehicleTypeWhere(currentWriteScope()) },
      select: {
        id: true,
        chassis: true,
        documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, submitDate: true, receiptDate: true } },
      },
    });
    if (!vehicle || vehicle.documentSubmissions[0]?.status !== 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'รถคันนี้ไม่อยู่ในคิวรอรับเล่ม (รับเล่มไปแล้ว หรือยังไม่ได้รับใบเสร็จ)' });
    }
    return vehicle;
  }

  // updateMany + bookReceivedDate: null กันกดพร้อมกันสองเครื่องแล้วทับรูปกัน
  private async linkVehicle(tx: Prisma.TransactionClient, vehicleId: string, date: Date, photoId: string) {
    const { count } = await tx.vehicle.updateMany({
      where: { id: vehicleId, bookReceivedDate: null },
      data: { bookReceivedDate: date, bookPhotoId: photoId },
    });
    if (count === 0) throw new BadRequestException({ error: 'รถคันนี้รับเล่มไปแล้ว' });
  }

  // multipart: file + vehicleId + date (YYYY-MM-DD) -> เก็บรูป แล้วตั้ง bookReceivedDate + bookPhotoId ของรถคันนั้น
  async attach(file: UploadedReceiptFile | undefined, vehicleIdRaw: unknown, dateRaw: unknown) {
    const date = parseReceivedDate(dateRaw);
    const vehicleId = typeof vehicleIdRaw === 'string' ? vehicleIdRaw : '';
    const vehicle = await this.pendingVehicle(vehicleId);
    assertReceivedDateInRange('วันที่รับเล่ม', date, vehicle.documentSubmissions[0]);
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const contentHash = contentHashOf(file.buffer);
    const existing = await this.prisma.bookPhoto.findUnique({
      where: { contentHash },
      select: { id: true, vehicles: { take: 1, select: { chassis: true, body: true } } },
    });
    const now = new Date();
    if (existing?.vehicles[0]) {
      // บอกว่ารูปไปอยู่กับรถคันไหน (เฉพาะคันที่ผู้ใช้เห็นได้) - แนบผิดคันจะได้รู้ (พบ 2026-09-27)
      const holder = existing.vehicles[0];
      throw duplicateUpload(isVehicleInScope(holder.body) ? `${DUPLICATE_UPLOAD_ERROR} (เป็นรูปเล่มของรถเลขตัวถัง ${holder.chassis})` : undefined);
    }
    if (existing) {
      // รูปที่อัปโหลดเข้าถาด AI เดิม (ก่อน 2026-09-26) แล้วไม่ได้ผูกกับรถคันไหน ยังถือ contentHash ไว้และลบไม่ได้แล้ว
      // (พบ 2026-09-27: แนบไฟล์เดิมแล้วได้ 409) -> ใช้แถวเดิม ไม่ต้องเก็บไฟล์ซ้ำเพราะไฟล์เดียวกันอยู่ในที่เก็บแล้ว
      await this.prisma.$transaction(async (tx) => {
        // แก้แถวรูปก่อน = ล็อกแถวไว้ คำขอที่ใช้รูปเดียวกันพร้อมกันต้องรอ แล้วการนับด้านล่างจะเห็นรถของคำขอก่อน
        await tx.bookPhoto.update({ where: { id: existing.id }, data: { closedAt: now, readPending: false } });
        await this.linkVehicle(tx, vehicle.id, date, existing.id);
        if ((await tx.vehicle.count({ where: { bookPhotoId: existing.id } })) > 1) throw duplicateUpload();
      });
      return { vehicleId: vehicle.id, chassis: vehicle.chassis, date: isoDay(date) };
    }

    const storageKey = `books/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        const photo = await tx.bookPhoto.create({
          data: {
            storageKey,
            contentHash,
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
    return { vehicleId: vehicle.id, chassis: vehicle.chassis, date: isoDay(date) };
  }

  // รถที่รับเล่มแล้วและยังไม่ได้ส่งเล่มให้ลูกค้า - ใช้ก่อนแก้วันที่รับ/ถอดรูป (ขอบเขตการแก้ของผู้ใช้: ADMIN ทุกคัน,
  // STAFF_CAR / STAFF_MOTO เฉพาะประเภทรถของตัวเอง - access-policy.ts กันบทบาทอื่นไว้แล้ว)
  private async receivedVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null },
      select: {
        id: true,
        chassis: true,
        body: true,
        bookReceivedDate: true,
        bookPhotoId: true,
        deliveredDate: true,
        documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { submitDate: true, receiptDate: true } },
      },
    });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertVehicleInScope(vehicle.body);
    const { bookReceivedDate } = vehicle;
    if (!bookReceivedDate) throw new BadRequestException({ error: 'รถคันนี้ยังไม่ได้รับเล่ม' });
    assertNotDeliveredYet('เล่ม', vehicle.deliveredDate);
    return { ...vehicle, bookReceivedDate };
  }

  // แก้วันที่รับเล่มที่พิมพ์ผิด (ผู้ใช้ 2026-09-27) - ต้องมีเหตุผล, ช่วงวันที่เดียวกับตอนแนบ, ก่อนส่งเล่มเท่านั้น
  async updateReceivedDate(vehicleId: string, dto: { date?: unknown; remark?: unknown }) {
    const remark = parseFixRemark(dto?.remark, 'แก้วันที่รับเล่ม');
    const date = parseReceivedDate(dto?.date);
    const vehicle = await this.receivedVehicle(vehicleId);
    assertReceivedDateInRange('วันที่รับเล่ม', date, vehicle.documentSubmissions[0]);
    const before = isoDay(vehicle.bookReceivedDate);
    if (before === isoDay(date)) throw new BadRequestException({ error: 'วันที่ไม่ได้เปลี่ยน' });
    await this.prisma.$transaction(async (tx) => {
      // เงื่อนไขรูป/วันที่เดิม + ยังไม่ส่งเล่ม กันแก้ทับการถอดรูปหรือการบันทึกส่งงานจากอีกเครื่อง
      const { count } = await tx.vehicle.updateMany({
        where: { id: vehicle.id, bookPhotoId: vehicle.bookPhotoId, bookReceivedDate: vehicle.bookReceivedDate, deliveredDate: null },
        data: { bookReceivedDate: date },
      });
      if (count === 0) throw staleReceivedRow();
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: vehicle.id,
          remark,
          changes: JSON.stringify({ bookReceivedDate: { from: before, to: isoDay(date) } }),
          editedById: currentUser()?.id ?? null,
        },
      });
    });
    return { vehicleId: vehicle.id, chassis: vehicle.chassis, date: isoDay(date) };
  }

  // ถอดรูปเล่มที่แนบผิดคัน/ผิดรูป (ผู้ใช้ 2026-09-27): ล้างวันที่รับเล่ม + รูป รถกลับเข้าคิวรอรับเล่ม (และออกจากคิว Delivery)
  // ต้องมีเหตุผล, ก่อนส่งเล่มเท่านั้น - ลบแถวรูปด้วยให้ contentHash ว่าง ยกเว้นรูปเก่าจากถาด AI ที่ยังผูกกับรถคันอื่นอยู่
  // ไฟล์ในที่เก็บลบหลัง transaction สำเร็จ (ลบก่อนแล้ว transaction ล้ม = รถยังชี้ไปที่ไฟล์ที่หายไปแล้ว)
  // photo บอกหน้าเว็บว่ารูปถูกลบจริงไหม (shared = แนบไฟล์เดิมให้คันอื่นไม่ได้ ต้องถ่ายใหม่ - พบ 2026-09-27)
  async detach(vehicleId: string, dto: { remark?: unknown }): Promise<{ vehicleId: string; chassis: string; photo: DetachedPhoto }> {
    const remark = parseFixRemark(dto?.remark, 'ถอดรูปเล่ม');
    const vehicle = await this.receivedVehicle(vehicleId);
    const photoId = vehicle.bookPhotoId;
    const { removed, photo } = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicle.updateMany({
        where: { id: vehicle.id, bookPhotoId: photoId, bookReceivedDate: { not: null }, deliveredDate: null },
        data: { bookReceivedDate: null, bookPhotoId: null },
      });
      if (count === 0) throw staleReceivedRow();
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: vehicle.id,
          remark,
          changes: JSON.stringify({
            bookReceivedDate: { from: isoDay(vehicle.bookReceivedDate), to: null },
            bookPhotoId: { from: photoId, to: null },
          }),
          editedById: currentUser()?.id ?? null,
        },
      });
      if (!photoId) return { removed: null, photo: 'none' as const };
      if ((await tx.vehicle.count({ where: { bookPhotoId: photoId } })) > 0) return { removed: null, photo: 'shared' as const };
      return { removed: await tx.bookPhoto.delete({ where: { id: photoId }, select: { storageKey: true } }), photo: 'deleted' as const };
    });
    if (removed) await this.storage.delete(removed.storageKey).catch(() => undefined);
    return { vehicleId: vehicle.id, chassis: vehicle.chassis, photo };
  }

  // ดูรูปได้เมื่อรูปผูกกับรถในขอบเขตประเภทรถของผู้ใช้ หรือยังไม่ผูกกับรถคันไหน (รูปค้างในถาด AI เดิม)
  // (พบ 2026-09-27: เดิมไม่ตรวจประเภทรถ STAFF_CAR เปิดรูปเล่มจักรยานยนต์ได้ถ้ารู้ id)
  async getImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const photo = await this.prisma.bookPhoto.findFirst({
      where: { id, OR: [{ vehicles: { none: {} } }, { vehicles: { some: vehicleTypeWhere() } }] },
      select: { storageKey: true, mimeType: true },
    });
    if (!photo) throw new NotFoundException({ error: 'ไม่พบรูปเล่มทะเบียน' });
    try {
      return { data: await this.storage.get(photo.storageKey), mimeType: photo.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียนในที่เก็บ' });
    }
  }
}
