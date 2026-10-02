import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, type OnApplicationBootstrap } from '@nestjs/common';
import { assertVehicleInScope, currentWriteScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { lockSubmissions } from '../document-submission/submission-lock.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackgroundReads, isBackgroundFlag } from './background-reads.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtraction, type ReceiptExtractor } from './receipt-extractor.js';
import { CHASSIS_LENGTH, CHASSIS_PREFIX, CHASSIS_SERIAL_LENGTH, isNearChassis } from './receipt-extraction.js';
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

type ReceiptMatch = 'chassis' | 'chassis-near' | 'chassis-mismatch' | null;

// ไฟล์จาก multer (memory storage) - ใช้แค่ฟิลด์เหล่านี้
export interface UploadedReceiptFile {
  buffer: Buffer;
  size: number;
  originalname: string;
}

// หน้าเว็บย่อรูปก่อนส่ง (~200KB) - เพดานนี้กันไฟล์ต้นฉบับจากกล้องที่ไม่ได้ย่อ
export const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;

// ถาดรูปรอจับคู่: โหลดทีละหน้า (โหลดเพิ่ม) - limit สูงสุดใช้ตอนหน้าเว็บโหลดใหม่ทั้งที่เปิดดูไว้หลายหน้าแล้ว
const UNASSIGNED_PAGE_SIZE = 200;
const UNASSIGNED_MAX_LIMIT = 1000;

// รูปที่ผู้ใช้เห็นได้: ยังไม่จับคู่ (ถาดรวม - ยังไม่รู้ประเภทรถ) หรืองานสลับเลข (ไม่มี submissionId) หรือรถที่อยู่ในขอบเขตการอ่าน
// (พบ 2026-09-27: เดิมดูรูป/ผลอ่านของรถประเภทอื่นได้ถ้ารู้ id)
const visibleReceiptWhere = () => ({ OR: [{ submissionId: null }, { submission: { vehicle: vehicleTypeWhere() } }] });

const isFlag = (v: unknown) => v === true || v === 'true' || v === '1';

const FAILED_ATTACH_ERROR = 'รายการนี้ยื่นไม่สำเร็จ แนบใบเสร็จไม่ได้';
const MOVE_RECEIVED_ERROR = 'รูปนี้เป็นใบเสร็จของรายการที่รับใบเสร็จแล้ว ย้ายไปรถคันอื่นไม่ได้';

// client ที่ใช้ล็อกแถวรายการแล้วเขียนรูป - PrismaService หรือ tx ของ $transaction
type LockClient = Pick<Prisma.TransactionClient, '$queryRaw' | 'receiptImage'>;

