import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// เก็บรหัสผ่านด้วย scrypt จาก node:crypto (ไม่ต้องติดตั้ง bcrypt) รูปแบบ "scrypt$<salt hex>$<hash hex>"
const scrypt = promisify<string, string, number, Buffer>(scryptCallback);
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, salt, hex] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const hash = await scrypt(password, salt, expected.length);
  return hash.length === expected.length && timingSafeEqual(hash, expected);
}
