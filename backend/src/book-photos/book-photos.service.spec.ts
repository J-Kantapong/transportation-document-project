import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import type { BookReader } from './book-reader.js';
import { BookPhotosService } from './book-photos.service.js';

function service(existingPhotoIds: string[]) {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    vehicle: {
      findMany: vi.fn().mockResolvedValue([
        { id: 'v1', chassis: 'VIN1', plateCategory: '8ขก', plateNumber: '1', registrationProvince: null, documentSubmissions: [{ status: 'RECEIPT_RECEIVED' }] },
      ]),
      update,
    },
    bookPhoto: {
      findMany: vi.fn().mockResolvedValue(existingPhotoIds.map((id) => ({ id }))),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
  } as unknown as PrismaService;
  return { svc: new BookPhotosService(prisma, {} as ReceiptStorage, {} as BookReader), update };
}

describe('BookPhotosService.confirm', () => {
  it('ไม่มีรูปเล่ม = ยืนยันไม่ได้ (ต้องมีรูปทุกคัน)', async () => {
    const { svc, update } = service([]);
    const res = await svc.confirm({ date: '2026-09-21', items: [{ vehicleId: 'v1' }, { vehicleId: 'v1', photoId: 'gone' }] });
    expect(res.succeeded).toEqual([]);
    expect(res.failed.map((f) => f.error)).toEqual([expect.stringContaining('รูปเล่ม'), expect.stringContaining('รูปเล่ม')]);
    expect(update).not.toHaveBeenCalled();
  });

  it('มีรูปจริง = บันทึกวันที่รับเล่มพร้อมผูกรูปเป็นหลักฐาน · คันที่ไม่อยู่ในคิวแจ้งกลับ', async () => {
    const { svc, update } = service(['b1']);
    const res = await svc.confirm({ date: '2026-09-21', items: [{ vehicleId: 'v1', photoId: 'b1' }, { vehicleId: 'v1', photoId: 'b1' }, { vehicleId: 'x', photoId: 'b1' }] });
    expect(res.succeeded).toEqual(['v1']);
    expect(res.failed).toHaveLength(2);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { bookReceivedDate: new Date('2026-09-21T00:00:00.000Z'), bookPhotoId: 'b1' } });
  });
});
