// ลิงก์เปิดใบกำกับภาษีจากไลน์โดยไม่ต้องล็อกอิน (ผู้ใช้ 2026-11-16: กดออกใบกำกับในไลน์แล้วส่งต่อให้พนักงานปริ้น)
// token = base64url("<id>.<หมดอายุ epoch วินาที>") + "." + HMAC-SHA256 ด้วย AUTH_SECRET - เดาไม่ได้ และหมดอายุเอง
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PRINT_LINK_DAYS = 7;

const sign = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

export function createPrintToken(taxInvoiceId: string, secret: string, now = Date.now(), days = PRINT_LINK_DAYS): string {
  if (!secret) throw new Error('ยังไม่ได้ตั้งค่า AUTH_SECRET');
  const payload = Buffer.from(`${taxInvoiceId}.${Math.floor(now / 1000) + days * 86_400}`).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

// คืน id ของใบกำกับเมื่อ token ถูกต้องและยังไม่หมดอายุ ไม่เช่นนั้น null
export function verifyPrintToken(token: unknown, secret: string, now = Date.now()): string | null {
  if (typeof token !== 'string' || !secret) return null;
  const [payload, signature, ...rest] = token.split('.');
  if (!payload || !signature || rest.length) return null;
  const expected = Buffer.from(sign(payload, secret));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const [id, exp] = Buffer.from(payload, 'base64url').toString().split('.');
  if (!id || !/^\d+$/.test(exp ?? '') || Number(exp) * 1000 < now) return null;
  return id;
}