// ข้อมูลที่ส่งกลับหน้าเว็บ (ไม่รวม storageKey - หน้าเว็บโหลดรูปผ่าน GET /api/receipts/:id/image)
const receiptSelect = {
  id: true,
  submissionId: true,
  mimeType: true,
  sizeBytes: true,
  originalName: true,
  extractionSource: true,
  extraction: true,
  readPending: true,
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
export class ReceiptsService implements OnApplicationBootstrap {
  // เลือกหลายใบจากคลังภาพ = อ่านเบื้องหลัง · ถ่ายทีละใบยังอ่านทันที เพราะคนถ่ายต้องรู้ผลตอนใบเสร็จยังอยู่ในมือ
  private readonly reads = new BackgroundReads(ReceiptsService.name, (id) => this.readOne(id));
  private finishing: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // server รีสตาร์ทระหว่างอ่าน -> รูปที่ค้างสถานะรออ่านอยู่ในฐานข้อมูล อ่านต่อตอนเปิดใหม่
  // ปิด AI ไปแล้ว (ไม่มี ANTHROPIC_API_KEY) -> เลิกรอ ให้พนักงานจับคู่เองเหมือนรูปที่ไม่มี AI
  async onApplicationBootstrap() {
    if (this.extractor.source === 'NONE') {
      await this.prisma.receiptImage.updateMany({ where: { readPending: true }, data: { readPending: false } });
      return;
    }
    const pending = await this.prisma.receiptImage.findMany({ where: { readPending: true }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    for (const { id } of pending) this.reads.enqueue(id, null);
  }

  private async readOne(id: string) {
    const row = await this.prisma.receiptImage.findUnique({ where: { id }, select: { storageKey: true, mimeType: true, readPending: true } });
    if (!row?.readPending) return; // ลบไปแล้ว หรืออ่านไปแล้ว
    let extraction: ReceiptExtraction | null;
    try {
      extraction = await this.extractor.extract(await this.storage.get(row.storageKey), row.mimeType);
    } catch {
      extraction = { error: 'อ่านรูปไม่สำเร็จ' };
    }
    try {
      await this.serialize(async () => {
        const current = await this.prisma.receiptImage.findUnique({ where: { id }, select: { submissionId: true } });
        if (!current) return; // ลบไปแล้วระหว่างรออ่าน
        const duplicate = await this.findDuplicate(extraction, id);
        // พนักงานจับคู่เองระหว่างรออ่าน -> คงรถที่เลือกไว้ แค่เช็กเลขตัวถัง · ใบซ้ำ -> ไม่แนบให้อัตโนมัติ (เหมือน upload)
        const matched = current.submissionId
          ? await this.matchByChassis(extraction, current.submissionId)
          : duplicate
            ? { submissionId: null, match: null }
            : await this.matchByChassis(extraction, null);
        // ระบบจับคู่ให้เอง: ล็อกรายการแล้วดูว่ายังรอใบเสร็จอยู่ (lockAttachTarget) ไม่งั้นรอในถาด
        const auto = !current.submissionId && matched.submissionId !== null;
        const save = async (client: LockClient) => {
          const submissionId = auto && matched.submissionId ? await this.lockAttachTarget(client, matched.submissionId, true) : matched.submissionId;
          await client.receiptImage.update({
            where: { id },
            data: {
              readPending: false,
              submissionId,
              ...(extraction ? { extraction: { ...extraction, match: submissionId ? matched.match : null, duplicate } as object } : {}),
            },
          });
        };
        await (auto ? this.prisma.$transaction((tx) => save(tx)) : save(this.prisma));
      });
    } catch (err) {
      // บันทึกผลไม่สำเร็จ (ฐานข้อมูลสะดุด / รายการที่จับคู่ได้ถูกยกเลิกระหว่างนั้น) -> เลิกสถานะรออ่าน ไม่ให้ค้าง "กำลังอ่าน"
      // จนกว่า server จะรีสตาร์ท (แล้วจ่ายค่า AI ซ้ำ) - เก็บผลอ่านไว้แต่ไม่จับคู่ให้ พนักงานจับคู่เองจากถาด (พบ 2026-09-27)
      // updateMany: รูปถูกลบไปแล้วก็ไม่ error · submissionId คงค่าปัจจุบัน (ถ้ามีคนจับคู่เองไว้)
      await this.prisma.receiptImage.updateMany({
        where: { id, readPending: true },
        data: { readPending: false, extraction: { ...(extraction ?? { error: 'อ่านรูปไม่สำเร็จ' }), match: null, duplicate: null } as object },
      });
      throw err; // BackgroundReads เขียน log
    }
  }

  // ตรวจซ้ำ + จับคู่ + บันทึก ทำทีละใบ (AI อ่านพร้อมกันได้): รูปใบเสร็จใบเดียวกันสองรูปที่อ่านเสร็จพร้อมกันจะได้เห็นกัน
  // และไม่ทับรถที่พนักงานจับคู่เอง (assign ก็ผ่านตรงนี้) - backend มี process เดียว ล็อกในหน่วยความจำพอ
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.finishing.then(fn, fn);
    this.finishing = run.catch(() => undefined);
    return run;
  }

  // GET /api/receipts?ids=a,b - หน้าเว็บถามผลของรูปที่ส่งไปอ่านเบื้องหลัง
  // id ที่ไม่อยู่ในผลลัพธ์ = ถูกลบไปแล้ว หรือถูกจับคู่กับรถนอกขอบเขตของผู้ใช้ - หน้าเว็บเลิกถามแล้วเอาออกจากรายการ
  async findByIds(idsRaw: unknown) {
    const ids = typeof idsRaw === 'string' ? [...new Set(idsRaw.split(',').map((s) => s.trim()).filter(Boolean))].slice(0, 200) : [];
    if (ids.length === 0) return { receipts: [] };
    const receipts = await this.prisma.receiptImage.findMany({ where: { id: { in: ids }, ...visibleReceiptWhere() }, select: receiptSelect });
    return { receipts };
  }

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
      throw new BadRequestException({ error: FAILED_ATTACH_ERROR });
    }
    return submission.id;
  }

  // ก่อนเขียนรูปเข้ารายการ: ล็อกแถวรายการแล้วดูสถานะล่าสุด (submission-lock.ts) - ระหว่างที่ AI อ่าน/ถาดเปิดค้างไว้
  // อีกคนอาจบันทึกยื่นไม่สำเร็จหรือยกเลิกรายการไปแล้ว (พบ 2026-09-27: assertAttachable ตรวจแล้วค่อยเขียน รูปไปค้างกับรายการที่ยื่นไม่สำเร็จ)
  // auto = ระบบจับคู่ให้เอง: รายการไม่ได้รอใบเสร็จแล้ว -> ไม่แนบ (null = รอในถาด) · พนักงานเลือกรถเอง -> แจ้ง error
  private async lockAttachTarget(client: LockClient, submissionId: string, auto: boolean): Promise<string | null> {
    const status = (await lockSubmissions(client, [submissionId])).get(submissionId);
    if (auto) return status === 'PENDING' ? submissionId : null;
    if (!status) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
    if (status === 'FAILED') throw new BadRequestException({ error: FAILED_ATTACH_ERROR });
    return submissionId;
  }

  // จับคู่ด้วยเลขตัวถังที่ AI อ่านได้:
  // - อัปโหลดหลายใบ (ไม่ระบุรถ): หารถที่รอใบเสร็จซึ่งเลขตัวถังตรงเป๊ะ -> แนบให้เลย (match = 'chassis')
  // - แนบในแถวของรถ: เลขตัวถังในใบเสร็จไม่ตรงกับรถคันนั้น -> เตือน (match = 'chassis-mismatch') แต่ยังแนบตามที่พนักงานเลือก
  // - ไม่ตรงเป๊ะแต่ใกล้เคียง (isNearChassis: ตัวผิด หรือตัวหาย/เกิน 1 ตัว) = AI อ่านเพี้ยน -> match = 'chassis-near' หน้าเว็บให้เช็กเลขตัวถังกับรูป
  //   อัปโหลดหลายใบ: แนบให้เฉพาะเมื่อมีรถที่รอใบเสร็จ (PENDING และยังไม่มีรูปใบเสร็จ) ใกล้เคียงแค่คันเดียว
  // ไม่มีผลอ่าน/อ่านเลขตัวถังไม่ได้ = ไม่จับคู่ให้ (match = null)
  private async matchByChassis(
    extraction: ReceiptExtraction | null,
    submissionId: string | null,
  ): Promise<{ submissionId: string | null; match: ReceiptMatch }> {
    const chassis = extraction && 'reading' in extraction ? extraction.reading.chassis?.trim().toUpperCase() : undefined;
    if (!chassis) return { submissionId, match: null };
    if (!submissionId) {
      // แนบให้อัตโนมัติ = บันทึก จึงจำกัดตามขอบเขตการแก้ของคนอัปโหลด · เลขตัวถังไม่สนตัวพิมพ์ (พบ 2026-09-27: รถที่คีย์
      // เลขตัวถังตัวเล็กไว้จับคู่ไม่เจอเลย - ผลอ่าน AI เป็นตัวใหญ่เสมอ)
      const scope = vehicleTypeWhere(currentWriteScope());
      const found = await this.prisma.documentSubmission.findFirst({
        where: { status: 'PENDING', vehicle: { chassis: { equals: chassis, mode: 'insensitive' }, deletedAt: null, ...scope } },
        select: { id: true },
      });
      if (found) return { submissionId: found.id, match: 'chassis' };
      if (chassis.length === CHASSIS_LENGTH) {
        // ครบ 17 ตัว: เลขท้าย 6 ตัวต้องตรง รถคันข้างเคียงในล็อตจึงไม่มีทางใกล้ ดูแค่รถที่รอใบเสร็จ
        const candidates = await this.prisma.documentSubmission.findMany({
          where: {
            status: 'PENDING',
            receipts: { none: {} },
            vehicle: { chassis: { endsWith: chassis.slice(-CHASSIS_SERIAL_LENGTH), mode: 'insensitive' }, deletedAt: null, ...scope },
          },
          select: { id: true, vehicle: { select: { chassis: true } } },
        });
        const near = candidates.filter((c) => isNearChassis(chassis, c.vehicle.chassis));
        return near.length === 1 ? { submissionId: near[0].id, match: 'chassis-near' } : { submissionId: null, match: null };
      }
      // 16/18 ตัว: ต้องเป็นคันเดียวที่ใกล้ในบรรดารถที่ยื่นแล้วทุกคัน และคันนั้นยังรอใบเสร็จอยู่ในขอบเขตของคนอัปโหลด
      const near = await this.nearSubmittedVehicles(chassis);
      if (near.length !== 1) return { submissionId: null, match: null };
      const target = await this.prisma.documentSubmission.findFirst({
        where: { id: near[0].id, status: 'PENDING', receipts: { none: {} }, vehicle: { deletedAt: null, ...scope } },
        select: { id: true },
      });
      return target ? { submissionId: target.id, match: 'chassis-near' } : { submissionId: null, match: null };
    }
    const target = await this.prisma.documentSubmission.findUnique({ where: { id: submissionId }, select: { vehicle: { select: { chassis: true } } } });
    if (!target || target.vehicle.chassis.toUpperCase() === chassis) return { submissionId, match: null };
    if (!isNearChassis(chassis, target.vehicle.chassis)) return { submissionId, match: 'chassis-mismatch' };
    if (chassis.length === CHASSIS_LENGTH) return { submissionId, match: 'chassis-near' };
    // 16/18 ตัว: ใกล้ทั้งรถคันนี้และคันข้างเคียง = อาจแนบผิดคัน -> เตือนแบบไม่ตรง (หน้าเว็บถามยืนยันก่อนบันทึก)
    const near = await this.nearSubmittedVehicles(chassis);
    return { submissionId, match: near.length === 1 && near[0].id === submissionId ? 'chassis-near' : 'chassis-mismatch' };
  }

  // เลขตัวถังที่อ่านได้ 16/18 ตัว: ตัวหาย/เกินทำให้รู้เลขท้ายไม่ครบ ใกล้ได้หลายคันในล็อตเดียวกัน (...00219 ใกล้ทั้ง ...002196 และ ...002197)
  // จึงดูรถที่ยื่นแล้วทุกคัน (ไม่จำกัดสถานะ/ขอบเขต) ไม่ใช่แค่คันที่รอใบเสร็จ - คันจริงที่มีรูป/ได้ใบเสร็จแล้วต้องทำให้ไม่แนบให้คันข้างเคียง
  // (พบตอนรีวิว 2026-09-28) · ค้นแคบด้วยเงื่อนไขที่ isNearChassis บังคับอยู่แล้ว: 3 ตัวท้ายตรงกัน (ตัวหาย/เกินไม่อยู่ใน 3 ตัวท้าย)
  // หรือตัวที่ 12-14 ตรงกัน (ตัวหาย/เกินอยู่ใน 3 ตัวท้าย) แล้วกรองด้วย isNearChassis · รถ 1 คันยื่นได้ครั้งเดียว (FAILED ไม่นับ)
  private async nearSubmittedVehicles(chassis: string): Promise<{ id: string }[]> {
    const rows = await this.prisma.documentSubmission.findMany({
      where: {
        status: { not: 'FAILED' },
        vehicle: {
          deletedAt: null,
          OR: [
            { chassis: { endsWith: chassis.slice(-3), mode: 'insensitive' } },
            { chassis: { contains: chassis.slice(CHASSIS_PREFIX, CHASSIS_PREFIX + 3), mode: 'insensitive' } },
          ],
        },
      },
      select: { id: true, vehicle: { select: { chassis: true } } },
    });
    const near = rows.filter((r) => isNearChassis(chassis, r.vehicle.chassis));
    // กันกรณีรถคันเดียวมีหลายรายการ (ไม่ควรเกิด) - นับเป็นคันเดียว
    return [...new Map(near.map((r) => [r.vehicle.chassis.toUpperCase(), r])).values()];
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
        where: { ...notSelf, plateSwapId: null, vehicleUseCancellationId: null, plateCopyId: null, extraction: { path: ['reading', 'receiptNo'], equals: receiptNo } },
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
  // background = เก็บรูปแล้วตอบทันที (readPending) AI อ่าน/จับคู่ทีหลัง - ใช้ได้เฉพาะแบบหลายใบที่เปิด AI
  async upload(file: UploadedReceiptFile | undefined, submissionIdRaw?: unknown, backgroundRaw?: unknown) {
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
    const background = !submissionId && isBackgroundFlag(backgroundRaw) && this.extractor.source !== 'NONE';
    const extraction = background ? null : await this.extractor.extract(file.buffer, type.mimeType);
    const duplicate = await this.findDuplicate(extraction, null);
    // อัปโหลดหลายใบแล้วเจอใบซ้ำ -> ไม่แนบให้อัตโนมัติ รอในถาดพร้อมคำเตือน ให้พนักงานดูแล้วลบ (แนบในแถวรถ = แนบตามที่เลือก แต่เตือน)
    const matched = duplicate && !submissionId ? { submissionId: null, match: null } : await this.matchByChassis(extraction, submissionId);
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    const create = (client: LockClient, target: string | null) =>
      client.receiptImage.create({
        data: {
          submissionId: target,
          storageKey,
          contentHash,
          mimeType: type.mimeType,
          sizeBytes: file.size,
          originalName: file.originalname ? file.originalname.slice(0, 200) : null,
          extractionSource: this.extractor.source,
          readPending: background,
          ...(extraction ? { extraction: { ...extraction, match: target ? matched.match : null, duplicate } as object } : {}),
        },
        select: receiptSelect,
      });
    try {
      // แนบเข้ารายการ (เลือกเอง/จับคู่ให้): ล็อกแถวแล้วดูสถานะล่าสุดก่อนเขียน - AI อ่านหลายวินาที อีกคนอาจบันทึกยื่นไม่สำเร็จไปแล้ว
      const target = matched.submissionId;
      const receipt = target
        ? await this.prisma.$transaction(async (tx) => create(tx, await this.lockAttachTarget(tx, target, !submissionId)))
        : await create(this.prisma, null);
      if (background) this.reads.enqueue(receipt.id);
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
  // ไม่กรองประเภทรถ: ยังไม่รู้ว่าเป็นรถคันไหน (คนอัปโหลดจับคู่อัตโนมัติได้แค่ในขอบเขตตัวเอง ที่เหลือให้อีกฝ่ายจับคู่)
  // total + offset/limit (พบ 2026-09-27: เดิมได้แค่ 200 รูปล่าสุด รูปที่เก่ากว่านั้นไม่ขึ้นในถาด จับคู่/ลบไม่ได้)
  async listUnassigned(offsetRaw?: unknown, limitRaw?: unknown) {
    const offset = this.parseCount(offsetRaw, 0, 'offset');
    const limit = Math.min(this.parseCount(limitRaw, UNASSIGNED_PAGE_SIZE, 'limit') || UNASSIGNED_PAGE_SIZE, UNASSIGNED_MAX_LIMIT);
    const where = { submissionId: null, plateSwapId: null, vehicleUseCancellationId: null, plateCopyId: null };
    const [receipts, total] = await Promise.all([
      this.prisma.receiptImage.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: limit, select: receiptSelect }),
      this.prisma.receiptImage.count({ where }),
    ]);
    return { receipts, total, hasMore: offset + receipts.length < total };
  }

  private parseCount(raw: unknown, fallback: number, name: string): number {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const text = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
    if (!/^\d{1,6}$/.test(text)) throw new BadRequestException({ error: `${name} ต้องเป็นจำนวนเต็มตั้งแต่ 0` });
    return Number(text);
  }

  async getImage(id: string): Promise<{ data: Buffer; mimeType: string }> {
    const receipt = await this.prisma.receiptImage.findFirst({ where: { id, ...visibleReceiptWhere() }, select: { storageKey: true, mimeType: true } });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    try {
      return { data: await this.storage.get(receipt.storageKey), mimeType: receipt.mimeType };
    } catch {
      throw new NotFoundException({ error: 'ไม่พบไฟล์รูปใบเสร็จในที่เก็บ' });
    }
  }

  // unassignedOnly = ถาดรูปรอจับคู่: รูปต้องยังไม่ได้จับคู่กับรถคันอื่น (ถาดที่เปิดค้างไว้อาจเก่า - อีกเครื่องจับคู่ไปแล้ว)
  async assign(id: string, submissionIdRaw: unknown, unassignedOnlyRaw?: unknown) {
    return this.serialize(() => this.assignNow(id, submissionIdRaw, isFlag(unassignedOnlyRaw)));
  }

  // ย้ายรูปออกจากรายการที่รับใบเสร็จแล้ว (หลักฐานวางบิล) หรือจากงานสลับเลขไม่ได้ และรายการเดิมต้องอยู่ในขอบเขตของผู้ใช้
  // (พบ 2026-09-27: เดิมไม่ดูว่ารูปเป็นของใครอยู่ ย้ายหลักฐานวางบิลออกได้ หรือรูปเป็นของทั้งงานสลับเลขและรถใหม่พร้อมกัน)
  private async assignNow(id: string, submissionIdRaw: unknown, unassignedOnly: boolean) {
    const existing = await this.prisma.receiptImage.findUnique({
      where: { id },
      select: {
        id: true,
        extraction: true,
        submissionId: true,
        plateSwapId: true,
        vehicleUseCancellationId: true,
        plateCopyId: true,
        submission: { select: { status: true, vehicle: { select: { body: true } } } },
      },
    });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    if (existing.plateSwapId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานสลับเลข จับคู่กับรถไม่ได้' });
    if (existing.vehicleUseCancellationId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานยกเลิกการใช้รถ จับคู่กับรถไม่ได้' });
    if (existing.plateCopyId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานคัดแผ่นป้ายทะเบียน จับคู่กับรถไม่ได้' });
    if (existing.submission) {
      assertVehicleInScope(existing.submission.vehicle.body);
      if (existing.submission.status === 'RECEIPT_RECEIVED') {
        throw new BadRequestException({ error: MOVE_RECEIVED_ERROR });
      }
    }
    const submissionId = await this.assertAttachable(submissionIdRaw);
    if (unassignedOnly && existing.submissionId && existing.submissionId !== submissionId) {
      throw new ConflictException({ error: 'รูปนี้ถูกจับคู่กับรถคันอื่นไปแล้ว - โหลดหน้าใหม่' });
    }
    // พนักงานจับคู่เอง - เช็กเลขตัวถังที่ AI อ่านได้กับรถที่เลือกอีกรอบ
    const extraction = existing.extraction as ReceiptExtraction | null;
    const matched = await this.matchByChassis(extraction, submissionId);
    const duplicate = await this.findDuplicate(extraction, id); // เช็กใหม่ - ใบเดิมอาจถูกลบไปแล้ว
    const source = existing.submissionId;
    const receipt = await this.prisma.$transaction(async (tx) => {
      // ล็อกรายการเดิมและรายการใหม่แล้วดูสถานะล่าสุด (พบ 2026-09-27: ตรวจแล้วค่อยเขียน ระหว่างนั้นรายการเดิมอาจเพิ่งได้ใบเสร็จ
      // เหลือรายการที่ได้ใบเสร็จแต่ไม่มีรูป หรือรายการใหม่เพิ่งถูกบันทึกยื่นไม่สำเร็จ รูปไปค้างกับรายการนั้น)
      const statuses = await lockSubmissions(tx, [source, submissionId]);
      if (source && source !== submissionId && statuses.get(source) === 'RECEIPT_RECEIVED') {
        throw new BadRequestException({ error: MOVE_RECEIVED_ERROR });
      }
      const target = statuses.get(submissionId);
      if (!target) throw new NotFoundException({ error: 'ไม่พบรายการที่ยื่นเอกสาร' });
      if (target === 'FAILED') throw new BadRequestException({ error: FAILED_ATTACH_ERROR });
      // เขียนเฉพาะเมื่อรูปยังอยู่ที่เดิม และรายการเดิมยังไม่ได้รับใบเสร็จ (ระหว่างนี้ถูกลบ/ย้ายไปแล้ว = ไม่ทับ)
      const { count } = await tx.receiptImage.updateMany({
        where: { id, plateSwapId: null, vehicleUseCancellationId: null, plateCopyId: null, submissionId: source, ...(source ? { submission: { status: { not: 'RECEIPT_RECEIVED' } } } : {}) },
        data: { submissionId, ...(extraction ? { extraction: { ...extraction, match: matched.match, duplicate } as object } : {}) },
      });
      if (count === 0) throw new ConflictException({ error: 'รูปนี้ถูกจับคู่หรือลบไปแล้ว - โหลดหน้าใหม่' });
      return tx.receiptImage.findUnique({ where: { id }, select: receiptSelect });
    });
    return { receipt };
  }

  // ลบได้เฉพาะรูปที่ยังไม่จับคู่ หรือของรายการที่ยังรอใบเสร็จ - รับใบเสร็จแล้วรูปเป็นหลักฐานวางบิล ห้ามลบ
  // รูปของรายการ: เฉพาะประเภทรถของผู้ใช้ · unassignedOnly = ลบจากถาด/หน้าถ่าย ("ถ่ายใหม่") รูปต้องยังไม่ได้จับคู่
  // (พบ 2026-09-27: ถาดที่เปิดค้างไว้ลบรูปที่อีกเครื่องเพิ่งจับคู่กับรถไปแล้วได้ รวมถึงรถประเภทอื่น)
  async remove(id: string, unassignedOnlyRaw?: unknown) {
    const receipt = await this.prisma.receiptImage.findUnique({
      where: { id },
      select: {
        id: true,
        storageKey: true,
        submissionId: true,
        plateSwapId: true,
        vehicleUseCancellationId: true,
        plateCopyId: true,
        submission: { select: { status: true, vehicle: { select: { body: true } } } },
      },
    });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    // ข้อความใช้ได้ทั้งถาดและหน้าถ่ายบนมือถือ (หน้าถ่ายไม่มีถาด และโหลดใหม่แล้วรายการที่ถ่ายรอบนี้หาย - พบ 2026-09-27)
    if (isFlag(unassignedOnlyRaw) && receipt.submissionId) {
      throw new ConflictException({ error: 'รูปนี้ถูกจับคู่กับรถไปแล้ว ลบไม่ได้ - ลบได้จากแถวของรถคันนั้นในหน้ารับใบเสร็จ' });
    }
    if (receipt.submission) {
      assertVehicleInScope(receipt.submission.vehicle.body);
      if (receipt.submission.status === 'RECEIPT_RECEIVED') {
        throw new BadRequestException({ error: 'รายการนี้รับใบเสร็จแล้ว ลบรูปใบเสร็จไม่ได้' });
      }
    }
    // ใบเสร็จงานสลับเลขลบผ่าน DELETE /api/plate-swaps/:id/receipts/:receiptId (รับเอกสารกลับแล้วห้ามลบ)
    if (receipt.plateSwapId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานสลับเลข ลบจากหน้างานสลับเลข' });
    if (receipt.vehicleUseCancellationId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานยกเลิกการใช้รถ ลบจากหน้างานยกเลิกการใช้รถ' });
    if (receipt.plateCopyId) throw new BadRequestException({ error: 'รูปนี้เป็นใบเสร็จงานคัดแผ่นป้ายทะเบียน ลบจากหน้างานคัดแผ่นป้ายทะเบียน' });
    // ลบเฉพาะเมื่อรูปยังอยู่ที่เดิม และรายการยังไม่ได้รับใบเสร็จ (ระหว่างนี้อีกเครื่องจับคู่/บันทึกไปแล้ว = ไม่ลบ)
    // รูปของรายการ: ล็อกแถวรายการก่อน ให้การบันทึก "ได้ใบเสร็จ" ที่ทำพร้อมกันรอ แล้วเห็นว่ารูปหายไปแล้ว (submission-lock.ts)
    const source = receipt.submissionId;
    const { count } = source
      ? await this.prisma.$transaction(async (tx) => {
          await lockSubmissions(tx, [source]);
          return tx.receiptImage.deleteMany({
            where: { id, plateSwapId: null, vehicleUseCancellationId: null, plateCopyId: null, submissionId: source, submission: { status: { not: 'RECEIPT_RECEIVED' } } },
          });
        })
      : await this.prisma.receiptImage.deleteMany({ where: { id, plateSwapId: null, vehicleUseCancellationId: null, plateCopyId: null, submissionId: null } });
    if (count === 0) throw new ConflictException({ error: 'รูปนี้ถูกจับคู่หรือเปลี่ยนสถานะไปแล้ว - โหลดหน้าใหม่' });
    await this.storage.delete(receipt.storageKey).catch(() => undefined);
    return { id };
  }
}
