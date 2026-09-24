import { createHash } from 'node:crypto';
import { ConflictException } from '@nestjs/common';

// กันอัปโหลดรูปเดิมซ้ำ (ผู้ใช้ 2026-09-24): เก็บ SHA-256 ของไฟล์ไว้ในคอลัมน์ contentHash (unique) ของแต่ละตารางรูป
// นับเฉพาะรูปที่ยังอยู่ในระบบ - ลบรูปแล้วอัปโหลดรูปเดิมใหม่ได้ (แถวถูกลบ hash ก็หายไปด้วย)
// รูปที่อัปโหลดก่อนมีคอลัมน์นี้เป็น NULL จึงตรวจซ้ำกับรูปเก่าเหล่านั้นไม่ได้
export const DUPLICATE_UPLOAD_ERROR = 'รูปนี้อัพโหลดไปแล้ว';

export function contentHashOf(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export function duplicateUpload(message: string = DUPLICATE_UPLOAD_ERROR): ConflictException {
  return new ConflictException({ error: message });
}

// อัปโหลดรูปเดียวกันพร้อมกัน 2 คำขอ ผ่านการตรวจล่วงหน้าทั้งคู่ -> unique index ของ contentHash กันไว้อีกชั้น (Prisma P2002)
export function isContentHashConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return false;
  // ชื่อคอลัมน์อยู่ใน meta.target หรือใน meta.driverAdapterError (แล้วแต่ adapter) - ไม่รู้คอลัมน์ = ถือว่าเป็นของ contentHash
  const meta = (err as { meta?: unknown }).meta;
  return meta === undefined || JSON.stringify(meta).includes('contentHash');
}
