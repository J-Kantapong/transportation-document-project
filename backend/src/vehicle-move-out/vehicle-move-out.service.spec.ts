import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptExtractor } from '../receipts/receipt-extractor.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { VehicleMoveOutService, serializeMoveOut } from './vehicle-move-out.service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'x1',
    vehicleClass: 'CAR',
    customerId: 'c1',
    customer: { id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก จำกัด' },
    ownerName: 'สมชาย',
    engine: '2AZ1234567',
    chassis: 'MR0FZ29G001234567',
    brand: 'Toyota',
    plateCategory: 'กข',
    plateNumber: '1234',
    submitDate: new Date('2026-09-20T00:00:00.000Z'),
    urgent: false,
    billTotal: 25,
    noBillTotal: 80,
    dutyAmount: 10,
    returnedDate: null,
    receiptNo: null,
    receiptDate: null,
    receiptAmount: null,
    cancelledAt: null,
    createdAt: new Date('2026-09-20T01:00:00.000Z'),
    updatedAt: new Date('2026-09-20T01:00:00.000Z'),
    receipts: [],
    ...overrides,
  };
}

const oneReceipt = [{ id: 'r1', createdAt: new Date('2026-09-21T00:00:00.000Z') }];
const noAiExtractor: ReceiptExtractor = { source: 'NONE', extract: vi.fn().mockResolvedValue(null) };

