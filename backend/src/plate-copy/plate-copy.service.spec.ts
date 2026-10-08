import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptExtractor } from '../receipts/receipt-extractor.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { PlateCopyService, serializePlateCopy } from './plate-copy.service.js';

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
    billTotal: 205,
    noBillTotal: 100,
    dutyAmount: 10,
    returnedDate: null,
    plateReceivedDate: null,
    platePhotoId: null,
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
    plateCopy: {
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
      count: vi.fn().mockResolvedValue(0),
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
    platePhoto: {
      create: vi.fn().mockResolvedValue({ id: "photo-1" }),
      findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      delete: vi.fn().mockResolvedValue({ storageKey: "plates/photo-1.jpg" }),
    },
    vehicle: { count: vi.fn().mockResolvedValue(0) },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit1' }) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const storage: ReceiptStorage = { put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  return { svc: new PlateCopyService(prisma as unknown as PrismaService, storage, noAiExtractor), create, update, prisma, storage };
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


describe('PlateCopyService.create', () => {
  it('บันทึกข้อมูลรถ ตัดช่องว่าง และเก็บค่าใช้จ่ายตายตัว Bill 205 / No Bill 100 + ค่าอากร 10 แยกต่างหาก (ไม่รับยอดจากผู้เรียก)', async () => {
    const { svc, create } = service(null);
    const { plateCopy } = await svc.create(validDto);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      vehicleClass: 'CAR',
      customerId: 'c1',
      ownerName: 'สมชาย',
      engine: '2AZ1234567',
      brand: 'Toyota',
      plateCategory: 'กข',
      plateNumber: '1234',
      billTotal: 205,
      noBillTotal: 100,
      dutyAmount: 10,
    });
    expect(data.submitDate).toEqual(new Date('2026-09-20T00:00:00.000Z'));
    expect(plateCopy.submitDate).toBe('2026-09-20');
  });

  it('ยอดที่ส่งมาจากผู้เรียกถูกเมิน - ใช้ค่าตายตัวเสมอ', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...validDto, billTotal: 9999, noBillTotal: 1, dutyAmount: 0 } as never);
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 205, noBillTotal: 100, dutyAmount: 10 });
  });

  it('คัดป้ายใบเดียว: เลขขาวดำปกติ Bill 100 / ประมูล Bill 600 ส่วน No Bill และค่าอากรเท่าเดิม และชนิดที่ไม่รู้จักถูกปฏิเสธ', async () => {
    const a = service(null);
    await a.svc.create({ ...validDto, copyType: 'SINGLE_NORMAL' });
    expect(a.create.mock.calls[0][0].data).toMatchObject({ copyType: 'SINGLE_NORMAL', billTotal: 105, noBillTotal: 100, dutyAmount: 10 });
    const b = service(null);
    await b.svc.create({ ...validDto, copyType: 'SINGLE_AUCTION' });
    expect(b.create.mock.calls[0][0].data).toMatchObject({ copyType: 'SINGLE_AUCTION', billTotal: 605 });
    const c = service(null);
    await c.svc.create({ ...validDto, copyType: 'BOTH_AUCTION' });
    expect(c.create.mock.calls[0][0].data).toMatchObject({ copyType: 'BOTH_AUCTION', billTotal: 1205 });
    const d = service(null);
    await d.svc.create({ ...validDto, copyType: 'BOTH' });
    expect(d.create.mock.calls[0][0].data).toMatchObject({ copyType: 'BOTH', billTotal: 205 });
    await expect(service(null).svc.create({ ...validDto, copyType: 'X' })).rejects.toThrow();
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

  it('รถยนต์เท่านั้น: STAFF_CAR บันทึกได้ STAFF_MOTO บันทึกไม่ได้ และ MOTO ถูกปฏิเสธ', async () => {
    const { svc, create } = service(null);
    await expect(asUser(['STAFF_MOTO'], () => svc.create(validDto))).rejects.toBeDefined();
    expect(create).not.toHaveBeenCalled();
    await asUser(['STAFF_CAR'], () => svc.create(validDto));
    expect(create).toHaveBeenCalledTimes(1);
    await expect(asUser(['STAFF_CAR'], () => svc.create({ ...validDto, vehicleClass: 'MOTO' }))).rejects.toMatchObject({
      response: { error: 'คัดแผ่นป้ายทะเบียนใช้ได้เฉพาะรถยนต์ (จักรยานยนต์ยังไม่เปิดให้ใช้)' },
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ค่า vehicleClass ที่ไม่รู้จักถูกปฏิเสธ', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, vehicleClass: 'BUS' })).rejects.toMatchObject({
      response: { error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR' },
    });
  });
});

describe('PlateCopyService.list', () => {
  it('กรองตามประเภทรถ สถานะ และไม่แสดงงานที่ยกเลิกแล้ว', async () => {
    const { svc, prisma } = service(null);
    await svc.list('pending', '2026-09', 'CAR');
    expect(prisma.plateCopy.findMany.mock.calls[0][0].where).toMatchObject({
      vehicleClass: 'CAR',
      cancelledAt: null,
      returnedDate: null,
      submitDate: { gte: new Date('2026-09-01T00:00:00.000Z'), lt: new Date('2026-10-01T00:00:00.000Z') },
    });
    await expect(svc.list('bogus')).rejects.toBeDefined();
    await expect(svc.list('all', '2026-13')).rejects.toBeDefined();
  });
});

describe('PlateCopyService.markReturned', () => {
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
    const { plateCopy } = await svc.markReturned('x1', '2026-09-22');
    expect(update.mock.calls[0][0].data.returnedDate).toEqual(new Date('2026-09-22T00:00:00.000Z'));
    expect(plateCopy.returnedDate).toBe('2026-09-22');
  });

  it('งานที่รับกลับแล้วรับซ้ำไม่ได้ / งานที่ยกเลิกแล้วแก้ต่อไม่ได้', async () => {
    const returned = service(row({ receipts: oneReceipt, returnedDate: new Date('2026-09-22T00:00:00.000Z') }));
    await expect(returned.svc.markReturned('x1', '2026-09-23')).rejects.toMatchObject({ response: { error: 'งานนี้รับเอกสารกลับแล้ว' } });
    const cancelled = service(row({ receipts: oneReceipt, cancelledAt: new Date() }));
    await expect(cancelled.svc.markReturned('x1', '2026-09-22')).rejects.toMatchObject({ status: 409 });
  });
});

