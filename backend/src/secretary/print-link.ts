// ลิงก์เปิดใบกำกับภาษีจากไลน์โดยไม่ต้องล็อกอิน (ผู้ใช้ 2026-11-16: กดออกใบกำกับในไลน์แล้วส่งต่อให้พนักงานปริ้น)
// token = base64url("<id>.<หมดอายุ epoch วินาที>") + "." + HMAC-SHA256 ด้วย AUTH_SECRET - เดาไม่ได้ และหมดอายุเอง
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRINT_LINK_DAYS = 7;

// ชนิดเอกสารของลิงก์: tv = ใบกำกับภาษี (id ล้วน เหมือน token รุ่นแรก) · iv = ใบวางบิล (id ขึ้นต้น "iv:", ผู้ใช้ 2026-11-16)
// ชนิดอยู่ในส่วนที่เซ็นแล้ว ลิงก์ของเอกสารชนิดหนึ่งจึงใช้เปิดอีกชนิดไม่ได้
export type PrintKind = 'tv' | 'iv';
const PREFIX: Record<PrintKind, string> = { tv: '', iv: 'iv:' };

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function createPrintToken(documentId: string, secret: string, now = Date.now(), days = PRINT_LINK_DAYS, kind: PrintKind = 'tv'): string {
  if (!secret) throw new Error('ยังไม่ได้ตั้งค่า AUTH_SECRET');
  const payload = Buffer.from(`${PREFIX[kind]}${documentId}.${Math.floor(now / 1000) + days * 86_400}`).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// คืน id ของเอกสารเมื่อ token ถูกต้อง ยังไม่หมดอายุ และเป็นชนิดที่ขอ ไม่เช่นนั้น null
export function verifyPrintToken(token: unknown, secret: string, now = Date.now(), kind: PrintKind = 'tv'): string | null {
  if (typeof token !== 'string' || !secret) return null;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [id, exp] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!id || !/^\d+$/.test(exp ?? '') || Number(exp) * 1000 < now) return null;
  if (kind === 'tv') return id.includes(':') ? null : id;
  return id.startsWith(PREFIX[kind]) && id.length > PREFIX[kind].length ? id.slice(PREFIX[kind].length) : null;
}