function service(found: unknown) {
  let current = found as Record<string, unknown> | null;
  const create = vi.fn().mockImplementation(async ({ data }) => row({ ...data }));
  const update = vi.fn().mockImplementation(async ({ data }) => {
    current = { ...current, ...data };
    return current;
  });
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    vehicleMoveOut: {
      create,
      update,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockImplementation(async () => current),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => current),
      // lockRow: สถานะล่าสุดหลังล็อกแถว
      findFirst: vi.fn().mockImplementation(async () =>
        current && !current.cancelledAt ? { returnedDate: current.returnedDate, _count: { receipts: (current.receipts as unknown[]).length } } : null,
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    brand: { findFirst: vi.fn().mockImplementation(async ({ where }) => (where.name.equals.toLowerCase() === 'toyota' ? { name: 'Toyota' } : null)) },
    customer: { findUnique: vi.fn().mockImplementation(async ({ where }) => (['c1', 'c2'].includes(where.id) ? { id: where.id } : null)) },
    receiptImage: {
      create: vi.fn().mockResolvedValue({ id: 'r-new' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockImplementation(async ({ where }) => ({ id: where.id, storageKey: `receipts/${where.id}.jpg` })),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit1' }) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const storage: ReceiptStorage = { put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  return { svc: new VehicleMoveOutService(prisma as unknown as PrismaService, storage, noAiExtractor), create, update, prisma, storage };
}

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

const validDto = {
  customerId: 'c1',
  ownerName: ' สมชาย ',
  engine: ' 2AZ1234567 ',
  chassis: 'MR0FZ29G001234567',
  brand: 'toyota',
  plateCategory: 'กข',
  plateNumber: '1234',
  submitDate: '2026-09-20',
};

const auditOf = (prisma: ReturnType<typeof service>['prisma']) => prisma.auditLog.create.mock.calls.map((c) => c[0].data);


describe('VehicleMoveOutService.create', () => {
  it('บันทึกข้อมูลรถ ตัดช่องว่าง', async () => {
    const { svc, create } = service(null);
    const { moveOut } = await svc.create(validDto);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      vehicleClass: 'CAR',
      customerId: 'c1',
      ownerName: 'สมชาย',
      engine: '2AZ1234567',
      brand: 'Toyota',
      plateCategory: 'กข',
      plateNumber: '1234',
    });
    expect(data.submitDate).toEqual(new Date('2026-09-20T00:00:00.000Z'));
    expect(moveOut.submitDate).toBe('2026-09-20');
  });

  it('มอเตอร์ไซค์: Bill 25 / No Bill ลงขัน 80 / ค่าอากร 10 แยกต่างหาก (ไม่รับยอดจากผู้เรียก)', async () => {
    const { svc, create } = service(null);
    await asUser(['STAFF_MOTO'], () => svc.create({ ...validDto, vehicleClass: 'MOTO', billTotal: 9999, noBillTotal: 1, dutyAmount: 0 } as never));
    expect(create.mock.calls[0][0].data).toMatchObject({ vehicleClass: 'MOTO', urgent: false, billTotal: 25, noBillTotal: 80, dutyAmount: 10 });
  });

  it('มอเตอร์ไซค์ด่วน: No Bill = 80 + ด่วนเพิ่ม 50 = 130', async () => {
    const { svc, create } = service(null);
    await asUser(['STAFF_MOTO'], () => svc.create({ ...validDto, vehicleClass: 'MOTO', urgent: true }));
    expect(create.mock.calls[0][0].data).toMatchObject({ urgent: true, billTotal: 25, noBillTotal: 130, dutyAmount: 10 });
  });

  it('รถยนต์ยังไม่มีอัตรา: ยอดเป็น 0 และเลือกงานด่วนไม่ได้', async () => {
    const { svc, create } = service(null);
    await svc.create(validDto);
    expect(create.mock.calls[0][0].data).toMatchObject({ urgent: false, billTotal: 0, noBillTotal: 0, dutyAmount: 0 });
    await expect(svc.create({ ...validDto, urgent: true })).rejects.toMatchObject({ response: { error: 'งานย้ายออกรถยนต์ยังไม่มีอัตรางานด่วน' } });
    await expect(svc.create({ ...validDto, vehicleClass: 'MOTO', urgent: 'ใช่' })).rejects.toBeDefined();
  });

  it('ต้องเลือกเจ้าของงานและกรอกครบทุกช่อง', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, customerId: '' })).rejects.toMatchObject({ response: { error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' } });
    await expect(svc.create({ ...validDto, customerId: 'nope' })).rejects.toMatchObject({ response: { error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' } });
    await expect(svc.create({ ...validDto, engine: ' ' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกเลขเครื่อง' } });
    await expect(svc.create({ ...validDto, chassis: '' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกเลขตัวถัง' } });
    await expect(svc.create({ ...validDto, plateCategory: '' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกหมวดทะเบียน' } });
    await expect(svc.create({ ...validDto, brand: 'Unknown' })).rejects.toMatchObject({ response: { error: 'กรุณาเลือกยี่ห้อจากรายการ' } });
    await expect(svc.create({ ...validDto, submitDate: '2026-02-31' })).rejects.toMatchObject({
      response: { error: 'กรุณาระบุวันที่ยื่นให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('รถยนต์ = STAFF_CAR และมอเตอร์ไซค์ = STAFF_MOTO เท่านั้น', async () => {
    const { svc, create } = service(null);
    await expect(asUser(['STAFF_MOTO'], () => svc.create(validDto))).rejects.toBeDefined();
    await expect(asUser(['STAFF_CAR'], () => svc.create({ ...validDto, vehicleClass: 'MOTO' }))).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
    await asUser(['STAFF_CAR'], () => svc.create(validDto));
    await asUser(['STAFF_MOTO'], () => svc.create({ ...validDto, vehicleClass: 'MOTO' }));
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1][0].data.vehicleClass).toBe('MOTO');
  });

  it('ค่า vehicleClass ที่ไม่รู้จักถูกปฏิเสธ', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, vehicleClass: 'BUS' })).rejects.toMatchObject({
      response: { error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR หรือ MOTO' },
    });
  });
});

describe('VehicleMoveOutService.list', () => {
  it('กรองตามประเภทรถ สถานะ และไม่แสดงงานที่ยกเลิกแล้ว', async () => {
    const { svc, prisma } = service(null);
    await svc.list('pending', '2026-09', 'MOTO');
    expect(prisma.vehicleMoveOut.findMany.mock.calls[0][0].where).toMatchObject({
      vehicleClass: 'MOTO',
      cancelledAt: null,
      returnedDate: null,
      submitDate: { gte: new Date('2026-09-01T00:00:00.000Z'), lt: new Date('2026-10-01T00:00:00.000Z') },
    });
    await expect(svc.list('bogus')).rejects.toBeDefined();
    await expect(svc.list('all', '2026-13')).rejects.toBeDefined();
  });
});

describe('VehicleMoveOutService.markReturned', () => {
  it('ต้องมีรูปใบเสร็จก่อนรับเอกสารกลับ', async () => {
    const { svc, update } = service(row());
    await expect(svc.markReturned('x1', '2026-09-22')).rejects.toMatchObject({ response: { error: 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('รับกลับได้เมื่อมีรูป และวันที่ต้องไม่ก่อนวันที่ยื่น / ไม่เกินวันนี้', async () => {
    const { svc, update } = service(row({ receipts: oneReceipt }));
    await expect(svc.markReturned('x1', '2026-09-19')).rejects.toMatchObject({ response: { error: 'วันที่รับเอกสารกลับต้องไม่ก่อนวันที่ยื่น' } });
    await expect(svc.markReturned('x1', '2999-01-01')).rejects.toMatchObject({ response: { error: 'วันที่รับเอกสารกลับต้องไม่เกินวันนี้' } });
    await expect(svc.markReturned('x1', 'not-a-date')).rejects.toBeDefined();
    expect(update).not.toHaveBeenCalled();
    const { moveOut } = await svc.markReturned('x1', '2026-09-22');
    expect(update.mock.calls[0][0].data.returnedDate).toEqual(new Date('2026-09-22T00:00:00.000Z'));
    expect(moveOut.returnedDate).toBe('2026-09-22');
  });

  it('งานที่รับกลับแล้วรับซ้ำไม่ได้ / งานที่ยกเลิกแล้วแก้ต่อไม่ได้', async () => {
    const returned = service(row({ receipts: oneReceipt, returnedDate: new Date('2026-09-22T00:00:00.000Z') }));
    await expect(returned.svc.markReturned('x1', '2026-09-23')).rejects.toMatchObject({ response: { error: 'งานนี้รับเอกสารกลับแล้ว' } });
    const cancelled = service(row({ receipts: oneReceipt, cancelledAt: new Date() }));
    await expect(cancelled.svc.markReturned('x1', '2026-09-22')).rejects.toMatchObject({ status: 409 });
  });
});

describe('VehicleMoveOutService.update', () => {
  it('ต้องระบุเหตุผลและบันทึกเฉพาะช่องที่เปลี่ยนลง AuditLog', async () => {
    const { svc, update, prisma } = service(row());
    await expect(svc.update('x1', { ownerName: 'ใหม่' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่แก้งานย้ายออก' } });
    await svc.update('x1', { ownerName: 'สมหญิง', remark: 'พิมพ์ชื่อผิด' });
    expect(update.mock.calls[0][0].data).toMatchObject({ ownerName: 'สมหญิง' });
    const [audit] = auditOf(prisma);
    expect(audit).toMatchObject({ entity: 'VehicleMoveOut', entityId: 'x1', action: 'update', remark: 'พิมพ์ชื่อผิด' });
    expect(update.mock.calls[0][0].data).toMatchObject({ urgent: false, noBillTotal: 80 }); // ไม่แตะติ๊กด่วน = คงยอด snapshot เดิม
    // แก้ได้เฉพาะชื่อ - ประวัติเก็บเฉพาะช่องที่เปลี่ยน
    expect(Object.keys(audit.changes as object).sort()).toEqual(['ownerName']);
  });

  it('แก้ติ๊กงานด่วนของมอเตอร์ไซค์: คิด No Bill ใหม่และลงประวัติ / รถยนต์ติ๊กด่วนไม่ได้', async () => {
    const moto = service(row({ vehicleClass: 'MOTO' }));
    await asUser(['STAFF_MOTO'], () => moto.svc.update('x1', { urgent: true, remark: 'ลูกค้าขอด่วน' }));
    expect(moto.update.mock.calls[0][0].data).toMatchObject({ urgent: true, noBillTotal: 130 });
    const changes = auditOf(moto.prisma)[0].changes as Record<string, unknown>;
    expect(Object.keys(changes).sort()).toEqual(['noBillTotal', 'urgent']);
    const car = service(row({ billTotal: 0, noBillTotal: 0, dutyAmount: 0 }));
    await expect(car.svc.update('x1', { urgent: true, remark: 'x' })).rejects.toMatchObject({ response: { error: 'งานย้ายออกรถยนต์ยังไม่มีอัตรางานด่วน' } });
  });

  it('ไม่มีอะไรเปลี่ยน = 400 / ฟอร์มเก่ากว่าในระบบ = 409', async () => {
    const { svc } = service(row());
    await expect(svc.update('x1', { ownerName: 'สมชาย', remark: 'x' })).rejects.toMatchObject({ response: { error: 'ไม่มีข้อมูลที่เปลี่ยน' } });
    await expect(svc.update('x1', { ownerName: 'อื่น', remark: 'x', expectedUpdatedAt: '2026-09-19T00:00:00.000Z' })).rejects.toMatchObject({ status: 409 });
  });

  it('วันที่รับกลับแก้ได้เฉพาะงานที่รับกลับแล้ว', async () => {
    const { svc } = service(row());
    await expect(svc.update('x1', { returnedDate: '2026-09-22', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'งานนี้ยังไม่รับเอกสารกลับ - ใช้ปุ่มยืนยันรับกลับในหน้ารับใบเสร็จ' },
    });
  });
});

describe('VehicleMoveOutService.cancel / undoReturn', () => {
  it('ยกเลิกงานต้องมีเหตุผล เก็บแถวไว้ ล้าง hash รูป และเขียนประวัติ', async () => {
    const { svc, update, prisma } = service(row({ receipts: oneReceipt }));
    await expect(svc.cancel('x1', '  ')).rejects.toBeDefined();
    await svc.cancel('x1', 'บันทึกซ้ำ');
    expect(update.mock.calls[0][0].data).toMatchObject({ cancelReason: 'บันทึกซ้ำ' });
    expect(prisma.receiptImage.updateMany).toHaveBeenCalledWith({ where: { vehicleMoveOutId: 'x1' }, data: { contentHash: null } });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'cancel', remark: 'บันทึกซ้ำ' });
  });

  it('ยกเลิกรับกลับต้องมีเหตุผลและงานต้องรับกลับแล้ว', async () => {
    const pending = service(row());
    await expect(pending.svc.undoReturn('x1', 'ผิดงาน')).rejects.toMatchObject({ response: { error: 'งานนี้ยังไม่รับเอกสารกลับ' } });
    const { svc, update, prisma } = service(row({ receipts: oneReceipt, returnedDate: new Date('2026-09-22T00:00:00.000Z') }));
    await expect(svc.undoReturn('x1', '')).rejects.toBeDefined();
    await svc.undoReturn('x1', 'กดผิดงาน');
    expect(update.mock.calls[0][0].data).toEqual({ returnedDate: null });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'undo-return' });
  });
});

describe('VehicleMoveOutService receipts', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const file = { buffer: jpeg, size: jpeg.length, originalname: 'r.jpg', mimetype: 'image/jpeg' };

  it('แนบรูปได้ (ผูกกับงานนี้) และรูปที่ใช้แล้วแนบซ้ำไม่ได้', async () => {
    const { svc, prisma, storage } = service(row());
    await svc.addReceipt('x1', file);
    expect(prisma.receiptImage.create.mock.calls[0][0].data).toMatchObject({ vehicleMoveOutId: 'x1', mimeType: 'image/jpeg' });
    expect(storage.put).toHaveBeenCalled();

    prisma.receiptImage.findUnique.mockResolvedValueOnce({ id: 'other' });
    await expect(svc.addReceipt('x1', file)).rejects.toMatchObject({ status: 409 });
  });

  it('งานที่รับกลับแล้วแนบ/ลบรูปต้องมีเหตุผล และต้องเหลืออย่างน้อย 1 รูป', async () => {
    const returned = row({ receipts: oneReceipt, returnedDate: new Date('2026-09-22T00:00:00.000Z') });
    const { svc, prisma, storage } = service(returned);
    await expect(svc.addReceipt('x1', file)).rejects.toBeDefined();
    await expect(svc.removeReceipt('x1', 'r1')).rejects.toBeDefined();
    await expect(svc.removeReceipt('x1', 'r1', 'ลบผิดใบ')).rejects.toMatchObject({
      response: { error: 'งานที่รับเอกสารกลับแล้วต้องมีรูปใบเสร็จอย่างน้อย 1 รูป - แนบรูปที่ถูกต้องก่อนแล้วจึงลบรูปนี้' },
    });
    expect(prisma.receiptImage.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ก่อนรับกลับลบรูปได้เลยพร้อมลบไฟล์', async () => {
    const { svc, prisma, storage } = service(row({ receipts: oneReceipt }));
    await svc.removeReceipt('x1', 'r1');
    expect(prisma.receiptImage.deleteMany).toHaveBeenCalledWith({ where: { id: 'r1', vehicleMoveOutId: 'x1' } });
    expect(storage.delete).toHaveBeenCalledWith('receipts/r1.jpg');
  });

  it('แก้ข้อมูลใบเสร็จ: วันที่ต้องอยู่ในช่วง / หลังรับกลับต้องมีเหตุผล', async () => {
    const open = service(row());
    await expect(open.svc.updateReceiptFields('x1', { receiptDate: '2026-09-01' })).rejects.toMatchObject({
      response: { error: 'วันที่ใบเสร็จต้องไม่ก่อนวันที่ยื่น' },
    });
    await open.svc.updateReceiptFields('x1', { receiptNo: ' R-1 ', receiptDate: '2026-09-21', receiptAmount: '340' });
    expect(open.update.mock.calls[0][0].data).toMatchObject({ receiptNo: 'R-1', receiptAmount: 340 });

    const returned = service(row({ receipts: oneReceipt, returnedDate: new Date('2026-09-22T00:00:00.000Z') }));
    await expect(returned.svc.updateReceiptFields('x1', { receiptNo: 'R-2' })).rejects.toBeDefined();
    await returned.svc.updateReceiptFields('x1', { receiptNo: 'R-2', remark: 'อ่านเลขผิด' });
    expect(auditOf(returned.prisma)[0]).toMatchObject({ action: 'update-receipt-fields' });
  });
});

describe('serializeMoveOut', () => {
  it('แปลงวันที่เป็น YYYY-MM-DD และเก็บเจ้าของงาน', () => {
    const out = serializeMoveOut(row({ returnedDate: new Date('2026-09-22T00:00:00.000Z'), receipts: oneReceipt }));
    expect(out).toMatchObject({ submitDate: '2026-09-20', returnedDate: '2026-09-22', urgent: false, billTotal: '25', noBillTotal: '80', dutyAmount: '10', customer: { company: 'บริษัท ก จำกัด' } });
    expect(out.receipts).toEqual([{ id: 'r1', createdAt: '2026-09-21T00:00:00.000Z' }]);
  });
});
