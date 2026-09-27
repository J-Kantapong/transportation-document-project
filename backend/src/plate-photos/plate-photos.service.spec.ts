import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { PlatePhotosService } from './plate-photos.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const file = (buffer = JPEG) => ({ buffer, size: buffer.length, originalname: 'plate.jpg', mimetype: 'image/jpeg' });
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const MOTO = 'รย.12-รถจักรยานยนต์ส่วนบุคคล';

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

// รถในคิวรอรับป้าย (ยื่น 20/09, ใบเสร็จลงวันที่ 21/09)
function pendingVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'CH1',
    body: MOTO,
    deliveredDate: null,
    plateDeliveredDate: null,
    customer: { name: 'ลูกค้า ก' },
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED', submitDate: day('2026-09-20'), receiptDate: day('2026-09-21') }],
    ...overrides,
  };
}

// รถที่รับป้ายแล้ว (แก้วันที่/ถอดรูป)
function receivedVehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'CH1',
    body: MOTO,
    plateReceivedDate: day('2026-09-25'),
    platePhotoId: 'p1',
    plateDeliveredDate: null,
    documentSubmissions: [{ submitDate: day('2026-09-20'), receiptDate: day('2026-09-21') }],
    ...overrides,
  };
}

function setup(
  opts: {
    vehicle?: unknown;
    existing?: unknown;
    updated?: number;
    photoUsers?: number;
    bookSlip?: unknown;
  } = {},
) {
  const vehicle = 'vehicle' in opts ? opts.vehicle : pendingVehicle();
  const create = vi.fn().mockResolvedValue({ id: 'p1' });
  const updateMany = vi.fn().mockResolvedValue({ count: opts.updated ?? 1 });
  const photoUpdate = vi.fn().mockResolvedValue({ id: 'old' });
  const photoDelete = vi.fn().mockResolvedValue({ storageKey: 'plates/2026/09/p1.jpg' });
  const count = vi.fn().mockResolvedValue(opts.photoUsers ?? 1);
  const logCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const tx = {
    platePhoto: { create, update: photoUpdate, delete: photoDelete },
    vehicle: { updateMany, count },
    vehicleEditLog: { create: logCreate },
  };
  const findFirstPhoto = vi.fn().mockResolvedValue({ storageKey: 'plates/k.jpg', mimeType: 'image/jpeg' });
  const findBookSlip = vi.fn().mockResolvedValue(opts.bookSlip ?? null);
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(vehicle) },
    deliverySlipItem: { findFirst: findBookSlip },
    platePhoto: { findUnique: vi.fn().mockResolvedValue(opts.existing ?? null), findFirst: findFirstPhoto },
    $transaction: vi.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  } as unknown as PrismaService;
  const storage = {
    put: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue(Buffer.from('img')),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReceiptStorage;
  return {
    svc: new PlatePhotosService(prisma, storage),
    prisma,
    create,
    updateMany,
    photoUpdate,
    photoDelete,
    count,
    logCreate,
    storage,
    findFirstPhoto,
    findBookSlip,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-27T03:00:00.000Z')); // 10:00 เวลาไทย
});
afterEach(() => vi.useRealTimers());

