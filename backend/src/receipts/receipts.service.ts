import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtraction, type ReceiptExtractor } from './receipt-extractor.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from './receipt-storage.js';

// ไฟล์จาก multer (memory storage) - ใช้แค่ฟิลด์เหล่านี้
export interface UploadedReceiptFile {
  buffer: Buffer;
  size: number;
  originalname: string;
}

// หน้าเว็บย่อรูปก่อนส่ง (~200KB) - เพดานนี้กันไฟล์ต้นฉบับจากกล้องที่ไม่ได้ย่อ
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

// ข้อมูลที่ส่งกลับหน้าเว็บ (ไม่รวม storageKey - หน้าเว็บโหลดรูปผ่าน GET /api/receipts/:id/image)
const receiptSelect = {
  id: true,
  submissionId: true,
  mimeType: true,
  sizeBytes: true,
  originalName: true,
  extractionSource: true,
  extraction: true,
  createdAt: true,
} as const;

// ดูชนิดไฟล์จาก byte แรกของไฟล์ ไม่เชื่อ mimetype/นามสกุลที่ browser ส่งมา - รับเฉพาะรูป JPEG/PNG/WebP
export function detectImageType(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mimeType: 'image/jpeg', ext: 'jpg' };
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', ext: 'png' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { mimeType: 'image/webp', ext: 'webp' };
  }
  return null;
}

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // แนบรูปได้เฉพาะรายการที่ยังรอใบเสร็จหรือรับใบเสร็จแล้ว - ยื่นไม่สำเร็จ (FAILED) ไม่มีใบเสร็จ
  private async assertAttachable(submissionIdRaw: unknown): Promise<string> {
    if (typeof submissionIdRaw !== 'string' || !submissionIdRaw.trim()) {
      throw new BadRequestException({ error: 'กรุณาเลือกรายการที่จะแนบใบเสร็จ' });
    }
    const submission = await this.prisma.documentSubmission.findUnique({
      where: { id: submissionIdRaw.trim() },
      select: { id: true, status: true },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    if (submission.status === 'FAILED') {
      throw new BadRequestException({ error: 'รายการนี้ยื่นไม่สำเร็จ แนบใบเสร็จไม่ได้' });
    }
    return submission.id;
  }

  // จับคู่ด้วยเลขตัวถังที่ AI อ่านได้:
  // - อัปโหลดหลายใบ (ไม่ระบุรถ): หารถที่รอใบเสร็จซึ่งเลขตัวถังตรงเป๊ะ -> แนบให้เลย (match = 'chassis')
  // - แนบในแถวของรถ: เลขตัวถังในใบเสร็จไม่ตรงกับรถคันนั้น -> เตือน (match = 'chassis-mismatch') แต่ยังแนบตามที่พนักงานเลือก
  // ไม่มีผลอ่าน/อ่านเลขตัวถังไม่ได้ = ไม่จับคู่ให้ (match = null)
  private async matchByChassis(
    extraction: ReceiptExtraction | null,
    submissionId: string | null,
  ): Promise<{ submissionId: string | null; match: 'chassis' | 'chassis-mismatch' | null }> {
    const chassis = extraction && 'reading' in extraction ? extraction.reading.chassis?.trim().toUpperCase() : undefined;
    if (!chassis) return { submissionId, match: null };
    if (!submissionId) {
      const found = await this.prisma.documentSubmission.findFirst({
        where: { status: 'PENDING', vehicle: { chassis } },
        select: { id: true },
      });
      return found ? { submissionId: found.id, match: 'chassis' } : { submissionId: null, match: null };
    }
    const target = await this.prisma.documentSubmission.findUnique({ where: { id: submissionId }, select: { vehicle: { select: { chassis: true } } } });
    return { submissionId, match: target && target.vehicle.chassis.toUpperCase() !== chassis ? 'chassis-mismatch' : null };
  }

  // submissionId ไม่ส่ง = อัปโหลดแบบหลายใบ (มี AI จะจับคู่ด้วยเลขตัวถังให้ ไม่งั้นรอพนักงานจับคู่)
  async upload(file: UploadedReceiptFile | undefined, submissionIdRaw?: unknown) {
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปใบเสร็จ' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    const submissionId =
      submissionIdRaw === undefined || submissionIdRaw === null || submissionIdRaw === '' ? null : await this.assertAttachable(submissionIdRaw);

    const now = new Date();
    const storageKey = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    const extraction = await this.extractor.extract(file.buffer, type.mimeType);
    const matched = await this.matchByChassis(extraction, submissionId);
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      const receipt = await this.prisma.receiptImage.create({
        data: {
          submissionId: matched.submissionId,
          storageKey,
          mimeType: type.mimeType,
          sizeBytes: file.size,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
          extractionSource: this.extractor.source,
          ...(extraction ? { extraction: { ...extraction, match: matched.match } as object } : {}),
        },
        select: receiptSelect,
      });
      return { receipt };
    } catch (err) {
      // บันทึกลงฐานข้อมูลไม่สำเร็จ - ลบไฟล์ทิ้งไม่ให้ค้างโดยไม่มีแถวอ้างถึง
      await this.storage.delete(storageKey).catch(() => undefined);
      throw err;
    }
  }

  // รูปที่อัปโหลดแบบหลายใบแล้วยังไม่ได้จับคู่กับรถ
  async listUnassigned() {
    const receipts = await this.prisma.receiptImage.findMany({
      where: { submissionId: null },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: receiptSelect,
    });
    return { receipts };
  }

  async getImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const receipt = await this.prisma.receiptImage.findUnique({ where: { id }, select: { storageKey: true, mimeType: true } });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    try {
      return { data: await this.storage.get(receipt.storageKey), mimeType: receipt.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปใบเสร็จในที่เก็บ' });
    }
  }

  async assign(id: string, submissionIdRaw: unknown) {
    const existing = await this.prisma.receiptImage.findUnique({ where: { id }, select: { id: true, extraction: true } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    const submissionId = await this.assertAttachable(submissionIdRaw);
    // พนักงานจับคู่เอง - เช็กเลขตัวถังที่ AI อ่านได้กับรถที่เลือกอีกรอบ
    const extraction = existing.extraction as ReceiptExtraction | null;
    const matched = await this.matchByChassis(extraction, submissionId);
    const receipt = await this.prisma.receiptImage.update({
      where: { id },
      data: { submissionId, ...(extraction ? { extraction: { ...extraction, match: matched.match } as object } : {}) },
      select: receiptSelect,
    });
    return { receipt };
  }

  // ลบได้เฉพาะรูปที่ยังไม่จับคู่ หรือของรายการที่ยังรอใบเสร็จ - รับใบเสร็จแล้วรูปเป็นหลักฐานวางบิล ห้ามลบ
  async remove(id: string) {
    const receipt = await this.prisma.receiptImage.findUnique({
      where: { id },
      select: { id: true, storageKey: true, submission: { select: { status: true } } },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (receipt.submission?.status === 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'รายการนี้รับใบเสร็จแล้ว ลบรูปใบเสร็จไม่ได้' });
    }
    await this.prisma.receiptImage.delete({ where: { id } });
    await this.storage.delete(receipt.storageKey).catch(() => undefined);
    return { id };
  }
}
