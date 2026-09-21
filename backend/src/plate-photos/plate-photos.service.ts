import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { PLATE_READER, type PlateExtraction, type PlateReader } from './plate-reader.js';
import { matchPlate, type PlateCandidate, type PlateMatch, type ReadPlate } from './plate-reading.js';

const photoSelect = { id: true, extractionSource: true, extraction: true, closedAt: true, createdAt: true } as const;

const candidateSelect = { id: true, plateCategory: true, plateNumber: true, registrationProvince: true } as const;

// ข้อมูลรถที่หน้าเว็บใช้แสดงคู่กับป้ายที่อ่านได้
const vehicleSelect = {
  ...candidateSelect,
  chassis: true,
  body: true,
  plateReceivedDate: true,
  customer: { select: { name: true } },
} as const;

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

type PhotoRow = { id: string; extractionSource: string; extraction: unknown; closedAt: Date | null; createdAt: Date };

// รูปป้ายทะเบียน (Step 6): อัปโหลด -> AI อ่านเลขทะเบียน -> จับคู่กับรถที่รอรับป้าย (ทะเบียนรู้แล้วจาก Step 5)
// AI ไม่บันทึกเอง: พนักงานกดยืนยัน (confirm) แล้วจึงตั้ง plateReceivedDate + platePhotoId
@Injectable()
export class PlatePhotosService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(PLATE_READER) private readonly reader: PlateReader,
  ) {}

  // เงื่อนไขเดียวกับคิวรับป้ายใน ReceivingService: ยังไม่รับป้าย + การยื่นเอกสารล่าสุด = RECEIPT_RECEIVED
  private async pendingCandidates() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { plateReceivedDate: null, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } } },
      select: { ...candidateSelect, documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    });
    return vehicles.filter((v) => v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED');
  }

  // จับคู่ใหม่ทุกครั้งที่ดู (คิวเปลี่ยนตลอด - รถที่เพิ่งได้ใบเสร็จ/เพิ่งรับป้ายไป) แล้วแนบข้อมูลรถที่เกี่ยวข้อง
  private async withMatches(photos: PhotoRow[]) {
    const plates = photos.flatMap((p) => plateList(p.extraction));
    const [pending, received] = await Promise.all([
      this.pendingCandidates(),
      plates.length
        ? this.prisma.vehicle.findMany({
            where: { plateReceivedDate: { not: null }, plateNumber: { in: [...new Set(plates.map((p) => p.number ?? '').filter(Boolean))] } },
            select: candidateSelect,
          })
        : Promise.resolve([] as PlateCandidate[]),
    ]);
    const matched = photos.map((photo) => ({
      photo,
      plates: plateList(photo.extraction).map((plate) => ({ ...plate, match: matchPlate(plate, pending, received) })),
    }));
    const ids = [...new Set(matched.flatMap((m) => m.plates.flatMap((p) => p.match.vehicleIds)))];
    const vehicles = ids.length ? await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: vehicleSelect }) : [];
    return {
      photos: matched.map(({ photo, plates: ps }) => ({
        id: photo.id,
        extractionSource: photo.extractionSource,
        error: extractionError(photo.extraction),
        closedAt: photo.closedAt?.toISOString() ?? null,
        createdAt: photo.createdAt.toISOString(),
        plates: ps as Array<ReadPlate & { match: PlateMatch }>,
      })),
      vehicles: vehicles.map((v) => ({
        id: v.id,
        customerName: v.customer.name,
        chassis: v.chassis,
        body: v.body,
        plateCategory: v.plateCategory,
        plateNumber: v.plateNumber,
        registrationProvince: v.registrationProvince,
        plateReceivedDate: v.plateReceivedDate?.toISOString().slice(0, 10) ?? null,
      })),
    };
  }

  async upload(file: UploadedReceiptFile | undefined) {
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const now = new Date();
    const storageKey = `plates/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    const extraction = await this.reader.read(file.buffer, type.mimeType);
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      const photo = await this.prisma.platePhoto.create({
        data: {
          storageKey,
          mimeType: type.mimeType,
          sizeBytes: file.size,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
          extractionSource: this.reader.source,
          ...(extraction ? { extraction: extraction as object } : {}),
        },
        select: photoSelect,
      });
      return this.withMatches([photo]);
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  // ถาดรอยืนยัน: รูปที่ยังไม่ได้ยืนยัน/ปิด (รวมที่ถ่ายจากมือถือ)
  async listOpen() {
    const photos = await this.prisma.platePhoto.findMany({ where: { closedAt: null }, orderBy: { createdAt: 'asc' }, take: 200, select: photoSelect });
    return this.withMatches(photos);
  }

  async getImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const photo = await this.prisma.platePhoto.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!photo) throw new NotFoundException({ error: 'ไม่พบรูปป้ายทะเบียน' });
    try {
      return { data: await this.storage.get(photo.storageKey), mimeType: photo.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียนในที่เก็บ' });
    }
  }

  // ยืนยันรับป้าย: items = คู่ (รถ, รูปที่เป็นหลักฐาน) ที่พนักงานติ๊ก - ทำทีละคัน (best-effort) คันที่ผิดเงื่อนไขแจ้งกลับ
  // closePhotoIds = รูปที่ยืนยันเสร็จแล้ว ย้ายออกจากถาด (แม้บางแผ่นในรูปจะจับคู่ไม่ได้ - พนักงานเห็นแล้วตอนยืนยัน)
  async confirm(dto: { date?: unknown; items?: unknown; closePhotoIds?: unknown }) {
    const date = parseIsoDate(dto?.date);
    if (!Array.isArray(dto?.items)) throw new BadRequestException({ error: 'ไม่พบรายการรถที่จะยืนยัน' });
    const items = dto.items as Array<{ vehicleId?: unknown; photoId?: unknown }>;
    const closePhotoIds = Array.isArray(dto.closePhotoIds) ? dto.closePhotoIds.filter((id): id is string => typeof id === 'string') : [];

    const pendingIds = new Set((await this.pendingCandidates()).map((v) => v.id));
    // ผู้ใช้ 2026-09-21: ต้องมีรูปป้ายทุกคัน - รถที่ไม่มีรูปที่มีอยู่จริงยืนยันไม่ได้
    const requestedPhotoIds = [...new Set(items.map((it) => it?.photoId).filter((id): id is string => typeof id === 'string'))];
    const photoIds = new Set(
      requestedPhotoIds.length
        ? (await this.prisma.platePhoto.findMany({ where: { id: { in: requestedPhotoIds } }, select: { id: true } })).map((p) => p.id)
        : [],
    );
    const succeeded: string[] = [];
    const failed: Array<{ vehicleId: string; error: string }> = [];
    for (const item of items) {
      const vehicleId = typeof item?.vehicleId === 'string' ? item.vehicleId : '';
      const photoId = typeof item?.photoId === 'string' && photoIds.has(item.photoId) ? item.photoId : null;
      if (!photoId) {
        failed.push({ vehicleId, error: 'ต้องมีรูปป้ายทะเบียนของรถคันนี้ก่อนยืนยัน' });
        continue;
      }
      if (!pendingIds.has(vehicleId)) {
        failed.push({ vehicleId, error: 'รถคันนี้ไม่อยู่ในคิวรอรับป้าย (รับป้ายไปแล้ว หรือยังไม่ได้รับใบเสร็จ)' });
        continue;
      }
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { plateReceivedDate: date, platePhotoId: photoId } });
      pendingIds.delete(vehicleId); // กันยืนยันคันเดิมซ้ำจากป้ายหน้า/หลังในคำขอเดียวกัน
      succeeded.push(vehicleId);
    }
    if (closePhotoIds.length) {
      await this.prisma.platePhoto.updateMany({ where: { id: { in: closePhotoIds }, closedAt: null }, data: { closedAt: new Date() } });
    }
    return { succeeded, failed };
  }

  // ลบได้เฉพาะรูปที่ยังไม่ถูกใช้เป็นหลักฐานของรถคันไหน
  async remove(id: string) {
    const photo = await this.prisma.platePhoto.findUnique({ where: { id }, select: { storageKey: true, _count: { select: { vehicles: true } } } });
    if (!photo) throw new NotFoundException({ error: 'ไม่พบรูปป้ายทะเบียน' });
    if (photo._count.vehicles > 0) throw new BadRequestException({ error: 'รูปนี้ใช้ยืนยันการรับป้ายแล้ว ลบไม่ได้' });
    await this.prisma.platePhoto.delete({ where: { id } });
    await this.storage.delete(photo.storageKey).catch(() => undefined);
    return { id };
  }
}

function plateList(extraction: unknown): ReadPlate[] {
  const e = extraction as PlateExtraction | null;
  return e && 'plates' in e ? e.plates : [];
}

function extractionError(extraction: unknown): string | null {
  const e = extraction as PlateExtraction | null;
  return e && 'error' in e ? e.error : null;
}
