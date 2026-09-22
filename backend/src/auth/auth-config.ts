import * as process from 'node:process';

// AUTH_SECRET ใช้เซ็น JWT - ต้องตั้งใน .env (dev) และ env ของ Render (prod) เปลี่ยนค่า = ทุกคนต้องล็อกอินใหม่
export function authSecret(): string {
  const secret = process.env.AUTH_SECRET?.trim();
  if (!secret || secret.length < 16) {
    throw new Error('ต้องตั้งค่า AUTH_SECRET (อย่างน้อย 16 ตัวอักษร) ใน backend/.env ก่อนเริ่มระบบ');
  }
  return secret;
}

// อายุ token 12 ชั่วโมง (หนึ่งวันทำงาน) - หมดอายุแล้วหน้าเว็บจะพากลับไปหน้าล็อกอินเอง
export const TOKEN_TTL_SECONDS = 12 * 60 * 60;
