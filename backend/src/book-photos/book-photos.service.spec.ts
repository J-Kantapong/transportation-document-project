import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { BookPhotosService } from './book-photos.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const file = (buffer = JPEG) => ({ buffer, size: buffer.length, originalname: 'book.jpg', mimetype: 'image/jpeg' });
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const MOTO = 'รย.12-รถจักรยานยนต์ส่วนบุคคล';

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

function pendingVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'CH1',
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED', submitDate: day('2026-09-20'), receiptDate: day('2026-09-21') }],
    ...overrides,
  };
}

function receivedVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'CH1',
    body: MOTO,
    bookReceivedDate: day('2026-09-25'),
    bookPhotoId: 'b1',
    deliveredDate: null,
    documentSubmissions: [{ submitDate: day('2026-09-20'), receiptDate: day('2026-09-21') }],
    ...overrides,
  };
}

function setup(opts: { vehicle?: unknown; existing?: unknown; updated?: number; photoUsers?: number } = {}) {
  const vehicle = 'vehicle' in opts ? opts.vehicle : pendingVehicle();
  const create = vi.fn().mockResolvedValue({ id: 'p1' });
  const updateMany = vi.fn().mockResolvedValue({ count: opts.updated ?? 1 });
  const photoUpdate = vi.fn().mockResolvedValue({ id: 'old' });
  const photoDelete = vi.fn().mockResolvedValue({ storageKey: 'books/2026/09/b1.jpg' });
  const count = vi.fn().mockResolvedValue(opts.photoUsers ?? 1);
  const logCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const tx = {
    bookPhoto: { create, update: photoUpdate, delete: photoDelete },
    vehicle: { updateMany, count },
    vehicleEditLog: { create: logCreate },
  };
  const findFirstPhoto = vi.fn().mockResolvedValue({ storageKey: 'books/k.jpg', mimeType: 'image/jpeg' });
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(vehicle) },
    bookPhoto: { findUnique: vi.fn().mockResolvedValue(opts.existing ?? null), findFirst: findFirstPhoto },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const storage = {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(Buffer.from('img')),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReceiptStorage;
  return { svc: new BookPhotosService(prisma, storage), create, updateMany, photoUpdate, photoDelete, logCreate, storage, findFirstPhoto };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T03:00:00.000Z')); // 10:00 เวลาไทย
});
afterEach(() => vi.useRealTimers());

describe('BookPhotosService.attach - แนบรูปเล่มทีละคัน (ไม่มี AI)', () => {
  it('เก็บรูป แล้วบันทึกรับเล่มพร้อมรูป', async () => {
    const { svc, create, updateMany } = setup();
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toEqual({ vehicleId: 'v1', chassis: 'CH1', date: '2026-09-26' });
    expect(create.mock.calls[0][0].data).toMatchObject({ closedAt: expect.any(Date) });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', bookReceivedDate: null },
      data: { bookReceivedDate: day('2026-09-26'), bookPhotoId: 'p1' },
    });
  });

  it('รถไม่อยู่ในคิว / ยังไม่ได้ใบเสร็จ / วันที่ผิด / ไม่มีไฟล์ = บันทึกไม่ได้', async () => {
    await expect(setup({ vehicle: null }).svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: expect.stringContaining('คิวรอรับเล่ม') } });
    const notReceived = pendingVehicle({ documentSubmissions: [{ status: 'PENDING', submitDate: day('2026-09-20'), receiptDate: null }] });
    await expect(setup({ vehicle: notReceived }).svc.attach(file(), 'v1', '2026-09-26')).rejects.toThrow();
    await expect(setup().svc.attach(file(), 'v1', '26/09/2026')).rejects.toThrow();
    await expect(setup().svc.attach(undefined, 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่พบไฟล์') } });
  });

  it('วันที่รับต้องไม่ก่อนวันที่ในใบเสร็จ และไม่เกินวันนี้ - ตรวจก่อนเก็บไฟล์', async () => {
    const early = setup();
    await expect(early.svc.attach(file(), 'v1', '2026-09-20')).rejects.toMatchObject({
      response: { error: 'วันที่รับเล่มต้องไม่ก่อนวันที่ในใบเสร็จ (21/09/2026)' },
    });
    expect(early.storage.put).not.toHaveBeenCalled();
    await expect(setup().svc.attach(file(), 'v1', '2026-09-28')).rejects.toMatchObject({ response: { error: 'วันที่รับเล่มต้องไม่เกินวันนี้' } });
  });

  it('รูปที่ผูกกับรถแล้ว = 409 บอกเลขตัวถัง ก่อนเก็บไฟล์', async () => {
    const { svc, storage } = setup({ existing: { id: 'old', vehicles: [{ chassis: 'OTHER1', body: MOTO }] } });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ status: 409, response: { error: expect.stringContaining('OTHER1') } });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('รูปค้างในถาด AI เดิมที่ไม่ได้ผูกกับรถ = ใช้แถวเดิม ไม่เก็บไฟล์ซ้ำ', async () => {
    const { svc, storage, create, photoUpdate, updateMany } = setup({ existing: { id: 'old', vehicles: [] } });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toMatchObject({ vehicleId: 'v1' });
    expect(storage.put).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(photoUpdate.mock.calls[0][0]).toEqual({ where: { id: 'old' }, data: { closedAt: expect.any(Date), readPending: false } });
    expect(updateMany.mock.calls[0][0].data).toEqual({ bookReceivedDate: day('2026-09-26'), bookPhotoId: 'old' });
  });

  it('มีคนรับเล่มคันนี้ไปพร้อมกัน = ลบไฟล์ที่เพิ่งเก็บทิ้ง', async () => {
    const { svc, storage } = setup({ updated: 0 });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: 'รถคันนี้รับเล่มไปแล้ว' } });
    expect(storage.delete).toHaveBeenCalled();
  });
});

