import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { ReceivingController } from './receiving.controller.js';
import { COMPLETED_PAGE_SIZE, ReceivingService } from './receiving.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const MOTO_ONLY = { AND: [{ body: { startsWith: 'รย.12-' } }] };
const CAR_ONLY = { AND: [{ OR: [{ body: null }, { NOT: { body: { startsWith: 'รย.12-' } } }] }] };
const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    date: new Date('2026-09-19T00:00:00.000Z'),
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: null,
    plateNumber: null,
    plateReceivedDate: null,
    platePhotoId: null,
    bookPhotoId: null,
    bookReceivedDate: null,
    deliveredDate: null,
    plateDeliveredDate: null,
    deliveryRecipient: null,
    deliveryNote: null,
    customer: { name: 'ลูกค้า' },
    brand: { name: 'Toyota' },
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED' }],
    ...overrides,
  };
}

function service(rows: unknown[] = []) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { vehicle: { findMany } } as unknown as PrismaService;
  return { svc: new ReceivingService(prisma), findMany };
}

describe('PATCH /api/vehicles/:id/receiving/:step ถูกถอดออก (พบ 2026-09-27)', () => {
  it('ไม่มีทางบันทึกส่งงาน/รับของโดยไม่ผ่านหน้าแนบรูปหรือใบส่งงาน', () => {
    expect((ReceivingService.prototype as unknown as Record<string, unknown>).markDone).toBeUndefined();
    expect((ReceivingController.prototype as unknown as Record<string, unknown>).markDone).toBeUndefined();
  });
});

describe('ReceivingService.listPending', () => {
  it('รับป้าย/เล่ม: ตัดรถที่ยื่นล่าสุดไม่ใช่ RECEIPT_RECEIVED ออกจากคิว', async () => {
    const { svc } = service([vehicle({ id: 'ok' }), vehicle({ id: 'resubmitted', documentSubmissions: [{ status: 'PENDING' }] })]);
    const rows = await svc.listPending('book');
    expect(rows.map((r) => r.id)).toEqual(['ok']);
  });

  it('?kind=moto กรองในฐานข้อมูลร่วมกับขอบเขตของผู้ใช้ และส่งวันที่ในใบเสร็จไปให้หน้าเว็บตรวจวันที่รับ', async () => {
    const receiptDate = new Date('2026-09-21T00:00:00.000Z');
    const { svc, findMany } = service([vehicle({ documentSubmissions: [{ status: 'RECEIPT_RECEIVED', receiptDate }] })]);
    const rows = await asUser(['STAFF_MOTO'], () => svc.listPending('plate', 'moto'));
    const where = findMany.mock.calls[0][0].where;
    expect(where.AND).toEqual([MOTO_ONLY, MOTO_ONLY]);
    expect(where.deletedAt).toBeNull();
    expect(rows[0].receiptDate).toBe('2026-09-21');
  });

  it('kind ที่ไม่รู้จัก = 400', async () => {
    await expect(service().svc.listPending('plate', 'truck')).rejects.toMatchObject({ response: { error: expect.stringContaining('kind') } });
    await expect(service().svc.listPending('nope')).rejects.toMatchObject({ response: { error: expect.stringContaining('step') } });
  });
});

