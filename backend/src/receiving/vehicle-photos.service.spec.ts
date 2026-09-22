import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehiclePhotosService } from './vehicle-photos.service.js';

function service(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { vehicle: { findMany } } as unknown as PrismaService;
  return { svc: new VehiclePhotosService(prisma), findMany };
}

const row = {
  id: 'v1',
  chassis: 'MR0FZ29G001234567',
  date: new Date('2026-09-01T00:00:00.000Z'),
  body: 'รย.1-เก๋ง 2 ตอน',
  plateCategory: 'ป้ายขาวดำ',
  plateNumber: '1กข 1234',
  plateReceivedDate: new Date('2026-09-20T00:00:00.000Z'),
  bookReceivedDate: null,
  customer: { name: 'ลูกค้า' },
  brand: { name: 'Toyota' },
  platePhoto: { id: 'p1', createdAt: new Date('2026-09-20T03:00:00.000Z') },
  bookPhoto: null,
  documentSubmissions: [
    {
      submitDate: new Date('2026-09-15T00:00:00.000Z'),
      status: 'RECEIPT_RECEIVED',
      receiptNo: '69/0035358',
      receipts: [{ id: 'r2', createdAt: new Date('2026-09-16T02:00:00.000Z') }],
    },
    {
      submitDate: new Date('2026-09-10T00:00:00.000Z'),
      status: 'FAILED',
      receiptNo: null,
      receipts: [],
    },
  ],
};

describe('VehiclePhotosService.searchByChassis', () => {
  it('rejects an empty chassis', async () => {
    const { svc, findMany } = service([]);
    await expect(svc.searchByChassis('   ')).rejects.toMatchObject({ response: { error: 'กรุณาระบุเลขตัวถัง' } });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('searches case-insensitively by partial chassis', async () => {
    const { svc, findMany } = service([]);
    await svc.searchByChassis(' 234567 ');
    expect(findMany.mock.calls[0][0].where.chassis).toEqual({ contains: '234567', mode: 'insensitive' });
    expect(findMany.mock.calls[0][0].take).toBe(10);
  });

  it('flattens receipts across submissions and keeps plate/book photo links', async () => {
    const { svc } = service([row]);
    const [v] = await svc.searchByChassis('MR0FZ29G001234567');
    expect(v).toMatchObject({
      id: 'v1',
      chassis: 'MR0FZ29G001234567',
      date: '2026-09-01',
      customerName: 'ลูกค้า',
      brandName: 'Toyota',
      plateNumber: '1กข 1234',
      platePhoto: { id: 'p1', receivedDate: '2026-09-20' },
      bookPhoto: null,
    });
    expect(v.receipts).toEqual([
      { id: 'r2', createdAt: '2026-09-16T02:00:00.000Z', submitDate: '2026-09-15', receiptNo: '69/0035358', submissionStatus: 'RECEIPT_RECEIVED' },
    ]);
  });
});
