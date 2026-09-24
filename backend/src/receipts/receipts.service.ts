import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { assertVehicleInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtraction, type ReceiptExtractor } from './receipt-extractor.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from './receipt-storage.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from './upload-hash.js';

// ใบเสร็จที่ AI อ่านได้ซ้ำกับที่มีในระบบแล้ว (ผู้ใช้ 2026-09-24: เตือน ไม่บล็อก เพราะ AI อ่านผิดได้) เก็บใน extraction.duplicate
// receiptNo = เลขที่ใบเสร็จตรงกับใบที่บันทึก/อัปโหลดไว้แล้ว · chassis = รถคันนี้มีรูปใบเสร็จแล้วหรือรับใบเสร็จแล้ว (รถ 1 คันต่อใบเสร็จ 1 ใบ)
export interface ReceiptDuplicate {
  by: 'receiptNo' | 'chassis';
  receiptNo: string | null;
  chassis: string | null;
  receivedDate: string | null; // YYYY-MM-DD = รถคันนั้นรับใบเสร็จแล้ว (Step 5)
}

const isoDate = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? null;

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
      select: { id: true, status: true, vehicle: { select: { body: true } } },
    });
    if (!submission) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    assertVehicleInScope(submission.vehicle.body); // STAFF_CAR / STAFF_MOTO แนบใบเสร็จได้เฉพาะประเภทรถของตัวเอง
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
        where: { status: 'PENDING', vehicle: { chassis, ...vehicleTypeWhere() } },
        select: { id: true },
      });
      return found ? { submissionId: found.id, match: 'chassis' } : { submissionId: null, match: null };
    }
    const target = await this.prisma.documentSubmission.findUnique({ where: { id: submissionId }, select: { vehicle: { select: { chassis: true } } } });
    return { submissionId, match: target && target.vehicle.chassis.toUpperCase() !== chassis ? 'chassis-mismatch' : null };
  }

  // หาใบเสร็จที่ซ้ำจากข้อมูลที่ AI อ่าน (selfId = รูปนี้เอง ไม่นับ) - ไม่มีผลอ่าน = ไม่รู้ ไม่เตือน
  // ไม่กรองตามประเภทรถของผู้ใช้: ใบเสร็จซ้ำกับรถประเภทอื่นก็ยังเป็นใบซ้ำ
  private async findDuplicate(extraction: ReceiptExtraction | null, selfId: string | null): Promise<ReceiptDuplicate | null> {
    if (!extraction || !('reading' in extraction)) return null;
    const receiptNo = extraction.reading.receiptNo?.trim();
    const chassis = extraction.reading.chassis?.trim().toUpperCase();
    const notSelf = selfId ? { id: { not: selfId } } : {};

    if (receiptNo && /^\d+\/\d+$/.test(receiptNo)) {
      // เลขที่ใบเสร็จที่พนักงานยืนยันแล้วใน Step 5 ก่อน แล้วจึงเลขที่ AI อ่านจากรูปอื่น (ไม่รวมใบเสร็จงานสลับเลข)
      const saved = await this.prisma.documentSubmission.findFirst({
        where: { receiptNo, status: { not: 'FAILED' } },
        select: { receiptReceivedDate: true, vehicle: { select: { chassis: true } } },
      });
      if (saved) return { by: 'receiptNo', receiptNo, chassis: saved.vehicle.chassis, receivedDate: isoDate(saved.receiptReceivedDate) };
      const image = await this.prisma.receiptImage.findFirst({
        where: { ...notSelf, plateSwapId: null, extraction: { path: ['reading', 'receiptNo'], equals: receiptNo } },
        select: { extraction: true, submission: { select: { receiptReceivedDate: true, vehicle: { select: { chassis: true } } } } },
      });
      if (image) {
        const read = image.extraction as { reading?: { chassis?: string | null } } | null;
        return {
          by: 'receiptNo',
          receiptNo,
          chassis: image.submission?.vehicle.chassis ?? read?.reading?.chassis ?? null,
          receivedDate: isoDate(image.submission?.receiptReceivedDate),
        };
      }
    }

    if (chassis && chassis.length === 17) {
      const submission = await this.prisma.documentSubmission.findFirst({
        where: {
          vehicle: { chassis: { equals: chassis, mode: 'insensitive' }, deletedAt: null },
          OR: [{ status: 'RECEIPT_RECEIVED' }, { status: 'PENDING', receipts: { some: notSelf } }],
        },
        orderBy: { createdAt: 'desc' },
        select: { receiptNo: true, receiptReceivedDate: true },
      });
      if (submission) return { by: 'chassis', receiptNo: submission.receiptNo, chassis, receivedDate: isoDate(submission.receiptReceivedDate) };
    }
    return null;
  }

  // submissionId ไม่ส่ง = อัปโหลดแบบหลายใบ (มี AI จะจับคู่ด้วยเลขตัวถังให้ ไม่งั้นรอพนักงานจับคู่)
  async upload(file: UploadedReceiptFile | undefined, submissionIdRaw?: unknown) {
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปใบเสร็จ' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    // ตรวจรูปซ้ำก่อนส่งให้ AI อ่าน - ไม่เสียค่า AI กับรูปที่มีอยู่แล้ว
    const contentHash = await this.assertNotUploaded(file.buffer);
    const submissionId =
      submissionIdRaw === undefined || submissionIdRaw === null || submissionIdRaw === '' ? null : await this.assertAttachable(submissionIdRaw);

    const now = new Date();
    const storageKey = `receipts/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    const extraction = await this.extractor.extract(file.buffer, type.mimeType);
    const duplicate = await this.findDuplicate(extraction, null);
    // อัปโหลดหลายใบแล้วเจอใบซ้ำ -> ไม่แนบให้อัตโนมัติ รอในถาดพร้อมคำเตือน ให้พนักงานดูแล้วลบ (แนบในแถวรถ = แนบตามที่เลือก แต่เตือน)
    const matched = duplicate && !submissionId ? { submissionId: null, match: null } : await this.matchByChassis(extraction, submissionId);
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      const receipt = await this.prisma.receiptImage.create({
        data: {
          submissionId: matched.submissionId,
          storageKey,
          contentHash,
          mimeType: type.mimeType,
          sizeBytes: file.size,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
          extractionSource: this.extractor.source,
          ...(extraction ? { extraction: { ...extraction, match: matched.match, duplicate } as object } : {}),
        },
        select: receiptSelect,
      });
      return { receipt };
    } catch (err) {
      // บันทึกลงฐานข้อมูลไม่สำเร็จ - ลบไฟล์ทิ้งไม่ให้ค้างโดยไม่มีแถวอ้างถึง
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
  }

  // ใบเสร็จทุกแบบ (Step 5 และงานสลับเลข) อยู่ในตาราง ReceiptImage เดียวกัน - รูปเดิมใช้ได้ครั้งเดียวทั้งระบบ
  private async assertNotUploaded(buf: Buffer): Promise<string> {
    const contentHash = contentHashOf(buf);
    const existing = await this.prisma.receiptImage.findUnique({ where: { contentHash }, select: { id: true } });
    if (existing) throw duplicateUpload();
    return contentHash;
  }

  // รูปที่อัปโหลดแบบหลายใบแล้วยังไม่ได้จับคู่กับรถ (ไม่รวมใบเสร็จงานสลับเลข ซึ่งผูกกับงานผ่าน plateSwapId)
  async listUnassigned() {
    const receipts = await this.prisma.receiptImage.findMany({
      where: { submissionId: null, plateSwapId: null },
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
    const duplicate = await this.findDuplicate(extraction, id); // เช็กใหม่ - ใบเดิมอาจถูกลบไปแล้ว
    const receipt = await this.prisma.receiptImage.update({
      where: { id },
      data: { submissionId, ...(extraction ? { extraction: { ...extraction, match: matched.match, duplicate } as object } : {}) },
      select: receiptSelect,
    });
    return { receipt };
  }

  // ลบได้เฉพาะรูปที่ยังไม่จับคู่ หรือของรายการที่ยังรอใบเสร็จ - รับใบเสร็จแล้วรูปเป็นหลักฐานวางบิล ห้ามลบ
  async remove(id: string) {
    const receipt = await this.prisma.receiptImage.findUnique({
      where: { id },
      select: { id: true, storageKey: true, plateSwapId: true, submission: { select: { status: true } } },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (receipt.submission?.status === 'RECEIPT_RECEIVED') {
      throw new BadRequestException({ error: 'รายการนี้รับใบเสร็จแล้ว ลบรูปใบเสร็จไม่ได้' });
    }
    // ใบเสร็จงานสลับเลขลบผ่าน DELETE /api/plate-swaps/:id/receipts/:receiptId (รับเอกสารกลับแล้วห้ามลบ)
    if (receipt.plateSwapId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานสลับเลข ลบจากหน้างานสลับเลข' });
    await this.prisma.receiptImage.delete({ where: { id } });
    await this.storage.delete(receipt.storageKey).catch(() => undefined);
    return { id };
  }
}