describe('ReceivingService.listCompleted - ตาราง "ดำเนินการแล้ว"', () => {
  it('กรองประเภทรถก่อนตัด 100 คัน และเรียงตามเวลาที่แนบรูป (ล่าสุดก่อน) ไม่ใช่วันที่รับที่พิมพ์', async () => {
    const { svc, findMany } = service([vehicle({ plateReceivedDate: new Date('2026-09-10T00:00:00.000Z'), platePhotoId: 'p1' })]);
    const res = await svc.listCompleted('plate', { kind: 'car' });
    const args = findMany.mock.calls[0][0];
    expect(args.where.plateReceivedDate).toEqual({ not: null });
    expect(args.where.AND).toEqual([{}, CAR_ONLY]);
    expect(args.orderBy[0]).toEqual({ platePhoto: { closedAt: { sort: 'desc', nulls: 'last' } } });
    expect(args.take).toBe(COMPLETED_PAGE_SIZE + 1);
    expect(args.skip).toBe(0);
    expect(res).toMatchObject({ hasMore: false, vehicles: [{ id: 'v1', platePhotoId: 'p1', doneDate: '2026-09-10', itemDeliveredDate: null }] });
  });

  it('เกิน 100 คัน = hasMore และส่งแค่ 100 คัน, offset = โหลดเพิ่ม', async () => {
    const rows = Array.from({ length: COMPLETED_PAGE_SIZE + 1 }, (_, i) => vehicle({ id: `v${i}`, bookReceivedDate: new Date('2026-09-20T00:00:00.000Z') }));
    const { svc, findMany } = service(rows);
    const res = await svc.listCompleted('book', { offset: '100' });
    expect(findMany.mock.calls[0][0].skip).toBe(100);
    expect(findMany.mock.calls[0][0].orderBy[0]).toEqual({ bookPhoto: { closedAt: { sort: 'desc', nulls: 'last' } } });
    expect(res.vehicles).toHaveLength(COMPLETED_PAGE_SIZE);
    expect(res.hasMore).toBe(true);
    await expect(svc.listCompleted('book', { offset: '-1' })).rejects.toMatchObject({ response: { error: expect.stringContaining('offset') } });
  });

  it('limit = โหลดใหม่ด้วยจำนวนที่เปิดอยู่ (กดโหลดเพิ่มไว้แล้วไม่หดกลับเหลือ 100) ได้ถึง 1,000 คัน', async () => {
    const rows = Array.from({ length: 251 }, (_, i) => vehicle({ id: `v${i}`, plateReceivedDate: new Date('2026-09-20T00:00:00.000Z') }));
    const { svc, findMany } = service(rows);
    const res = await svc.listCompleted('plate', { limit: '250' });
    expect(findMany.mock.calls[0][0].take).toBe(251);
    expect(res.vehicles).toHaveLength(250);
    expect(res.hasMore).toBe(true);
    await expect(svc.listCompleted('plate', { limit: '1001' })).rejects.toMatchObject({ response: { error: expect.stringContaining('limit') } });
    await expect(svc.listCompleted('plate', { limit: '0' })).rejects.toMatchObject({ response: { error: expect.stringContaining('limit') } });
    await expect(svc.listCompleted('plate', { limit: 'abc' })).rejects.toMatchObject({ response: { error: expect.stringContaining('limit') } });
  });

  it('q ค้นเลขตัวถัง/ทะเบียน/ลูกค้า หรือเลขที่ใบเสร็จ', async () => {
    const { svc, findMany } = service();
    await svc.listCompleted('plate', { kind: 'moto', q: '0035' });
    const and = findMany.mock.calls[0][0].where.AND;
    expect(and).toHaveLength(3);
    expect(and[2].OR[1]).toEqual({ documentSubmissions: { some: { receiptNo: { contains: '0035', mode: 'insensitive' } } } });
    expect(JSON.stringify(and[2].OR[0])).toContain('chassis');
  });

  it('บอกวันที่ส่งของชิ้นนั้นให้ลูกค้า (ป้าย = plateDeliveredDate, เล่ม = deliveredDate) - ส่งแล้วแก้/ถอดรูปไม่ได้', async () => {
    const delivered = vehicle({
      plateReceivedDate: new Date('2026-09-20T00:00:00.000Z'),
      bookReceivedDate: new Date('2026-09-20T00:00:00.000Z'),
      deliveredDate: new Date('2026-09-22T00:00:00.000Z'),
    });
    const plate = await service([delivered]).svc.listCompleted('plate');
    const book = await service([delivered]).svc.listCompleted('book');
    expect(plate.vehicles[0].itemDeliveredDate).toBeNull();
    expect(book.vehicles[0].itemDeliveredDate).toBe('2026-09-22');
  });
});

describe('ReceivingService - รับป้ายของรถที่ส่งเล่มไปก่อนแล้ว (พบ 2026-09-27)', () => {
  it('คิวรอรับป้ายบอกวันที่ส่งเล่ม - ป้ายไปพร้อมเล่ม (แนบรูปช้า) วันที่รับป้ายต้องไม่หลังวันนั้น', async () => {
    const bookSent = vehicle({ bookReceivedDate: new Date('2026-09-20T00:00:00.000Z'), deliveredDate: new Date('2026-09-22T00:00:00.000Z') });
    const [plateRow] = await service([bookSent]).svc.listPending('plate');
    expect(plateRow.bookDeliveredDate).toBe('2026-09-22');
    const [notSent] = await service([vehicle()]).svc.listPending('plate');
    expect(notSent.bookDeliveredDate).toBeNull();
    // ขั้นอื่นไม่ใช้
    const book = await service([bookSent]).svc.listCompleted('book');
    expect(book.vehicles[0].bookDeliveredDate).toBeNull();
  });
});
