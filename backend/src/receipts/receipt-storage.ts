import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as process from 'node:process';
import { Injectable } from '@nestjs/common';

// ที่เก็บไฟล์รูปใบเสร็จ - ตาราง ReceiptImage เก็บแค่ key; ตัวไฟล์อยู่ที่นี่
// ตอนนี้ใช้ดิสก์ในเครื่อง (ทดสอบบนเครื่องได้โดยไม่ต้องมีบัญชี cloud) - ต่อไปจะเพิ่ม Cloudflare R2 ที่ใช้ interface เดียวกัน
export const RECEIPT_STORAGE = Symbol('RECEIPT_STORAGE');

export interface ReceiptStorage {
  put(key: string, data: Buffer, mimeType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

// เก็บที่ backend/uploads/receipts (อยู่ใน .gitignore) หรือโฟลเดอร์ใน RECEIPT_STORAGE_DIR
// ใช้บนเครื่องเท่านั้น - ดิสก์ของ Render ถูกล้างทุกครั้งที่ deploy จึงห้ามใช้ตัวนี้บน production
@Injectable()
export class LocalReceiptStorage implements ReceiptStorage {
  private readonly root = path.resolve(process.env.RECEIPT_STORAGE_DIR ?? 'uploads/receipts');

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
