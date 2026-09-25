import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

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
      where: { id: vehicleId, deletedAt: null, bookReceivedDate: null, ...vehicleTypeWhere() },
      select: { id: true, documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    });
    if (!vehicle || vehicle.documentSubmissions[0]?.status !== 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'รถคันนี้ไม่อยู่ในคิวรอรับเล่ม (รับเล่มไปแล้ว หรือยังไม่ได้รับใบเสร็จ)' });
    }
    return vehicle;
  }

  // multipart: file + vehicleId + date (YYYY-MM-DD) -> เก็บรูป แล้วตั้ง bookReceivedDate + bookPhotoId ของรถคันนั้น
  async attach(file: UploadedReceiptFile | undefined, vehicleIdRaw: unknown, dateRaw: unknown) {
    const date = parseIsoDate(dateRaw);
    const vehicleId = typeof vehicleIdRaw === 'string' ? vehicleIdRaw : '';
    const vehicle = await this.pendingVehicle(vehicleId);
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.bookPhoto.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    const now = new Date();
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
        // updateMany + bookReceivedDate: null กันกดพร้อมกันสองเครื่องแล้วทับรูปกัน
        const { count } = await tx.vehicle.updateMany({
          where: { id: vehicle.id, bookReceivedDate: null },
          data: { bookReceivedDate: date, bookPhotoId: photo.id },
        });
        if (count === 0) throw new BadRequestException({ error: 'รถคันนี้รับเล่มไปแล้ว' });
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return { vehicleId: vehicle.id };
  }

  async getImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const photo = await this.prisma.bookPhoto.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!photo) throw new NotFoundException({ error: 'ไม่พบรูปเล่มทะเบียน' });
    try {
      return { data: await this.storage.get(photo.storageKey), mimeType: photo.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียนในที่เก็บ' });
    }
  }
}