describe('BookPhotosService.updateReceivedDate - แก้วันที่รับเล่ม (ผู้ใช้ 2026-09-27)', () => {
  it('แก้วันที่ + บันทึกประวัติ โดยเงื่อนไขรูป/วันที่เดิมและยังไม่ส่งเล่ม', async () => {
    const { svc, updateMany, logCreate } = setup({ vehicle: receivedVehicle() });
    await expect(svc.updateReceivedDate('v1', { date: '2026-09-22', remark: 'พิมพ์วันที่ผิด' })).resolves.toMatchObject({ date: '2026-09-22' });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', bookPhotoId: 'b1', bookReceivedDate: day('2026-09-25'), deliveredDate: null },
      data: { bookReceivedDate: day('2026-09-22') },
    });
    expect(JSON.parse(logCreate.mock.calls[0][0].data.changes)).toEqual({ bookReceivedDate: { from: '2026-09-25', to: '2026-09-22' } });
  });

  it('ไม่มีเหตุผล / ส่งเล่มแล้ว = แก้ไม่ได้', async () => {
    await expect(setup({ vehicle: receivedVehicle() }).svc.updateReceivedDate('v1', { date: '2026-09-22' })).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่แก้วันที่รับเล่ม' },
    });
    await expect(
      setup({ vehicle: receivedVehicle({ deliveredDate: day('2026-09-26') }) }).svc.updateReceivedDate('v1', { date: '2026-09-22', remark: 'x' }),
    ).rejects.toMatchObject({ response: { error: expect.stringContaining('ส่งเล่มให้ลูกค้าไปแล้ว') } });
  });
});

describe('BookPhotosService.detach - ถอดรูปเล่มที่แนบผิด (ผู้ใช้ 2026-09-27)', () => {
  it('ล้างวันที่รับ + รูป, บันทึกประวัติ, ลบแถวรูปและไฟล์', async () => {
    const { svc, updateMany, logCreate, photoDelete, storage } = setup({ vehicle: receivedVehicle(), photoUsers: 0 });
    await expect(asUser(['ADMIN'], () => svc.detach('v1', { remark: 'แนบผิดคัน' }))).resolves.toEqual({ vehicleId: 'v1', chassis: 'CH1', photo: 'deleted' });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', bookPhotoId: 'b1', bookReceivedDate: { not: null }, deliveredDate: null },
      data: { bookReceivedDate: null, bookPhotoId: null },
    });
    expect(logCreate.mock.calls[0][0].data).toMatchObject({ remark: 'แนบผิดคัน', editedById: 'u1' });
    expect(photoDelete).toHaveBeenCalledWith({ where: { id: 'b1' }, select: { storageKey: true } });
    expect(storage.delete).toHaveBeenCalledWith('books/2026/09/b1.jpg');
  });

  it('รูปเก่าที่ยังผูกกับรถคันอื่นอยู่ = ไม่ลบรูป และบอกหน้าเว็บว่ารูปยังใช้อยู่ / ไม่มีรูป = ล้างวันที่อย่างเดียว', async () => {
    const shared = setup({ vehicle: receivedVehicle(), photoUsers: 1 });
    await expect(shared.svc.detach('v1', { remark: 'แนบผิดคัน' })).resolves.toMatchObject({ photo: 'shared' });
    expect(shared.photoDelete).not.toHaveBeenCalled();
    expect(shared.storage.delete).not.toHaveBeenCalled();
    const noPhoto = setup({ vehicle: receivedVehicle({ bookPhotoId: null }), photoUsers: 0 });
    await expect(noPhoto.svc.detach('v1', { remark: 'รับผิดคัน' })).resolves.toMatchObject({ photo: 'none' });
    expect(noPhoto.photoDelete).not.toHaveBeenCalled();
  });

  it('มีคนแก้พร้อมกัน = 409 ให้หน้าเว็บโหลดรายการใหม่ และไม่ลบรูป', async () => {
    const stale = setup({ vehicle: receivedVehicle(), updated: 0, photoUsers: 0 });
    await expect(stale.svc.detach('v1', { remark: 'x' })).rejects.toMatchObject({ status: 409, response: { error: expect.stringContaining('รายการโหลดใหม่แล้ว') } });
    expect(stale.photoDelete).not.toHaveBeenCalled();
  });

  it('ส่งเล่มแล้ว = ถอดไม่ได้ ต้องยกเลิกใบส่งงานก่อน', async () => {
    const { svc, updateMany } = setup({ vehicle: receivedVehicle({ deliveredDate: day('2026-09-26') }) });
    await expect(svc.detach('v1', { remark: 'x' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ยกเลิกใบส่งงาน') } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('STAFF_CAR ถอดรูปเล่มรถจักรยานยนต์ไม่ได้', async () => {
    const { svc } = setup({ vehicle: receivedVehicle() });
    await asUser(['STAFF_CAR', 'ACCOUNTANT'], async () => {
      await expect(svc.detach('v1', { remark: 'x' })).rejects.toMatchObject({ status: 403 });
    });
  });
});

describe('BookPhotosService.getImage - ขอบเขตประเภทรถ', () => {
  it('กรองรูปตามรถที่ผูก (ยังไม่ผูก = เปิดได้)', async () => {
    const { svc, findFirstPhoto } = setup();
    await asUser(['STAFF_MOTO'], () => svc.getImage('b9'));
    const where = findFirstPhoto.mock.calls[0][0].where;
    expect(where.OR).toEqual([{ vehicles: { none: {} } }, { vehicles: { some: { AND: [{ body: { startsWith: 'รย.12-' } }] } } }]);
  });
});
