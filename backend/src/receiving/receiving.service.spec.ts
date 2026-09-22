import { vi } from 'vitest';
import { ReceivingService } from './receiving.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    date: new Date('2026-09-19T00:00:00.000Z'),
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: null,
    plateNumber: null,
    plateReceivedDate: null,
    bookReceivedDate: null,
    deliveredDate: null,
    deliveryRecipient: null,
    deliveryNote: null,
    customer: { name: 'ลูกค้า' },
    brand: { name: 'Toyota' },
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED' }],
    ...overrides,
  };
}

function service(found: unknown, updateMock = vi.fn().mockImplementation(async ({ data }) => ({ ...(found as object), ...data }))) {
  const prisma = { vehicle: { findUnique: vi.fn().mockResolvedValue(found), update: updateMock, findMany: vi.fn() } } as unknown as PrismaService;
  return { svc: new ReceivingService(prisma), updateMock, prisma };
}

describe('ReceivingService.markDone', () => {
  it('รับป้ายทะเบียนติ๊กเองไม่ได้ ต้องยืนยันด้วยรูปป้าย', async () => {
    const { svc, updateMock } = service(vehicle());
    await expect(svc.markDone('v1', 'plate', { date: '2026-09-20' })).rejects.toMatchObject({ response: { error: expect.stringContaining('รูปป้าย') } });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('รับเล่มทะเบียนติ๊กเองไม่ได้ ต้องยืนยันด้วยรูปเล่ม', async () => {
    const { svc, updateMock } = service(vehicle());
    await expect(svc.markDone('v1', 'book', { date: '2026-09-20' })).rejects.toMatchObject({ response: { error: expect.stringContaining('รูปเล่ม') } });
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('Delivery ไม่ได้ถ้ารับป้ายและเล่มไม่ครบ', async () => {
    const { svc } = service(vehicle({ plateReceivedDate: new Date('2026-09-20T00:00:00.000Z') }));
    await expect(svc.markDone('v1', 'delivery', { date: '2026-09-21' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ป้ายทะเบียนและเล่มทะเบียนให้ครบ') },
    });
  });

  it('Delivery ได้เมื่อรับป้ายและเล่มครบ พร้อมเก็บผู้รับ/หมายเหตุ', async () => {
    const { svc, updateMock } = service(
      vehicle({ plateReceivedDate: new Date('2026-09-20T00:00:00.000Z'), bookReceivedDate: new Date('2026-09-20T00:00:00.000Z') }),
    );
    const row = await svc.markDone('v1', 'delivery', { date: '2026-09-21', recipient: ' คุณสมชาย ', note: '' });
    expect(updateMock.mock.calls[0][0].data).toEqual({
      deliveredDate: new Date('2026-09-21T00:00:00.000Z'),
      deliveryRecipient: 'คุณสมชาย',
      deliveryNote: null,
    });
    expect(row.recipient).toBe('คุณสมชาย');
  });

  it('ปฏิเสธ step ที่ไม่รู้จักและวันที่ผิดรูปแบบ', async () => {
    const { svc } = service(vehicle());
    await expect(svc.markDone('v1', 'nope', { date: '2026-09-20' })).rejects.toMatchObject({ response: { error: expect.stringContaining('step') } });
    await expect(svc.markDone('v1', 'delivery', { date: '20/09/2026' })).rejects.toMatchObject({ response: { error: expect.stringContaining('วันที่') } });
  });
});

describe('ReceivingService.listPending', () => {
  it('รับป้าย/เล่ม: ตัดรถที่ยื่นล่าสุดไม่ใช่ RECEIPT_RECEIVED ออกจากคิว', async () => {
    const { svc, prisma } = service(null);
    (prisma.vehicle.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      vehicle({ id: 'ok' }),
      vehicle({ id: 'resubmitted', documentSubmissions: [{ status: 'PENDING' }] }),
    ]);
    const rows = await svc.listPending('book');
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });
});
