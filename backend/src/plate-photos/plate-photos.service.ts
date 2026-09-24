import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { assertKindInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { isMotorcycle } from '../document-submission/document-fee-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackgroundReads, isBackgroundFlag } from '../receipts/background-reads.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { PLATE_READER, type PlateExtraction, type PlateReader } from './plate-reader.js';
import { matchPlate, type PlateCandidate, type PlateKind, type PlateMatch, type ReadPlate } from './plate-reading.js';

const photoSelect = { id: true, kind: true, extractionSource: true, extraction: true, readPending: true, closedAt: true, createdAt: true } as const;

// body ใช้แยกรถยนต์/มอเตอร์ไซค์ (รย.12 = มอเตอร์ไซค์) - ป้ายสองประเภทเลขซ้ำกันได้ จึงจับคู่เฉพาะประเภทเดียวกับรูป
const candidateSelect = { id: true, plateCategory: true, plateNumber: true, registrationProvince: true, body: true } as const;

const vehicleKind = (body: string | null): PlateKind => (isMotorcycle(body) ? 'moto' : 'car');

// แท็บรถยนต์/มอเตอร์ไซค์ในหน้ารับป้าย
export function parseKind(raw: unknown): PlateKind {
  if (raw === 'car' || raw === 'moto') return raw;
  throw new BadRequestException({ error: 'กรุณาเลือกประเภทป้าย: รถยนต์ หรือ มอเตอร์ไซค์' });
}

// ข้อมูลรถที่หน้าเว็บใช้แสดงคู่กับป้ายที่อ่านได้
const vehicleSelect = {
  ...candidateSelect,
  chassis: true,
  plateReceivedDate: true,
  customer: { select: { name: true } },
} as const;

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

type PhotoRow = { id: string; kind: string; extractionSource: string; extraction: unknown; readPending: boolean; closedAt: Date | null; createdAt: Date };

// รูปป้ายทะเบียน (Step 6): อัปโหลด -> AI อ่านเลขทะเบียน -> จับคู่กับรถที่รอรับป้าย (ทะเบียนรู้แล้วจาก Step 5)
// AI ไม่บันทึกเอง: พนักงานกดยืนยัน (confirm) แล้วจึงตั้ง plateReceivedDate + platePhotoId
@Injectable()
export class PlatePhotosService implements OnApplicationBootstrap {
  // เลือกหลายรูปจากคลังภาพ = อ่านเบื้องหลัง (ดู background-reads.ts) · ถ่ายจากกล้องยังอ่านทันที
  private readonly reads = new BackgroundReads(PlatePhotosService.name, (id) => this.readOne(id));

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(PLATE_READER) private readonly reader: PlateReader,
  ) {}

  // เงื่อนไขเดียวกับคิวรับป้ายใน ReceivingService: ยังไม่รับป้าย + การยื่นเอกสารล่าสุด = RECEIPT_RECEIVED
  private async pendingCandidates() {
    const vehicles = await this.prisma.vehicle.findMany({
      // ...vehicleTypeWhere(): STAFF_CAR / STAFF_MOTO จับคู่ได้เฉพาะประเภทรถของตัวเอง (แท็บถูกกันไว้แล้วอีกชั้นที่ listOpen/upload)
      where: { plateReceivedDate: null, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } }, ...vehicleTypeWhere() },
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
            where: {
              plateReceivedDate: { not: null },
              plateNumber: { in: [...new Set(plates.map((p) => p.number ?? '').filter(Boolean))] },
              ...vehicleTypeWhere(),
            },
            select: candidateSelect,
          })
        : Promise.resolve([] as Array<PlateCandidate & { body: string | null }>),
    ]);
    const matched = photos.map((photo) => {
      const kind = photo.kind === 'moto' ? 'moto' : 'car';
      const sameKind = (v: PlateCandidate & { body: string | null }) => vehicleKind(v.body) === kind;
      const [p, r] = [pending.filter(sameKind), received.filter(sameKind)];
      return { photo, plates: plateList(photo.extraction).map((plate) => ({ ...plate, match: matchPlate(plate, p, r, kind) })) };
    });
    const ids = [...new Set(matched.flatMap((m) => m.plates.flatMap((p) => p.match.vehicleIds)))];
    const vehicles = ids.length ? await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: vehicleSelect }) : [];
    return {
      photos: matched.map(({ photo, plates: ps }) => ({
        id: photo.id,
        kind: photo.kind,
        extractionSource: photo.extractionSource,
        error: extractionError(photo.extraction),
        readPending: photo.readPending,
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

  // รูปที่ค้างรออ่านตอน server รีสตาร์ท -> อ่านต่อ · ปิด AI ไปแล้ว -> เลิกรอ (แสดงแบบไม่มี AI)
  async onApplicationBootstrap() {
    if (this.reader.source === 'NONE') {
      await this.prisma.platePhoto.updateMany({ where: { readPending: true }, data: { readPending: false } });
      return;
    }
    const pending = await this.prisma.platePhoto.findMany({ where: { readPending: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    for (const { id } of pending) this.reads.enqueue(id, null);
  }

  // จับคู่คำนวณใหม่ทุกครั้งที่ดู (withMatches) จึงแค่บันทึกผลอ่าน - รูปถูกลบระหว่างรออ่าน = updateMany ไม่เจอแถว
  private async readOne(id: string) {
    const row = await this.prisma.platePhoto.findUnique({ where: { id }, select: { storageKey: true, mimeType: true, readPending: true } });
    if (!row?.readPending) return;
    let extraction: unknown;
    try {
      extraction = await this.reader.read(await this.storage.get(row.storageKey), row.mimeType);
    } catch {
      extraction = { error: 'อ่านรูปไม่สำเร็จ' };
    }
    await this.prisma.platePhoto.updateMany({
      where: { id, readPending: true },
      data: { readPending: false, ...(extraction ? { extraction: extraction as object } : {}) },
    });
  }

  // backgroundRaw = '1' -> เก็บรูปแล้วตอบทันที AI อ่านทีหลัง (รูปขึ้นในถาดเป็น readPending)
  async upload(file: UploadedReceiptFile | undefined, kindRaw: unknown, backgroundRaw?: unknown) {
    const kind = parseKind(kindRaw);
    assertKindInScope(kind); // STAFF_CAR ถ่ายได้เฉพาะแท็บรถยนต์ / STAFF_MOTO เฉพาะแท็บมอเตอร์ไซค์
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปป้ายทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    // ตรวจรูปซ้ำก่อนส่งให้ AI อ่าน (นับทั้งแท็บรถยนต์และมอเตอร์ไซค์)
    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.platePhoto.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    const now = new Date();
    const storageKey = `plates/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    const background = isBackgroundFlag(backgroundRaw) && this.reader.source !== 'NONE';
    const extraction = background ? null : await this.reader.read(file.buffer, type.mimeType);
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      const photo = await this.prisma.platePhoto.create({
        data: {
          storageKey,
          contentHash,
          kind,
          mimeType: type.mimeType,
          sizeBytes: file.size,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
          extractionSource: this.reader.source,
          readPending: background,
          ...(extraction ? { extraction: extraction as object } : {}),
        },
        select: photoSelect,
      });
      if (background) this.reads.enqueue(photo.id);
      return this.withMatches([photo]);
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
  }

  // ถาดรอยืนยัน: รูปที่ยังไม่ได้ยืนยัน/ปิด (รวมที่ถ่ายจากมือถือ)
  async listOpen(kindRaw: unknown) {
    const kind = parseKind(kindRaw);
    assertKindInScope(kind);
    const photos = await this.prisma.platePhoto.findMany({ where: { closedAt: null, kind }, orderBy: { createdAt: 'asc' }, take: 200, select: photoSelect });
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

    const pendingKinds = new Map((await this.pendingCandidates()).map((v) => [v.id, vehicleKind(v.body)])); // vehicleId -> car/moto
    // ผู้ใช้ 2026-09-21: ต้องมีรูปป้ายทุกคัน - รถที่ไม่มีรูปที่มีอยู่จริงยืนยันไม่ได้
    const requestedPhotoIds = [...new Set(items.map((it) => it?.photoId).filter((id): id is string => typeof id === 'string'))];
    const photoKinds = new Map(
      requestedPhotoIds.length
        ? (await this.prisma.platePhoto.findMany({ where: { id: { in: requestedPhotoIds } }, select: { id: true, kind: true } })).map((p) => [p.id, p.kind])
        : [],
    );
    const succeeded: string[] = [];
    const failed: Array<{ vehicleId: string; error: string }> = [];
    for (const item of items) {
      const vehicleId = typeof item?.vehicleId === 'string' ? item.vehicleId : '';
      const photoId = typeof item?.photoId === 'string' && photoKinds.has(item.photoId) ? item.photoId : null;
      if (!photoId) {
        failed.push({ vehicleId, error: 'ต้องมีรูปป้ายทะเบียนของรถคันนี้ก่อนยืนยัน' });
        continue;
      }
      const kind = pendingKinds.get(vehicleId);
      if (!kind) {
        failed.push({ vehicleId, error: 'รถคันนี้ไม่อยู่ในคิวรอรับป้าย (รับป้ายไปแล้ว หรือยังไม่ได้รับใบเสร็จ)' });
        continue;
      }
      if (photoKinds.get(photoId) !== kind) {
        failed.push({ vehicleId, error: kind === 'moto' ? 'รถคันนี้เป็นมอเตอร์ไซค์ แต่รูปป้ายถ่ายในแท็บรถยนต์' : 'รถคันนี้เป็นรถยนต์ แต่รูปป้ายถ่ายในแท็บมอเตอร์ไซค์' });
        continue;
      }
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { plateReceivedDate: date, platePhotoId: photoId } });
      pendingKinds.delete(vehicleId); // กันยืนยันคันเดิมซ้ำจากป้ายหน้า/หลังในคำขอเดียวกัน
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
