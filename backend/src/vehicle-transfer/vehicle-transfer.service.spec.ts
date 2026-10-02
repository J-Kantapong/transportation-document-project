import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptExtractor } from '../receipts/receipt-extractor.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { VehicleTransferService } from './vehicle-transfer.service.js';

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 't1',
    transferType: 'OWNER',
    vehicleClass: 'CAR',
    customerId: 'c1',
    customer: { id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก จำกัด' },
    transferorName: 'สมชาย',
    transfereeName: 'สมหญิง',
    engine: '2AZ1234567',
    chassis: 'MR0FZ29G001234567',
    brand: 'Toyota',
    plateCategory: 'กข',
    plateNumber: '1234',
    submitDate: new Date('2026-09-20T00:00:00.000Z'),
    billTotal: 500,
    noBillTotal: 300,
    dutyAmount: 0,
    useRequest: false,
    urgent: false,
    fineAmount: 0,
    inspectionSentDate: null,
    inspectionResult: null,
    inspectionResultDate: null,
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
  const findMany = vi.fn().mockResolvedValue([]);
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    vehicleTransfer: {
      create,
      update,
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockImplementation(async () => current),
      findUniqueOrThrow: vi.fn().mockImplementation(async () => current),
      findFirst: vi.fn().mockImplementation(async () =>
        current && !current.cancelledAt
          ? {
              returnedDate: current.returnedDate,
              transferType: current.transferType,
              inspectionResult: current.inspectionResult,
              _count: { receipts: (current.receipts as unknown[]).length },
            }
          : null,
      ),
      findMany,
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
  return { svc: new VehicleTransferService(prisma as unknown as PrismaService, storage, noAiExtractor), create, update, findMany, prisma };
}

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

const validDto = {
  transferType: 'OWNER',
  vehicleClass: 'CAR',
  customerId: 'c1',
  transferorName: ' สมชาย ',
  transfereeName: ' สมหญิง ',
  engine: ' 2AZ1234567 ',
  chassis: 'MR0FZ29G001234567',
  brand: 'toyota',
  plateCategory: 'กข',
  plateNumber: '1234',
  submitDate: '2026-09-20',
  billTotal: '500',
};

const auditOf = (prisma: ReturnType<typeof service>['prisma']) => prisma.auditLog.create.mock.calls.map((c) => c[0].data);

describe('VehicleTransferService.create', () => {
  it('บันทึกผู้โอน/ผู้รับโอน/ข้อมูลรถ ตัดช่องว่าง และเก็บ Bill / No Bill ที่พนักงานกรอก', async () => {
    const { svc, create } = service(null);
    const { transfer } = await svc.create(validDto);
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      transferType: 'OWNER',
      vehicleClass: 'CAR',
      customerId: 'c1',
      transferorName: 'สมชาย',
      transfereeName: 'สมหญิง',
      engine: '2AZ1234567',
      brand: 'Toyota',
      billTotal: 500,
      noBillTotal: 100,
    });
    expect(transfer.submitDate).toBe('2026-09-20');
    expect(transfer.transferType).toBe('OWNER');
  });

  it('ต้องเลือกแบบงาน ประเภทรถ เจ้าของงาน และกรอกผู้โอน/ผู้รับโอนครบ', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, transferType: '' })).rejects.toMatchObject({
      response: { error: 'กรุณาเลือกแบบงานโอน (โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ)' },
    });
    await expect(svc.create({ ...validDto, transferType: 'X' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create({ ...validDto, vehicleClass: '' })).rejects.toMatchObject({ response: { error: 'กรุณาเลือกประเภทรถ (รถยนต์ / รถจักรยานยนต์)' } });
    await expect(svc.create({ ...validDto, customerId: '' })).rejects.toMatchObject({ response: { error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' } });
    await expect(svc.create({ ...validDto, transferorName: ' ' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกผู้โอน' } });
    await expect(svc.create({ ...validDto, transfereeName: '' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกผู้รับโอน' } });
    await expect(svc.create({ ...validDto, brand: 'Unknown' })).rejects.toMatchObject({ response: { error: 'กรุณาเลือกยี่ห้อจากรายการ' } });
  });

  it('ต้องกรอก Bill ของรถยนต์ (0 ได้ ติดลบ/ไม่ใช่ตัวเลขไม่ได้)', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, billTotal: '' })).rejects.toMatchObject({ response: { error: 'กรุณากรอก Bill' } });
    await expect(svc.create({ ...validDto, billTotal: '-1' })).rejects.toMatchObject({ response: { error: 'Bill ไม่ถูกต้อง' } });
    await expect(svc.create({ ...validDto, billTotal: 'abc' })).rejects.toMatchObject({ status: 400 });
    await svc.create({ ...validDto, billTotal: 0 });
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 0, noBillTotal: 100 });
  });

  it('STAFF_CAR ยื่นรถจักรยานยนต์ไม่ได้ และ STAFF_MOTO ยื่นรถยนต์ไม่ได้ (403) แต่ถือทั้งคู่ยื่นได้ทั้งสอง', async () => {
    const { svc } = service(null);
    await expect(asUser(['STAFF_CAR'], () => svc.create({ ...validDto, vehicleClass: 'MOTO' }))).rejects.toMatchObject({ status: 403 });
    await expect(asUser(['STAFF_MOTO'], () => svc.create(validDto))).rejects.toMatchObject({ status: 403 });
    await expect(asUser(['STAFF_CAR', 'STAFF_MOTO'], () => svc.create({ ...validDto, vehicleClass: 'MOTO' }))).resolves.toBeTruthy();
    await expect(asUser(['STAFF_CAR'], () => svc.create(validDto))).resolves.toBeTruthy();
  });
});

const motoDto = { ...validDto, vehicleClass: 'MOTO', billTotal: undefined };

describe('VehicleTransferService.create - ค่าใช้จ่ายมอเตอร์ไซค์ (อัตราของผู้ใช้ 2026-10-02)', () => {
  it('โอนปกติ: Bill 5 + 100 = 105 / No Bill ลงขัน 60 (ไม่รวมค่าอากร) / ค่าอากร 20 แยกไว้ที่ dutyAmount', async () => {
    const { svc, create } = service(null);
    await svc.create(motoDto);
    expect(create.mock.calls[0][0].data).toMatchObject({
      vehicleClass: 'MOTO',
      billTotal: 105,
      noBillTotal: 60,
      dutyAmount: 20,
      useRequest: false,
      urgent: false,
      fineAmount: 0,
    });
  });

  it('โอนขอใช้: Bill 10 + 100 + 20 = 130 / No Bill 60 / ค่าอากร 40 แยก (ค่าอากรออโต้ตามประเภท)', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...motoDto, useRequest: true });
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 130, noBillTotal: 60, dutyAmount: 40, useRequest: true });
  });

  it('งานด่วนบวก 50 ใน No Bill และค่าปรับบวกใน Bill ได้ทั้งสองประเภท', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...motoDto, urgent: true, fineAmount: '200' });
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 305, noBillTotal: 110, dutyAmount: 20, urgent: true, fineAmount: 200 });
    await svc.create({ ...motoDto, useRequest: 'true', urgent: true, fineAmount: '50.5' });
    expect(create.mock.calls[1][0].data).toMatchObject({ billTotal: 180.5, noBillTotal: 110, dutyAmount: 40 });
  });

  it('ยอดที่ส่งมาจากหน้าเว็บถูกเมิน - มอเตอร์ไซค์คิดจากอัตราเสมอ', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...motoDto, billTotal: 9999, noBillTotal: 1 } as never);
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 105, noBillTotal: 60, dutyAmount: 20 });
  });

  it('รถยนต์: No Bill ลงขัน 100 (ผู้ใช้ 2026-10-02) ไม่มีค่าอากร / Bill พนักงานกรอกเอง / ยอด No Bill จากหน้าเว็บถูกเมิน', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...validDto, noBillTotal: 1 } as never);
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 500, noBillTotal: 100, dutyAmount: 0, useRequest: false, urgent: false, fineAmount: 0 });
  });

  it('รถยนต์งานด่วน: No Bill 100 + ด่วน 100 = 200', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...validDto, urgent: true });
    expect(create.mock.calls[0][0].data).toMatchObject({ billTotal: 500, noBillTotal: 200, urgent: true });
  });

  it('รถยนต์ยังไม่มีอัตราโอนขอใช้/ค่าปรับ - ใช้ไม่ได้', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, useRequest: true })).rejects.toMatchObject({ response: { error: 'รถยนต์ยังไม่มีอัตราโอนขอใช้/ค่าปรับ - กรอก Bill เอง' } });
    await expect(svc.create({ ...validDto, fineAmount: 100 })).rejects.toMatchObject({ status: 400 });
  });

  it('ค่าปรับติดลบ / ติ๊กค่าแปลกๆ ตอบ 400', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...motoDto, fineAmount: '-5' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.create({ ...motoDto, urgent: 'maybe' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('VehicleTransferService.update - ค่าใช้จ่ายมอเตอร์ไซค์', () => {
  const motoRow = (o: Record<string, unknown> = {}) => row({ vehicleClass: 'MOTO', billTotal: 105, noBillTotal: 60, dutyAmount: 20, ...o });

  it('แก้ชื่ออย่างเดียว เก็บ snapshot ยอดเดิม (ไม่คิดใหม่แม้อัตราเปลี่ยนภายหลัง)', async () => {
    const { svc, update } = service(motoRow({ billTotal: 99, noBillTotal: 77, dutyAmount: 7 }));
    await svc.update('t1', { transfereeName: 'สมศรี', useRequest: false, urgent: false, fineAmount: '0', remark: 'พิมพ์ชื่อผิด' });
    expect(update.mock.calls[0][0].data).toMatchObject({ transfereeName: 'สมศรี', billTotal: 99, noBillTotal: 77, dutyAmount: 7 });
  });

  it('เปลี่ยนเป็นโอนขอใช้ + ด่วน คิดยอดใหม่และลงประวัติ', async () => {
    const { svc, update, prisma } = service(motoRow());
    await svc.update('t1', { useRequest: true, urgent: true, remark: 'ลูกค้าขอเปลี่ยนเป็นขอใช้' });
    expect(update.mock.calls[0][0].data).toMatchObject({ useRequest: true, urgent: true, billTotal: 130, noBillTotal: 110, dutyAmount: 40 });
    const changes = auditOf(prisma)[0].changes;
    expect(Object.keys(changes).sort()).toEqual(['billTotal', 'dutyAmount', 'noBillTotal', 'urgent', 'useRequest']);
  });

  it('ย้ายจากมอเตอร์ไซค์ไปรถยนต์ต้องกรอก Bill / No Bill เอง', async () => {
    const { svc } = service(motoRow());
    await expect(svc.update('t1', { vehicleClass: 'CAR', remark: 'ประเภทรถผิด' })).rejects.toMatchObject({ response: { error: 'กรุณากรอก Bill' } });
    const ok = service(motoRow());
    await ok.svc.update('t1', { vehicleClass: 'CAR', billTotal: '400', remark: 'ประเภทรถผิด' });
    expect(ok.update.mock.calls[0][0].data).toMatchObject({ vehicleClass: 'CAR', billTotal: 400, noBillTotal: 100, dutyAmount: 0, useRequest: false, urgent: false, fineAmount: 0 });
  });
});

describe('VehicleTransferService.update - ค่าใช้จ่ายรถยนต์', () => {
  it('ติ๊กด่วนเพิ่มคิด No Bill ใหม่ (ลงขัน 100 + ด่วน 100) / เอาออกกลับเป็น 100', async () => {
    const { svc, update } = service(row({ billTotal: 500, noBillTotal: 100 }));
    await svc.update('t1', { urgent: true, remark: 'ลูกค้าขอด่วน' });
    expect(update.mock.calls[0][0].data).toMatchObject({ billTotal: 500, noBillTotal: 200, urgent: true });
    const back = service(row({ billTotal: 500, noBillTotal: 200, urgent: true }));
    await back.svc.update('t1', { urgent: false, remark: 'ยกเลิกด่วน' });
    expect(back.update.mock.calls[0][0].data).toMatchObject({ noBillTotal: 100, urgent: false });
  });

  it('ขอใช้/ค่าปรับของรถยนต์ใช้ไม่ได้ตอนแก้ด้วย', async () => {
    const { svc } = service(row());
    await expect(svc.update('t1', { useRequest: true, remark: 'x' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.update('t1', { fineAmount: '50', remark: 'x' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('VehicleTransferService.list', () => {
  it('งานโอนตรวจรถจะนับว่า "รอรับเอกสารกลับ" ก็ต่อเมื่อตรวจผ่านแล้ว', async () => {
    const { svc, findMany } = service(null);
    await svc.list('pending', undefined, 'INSPECTION');
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ cancelledAt: null, transferType: 'INSPECTION', returnedDate: null });
    expect(where.OR).toEqual([{ transferType: 'OWNER' }, { inspectionResult: 'PASS' }]);
  });

  it('รอส่งตรวจ / รอผลตรวจ แยกกันตามวันที่ส่งตรวจ', async () => {
    const { svc, findMany } = service(null);
    await svc.list('to-send', undefined, 'INSPECTION');
    expect(findMany.mock.calls[0][0].where).toMatchObject({ transferType: 'INSPECTION', inspectionSentDate: null, returnedDate: null });
    await svc.list('to-result', undefined, 'INSPECTION');
    expect(findMany.mock.calls[1][0].where).toMatchObject({ inspectionSentDate: { not: null }, inspectionResult: null });
  });

  it('ผู้ใช้ที่ดูแลเฉพาะรถยนต์เห็นเฉพาะงานรถยนต์ แต่ ADMIN เห็นทุกประเภทรถ', async () => {
    const { svc, findMany } = service(null);
    await asUser(['STAFF_CAR'], () => svc.list('all'));
    expect(findMany.mock.calls[0][0].where).toMatchObject({ vehicleClass: 'CAR' });
    await asUser(['ADMIN'], () => svc.list('all'));
    expect(findMany.mock.calls[1][0].where).not.toHaveProperty('vehicleClass');
    await expect(asUser(['STAFF_CAR'], () => svc.list('all', undefined, undefined, 'MOTO'))).rejects.toMatchObject({ status: 403 });
  });

  it('พารามิเตอร์ผิดตอบ 400', async () => {
    const { svc } = service(null);
    await expect(svc.list('bogus')).rejects.toMatchObject({ status: 400 });
    await expect(svc.list('all', '2026-13')).rejects.toMatchObject({ status: 400 });
    await expect(svc.list('all', undefined, 'X')).rejects.toMatchObject({ status: 400 });
  });
});

describe('VehicleTransferService - ขั้นตรวจรถ', () => {
  const inspection = (overrides: Record<string, unknown> = {}) => row({ transferType: 'INSPECTION', ...overrides });

  it('งานโอนตามผู้ถือกรรมสิทธิ์ไม่มีขั้นตรวจรถ', async () => {
    const { svc } = service(row());
    await expect(svc.markInspectionSent('t1', '2026-09-21')).rejects.toMatchObject({ response: { error: 'งานโอนตามผู้ถือกรรมสิทธิ์ไม่มีขั้นตรวจรถ' } });
  });

  it('ส่งตรวจได้ครั้งเดียว วันที่ต้องไม่ก่อนวันที่ยื่น', async () => {
    const { svc, update } = service(inspection());
    await expect(svc.markInspectionSent('t1', '2026-09-19')).rejects.toMatchObject({ response: { error: 'วันที่ส่งตรวจต้องไม่ก่อนวันที่ยื่น' } });
    await svc.markInspectionSent('t1', '2026-09-21');
    expect(update.mock.calls[0][0].data).toEqual({ inspectionSentDate: new Date('2026-09-21T00:00:00.000Z') });
    expect(update.mock.calls[0][0].where).toMatchObject({ inspectionSentDate: null, returnedDate: null });
  });

  it('บันทึกผลตรวจต้องส่งตรวจก่อน และต้องเป็น ผ่าน/ไม่ผ่าน', async () => {
    const notSent = service(inspection());
    await expect(notSent.svc.recordInspectionResult('t1', 'PASS', '2026-09-22')).rejects.toMatchObject({
      response: { error: 'ยังไม่ได้บันทึกวันที่ส่งตรวจ' },
    });
    const sent = service(inspection({ inspectionSentDate: new Date('2026-09-21T00:00:00.000Z') }));
    await expect(sent.svc.recordInspectionResult('t1', 'MAYBE', '2026-09-22')).rejects.toMatchObject({ response: { error: 'ผลตรวจต้องเป็น ผ่าน หรือ ไม่ผ่าน' } });
    await expect(sent.svc.recordInspectionResult('t1', 'PASS', '2026-09-20')).rejects.toMatchObject({ response: { error: 'วันที่ผลตรวจต้องไม่ก่อนวันที่ยื่น' } });
    await sent.svc.recordInspectionResult('t1', 'FAIL', '2026-09-22');
    expect(sent.update.mock.calls[0][0].data).toEqual({ inspectionResult: 'FAIL', inspectionResultDate: new Date('2026-09-22T00:00:00.000Z') });
  });

  it('ยังไม่ผ่านตรวจ แนบใบเสร็จ/รับเอกสารกลับไม่ได้ (ไม่ผ่านก็ไม่ได้)', async () => {
    const failed = service(
      inspection({ inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'), inspectionResult: 'FAIL', inspectionResultDate: new Date('2026-09-22T00:00:00.000Z'), receipts: oneReceipt }),
    );
    await expect(failed.svc.markReturned('t1', '2026-09-23')).rejects.toMatchObject({ response: { error: 'งานโอนตรวจรถต้องตรวจรถผ่านก่อนจึงรับใบเสร็จได้' } });
    await expect(failed.svc.addReceipt('t1', undefined)).rejects.toMatchObject({ response: { error: 'งานโอนตรวจรถต้องตรวจรถผ่านก่อนจึงรับใบเสร็จได้' } });
    expect(failed.update).not.toHaveBeenCalled();
  });

  it('ผ่านตรวจแล้วรับเอกสารกลับได้ แต่วันที่รับกลับต้องไม่ก่อนวันที่ผลตรวจ', async () => {
    const passed = service(
      inspection({ inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'), inspectionResult: 'PASS', inspectionResultDate: new Date('2026-09-23T00:00:00.000Z'), receipts: oneReceipt }),
    );
    await expect(passed.svc.markReturned('t1', '2026-09-22')).rejects.toMatchObject({ response: { error: 'วันที่รับเอกสารกลับต้องไม่ก่อนวันที่ยื่น' } });
    await passed.svc.markReturned('t1', '2026-09-24');
    expect(passed.update.mock.calls[0][0].data).toEqual({ returnedDate: new Date('2026-09-24T00:00:00.000Z') });
  });

  it('งานโอนตามผู้ถือกรรมสิทธิ์ไม่ต้องตรวจรถ รับกลับได้เมื่อมีรูปใบเสร็จ', async () => {
    const { svc, update } = service(row({ receipts: oneReceipt }));
    await svc.markReturned('t1', '2026-09-24');
    expect(update.mock.calls[0][0].data).toEqual({ returnedDate: new Date('2026-09-24T00:00:00.000Z') });
    const noReceipt = service(row());
    await expect(noReceipt.svc.markReturned('t1', '2026-09-24')).rejects.toMatchObject({ response: { error: 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับเอกสารกลับ' } });
  });

  it('ถอยขั้นตรวจต้องมีเหตุผล: มีผลตรวจ = ล้างผล, ไม่มีผล = ล้างวันที่ส่งตรวจ และบันทึกประวัติ', async () => {
    const withResult = service(
      inspection({ inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'), inspectionResult: 'FAIL', inspectionResultDate: new Date('2026-09-22T00:00:00.000Z') }),
    );
    await expect(withResult.svc.undoInspection('t1', ' ')).rejects.toMatchObject({ status: 400 });
    await withResult.svc.undoInspection('t1', 'บันทึกผลผิด');
    expect(withResult.update.mock.calls[0][0].data).toEqual({ inspectionResult: null, inspectionResultDate: null });
    expect(auditOf(withResult.prisma)[0]).toMatchObject({ entity: 'VehicleTransfer', action: 'undo-inspection-result', remark: 'บันทึกผลผิด' });

    const sentOnly = service(inspection({ inspectionSentDate: new Date('2026-09-21T00:00:00.000Z') }));
    await sentOnly.svc.undoInspection('t1', 'กดส่งตรวจผิดงาน');
    expect(sentOnly.update.mock.calls[0][0].data).toEqual({ inspectionSentDate: null });
    expect(auditOf(sentOnly.prisma)[0]).toMatchObject({ action: 'undo-inspection-sent' });

    const untouched = service(inspection());
    await expect(untouched.svc.undoInspection('t1', 'x')).rejects.toMatchObject({ response: { error: 'งานนี้ยังไม่ได้ส่งตรวจ' } });
  });
});

describe('VehicleTransferService.update / cancel', () => {
  it('แก้ต้องมีเหตุผล บันทึกเฉพาะช่องที่เปลี่ยนลงประวัติ และเปลี่ยนชื่อผู้รับโอนได้', async () => {
    const { svc, update, prisma } = service(row());
    await expect(svc.update('t1', { transfereeName: 'สมศรี' })).rejects.toMatchObject({ status: 400 });
    await svc.update('t1', { transfereeName: 'สมศรี', remark: 'พิมพ์ชื่อผิด' });
    expect(update.mock.calls[0][0].data).toMatchObject({ transfereeName: 'สมศรี', transferorName: 'สมชาย' });
    const [audit] = auditOf(prisma);
    expect(audit).toMatchObject({ entity: 'VehicleTransfer', action: 'update', remark: 'พิมพ์ชื่อผิด' });
    expect(Object.keys(audit.changes)).toEqual(['transfereeName']);
  });

  it('แก้ Bill / No Bill ได้ด้วยเหตุผล และลงประวัติเฉพาะช่องที่เปลี่ยน', async () => {
    const { svc, update, prisma } = service(row());
    await svc.update('t1', { billTotal: '650', remark: 'คีย์ราคาผิด' });
    // แก้เฉพาะ Bill ที่กรอก - No Bill เดิมคงไว้ (ไม่คิดใหม่)
    expect(update.mock.calls[0][0].data).toMatchObject({ billTotal: 650, noBillTotal: 300 });
    expect(Object.keys(auditOf(prisma)[0].changes)).toEqual(['billTotal']);
  });

  it('วันที่ยื่นแก้ให้หลังวันที่ส่งตรวจไม่ได้', async () => {
    const { svc } = service(row({ transferType: 'INSPECTION', inspectionSentDate: new Date('2026-09-21T00:00:00.000Z') }));
    await expect(svc.update('t1', { submitDate: '2026-09-25', remark: 'แก้วันที่' })).rejects.toMatchObject({
      response: { error: 'วันที่ยื่นต้องไม่หลังวันที่ส่งตรวจ' },
    });
  });

  it('ยกเลิกงานไม่ลบแถว ล้าง hash รูปใบเสร็จ และเก็บ snapshot ลงประวัติ', async () => {
    const { svc, update, prisma } = service(row({ receipts: oneReceipt }));
    await expect(svc.cancel('t1', '')).rejects.toMatchObject({ status: 400 });
    await svc.cancel('t1', 'บันทึกซ้ำ');
    expect(update.mock.calls[0][0].data).toMatchObject({ cancelReason: 'บันทึกซ้ำ' });
    expect(prisma.receiptImage.updateMany).toHaveBeenCalledWith({ where: { vehicleTransferId: 't1' }, data: { contentHash: null } });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'cancel', changes: expect.objectContaining({ transferorName: 'สมชาย', transfereeName: 'สมหญิง' }) });
  });

  it('STAFF_MOTO แก้/ยกเลิกงานรถยนต์ไม่ได้', async () => {
    const { svc } = service(row());
    await expect(asUser(['STAFF_MOTO'], () => svc.cancel('t1', 'x'))).rejects.toMatchObject({ status: 403 });
  });
});