describe('PlateCopyService.update', () => {
  it('ต้องระบุเหตุผลและบันทึกเฉพาะช่องที่เปลี่ยนลง AuditLog', async () => {
    const { svc, update, prisma } = service(row());
    await expect(svc.update('x1', { ownerName: 'ใหม่' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่แก้งานคัดแผ่นป้ายทะเบียน' } });
    await svc.update('x1', { ownerName: 'สมหญิง', remark: 'พิมพ์ชื่อผิด' });
    expect(update.mock.calls[0][0].data).toMatchObject({ ownerName: 'สมหญิง' });
    expect(update.mock.calls[0][0].data).not.toHaveProperty('billTotal');
    const [audit] = auditOf(prisma);
    expect(audit).toMatchObject({ entity: 'PlateCopy', entityId: 'x1', action: 'update', remark: 'พิมพ์ชื่อผิด' });
    // แก้ได้เฉพาะชื่อ - ค่าใช้จ่ายตายตัวไม่อยู่ในประวัติ/ไม่ถูกแตะ
    expect(Object.keys(audit.changes as object).sort()).toEqual(['ownerName']);
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

describe('PlateCopyService.cancel / undoReturn', () => {
  it('ยกเลิกงานต้องมีเหตุผล เก็บแถวไว้ ล้าง hash รูป และเขียนประวัติ', async () => {
    const { svc, update, prisma } = service(row({ receipts: oneReceipt }));
    await expect(svc.cancel('x1', '  ')).rejects.toBeDefined();
    await svc.cancel('x1', 'บันทึกซ้ำ');
    expect(update.mock.calls[0][0].data).toMatchObject({ cancelReason: 'บันทึกซ้ำ' });
    expect(prisma.receiptImage.updateMany).toHaveBeenCalledWith({ where: { plateCopyId: 'x1' }, data: { contentHash: null } });
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

describe('PlateCopyService receipts', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const file = { buffer: jpeg, size: jpeg.length, originalname: 'r.jpg', mimetype: 'image/jpeg' };

  it('แนบรูปได้ (ผูกกับงานนี้) และรูปที่ใช้แล้วแนบซ้ำไม่ได้', async () => {
    const { svc, prisma, storage } = service(row());
    await svc.addReceipt('x1', file);
    expect(prisma.receiptImage.create.mock.calls[0][0].data).toMatchObject({ plateCopyId: 'x1', mimeType: 'image/jpeg' });
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
    expect(prisma.receiptImage.deleteMany).toHaveBeenCalledWith({ where: { id: 'r1', plateCopyId: 'x1' } });
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

describe('serializePlateCopy', () => {
  it('แปลงวันที่เป็น YYYY-MM-DD และเก็บเจ้าของงาน', () => {
    const out = serializePlateCopy(row({ returnedDate: new Date('2026-09-22T00:00:00.000Z'), receipts: oneReceipt }));
    expect(out).toMatchObject({ submitDate: '2026-09-20', returnedDate: '2026-09-22', billTotal: '205', dutyAmount: '10', customer: { company: 'บริษัท ก จำกัด' } });
    expect(out.receipts).toEqual([{ id: 'r1', createdAt: '2026-09-21T00:00:00.000Z' }]);
  });
});

describe('PlateCopyService รับป้าย (แนบรูปป้าย + วันที่รับ)', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const file = { buffer: jpeg, size: jpeg.length, originalname: 'plate.jpg', mimetype: 'image/jpeg' };
  const RECEIVED = new Date('2026-09-25T00:00:00.000Z');

  it('แนบรูปป้ายแล้วบันทึกวันที่รับพร้อมกัน (ไม่ต้องรอรับใบเสร็จ)', async () => {
    const { svc, prisma, storage } = service(row());
    await svc.attachPlatePhoto('x1', file, '2026-09-22');
    expect(prisma.platePhoto.create.mock.calls[0][0].data).toMatchObject({ kind: 'car', mimeType: 'image/jpeg' });
    expect(prisma.plateCopy.updateMany).toHaveBeenCalledWith({
      where: { id: 'x1', platePhotoId: null },
      data: { plateReceivedDate: new Date('2026-09-22T00:00:00.000Z'), platePhotoId: 'photo-1' },
    });
    expect(storage.put).toHaveBeenCalled();
  });

  it('วันที่รับต้องไม่ก่อนวันที่ยื่นและไม่เกินวันนี้ / ต้องมีไฟล์รูป', async () => {
    const { svc, prisma } = service(row());
    await expect(svc.attachPlatePhoto('x1', file, '2026-09-19')).rejects.toMatchObject({ response: { error: 'วันที่รับป้ายต้องไม่ก่อนวันที่ยื่น' } });
    await expect(svc.attachPlatePhoto('x1', file, '2999-01-01')).rejects.toMatchObject({ response: { error: 'วันที่รับป้ายต้องไม่เกินวันนี้' } });
    await expect(svc.attachPlatePhoto('x1', undefined, '2026-09-22')).rejects.toMatchObject({ response: { error: 'ไม่พบไฟล์รูปป้ายทะเบียน' } });
    await expect(svc.attachPlatePhoto('x1', { ...file, buffer: Buffer.from('not an image') }, '2026-09-22')).rejects.toMatchObject({
      response: { error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' },
    });
    expect(prisma.platePhoto.create).not.toHaveBeenCalled();
  });

  it('รูปที่ใช้เป็นป้ายที่ไหนแล้วแนบซ้ำไม่ได้', async () => {
    const { svc, prisma } = service(row());
    prisma.platePhoto.findUnique.mockResolvedValueOnce({ id: 'other' });
    await expect(svc.attachPlatePhoto('x1', file, '2026-09-22')).rejects.toMatchObject({ status: 409 });
    expect(prisma.platePhoto.create).not.toHaveBeenCalled();
  });

  it('งานที่รับป้ายไปแล้ว (แนบพร้อมกันสองเครื่อง) ถูกปฏิเสธและลบไฟล์ที่เพิ่งเก็บ', async () => {
    const { svc, prisma, storage } = service(row());
    prisma.plateCopy.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.attachPlatePhoto('x1', file, '2026-09-22')).rejects.toMatchObject({ response: { error: 'งานนี้รับป้ายไปแล้ว' } });
    expect(storage.delete).toHaveBeenCalled();
  });

  it('งานที่ยกเลิกแล้วแนบป้ายไม่ได้ / MOTO แก้ไม่ได้', async () => {
    const cancelled = service(row({ cancelledAt: new Date() }));
    await expect(cancelled.svc.attachPlatePhoto('x1', file, '2026-09-22')).rejects.toMatchObject({ status: 409 });
    const { svc } = service(row());
    await expect(asUser(['STAFF_MOTO'], () => svc.attachPlatePhoto('x1', file, '2026-09-22'))).rejects.toBeDefined();
  });

  it('แก้วันที่รับป้าย: ต้องมีเหตุผล วันที่ต้องเปลี่ยนจริง และเขียนประวัติ', async () => {
    const received = row({ plateReceivedDate: RECEIVED, platePhotoId: 'photo-1' });
    const { svc, prisma } = service(received);
    await expect(svc.updatePlateReceivedDate('x1', { date: '2026-09-26' })).rejects.toBeDefined();
    await expect(svc.updatePlateReceivedDate('x1', { date: '2026-09-25', remark: 'x' })).rejects.toMatchObject({ response: { error: 'วันที่ไม่ได้เปลี่ยน' } });
    await svc.updatePlateReceivedDate('x1', { date: '2026-09-26', remark: 'พิมพ์วันผิด' });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'update-plate-date', remark: 'พิมพ์วันผิด' });
    const pending = service(row());
    await expect(pending.svc.updatePlateReceivedDate('x1', { date: '2026-09-26', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'งานนี้ยังไม่รับป้าย' },
    });
  });

  it('ถอดรูปป้าย: ต้องมีเหตุผล ล้างวันที่+รูป ลบแถวรูปและไฟล์', async () => {
    const received = row({ plateReceivedDate: RECEIVED, platePhotoId: 'photo-1' });
    const { svc, prisma, storage } = service(received);
    await expect(svc.detachPlatePhoto('x1', {})).rejects.toBeDefined();
    await svc.detachPlatePhoto('x1', { remark: 'แนบผิดคัน' });
    expect(prisma.plateCopy.updateMany.mock.calls[0][0].data).toEqual({ plateReceivedDate: null, platePhotoId: null });
    expect(prisma.platePhoto.delete).toHaveBeenCalledWith({ where: { id: 'photo-1' }, select: { storageKey: true } });
    expect(storage.delete).toHaveBeenCalledWith('plates/photo-1.jpg');
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'detach-plate-photo' });
  });

  it('รายการรับป้ายกรองตามสถานะ รอรับเรียงงานเก่าก่อน', async () => {
    const { svc, prisma } = service(null);
    await svc.listByPlateStatus('pending');
    expect(prisma.plateCopy.findMany.mock.calls[0][0]).toMatchObject({
      where: { vehicleClass: 'CAR', cancelledAt: null, plateReceivedDate: null },
      orderBy: [{ submitDate: 'asc' }, { createdAt: 'desc' }],
    });
    await svc.listByPlateStatus('received');
    expect(prisma.plateCopy.findMany.mock.calls[1][0].where).toMatchObject({ plateReceivedDate: { not: null } });
    await expect(svc.listByPlateStatus('bogus')).rejects.toBeDefined();
  });

  it('ยกเลิกงานปล่อย hash ของรูปป้ายที่แนบไว้ด้วย', async () => {
    const { svc, prisma } = service(row({ plateReceivedDate: RECEIVED, platePhotoId: 'photo-1' }));
    await svc.cancel('x1', 'บันทึกซ้ำ');
    expect(prisma.platePhoto.updateMany).toHaveBeenCalledWith({ where: { id: 'photo-1' }, data: { contentHash: null } });
  });
});
