import { BadRequestException, Injectable } from '@nestjs/common';
import { writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ลายเซ็นผู้จ่ายเงินบนสลิปเงินเดือน (ผู้ใช้ 2026-10-06) - ADMIN เท่านั้น (/api/hr) แถวเดียว id 'payer'
// หน้าเว็บทำรูปให้สะอาดก่อนส่ง (พื้นโปร่งใส ลายเซ็นสีดำ ไม่เกิน 600x240) ฝั่งนี้ตรวจซ้ำว่าเป็น PNG จริงและไม่ใหญ่เกินไป

const ID = 'payer';
const MAX_BYTES = 300_000;
const MAX_WIDTH = 1200;
const MAX_HEIGHT = 600;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PREFIX = 'data:image/png;base64,';

const bad = (error: string) => new BadRequestException({ error });

function parsePng(dataUrl: unknown): Buffer {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PREFIX)) throw bad('รูปลายเซ็นต้องเป็นไฟล์ PNG');
  const body = dataUrl.slice(PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) throw bad('รูปลายเซ็นไม่ถูกต้อง');
  const bytes = Buffer.from(body, 'base64');
  if (bytes.length > MAX_BYTES) throw bad('รูปลายเซ็นใหญ่เกินไป (ไม่เกิน 300 KB)');
  if (bytes.length < 33 || PNG_MAGIC.some((b, i) => bytes[i] !== b)) throw bad('รูปลายเซ็นต้องเป็นไฟล์ PNG');
  // IHDR: กว้าง/สูง อยู่ที่ไบต์ 16-23
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width < 20 || height < 10 || width > MAX_WIDTH || height > MAX_HEIGHT) throw bad(`ขนาดรูปลายเซ็นต้องไม่เกิน ${MAX_WIDTH}x${MAX_HEIGHT} พิกเซล`);
  return bytes;
}

@Injectable()
export class PayslipSignatureService {
  constructor(private readonly prisma: PrismaService) {}

  async get() {
    const row = await this.prisma.payslipSignature.findUnique({ where: { id: ID } });
    if (!row) return { exists: false as const, signerName: null, imageDataUrl: null, updatedAt: null, updatedByName: null };
    return {
      exists: true as const,
      signerName: row.signerName,
      imageDataUrl: `data:${row.mimeType};base64,${Buffer.from(row.image).toString('base64')}`,
      updatedAt: row.updatedAt.toISOString(),
      updatedByName: row.updatedByName,
    };
  }

  async set(dto: { imageDataUrl?: unknown; signerName?: unknown }) {
    const image = parsePng(dto?.imageDataUrl);
    let signerName: string | null = null;
    if (dto.signerName !== undefined && dto.signerName !== null) {
      if (typeof dto.signerName !== 'string') throw bad('ชื่อผู้จ่ายเงินต้องเป็นข้อความ');
      signerName = dto.signerName.trim().slice(0, 100) || null;
    }
    const by = currentUser()?.name ?? null;
    await this.prisma.$transaction(async (tx) => {
      const had = (await tx.payslipSignature.count({ where: { id: ID } })) > 0;
      await tx.payslipSignature.upsert({
        where: { id: ID },
        create: { id: ID, signerName, image: new Uint8Array(image), updatedByName: by },
        update: { signerName, image: new Uint8Array(image), mimeType: 'image/png', updatedByName: by },
      });
      // ไม่เก็บรูปลงประวัติ - บันทึกแค่ว่าใครตั้ง/เปลี่ยนเมื่อไร
      await writeAudit(tx, { entity: 'PayslipSignature', entityId: ID, action: had ? 'replace' : 'set', remark: had ? 'เปลี่ยนลายเซ็นผู้จ่ายเงิน' : 'ตั้งลายเซ็นผู้จ่ายเงิน', changes: { signerName, bytes: image.length } });
    });
    return this.get();
  }

  async remove() {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payslipSignature.deleteMany({ where: { id: ID } });
      if (count > 0) await writeAudit(tx, { entity: 'PayslipSignature', entityId: ID, action: 'remove', remark: 'ลบลายเซ็นผู้จ่ายเงิน', changes: {} });
    });
    return this.get();
  }
}
