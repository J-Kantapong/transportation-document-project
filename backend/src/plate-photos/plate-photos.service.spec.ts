import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import type { PlateReader } from './plate-reader.js';
import { PlatePhotosService } from './plate-photos.service.js';

function service(existingPhotoIds: string[]) {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    vehicle: {
      findMany: vi.fn().mockResolvedValue([{ id: 'v1', plateCategory: '8ขก', plateNumber: '1', registrationProvince: null, body: 'รย.1-นั่ง 2 ตอน', documentSubmissions: [{ status: 'RECEIPT_RECEIVED' }] }]),
      update,
    },
    platePhoto: {
      findMany: vi.fn().mockResolvedValue(existingPhotoIds.map((id) => ({ id, kind: id.startsWith('m') ? 'moto' : 'car' }))),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
  return { svc: new PlatePhotosService(prisma, {} as ReceiptStorage, {} as PlateReader), update };
}

describe('PlatePhotosService.confirm', () => {
  it('ไม่มีรูปป้าย = ยืนยันไม่ได้ (ต้องมีรูปทุกคัน)', async () => {
    const { svc, update } = service([]);
    const res = await svc.confirm({ date: '2026-09-21', items: [{ vehicleId: 'v1' }, { vehicleId: 'v1', photoId: 'gone' }] });
    expect(res.succeeded).toEqual([]);
    expect(res.failed.map((f) => f.error)).toEqual([expect.stringContaining('รูปป้าย'), expect.stringContaining('รูปป้าย')]);
    expect(update).not.toHaveBeenCalled();
  });

  it('มีรูปจริง = บันทึกวันที่รับป้ายพร้อมผูกรูปเป็นหลักฐาน', async () => {
    const { svc, update } = service(['p1']);
    const res = await svc.confirm({ date: '2026-09-21', items: [{ vehicleId: 'v1', photoId: 'p1' }] });
    expect(res.succeeded).toEqual(['v1']);
    expect(update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateReceivedDate: new Date('2026-09-21T00:00:00.000Z'), platePhotoId: 'p1' } });
  });

  it('รูปถ่ายในแท็บมอเตอร์ไซค์ ยืนยันให้รถยนต์ไม่ได้', async () => {
    const { svc, update } = service(['m1']);
    const res = await svc.confirm({ date: '2026-09-21', items: [{ vehicleId: 'v1', photoId: 'm1' }] });
    expect(res.failed[0].error).toContain('แท็บมอเตอร์ไซค์');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PlatePhotosService.upload - อ่านเบื้องหลัง (background)', () => {
  it('เก็บรูปแล้วตอบทันที (readPending) แล้วค่อยบันทึกผลที่ AI อ่าน', async () => {
    const plates = { plates: [{ category: '8ขก', number: '1', province: null, plateType: 'car' }] };
    const reader = { source: 'claude-sonnet-5', read: vi.fn().mockResolvedValue(plates) } as unknown as PlateReader;
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'p1', closedAt: null, createdAt: new Date(), ...data }));
    const prisma = {
      vehicle: { findMany: vi.fn().mockResolvedValue([]) },
      platePhoto: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ storageKey: 'k', mimeType: 'image/jpeg', readPending: true }),
        create,
        updateMany,
      },
    } as unknown as PrismaService;
    const storage = { put: vi.fn(), get: vi.fn().mockResolvedValue(Buffer.from('x')), delete: vi.fn() } as unknown as ReceiptStorage;
    const svc = new PlatePhotosService(prisma, storage, reader);
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
    const res = await svc.upload({ buffer: jpeg, size: jpeg.length, originalname: 'p.jpg' }, 'car', '1');
    expect(create.mock.calls[0][0].data).toMatchObject({ readPending: true });
    expect(res.photos[0]).toMatchObject({ readPending: true, plates: [] });
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalled());
    expect(reader.read).toHaveBeenCalledTimes(1);
    expect(updateMany.mock.calls[0][0]).toEqual({ where: { id: 'p1', readPending: true }, data: { readPending: false, extraction: plates } });
  });
});
