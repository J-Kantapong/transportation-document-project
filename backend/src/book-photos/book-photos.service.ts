import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackgroundReads, isBackgroundFlag } from '../receipts/background-reads.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { BOOK_READER, type BookExtraction, type BookReader } from './book-reader.js';
import { matchBook, normChassis, type BookCandidate, type BookMatch, type ReadBook } from './book-reading.js';

const photoSelect = { id: true, extractionSource: true, extraction: true, readPending: true, closedAt: true, createdAt: true } as const;

const candidateSelect = { id: true, chassis: true, plateCategory: true, plateNumber: true, registrationProvince: true } as const;

// ข้อมูลรถที่หน้าเว็บใช้แสดงคู่กับเล่มที่อ่านได้
const vehicleSelect = {
  ...candidateSelect,
  body: true,
  bookReceivedDate: true,
  customer: { select: { name: true } },
} as const;

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

type PhotoRow = { id: string; extractionSource: string; extraction: unknown; readPending: boolean; closedAt: Date | null; createdAt: Date };

// รูปเล่มทะเบียน (Step 7): อัปโหลด -> AI อ่านเลขตัวรถ + ทะเบียน -> จับคู่กับรถที่รอรับเล่ม
// โครงเดียวกับรูปป้าย (plate-photos) - AI ไม่บันทึกเอง: พนักงานกดยืนยันแล้วจึงตั้ง bookReceivedDate + bookPhotoId
@Injectable()
export class BookPhotosService implements OnApplicationBootstrap {
  // เลือกหลายรูปจากคลังภาพ = อ่านเบื้องหลัง (ดู background-reads.ts) · ถ่ายจากกล้องยังอ่านทันที
  private readonly reads = new BackgroundReads(BookPhotosService.name, (id) => this.readOne(id));

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(BOOK_READER) private readonly reader: BookReader,
  ) {}

  // เงื่อนไขเดียวกับคิวรับเล่มใน ReceivingService: ยังไม่รับเล่ม + การยื่นเอกสารล่าสุด = RECEIPT_RECEIVED
  private async pendingCandidates(): Promise<BookCandidate[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      // ...vehicleTypeWhere(): STAFF_CAR / STAFF_MOTO จับคู่/ยืนยันรับเล่มได้เฉพาะประเภทรถของตัวเอง
      where: { bookReceivedDate: null, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } }, ...vehicleTypeWhere() },
      select: { ...candidateSelect, documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true } } },
    });
    return vehicles.filter((v) => v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED');
  }

  // จับคู่ใหม่ทุกครั้งที่ดู (คิวเปลี่ยนตลอด) แล้วแนบข้อมูลรถที่เกี่ยวข้อง
  private async withMatches(photos: PhotoRow[]) {
    const books = photos.flatMap((p) => bookList(p.extraction));
    const vins = [...new Set(books.map((b) => normChassis(b.chassis)).filter(Boolean))];
    const numbers = [...new Set(books.map((b) => (b.number ?? '').replace(/\D/g, '').replace(/^0+/, '')).filter(Boolean))];
    const [pending, received] = await Promise.all([
      this.pendingCandidates(),
      books.length
        ? this.prisma.vehicle.findMany({
            where: {
              bookReceivedDate: { not: null },
              OR: [{ chassis: { in: vins, mode: 'insensitive' } }, { plateNumber: { in: numbers } }],
              ...vehicleTypeWhere(),
            },
            select: candidateSelect,
          })
        : Promise.resolve([] as BookCandidate[]),
    ]);
    const matched = photos.map((photo) => ({
      photo,
      books: bookList(photo.extraction).map((book) => ({ ...book, match: matchBook(book, pending, received) })),
    }));
    const ids = [...new Set(matched.flatMap((m) => m.books.flatMap((b) => b.match.vehicleIds)))];
    const vehicles = ids.length ? await this.prisma.vehicle.findMany({ where: { id: { in: ids } }, select: vehicleSelect }) : [];
    return {
      photos: matched.map(({ photo, books: bs }) => ({
        id: photo.id,
        extractionSource: photo.extractionSource,
        error: extractionError(photo.extraction),
        readPending: photo.readPending,
        closedAt: photo.closedAt?.toISOString() ?? null,
        createdAt: photo.createdAt.toISOString(),
        books: bs as Array<ReadBook & { match: BookMatch }>,
      })),
      vehicles: vehicles.map((v) => ({
        id: v.id,
        customerName: v.customer.name,
        chassis: v.chassis,
        body: v.body,
        plateCategory: v.plateCategory,
        plateNumber: v.plateNumber,
        registrationProvince: v.registrationProvince,
        bookReceivedDate: v.bookReceivedDate?.toISOString().slice(0, 10) ?? null,
      })),
    };
  }

  // รูปที่ค้างรออ่านตอน server รีสตาร์ท -> อ่านต่อ · ปิด AI ไปแล้ว -> เลิกรอ (แสดงแบบไม่มี AI)
  async onApplicationBootstrap() {
    if (this.reader.source === 'NONE') {
      await this.prisma.bookPhoto.updateMany({ where: { readPending: true }, data: { readPending: false } });
      return;
    }
    const pending = await this.prisma.bookPhoto.findMany({ where: { readPending: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    for (const { id } of pending) this.reads.enqueue(id, null);
  }

  // จับคู่คำนวณใหม่ทุกครั้งที่ดู (withMatches) จึงแค่บันทึกผลอ่าน - รูปถูกลบระหว่างรออ่าน = updateMany ไม่เจอแถว
  private async readOne(id: string) {
    const row = await this.prisma.bookPhoto.findUnique({ where: { id }, select: { storageKey: true, mimeType: true, readPending: true } });
    if (!row?.readPending) return;
    let extraction: unknown;
    try {
      extraction = await this.reader.read(await this.storage.get(row.storageKey), row.mimeType);
    } catch {
      extraction = { error: 'อ่านรูปไม่สำเร็จ' };
    }
    await this.prisma.bookPhoto.updateMany({
      where: { id, readPending: true },
      data: { readPending: false, ...(extraction ? { extraction: extraction as object } : {}) },
    });
  }

  // backgroundRaw = '1' -> เก็บรูปแล้วตอบทันที AI อ่านทีหลัง (รูปขึ้นในถาดเป็น readPending)
  async upload(file: UploadedReceiptFile | undefined, backgroundRaw?: unknown) {
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปเล่มทะเบียน' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    // ตรวจรูปซ้ำก่อนส่งให้ AI อ่าน
    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.bookPhoto.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    const now = new Date();
    const storageKey = `books/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    const background = isBackgroundFlag(backgroundRaw) && this.reader.source !== 'NONE';
    const extraction = background ? null : await this.reader.read(file.buffer, type.mimeType);
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      const photo = await this.prisma.bookPhoto.create({
        data: {
          storageKey,
          contentHash,
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
  async listOpen() {
    const photos = await this.prisma.bookPhoto.findMany({ where: { closedAt: null }, orderBy: { createdAt: 'asc' }, take: 200, select: photoSelect });
    return this.withMatches(photos);
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

  // ยืนยันรับเล่ม: items = คู่ (รถ, รูปที่เป็นหลักฐาน) ที่พนักงานติ๊ก - ทำทีละคัน (best-effort) คันที่ผิดเงื่อนไขแจ้งกลับ
  // closePhotoIds = รูปที่ยืนยันเสร็จแล้ว ย้ายออกจากถาด
  async confirm(dto: { date?: unknown; items?: unknown; closePhotoIds?: unknown }) {
    const date = parseIsoDate(dto?.date);
    if (!Array.isArray(dto?.items)) throw new BadRequestException({ error: 'ไม่พบรายการรถที่จะยืนยัน' });
    const items = dto.items as Array<{ vehicleId?: unknown; photoId?: unknown }>;
    const closePhotoIds = Array.isArray(dto.closePhotoIds) ? dto.closePhotoIds.filter((id): id is string => typeof id === 'string') : [];

    const pendingIds = new Set((await this.pendingCandidates()).map((v) => v.id));
    // เหมือนรับป้าย: ต้องมีรูปเล่มทุกคัน - รถที่ไม่มีรูปที่มีอยู่จริงยืนยันไม่ได้
    const requestedPhotoIds = [...new Set(items.map((it) => it?.photoId).filter((id): id is string => typeof id === 'string'))];
    const photoIds = new Set(
      requestedPhotoIds.length
        ? (await this.prisma.bookPhoto.findMany({ where: { id: { in: requestedPhotoIds } }, select: { id: true } })).map((p) => p.id)
        : [],
    );
    const succeeded: string[] = [];
    const failed: Array<{ vehicleId: string; error: string }> = [];
    for (const item of items) {
      const vehicleId = typeof item?.vehicleId === 'string' ? item.vehicleId : '';
      const photoId = typeof item?.photoId === 'string' && photoIds.has(item.photoId) ? item.photoId : null;
      if (!photoId) {
        failed.push({ vehicleId, error: 'ต้องมีรูปเล่มทะเบียนของรถคันนี้ก่อนยืนยัน' });
        continue;
      }
      if (!pendingIds.has(vehicleId)) {
        failed.push({ vehicleId, error: 'รถคันนี้ไม่อยู่ในคิวรอรับเล่ม (รับเล่มไปแล้ว หรือยังไม่ได้รับใบเสร็จ)' });
        continue;
      }
      await this.prisma.vehicle.update({ where: { id: vehicleId }, data: { bookReceivedDate: date, bookPhotoId: photoId } });
      pendingIds.delete(vehicleId); // กันยืนยันคันเดิมซ้ำในคำขอเดียวกัน
      succeeded.push(vehicleId);
    }
    if (closePhotoIds.length) {
      await this.prisma.bookPhoto.updateMany({ where: { id: { in: closePhotoIds }, closedAt: null }, data: { closedAt: new Date() } });
    }
    return { succeeded, failed };
  }

  // ลบได้เฉพาะรูปที่ยังไม่ถูกใช้เป็นหลักฐานของรถคันไหน
  async remove(id: string) {
    const photo = await this.prisma.bookPhoto.findUnique({ where: { id }, select: { storageKey: true, _count: { select: { vehicles: true } } } });
    if (!photo) throw new NotFoundException({ error: 'ไม่พบรูปเล่มทะเบียน' });
    if (photo._count.vehicles > 0) throw new BadRequestException({ error: 'รูปนี้ใช้ยืนยันการรับเล่มแล้ว ลบไม่ได้' });
    await this.prisma.bookPhoto.delete({ where: { id } });
    await this.storage.delete(photo.storageKey).catch(() => undefined);
    return { id };
  }
}

function bookList(extraction: unknown): ReadBook[] {
  const e = extraction as BookExtraction | null;
  return e && 'books' in e ? e.books : [];
}

function extractionError(extraction: unknown): string | null {
  const e = extraction as BookExtraction | null;
  return e && 'error' in e ? e.error : null;
}
