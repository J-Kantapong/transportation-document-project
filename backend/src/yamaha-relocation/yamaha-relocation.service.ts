import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { YamahaRelocationAttachmentKind, YamahaRelocationSize } from '../generated/prisma/enums.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { calculateYamahaRelocationFees } from './yamaha-relocation-fee.js';
import { CreateYamahaRelocationEntryDto } from './dto/create-yamaha-relocation-entry.dto.js';
import type { UpdateYamahaRelocationEntryDto } from './dto/update-yamaha-relocation-entry.dto.js';

// แก้/ยกเลิกรายการที่บันทึกผิด (ผู้ใช้ 2026-09-27): ADMIN / STAFF_ENTRY (access-policy.ts กฎขั้น 1-3) ต้องระบุเหตุผลเสมอ
// บันทึกประวัติลง AuditLog (entity 'YamahaRelocation') - ยกเลิกไม่ลบแถว (cancelledAt) และไม่นับในรายการ/ยอดรวม/ภาพรวม
// ตอนยกเลิกล้าง contentHash ของไฟล์แนบ ให้แนบไฟล์เดิมกับรายการที่บันทึกใหม่ได้ (ตัวไฟล์ยังอยู่ใน storage เป็นหลักฐาน)
const STALE_ERROR = 'รายการนี้ถูกแก้หรือยกเลิกไปก่อนแล้ว - โหลดรายการใหม่';

// ไฟล์แนบที่ต้องมีทุกรายการ (ผู้ใช้ 2026-09-22): ใบเสร็จ 1 ไฟล์ + Report 1 ไฟล์ เสมอ - รับรูป JPEG/PNG/WebP หรือ PDF
export interface YamahaRelocationFiles {
  receipt?: UploadedReceiptFile[];
  report?: UploadedReceiptFile[];
}

// ใช้ในข้อความ error: "กรุณาแนบไฟล์ใบเสร็จ", "กรุณาแนบไฟล์ Report" (เว้นวรรคก่อนคำอังกฤษ)
export const ATTACHMENT_LABEL: Record<YamahaRelocationAttachmentKind, string> = {
  [YamahaRelocationAttachmentKind.RECEIPT]: 'ไฟล์ใบเสร็จ',
  [YamahaRelocationAttachmentKind.REPORT]: 'ไฟล์ Report',
};

// โฟลเดอร์ใน storage แยกตามชนิดไฟล์แนบ: yamaha-relocation/receipts/ปี/เดือน/uuid.ext, yamaha-relocation/reports/...
const STORAGE_FOLDER: Record<YamahaRelocationAttachmentKind, string> = {
  [YamahaRelocationAttachmentKind.RECEIPT]: 'yamaha-relocation/receipts',
  [YamahaRelocationAttachmentKind.REPORT]: 'yamaha-relocation/reports',
};

// เหมือน detectImageType แต่รับ PDF ด้วย (Report มักเป็น PDF) - ดูจาก byte แรก ไม่เชื่อ mimetype ที่ browser ส่งมา
export function detectAttachmentType(buf: Buffer): { mimeType: string; ext: string } | null {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { mimeType: 'application/pdf', ext: 'pdf' };
  return detectImageType(buf);
}