describe('PlatePhotosService.attach - แนบรูปป้ายทีละคัน (ไม่มี AI)', () => {
  it('เก็บรูปตามประเภทรถ แล้วบันทึกรับป้ายพร้อมรูป', async () => {
    const { svc, create, updateMany } = setup();
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toEqual({
      vehicleId: 'v1',
      chassis: 'CH1',
      date: '2026-09-26',
      alreadyDelivered: false,
      customerName: 'ลูกค้า ก',
      bookDeliveredDate: null,
      bookSlipNo: null,
    });
    expect(create.mock.calls[0][0].data).toMatchObject({ kind: 'moto', closedAt: expect.any(Date) });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', plateReceivedDate: null },
      data: { plateReceivedDate: day('2026-09-26'), platePhotoId: 'p1' },
    });
  });

  it('ส่งเล่มให้ลูกค้าไปแล้วแต่ป้ายยังไม่ได้ส่ง = บอกวันที่และเลขใบส่งเล่ม (ป้ายไปพร้อมเล่มแล้ว / ส่งป้ายอย่างเดียว)', async () => {
    const { svc, findBookSlip } = setup({ vehicle: pendingVehicle({ deliveredDate: day('2026-09-24') }), bookSlip: { slip: { slipNo: 7 } } });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toMatchObject({
      alreadyDelivered: true,
      customerName: 'ลูกค้า ก',
      bookDeliveredDate: '2026-09-24',
      bookSlipNo: 7,
    });
    expect(findBookSlip.mock.calls[0][0]).toMatchObject({ where: { vehicleId: 'v1', book: true, cancelledAt: null }, orderBy: { slip: { slipNo: 'desc' } } });
  });

  it('ส่งเล่มแล้วแต่หาใบส่งเล่มไม่ได้ = ยังตอบสำเร็จ (รูปบันทึกไปแล้ว) แค่ไม่บอกเลขใบ', async () => {
    const { svc, findBookSlip } = setup({ vehicle: pendingVehicle({ deliveredDate: day('2026-09-24') }) });
    findBookSlip.mockRejectedValue(new Error('db'));
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toMatchObject({ alreadyDelivered: true, bookDeliveredDate: '2026-09-24', bookSlipNo: null });
  });

  it('ยังไม่ส่งเล่ม = ไม่ต้องหาใบส่งเล่ม', async () => {
    const { svc, findBookSlip } = setup();
    await svc.attach(file(), 'v1', '2026-09-26');
    expect(findBookSlip).not.toHaveBeenCalled();
  });

  it('รถไม่อยู่ในคิว / ยังไม่ได้ใบเสร็จ / วันที่ผิด / ไม่มีไฟล์ = บันทึกไม่ได้', async () => {
    await expect(setup({ vehicle: null }).svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: expect.stringContaining('คิวรอรับป้าย') } });
    const notReceived = pendingVehicle({ documentSubmissions: [{ status: 'PENDING', submitDate: day('2026-09-20'), receiptDate: null }] });
    await expect(setup({ vehicle: notReceived }).svc.attach(file(), 'v1', '2026-09-26')).rejects.toThrow();
    await expect(setup().svc.attach(file(), 'v1', '26/09/2026')).rejects.toThrow();
    await expect(setup().svc.attach(file(), 'v1', '2026-02-31')).rejects.toThrow();
    await expect(setup().svc.attach(undefined, 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่พบไฟล์') } });
  });

  it('วันที่รับต้องไม่ก่อนวันที่ในใบเสร็จ (ไม่มี = วันที่ยื่น) และไม่เกินวันนี้ตามเวลาไทย - ตรวจก่อนเก็บไฟล์', async () => {
    const early = setup();
    await expect(early.svc.attach(file(), 'v1', '2026-09-20')).rejects.toMatchObject({
      response: { error: 'วันที่รับป้ายต้องไม่ก่อนวันที่ในใบเสร็จ (21/09/2026)' },
    });
    expect(early.storage.put).not.toHaveBeenCalled();
    const noReceiptDate = pendingVehicle({ documentSubmissions: [{ status: 'RECEIPT_RECEIVED', submitDate: day('2026-09-20'), receiptDate: null }] });
    await expect(setup({ vehicle: noReceiptDate }).svc.attach(file(), 'v1', '2026-09-19')).rejects.toMatchObject({
      response: { error: 'วันที่รับป้ายต้องไม่ก่อนวันที่ยื่นเอกสาร (20/09/2026)' },
    });
    await expect(setup().svc.attach(file(), 'v1', '2026-09-28')).rejects.toMatchObject({ response: { error: 'วันที่รับป้ายต้องไม่เกินวันนี้' } });
    // 06:00 เวลาไทยของวันที่ 28 (ยังเป็นวันที่ 27 ตาม UTC) = วันนี้ของไทยคือ 28 แล้ว
    vi.setSystemTime(new Date('2026-09-27T23:00:00.000Z'));
    await expect(setup().svc.attach(file(), 'v1', '2026-09-28')).resolves.toMatchObject({ date: '2026-09-28' });
  });

  it('รูปที่ผูกกับรถแล้ว = 409 บอกเลขตัวถังของคันที่ใช้รูปนี้ ก่อนเก็บไฟล์', async () => {
    const { svc, storage } = setup({ existing: { id: 'old', vehicles: [{ chassis: 'OTHER1', body: MOTO }] } });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({
      status: 409,
      response: { error: expect.stringContaining('OTHER1') },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('รูปเป็นของรถอีกประเภท (นอกขอบเขตผู้ใช้) = 409 ไม่บอกเลขตัวถัง', async () => {
    const { svc } = setup({ existing: { id: 'old', vehicles: [{ chassis: 'CAR1', body: 'รย.1-เก๋ง' }] } });
    await asUser(['STAFF_MOTO'], async () => {
      await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ status: 409, response: { error: 'รูปนี้อัพโหลดไปแล้ว' } });
    });
  });

  it('รูปค้างในถาด AI เดิมที่ไม่ได้ผูกกับรถคันไหน = ใช้แถวเดิม ไม่เก็บไฟล์ซ้ำ', async () => {
    const { svc, storage, create, photoUpdate, updateMany } = setup({ existing: { id: 'old', vehicles: [] } });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).resolves.toMatchObject({ vehicleId: 'v1', date: '2026-09-26' });
    expect(storage.put).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(photoUpdate.mock.calls[0][0]).toEqual({ where: { id: 'old' }, data: { closedAt: expect.any(Date), kind: 'moto', readPending: false } });
    expect(updateMany.mock.calls[0][0].data).toEqual({ plateReceivedDate: day('2026-09-26'), platePhotoId: 'old' });
  });

  it('รูปค้างถูกคำขออื่นเอาไปใช้พร้อมกัน = 409', async () => {
    const { svc } = setup({ existing: { id: 'old', vehicles: [] }, photoUsers: 2 });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ status: 409 });
  });

  it('มีคนรับป้ายคันนี้ไปพร้อมกัน = ลบไฟล์ที่เพิ่งเก็บทิ้ง', async () => {
    const { svc, storage } = setup({ updated: 0 });
    await expect(svc.attach(file(), 'v1', '2026-09-26')).rejects.toMatchObject({ response: { error: 'รถคันนี้รับป้ายไปแล้ว' } });
    expect(storage.delete).toHaveBeenCalled();
  });
});

