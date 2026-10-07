// กุญแจให้ GitHub Actions สั่งส่งสรุปตามเวลา (ผู้ใช้ 2026-10-07): ส่งใน header x-secretary-key เทียบกับ env SECRETARY_RUN_KEY
// เทียบแบบเวลาคงที่ (hash ก่อนเทียบเพื่อให้ความยาวเท่ากัน) · กุญแจสั้นกว่า MIN_KEY_LENGTH = ถือว่าไม่ได้ตั้งค่า
import { createHash, timingSafeEqual } from 'node:crypto';

export const MIN_KEY_LENGTH = 16;
export type Slot = 'morning' | 'evening';

export const isSlot = (value: unknown): value is Slot => value === 'morning' || value === 'evening';

export function verifyRunKey(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected || expected.length < MIN_KEY_LENGTH) return false;
  const hash = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(hash(given), hash(expected));
}
