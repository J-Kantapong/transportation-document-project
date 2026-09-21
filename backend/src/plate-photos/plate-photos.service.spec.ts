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
