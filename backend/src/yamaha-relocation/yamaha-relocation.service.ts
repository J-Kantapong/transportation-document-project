import { randomUUID } from 'node:crypto';
import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { YamahaRelocationAttachmentKind, YamahaRelocationSize } from '../generated/prisma/enums.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { calculateYamahaRelocationFees } from './yamaha-relocation-fee.js';
import { CreateYamahaRelocationEntryDto } from './dto/create-yamaha-relocation-entry.dto.js';

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

function isValidDateParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
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
  return {
    id: entry.id,
    date: entry.date.toISOString().slice(0, 10),
    size: entry.size,
    count: entry.count,
    billFee: String(entry.billFee),
    noBillFee: String(entry.noBillFee),
    createdAt: entry.createdAt.toISOString(),
    receipt: byKind(YamahaRelocationAttachmentKind.RECEIPT), // null เฉพาะรายการเก่าที่บันทึกก่อนมีไฟล์แนบ
    report: byKind(YamahaRelocationAttachmentKind.REPORT),
  };
}

@Injectable()
export class YamahaRelocationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  // ตรวจไฟล์แนบ 1 ชนิด: ต้องมี 1 ไฟล์, ไม่เกิน 8MB, เป็นรูปหรือ PDF จริง
  private checkFile(kind: YamahaRelocationAttachmentKind, files: UploadedReceiptFile[] | undefined) {
    const label = ATTACHMENT_LABEL[kind];
    const file = files?.[0];
    if (!file || file.size === 0) throw new BadRequestException({ error: `กรุณาแนบ${label}` });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: `${label}ใหญ่เกิน 8MB` });
    const type = detectAttachmentType(file.buffer);
    if (!type) throw new BadRequestException({ error: `${label}ต้องเป็นรูป JPEG, PNG, WebP หรือ PDF` });
    return { kind, file, type };
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
      this.checkFile(YamahaRelocationAttachmentKind.RECEIPT, files?.receipt),
      this.checkFile(YamahaRelocationAttachmentKind.REPORT, files?.report),
    ];

    const { billFee, noBillFee } = calculateYamahaRelocationFees(dto.size, count);

    const now = new Date();
    const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
    const uploads = checked.map((c) => ({
      kind: c.kind,
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
            create: uploads.map(({ kind, storageKey, mimeType, sizeBytes, originalName }) => ({
              kind,
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

    const entries = await this.prisma.yamahaRelocationEntry.findMany({
      where: { size: sizeParam, date: { gte: monthStart, lt: monthEnd } },
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
