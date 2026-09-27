import { createHmac, timingSafeEqual } from 'node:crypto';

// JWT HS256 แบบย่อด้วย node:crypto - payload มีแค่ id ผู้ใช้ + วันหมดอายุ ส่วน roles/status อ่านสดจากฐานข้อมูล
// ทุกคำขอ (AuthGuard) เพื่อให้การเปลี่ยน role/ระงับบัญชีมีผลทันที
export interface TokenPayload {
  sub: string; // User.id
  roles: string[]; // สำเนาให้ frontend proxy ใช้เลือกหน้า (ฝั่ง API ไม่เชื่อค่านี้ อ่านจากฐานข้อมูลแทน)
  iat: number;
  exp: number;
}

const encode = (value: object | Buffer) =>
  (Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))).toString('base64url');

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signToken(userId: string, roles: string[], secret: string, ttlSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  return build({ sub: userId, roles, iat: now, exp: now + ttlSeconds }, secret);
}

// ออก token ใหม่ด้วย roles ล่าสุด แต่หมดอายุเวลาเดิม (ไม่ต่ออายุการล็อกอิน) - /api/auth/me ส่งให้หน้าเว็บ
// เมื่อ Admin เปลี่ยนบทบาทระหว่างที่ล็อกอินอยู่ (พบ 2026-09-27: proxy.ts ใช้ roles เก่าใน token จนออกแล้วเข้าใหม่)
export function resignToken(userId: string, roles: string[], secret: string, exp: number): string {
  return build({ sub: userId, roles, iat: Math.floor(Date.now() / 1000), exp }, secret);
}

function build(payload: TokenPayload, secret: string): string {
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  return `${head}.${body}.${encode(sign(`${head}.${body}`, secret))}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expected = sign(`${head}.${body}`, secret);
  const actual = Buffer.from(sig, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as Partial<TokenPayload>;
    if (typeof payload.sub !== 'string' || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') return null;
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return { ...payload, roles: Array.isArray(payload.roles) ? payload.roles : [] } as TokenPayload;
  } catch {
    return null;
  }
}
