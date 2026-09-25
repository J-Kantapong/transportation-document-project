import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { BookPhotosService } from './book-photos.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const file = (buffer = JPEG) => ({ buffer, size: buffer.length, originalname: 'book.jpg', mimetype: 'image/jpeg' });

function setup(opts: { vehicle?: unknown; duplicate?: boolean; updated?: number } = {}) {
  const vehicle =
    'vehicle' in opts ? opts.vehicle : { id: 'v1', body: 'รย.12-รถจักรยานยนต์ส่วนบุคคล', documentSubmissions: [{ status: 'RECEIPT_RECEIVED' }] };
  const create = vi.fn().mockResolvedValue({ id: 'p1' });
  const updateMany = vi.fn().mockResolvedValue({ count: opts.updated ?? 1 });
  const tx = { bookPhoto: { create }, vehicle: { updateMany } };
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(vehicle) },
    bookPhoto: { findUnique: vi.fn().mockResolvedValue(opts.duplicate ? { id: 'old' } : null) },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const storage = { put: vi.fn().mockResolvedValue(undefined), delete: vi.fn().mockResolvedValue(undefined) } as unknown as ReceiptStorage;
  return { svc: new BookPhotosService(prisma, storage), create, updateMany, storage };
}

describe('BookPhotosService.attach - แนบรูปเล่มทีละคัน (ไม่มี AI)', () => {
  it('เก็บรูป แล้วบันทึกรับเล่มพร้อมรูป', async () => {
    const { svc, create, updateMany } = setup();
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toEqual({ vehicleId: 'v1' });
    expect(create.mock.calls[0][0].data).toMatchObject({ closedAt: expect.any(Date) });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', bookReceivedDate: null },
      data: { bookReceivedDate: new Date('2026-09-26T00:00:00.000Z'), bookPhotoId: 'p1' },
    });
  });

  it('รถไม่อยู่ในคิว / ยังไม่ได้ใบเสร็จ / วันที่ผิด / ไม่มีไฟล์ = บันทึกไม่ได้', async () => {
    await expect(setup({ vehicle: null }).svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: expect.stringContaining('คิวรอรับเล่ม') } });
    await expect(setup({ vehicle: { id: 'v1', body: null, documentSubmissions: [{ status: 'PENDING' }] } }).svc.attach(file(), 'v1', '2026-09-26')).rejects.toThrow();
    await expect(setup().svc.attach(file(), 'v1', '26/09/2026')).rejects.toThrow();
    await expect(setup().svc.attach(undefined, 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่พบไฟล์') } });
  });

  it('รูปซ้ำ = 409 ก่อนเก็บไฟล์', async () => {
    const { svc, storage } = setup({ duplicate: true });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ status: 409 });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('มีคนรับเล่มคันนี้ไปพร้อมกัน = ลบไฟล์ที่เพิ่งเก็บทิ้ง', async () => {
    const { svc, storage } = setup({ updated: 0 });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: 'รถคันนี้รับเล่มไปแล้ว' } });
    expect(storage.delete).toHaveBeenCalled();
  });
});
