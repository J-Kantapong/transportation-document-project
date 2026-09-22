import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger, type Provider } from '@nestjs/common';

// ที่เก็บไฟล์รูป - ตาราง ReceiptImage/PlatePhoto/BookPhoto เก็บแค่ key; ตัวไฟล์อยู่ที่นี่
// key แยกโฟลเดอร์ตามประเภท: receipts/ปี/เดือน/uuid.jpg, plates/ปี/เดือน/..., books/ปี/เดือน/... (ทั้งบนดิสก์และใน R2)
// มี 2 แบบ ใช้ interface เดียวกัน: ดิสก์ในเครื่อง (dev) และ Cloudflare R2 (production) - เลือกอัตโนมัติจาก env
export const RECEIPT_STORAGE = Symbol('RECEIPT_STORAGE');

export interface ReceiptStorage {
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

// เก็บที่ backend/uploads (อยู่ใน .gitignore) หรือโฟลเดอร์ใน RECEIPT_STORAGE_DIR → uploads/receipts, uploads/plates, uploads/books
// ใช้บนเครื่องเท่านั้น - ดิสก์ของ Render ถูกล้างทุกครั้งที่ deploy จึงห้ามใช้ตัวนี้บน production
@Injectable()
export class LocalReceiptStorage implements ReceiptStorage {
  private readonly root = path.resolve(process.env.RECEIPT_STORAGE_DIR ?? 'uploads');

  private resolve(key: string): string {
    const full = path.resolve(this.root, key);
    if (!full.startsWith(this.root + path.sep)) throw new Error(`invalid storage key: ${key}`);
    return full;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
  }

  get(key: string): Promise<Buffer> {
    return readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.resolve(key), { force: true });
  }
}

// Cloudflare R2 ผ่าน S3 API - bucket ต้องเป็น private; หน้าเว็บโหลดรูปผ่าน backend (GET /api/.../image) เท่านั้น
// ต้องตั้ง env ครบ 4 ตัว: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (ดู .env.example)
export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export function readR2Config(env: NodeJS.ProcessEnv = process.env): R2Config | null {
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = env.R2_BUCKET?.trim();
  const set = [accountId, accessKeyId, secretAccessKey, bucket].filter(Boolean).length;
  if (set === 0) return null;
  if (set < 4) {
    throw new Error('ตั้งค่า R2 ไม่ครบ: ต้องมี R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET ทั้ง 4 ตัว (หรือลบออกทั้งหมดเพื่อเก็บในเครื่อง)');
  }
  return { accountId: accountId!, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey!, bucket: bucket! };
}

export class R2ReceiptStorage implements ReceiptStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: 'auto',
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async put(key: string, data: Buffer, mimeType: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: data, ContentType: mimeType }));
  }

  async get(key: string): Promise<Buffer> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (!res.Body) throw new Error(`R2 object has no body: ${key}`);
    return Buffer.from(await res.Body.transformToByteArray());
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

// provider เดียวใช้ร่วมกันทุก module ที่เก็บรูป: มี env R2 → R2, ไม่มี → ดิสก์ในเครื่อง
export const receiptStorageProvider: Provider = {
  provide: RECEIPT_STORAGE,
  useFactory: (): ReceiptStorage => {
    const logger = new Logger('ReceiptStorage');
    const r2 = readR2Config();
    if (r2) {
      logger.log(`เก็บรูปที่ Cloudflare R2 bucket "${r2.bucket}"`);
      return new R2ReceiptStorage(r2);
    }
    logger.log('เก็บรูปในดิสก์เครื่อง (backend/uploads) - ตั้ง R2_* ใน .env เพื่อใช้ Cloudflare R2');
    return new LocalReceiptStorage();
  },
};