// วันที่ ค.ศ. YYYY-MM-DD ที่มีอยู่จริง - Date.parse ยอม 2026-02-31 (เลื่อนไป 3 มี.ค.) จึงต้องแปลงกลับได้วันเดิม
function isValidDateParam(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidMonthParam(value: string): boolean {
  return /^\d{4}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}-01`));
}

function isSize(value: unknown): value is YamahaRelocationSize {
  return value === YamahaRelocationSize.SMALL || value === YamahaRelocationSize.LARGE;
}

// multipart ส่ง count มาเป็นข้อความ ("3") - รับทั้งตัวเลขและข้อความที่เป็นจำนวนเต็มบวก
function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ค่าที่ฟอร์มแก้โหลดมาตอนเปิด (expectedDate/Size/Count) - ช่องที่ไม่ส่งใช้ค่าที่อ่านในคำขอนี้ / ส่งมาผิดรูปแบบ = 400
export function expectedState(
  dto: UpdateYamahaRelocationEntryDto,
  existing: { date: Date; size: YamahaRelocationSize; count: number },
): { date: Date; size: YamahaRelocationSize; count: number } {
  const bad = () => new BadRequestException({ error: 'ข้อมูลรายการที่โหลดมาไม่ถูกต้อง - โหลดรายการใหม่' });
  let date = existing.date;
  if (dto.expectedDate !== undefined) {
    const raw = typeof dto.expectedDate === 'string' ? dto.expectedDate.trim() : '';
    if (!isValidDateParam(raw)) throw bad();
    date = new Date(`${raw}T00:00:00.000Z`);
  }
  if (dto.expectedSize !== undefined && !isSize(dto.expectedSize)) throw bad();
  const count = dto.expectedCount !== undefined ? parsePositiveInt(dto.expectedCount) : existing.count;
  if (count === null) throw bad();
  return { date, size: (dto.expectedSize as YamahaRelocationSize | undefined) ?? existing.size, count };
}

const attachmentSelect = { id: true, kind: true, mimeType: true, sizeBytes: true, originalName: true, createdAt: true } as const;

type AttachmentRow = {
  id: string;
  kind: YamahaRelocationAttachmentKind;
  mimeType: string;
  sizeBytes: number;
  originalName: string | null;
  createdAt: Date;
};

function serializeAttachment(a: AttachmentRow) {
  return {
    id: a.id,
    kind: a.kind,
    mimeType: a.mimeType,
    sizeBytes: a.sizeBytes,
    originalName: a.originalName,
    createdAt: a.createdAt.toISOString(),
  };
}

function serializeEntry(entry: {
  id: string;
  date: Date;
  size: YamahaRelocationSize;
  count: number;
  billFee: unknown;
  noBillFee: unknown;
  createdAt: Date;
  attachments: AttachmentRow[];
}) {
  const byKind = (kind: YamahaRelocationAttachmentKind) => {
    const a = entry.attachments.find((x) => x.kind === kind);
    return a ? serializeAttachment(a) : null;
  };
  const allOfKind = (kind: YamahaRelocationAttachmentKind) =>
    entry.attachments
      .filter((x) => x.kind === kind)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(serializeAttachment);
  return {
    id: entry.id,
    date: entry.date.toISOString().slice(0, 10),
    size: entry.size,
    count: entry.count,
    billFee: String(entry.billFee),
    noBillFee: String(entry.noBillFee),
    createdAt: entry.createdAt.toISOString(),
    receipt: byKind(YamahaRelocationAttachmentKind.RECEIPT), // null เฉพาะรายการเก่าที่บันทึกก่อนมีไฟล์แนบ (ไฟล์แรก)
    report: byKind(YamahaRelocationAttachmentKind.REPORT),
    // แนบได้หลายไฟล์ต่อชนิด (ผู้ใช้ 2026-09-30) - เรียงตามลำดับที่แนบ
    receipts: allOfKind(YamahaRelocationAttachmentKind.RECEIPT),
    reports: allOfKind(YamahaRelocationAttachmentKind.REPORT),
  };
}

@Injectable()
export class YamahaRelocationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // ตรวจไฟล์แนบ 1 ชนิด: ต้องมีอย่างน้อย 1 ไฟล์ (แนบได้หลายไฟล์), ไม่เกิน 8MB ต่อไฟล์, เป็นรูปหรือ PDF จริง
  private checkFiles(kind: YamahaRelocationAttachmentKind, files: UploadedReceiptFile[] | undefined) {
    const label = ATTACHMENT_LABEL[kind];
    if (!files?.length || files.some((f) => f.size === 0)) throw new BadRequestException({ error: `กรุณาแนบ${label}` });
    return files.map((file) => {
      if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: `${label}ใหญ่เกิน 8MB` });
      const type = detectAttachmentType(file.buffer);
      if (!type) throw new BadRequestException({ error: `${label}ต้องเป็นรูป JPEG, PNG, WebP หรือ PDF` });
      return { kind, file, type };
    });
  }

  async create(dto: CreateYamahaRelocationEntryDto, files: YamahaRelocationFiles | undefined) {
    const dateRaw = typeof dto?.date === 'string' ? dto.date.trim() : '';

    if (!isValidDateParam(dateRaw)) {
      throw new BadRequestException({ error: 'กรุณาระบุวันที่ให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    }
    if (!isSize(dto?.size)) {
      throw new BadRequestException({ error: 'กรุณาระบุขนาดรถ (รถเล็ก/รถใหญ่)' });
    }
    const count = parsePositiveInt(dto?.count);
    if (count === null) {
      throw new BadRequestException({ error: 'กรุณาระบุจำนวนคันเป็นจำนวนเต็มตั้งแต่ 1' });
    }
    // ทั้ง 2 ไฟล์ต้องผ่านการตรวจก่อนจึงอัปโหลด - ไม่ให้เหลือไฟล์ค้างใน storage เมื่อคำขอถูกปฏิเสธ
    const checked = [
      ...this.checkFiles(YamahaRelocationAttachmentKind.RECEIPT, files?.receipt),
      ...this.checkFiles(YamahaRelocationAttachmentKind.REPORT, files?.report),
    ];

    // กันไฟล์ซ้ำ: ทุกไฟล์ในคำขอนี้ต้องคนละไฟล์ (ทั้งในชนิดเดียวกันและข้ามชนิด) และต้องไม่เคยแนบกับรายการไหนมาก่อน
    const hashes = checked.map((c) => contentHashOf(c.file.buffer));
    const firstOf = (i: number) => hashes.indexOf(hashes[i]);
    const repeated = hashes.findIndex((_, i) => firstOf(i) !== i);
    if (repeated >= 0) {
      const other = checked[firstOf(repeated)];
      throw duplicateUpload(
        other.kind === checked[repeated].kind
          ? `${ATTACHMENT_LABEL[other.kind]}ถูกเลือกซ้ำ (ไฟล์เดียวกัน)`
          : 'ไฟล์ใบเสร็จกับไฟล์ Report เป็นไฟล์เดียวกัน',
      );
    }
    const dupes = await this.prisma.yamahaRelocationAttachment.findMany({ where: { contentHash: { in: hashes } }, select: { contentHash: true } });
    const dupe = checked.find((_, i) => dupes.some((d) => d.contentHash === hashes[i]));    if (dupe) {
      const label = ATTACHMENT_LABEL[dupe.kind];
      throw duplicateUpload(`${label}${/[A-Za-z]$/.test(label) ? ' ' : ''}นี้อัพโหลดไปแล้ว`); // "ไฟล์ Report นี้..." เว้นวรรคหลังคำอังกฤษ
    }

    const { billFee, noBillFee } = calculateYamahaRelocationFees(dto.size, count);

    const now = new Date();
    const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const uploads = checked.map((c, i) => ({
      kind: c.kind,
      contentHash: hashes[i],
      storageKey: `${STORAGE_FOLDER[c.kind]}/${ym}/${randomUUID()}.${c.type.ext}`,
      mimeType: c.type.mimeType,
      sizeBytes: c.file.size,
      originalName: c.file.originalname || null,
      buffer: c.file.buffer,
    }));

    const stored: string[] = [];
    try {
      for (const u of uploads) {
        await this.storage.put(u.storageKey, u.buffer, u.mimeType);
        stored.push(u.storageKey);
      }
      const entry = await this.prisma.yamahaRelocationEntry.create({
        data: {
          date: new Date(`${dateRaw}T00:00:00.000Z`),
          size: dto.size,
          count,
          billFee,
          noBillFee,
          attachments: {
            create: uploads.map(({ kind, contentHash, storageKey, mimeType, sizeBytes, originalName }) => ({
              kind,
              contentHash,
              storageKey,
              mimeType,
              sizeBytes,
              originalName,
            })),
          },
        },
        include: { attachments: { select: attachmentSelect } },
      });
      return { entry: serializeEntry(entry) };
    } catch (err) {
      // อัปโหลด/บันทึกไม่สำเร็จ -> ลบไฟล์ที่ขึ้นไปแล้วทิ้ง ไม่ให้เป็นขยะใน R2
      await Promise.allSettled(stored.map((key) => this.storage.delete(key)));
      if (isContentHashConflict(err)) throw duplicateUpload('ไฟล์นี้อัพโหลดไปแล้ว');
      throw err;
    }
  }

  async findForMonth(sizeParam: string, monthParam: string) {
    if (!isSize(sizeParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ size ต้องเป็น SMALL หรือ LARGE' });
    }
    if (!isValidMonthParam(monthParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ month ต้องเป็น ค.ศ. YYYY-MM ที่ถูกต้อง' });
    }

    const monthStart = new Date(`${monthParam}-01T00:00:00.000Z`);
    const monthEnd = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1));

    // รายการที่ยกเลิกแล้วไม่แสดงและไม่นับในยอดรวมของเดือน (ผู้ใช้ 2026-09-27)
    const entries = await this.prisma.yamahaRelocationEntry.findMany({
      where: { size: sizeParam, date: { gte: monthStart, lt: monthEnd }, cancelledAt: null },
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      include: { attachments: { select: attachmentSelect } },
    });

    const summary = entries.reduce(
      (acc, entry) => {
        acc.totalCount += entry.count;
        acc.billFee += Number(entry.billFee);
        acc.noBillFee += Number(entry.noBillFee);
        return acc;
      },
      { totalCount: 0, billFee: 0, noBillFee: 0 },
    );

    return {
      entries: entries.map(serializeEntry),
      summary: {
        ...summary,
        totalFee: summary.billFee + summary.noBillFee,
      },
    };
  }

  // รายการที่จะแก้/ยกเลิก - ยกเลิกไปแล้วแก้ต่อไม่ได้ (409 ให้หน้าเว็บโหลดใหม่)
  private async findActive(id: string) {
    const entry = await this.prisma.yamahaRelocationEntry.findUnique({ where: { id }, include: { attachments: { select: attachmentSelect } } });
    if (!entry) throw new NotFoundException({ error: 'ไม่พบรายการแจ้งย้ายนี้' });
    if (entry.cancelledAt) throw new ConflictException({ error: 'รายการนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return entry;
  }

  // แก้วันที่ / รถเล็ก-รถใหญ่ / จำนวนคัน (ผู้ใช้ 2026-09-27) - ค่าธรรมเนียมคิดใหม่จากจำนวนคันและขนาดรถ ไฟล์แนบคงเดิม
  async update(id: string, dto: UpdateYamahaRelocationEntryDto) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้รายการแจ้งย้าย');
    const existing = await this.findActive(id);
    const loaded = expectedState(dto, existing);
    // ฟอร์มส่งวันที่/ขนาด/จำนวนทุกช่องจากตอนเปิด - เปิดค้างไว้ขณะที่อีกคนแก้ไปก่อน = 409 ไม่เอาค่าเก่าไปทับ (พบ 2026-09-27:
    // เดิมเทียบกับค่าที่อ่านในคำขอนี้เอง จึงกันได้แค่ช่วงไม่กี่มิลลิวินาที)
    if (loaded.date.getTime() !== existing.date.getTime() || loaded.size !== existing.size || loaded.count !== existing.count) {
      throw new ConflictException({ error: STALE_ERROR });
    }

    let date = existing.date;
    if (dto.date !== undefined) {
      const raw = typeof dto.date === 'string' ? dto.date.trim() : '';
      if (!isValidDateParam(raw)) throw new BadRequestException({ error: 'กรุณาระบุวันที่ให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
      date = new Date(`${raw}T00:00:00.000Z`);
    }
    if (dto.size !== undefined && !isSize(dto.size)) throw new BadRequestException({ error: 'กรุณาระบุขนาดรถ (รถเล็ก/รถใหญ่)' });
    const size = dto.size !== undefined ? (dto.size as YamahaRelocationSize) : existing.size;
    const count = dto.count !== undefined ? parsePositiveInt(dto.count) : existing.count;
    if (count === null) throw new BadRequestException({ error: 'กรุณาระบุจำนวนคันเป็นจำนวนเต็มตั้งแต่ 1' });

    const next = { date, size, count, ...calculateYamahaRelocationFees(size, count) };
    const changes = diffChanges(existing, next);
    if (Object.keys(changes).length === 0) throw new BadRequestException({ error: 'ไม่มีข้อมูลที่เปลี่ยน' });

    const updated = await this.prisma.$transaction(async (tx) => {
      // ตารางนี้ไม่มี updatedAt - กันแก้ทับกันด้วยค่าที่ฟอร์มโหลดมา (อีกคนแก้/ยกเลิกไปก่อน = ไม่เจอแถว)
      const { count: matched } = await tx.yamahaRelocationEntry.updateMany({
        where: { id, cancelledAt: null, date: loaded.date, size: loaded.size, count: loaded.count },
        data: next,
      });
      if (matched === 0) throw new ConflictException({ error: STALE_ERROR });
      await writeAudit(tx, { entity: 'YamahaRelocation', entityId: id, action: 'update', remark, changes });
      return tx.yamahaRelocationEntry.findUniqueOrThrow({ where: { id }, include: { attachments: { select: attachmentSelect } } });
    });
    return { entry: serializeEntry(updated) };
  }

  // ยกเลิกรายการ (ผู้ใช้ 2026-09-27: ไม่ลบแถว) - ล้าง contentHash ของไฟล์แนบให้แนบไฟล์เดิมกับรายการที่ถูกต้องได้อีก
  async cancel(id: string, remarkRaw: unknown): Promise<{ id: string }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกรายการแจ้งย้าย');
    const existing = await this.findActive(id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.yamahaRelocationEntry.updateMany({
        where: { id, cancelledAt: null },
        data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null },
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await tx.yamahaRelocationAttachment.updateMany({ where: { entryId: id }, data: { contentHash: null } });
      await writeAudit(tx, {
        entity: 'YamahaRelocation',
        entityId: id,
        action: 'cancel',
        remark,
        changes: {
          date: existing.date,
          size: existing.size,
          count: existing.count,
          billFee: existing.billFee,
          noBillFee: existing.noBillFee,
          attachments: existing.attachments.map((a) => ({ id: a.id, kind: a.kind, originalName: a.originalName })),
        },
      });
    });
    return { id };
  }

  // ตัวไฟล์แนบ (หน้าเว็บโหลดผ่าน backend เท่านั้น - bucket เป็น private)
  async getFile(id: string): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
    const a = await this.prisma.yamahaRelocationAttachment.findUnique({
      where: { id },
      select: { storageKey: true, mimeType: true, originalName: true, kind: true },
    });
    if (!a) throw new NotFoundException({ error: 'ไม่พบไฟล์แนบ' });
    const ext = a.storageKey.slice(a.storageKey.lastIndexOf('.') + 1);
    return {
      data: await this.storage.get(a.storageKey),
      mimeType: a.mimeType,
      fileName: a.originalName || `${a.kind.toLowerCase()}.${ext}`,
    };
  }
}
