import { vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NoAiReceiptExtractor, type ReceiptExtractor } from './receipt-extractor.js';
import { checkReading, type ReceiptReading } from './receipt-extraction.js';
import type { ReceiptStorage } from './receipt-storage.js';
import { ReceiptsService, detectImageType } from './receipts.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const file = (buffer = JPEG) => ({ buffer, size: buffer.length, originalname: 'receipt.jpg' });

function setup(submission: unknown = { id: 's1', status: 'PENDING', vehicle: { chassis: 'LS6CME0P7TC914754' } }, receipt: unknown = null, extractor: ReceiptExtractor = new NoAiReceiptExtractor(), pendingByChassis: unknown = null) {
  const storage = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) } satisfies ReceiptStorage;
  const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
  const prisma = {
    documentSubmission: { findUnique: vi.fn().mockResolvedValue(submission), findFirst: vi.fn().mockResolvedValue(pendingByChassis) },
    receiptImage: {
      create,
      findUnique: vi.fn().mockResolvedValue(receipt),
      update: vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data })),
      delete: vi.fn().mockResolvedValue(receipt),
    },
  } as unknown as PrismaService;
  return { svc: new ReceiptsService(prisma, storage, extractor), storage, create };
}

describe('detectImageType', () => {
  it('ดูชนิดจาก byte แรก ไม่ใช่นามสกุล', () => {
    expect(detectImageType(JPEG)?.mimeType).toBe('image/jpeg');
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mimeType).toBe('image/webp');
    expect(detectImageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
});

describe('ReceiptsService.upload', () => {
  it('ไม่รับไฟล์ที่ไม่ใช่รูป', async () => {
    const { svc, storage } = setup();
    await expect(svc.upload(file(Buffer.from('%PDF-1.7')), 's1')).rejects.toMatchObject({
      response: { error: expect.stringContaining('JPEG, PNG หรือ WebP') },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('แนบกับรายการที่รอใบเสร็จ - เก็บไฟล์แล้วบันทึก key โดยยังไม่ใช้ AI', async () => {
    const { svc, storage, create } = setup();
    await svc.upload(file(), 's1');
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ submissionId: 's1', mimeType: 'image/jpeg', extractionSource: 'NONE' });
    expect(data.storageKey).toMatch(/^\d{4}\/\d{2}\/[0-9a-f-]+\.jpg$/);
    expect(storage.put).toHaveBeenCalledWith(data.storageKey, JPEG, 'image/jpeg');
  });

  it('ไม่ส่ง submissionId = อัปโหลดหลายใบ รอจับคู่', async () => {
    const { svc, create } = setup();
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.submissionId).toBeNull();
  });

  it('แนบกับรายการที่ยื่นไม่สำเร็จไม่ได้', async () => {
    const { svc } = setup({ id: 's1', status: 'FAILED' });
    await expect(svc.upload(file(), 's1')).rejects.toMatchObject({ response: { error: expect.stringContaining('ยื่นไม่สำเร็จ') } });
  });

  it('บันทึกฐานข้อมูลไม่สำเร็จ - ลบไฟล์ที่เก็บไปแล้วทิ้ง', async () => {
    const { svc, storage, create } = setup();
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.upload(file(), 's1')).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalledWith(vi.mocked(storage.put).mock.calls[0][0]);
  });
});

describe('ReceiptsService.remove', () => {
  it('ลบรูปของรายการที่รับใบเสร็จแล้วไม่ได้ (หลักฐานวางบิล)', async () => {
    const { svc, storage } = setup(undefined, { id: 'r1', storageKey: 'k', submission: { status: 'RECEIPT_RECEIVED' } });
    await expect(svc.remove('r1')).rejects.toMatchObject({ response: { error: expect.stringContaining('ลบรูปใบเสร็จไม่ได้') } });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ลบรูปที่ยังไม่จับคู่ได้ ทั้งแถวและไฟล์', async () => {
    const { svc, storage } = setup(undefined, { id: 'r1', storageKey: 'k', submission: null });
    await svc.remove('r1');
    expect(storage.delete).toHaveBeenCalledWith('k');
  });
});

const READING: ReceiptReading = {
  receiptNo: '69/0035358',
  date: '2026-09-07',
  plateCategory: '8ขก',
  plateNumber: '3484',
  chassis: 'LS6CME0P7TC914754',
  weightKg: 1850,
  items: [5, 50, 200, 100, 1600].map((amount) => ({ label: 'x', amount })),
  total: 1955,
  uncertainFields: [],
};
const aiReading = (reading: ReceiptReading): ReceiptExtractor => ({
  source: 'claude-sonnet-5',
  extract: () => Promise.resolve({ reading, checks: checkReading(reading), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }),
});

describe('ReceiptsService.upload - จับคู่ด้วยเลขตัวถังที่ AI อ่าน', () => {
  it('อัปโหลดหลายใบ: เลขตัวถังตรงกับรถที่รอใบเสร็จ -> แนบให้เลย', async () => {
    const { svc, create } = setup(undefined, null, aiReading(READING), { id: 's9' });
    await svc.upload(file());
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBe('s9');
    expect(data.extraction.match).toBe('chassis');
  });

  it('อัปโหลดหลายใบ: ไม่เจอรถ -> รอจับคู่', async () => {
    const { svc, create } = setup(undefined, null, aiReading(READING), null);
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.submissionId).toBeNull();
  });

  it('แนบในแถวแต่เลขตัวถังในใบเสร็จเป็นของรถคันอื่น -> เตือน', async () => {
    const { svc, create } = setup(undefined, null, aiReading({ ...READING, chassis: 'LS6CME0P2TC915746' }));
    await svc.upload(file(), 's1');
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBe('s1');
    expect(data.extraction.match).toBe('chassis-mismatch');
  });
});

describe('checkReading - ตรวจอัตโนมัติ', () => {
  it('ใบที่อ่านถูกผ่านทุกข้อ', () => {
    expect(checkReading(READING)).toEqual({ chassisValid: true, receiptNoValid: true, plateValid: true, itemsSumMatchesTotal: true });
  });

  it('จับเลขตัวถังขาดหลัก / มีตัว O / รายการรวมไม่เท่ายอด / ทะเบียนผิดรูป', () => {
    expect(checkReading({ ...READING, chassis: 'LS6CMEP7TC914754' }).chassisValid).toBe(false);
    expect(checkReading({ ...READING, chassis: 'LS6CMEOP4TC915148' }).chassisValid).toBe(false);
    expect(checkReading({ ...READING, total: 1980 }).itemsSumMatchesTotal).toBe(false);
    expect(checkReading({ ...READING, plateCategory: '8ยถก' }).plateValid).toBe(false);
  });

  it('เลขที่ใบเสร็จไม่ล็อกว่าต้องขึ้นต้น 69', () => {
    expect(checkReading({ ...READING, receiptNo: '70/0000001' }).receiptNoValid).toBe(true);
  });
});