describe('PlatePhotosService.updateReceivedDate - แก้วันที่รับป้าย (ผู้ใช้ 2026-09-27)', () => {
  it('ต้องมีเหตุผล', async () => {
    const { svc } = setup({ vehicle: receivedVehicle() });
    await expect(svc.updateReceivedDate('v1', { date: '2026-09-24', remark: ' ' })).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่แก้วันที่รับป้าย' },
    });
  });

  it('แก้วันที่ + บันทึกประวัติ โดยเงื่อนไขรูป/วันที่เดิมและยังไม่ส่งป้าย', async () => {
    const { svc, updateMany, logCreate } = setup({ vehicle: receivedVehicle() });
    await expect(svc.updateReceivedDate('v1', { date: '2026-09-24', remark: 'พิมพ์วันที่ผิด' })).resolves.toEqual({
      vehicleId: 'v1',
      chassis: 'CH1',
      date: '2026-09-24',
    });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', platePhotoId: 'p1', plateReceivedDate: day('2026-09-25'), plateDeliveredDate: null },
      data: { plateReceivedDate: day('2026-09-24') },
    });
    const log = logCreate.mock.calls[0][0].data;
    expect(log).toMatchObject({ vehicleId: 'v1', remark: 'พิมพ์วันที่ผิด', editedById: null });
    expect(JSON.parse(log.changes)).toEqual({ plateReceivedDate: { from: '2026-09-25', to: '2026-09-24' } });
  });

  it('ส่งป้ายให้ลูกค้าไปแล้ว = แก้ไม่ได้ ต้องยกเลิกใบส่งงานก่อน', async () => {
    const { svc, updateMany } = setup({ vehicle: receivedVehicle({ plateDeliveredDate: day('2026-09-26') }) });
    await expect(svc.updateReceivedDate('v1', { date: '2026-09-24', remark: 'ผิด' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ยกเลิกใบส่งงาน') },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ยังไม่ได้รับป้าย / ช่วงวันที่ผิด / วันที่เดิม / มีคนแก้พร้อมกัน = แก้ไม่ได้', async () => {
    await expect(setup({ vehicle: receivedVehicle({ plateReceivedDate: null }) }).svc.updateReceivedDate('v1', { date: '2026-09-24', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'รถคันนี้ยังไม่ได้รับป้าย' },
    });
    await expect(setup({ vehicle: null }).svc.updateReceivedDate('v1', { date: '2026-09-24', remark: 'x' })).rejects.toMatchObject({ status: 404 });
    await expect(setup({ vehicle: receivedVehicle() }).svc.updateReceivedDate('v1', { date: '2026-09-20', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ต้องไม่ก่อนวันที่ในใบเสร็จ') },
    });
    await expect(setup({ vehicle: receivedVehicle() }).svc.updateReceivedDate('v1', { date: '2026-09-28', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'วันที่รับป้ายต้องไม่เกินวันนี้' },
    });
    await expect(setup({ vehicle: receivedVehicle() }).svc.updateReceivedDate('v1', { date: '2026-09-25', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'วันที่ไม่ได้เปลี่ยน' },
    });
    const stale = setup({ vehicle: receivedVehicle(), updated: 0 });
    await expect(stale.svc.updateReceivedDate('v1', { date: '2026-09-24', remark: 'x' })).rejects.toMatchObject({
      status: 409,
      response: { error: expect.stringContaining('รายการโหลดใหม่แล้ว') },
    });
    expect(stale.logCreate).not.toHaveBeenCalled();
  });

  it('STAFF_CAR แก้รถจักรยานยนต์ไม่ได้', async () => {
    const { svc } = setup({ vehicle: receivedVehicle() });
    await asUser(['STAFF_CAR'], async () => {
      await expect(svc.updateReceivedDate('v1', { date: '2026-09-24', remark: 'x' })).rejects.toMatchObject({ status: 403 });
    });
  });
});

describe('PlatePhotosService.detach - ถอดรูปป้ายที่แนบผิด (ผู้ใช้ 2026-09-27)', () => {
  it('ล้างวันที่รับ + รูป, บันทึกประวัติพร้อมผู้แก้, ลบแถวรูปแล้วค่อยลบไฟล์หลัง transaction', async () => {
    const { svc, updateMany, logCreate, photoDelete, storage, prisma } = setup({ vehicle: receivedVehicle(), photoUsers: 0 });
    await asUser(['STAFF_MOTO'], async () => {
      await expect(svc.detach('v1', { remark: 'แนบผิดคัน' })).resolves.toEqual({ vehicleId: 'v1', chassis: 'CH1', photo: 'deleted' });
    });
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', platePhotoId: 'p1', plateReceivedDate: { not: null }, plateDeliveredDate: null },
      data: { plateReceivedDate: null, platePhotoId: null },
    });
    const log = logCreate.mock.calls[0][0].data;
    expect(log).toMatchObject({ vehicleId: 'v1', remark: 'แนบผิดคัน', editedById: 'u1' });
    expect(JSON.parse(log.changes)).toEqual({ plateReceivedDate: { from: '2026-09-25', to: null }, platePhotoId: { from: 'p1', to: null } });
    expect(photoDelete).toHaveBeenCalledWith({ where: { id: 'p1' }, select: { storageKey: true } });
    expect(storage.delete).toHaveBeenCalledWith('plates/2026/09/p1.jpg');
    // ลบไฟล์หลัง transaction จบแล้วเท่านั้น
    expect((storage.delete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]).toBeGreaterThan(
      (prisma.$transaction as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    );
  });

  it('รูปเก่าที่ยังผูกกับรถคันอื่นอยู่ = ถอดเฉพาะคันนี้ ไม่ลบรูป และบอกหน้าเว็บว่ารูปยังใช้อยู่ (แนบไฟล์เดิมซ้ำไม่ได้)', async () => {
    const { svc, photoDelete, storage } = setup({ vehicle: receivedVehicle(), photoUsers: 1 });
    await expect(svc.detach('v1', { remark: 'แนบผิดคัน' })).resolves.toMatchObject({ photo: 'shared' });
    expect(photoDelete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('แถวเก่าที่รับป้ายโดยไม่มีรูป = ล้างวันที่รับอย่างเดียว', async () => {
    const { svc, photoDelete, count } = setup({ vehicle: receivedVehicle({ platePhotoId: null }), photoUsers: 0 });
    await expect(svc.detach('v1', { remark: 'รับผิดคัน' })).resolves.toMatchObject({ photo: 'none' });
    expect(count).not.toHaveBeenCalled();
    expect(photoDelete).not.toHaveBeenCalled();
  });

  it('ไม่มีเหตุผล / ส่งป้ายแล้ว / มีคนแก้พร้อมกัน = ถอดไม่ได้ และไม่ลบไฟล์', async () => {
    await expect(setup({ vehicle: receivedVehicle() }).svc.detach('v1', {})).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่ถอดรูปป้าย' } });
    const delivered = setup({ vehicle: receivedVehicle({ plateDeliveredDate: day('2026-09-26') }) });
    await expect(delivered.svc.detach('v1', { remark: 'x' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ส่งป้ายให้ลูกค้าไปแล้ว (26/09/2026)') } });
    expect(delivered.updateMany).not.toHaveBeenCalled();
    const stale = setup({ vehicle: receivedVehicle(), updated: 0, photoUsers: 0 });
    await expect(stale.svc.detach('v1', { remark: 'x' })).rejects.toThrow();
    expect(stale.photoDelete).not.toHaveBeenCalled();
    expect(stale.storage.delete).not.toHaveBeenCalled();
  });
});

describe('PlatePhotosService.getImage - ขอบเขตประเภทรถ', () => {
  it('เปิดได้เมื่อรูปยังไม่ผูกกับรถ หรือผูกกับรถในขอบเขตของผู้ใช้', async () => {
    const { svc, findFirstPhoto } = setup();
    await asUser(['STAFF_CAR'], () => svc.getImage('p9'));
    const where = findFirstPhoto.mock.calls[0][0].where;
    expect(where.id).toBe('p9');
    expect(where.OR[0]).toEqual({ vehicles: { none: {} } });
    expect(where.OR[1].vehicles.some).toEqual({ AND: [{ OR: [{ body: null }, { NOT: { body: { startsWith: 'รย.12-' } } }] }] });
  });

  it('ไม่พบ (หรือเป็นของรถนอกขอบเขต) = 404', async () => {
    const { svc, findFirstPhoto } = setup();
    findFirstPhoto.mockResolvedValue(null);
    await expect(svc.getImage('p9')).rejects.toMatchObject({ status: 404 });
  });
});
