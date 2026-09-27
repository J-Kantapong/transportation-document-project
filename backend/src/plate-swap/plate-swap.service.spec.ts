import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { linkedPlateIsNewPlate, openSwapWhere, PlateSwapService, plateSwapLinkBlockReason, serializePlateSwap } from './plate-swap.service.js';

function swapRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    kind: 'OLD_NEW',
    oldOwnerName: 'สมชาย',
    oldEngine: '2AZ1234567',
    oldChassis: 'MR0FZ29G001234567',
    oldBrand: 'Toyota',
    oldPlateCategory: 'กข',
    oldPlateNumber: '1234',
    newPlateCategory: '1กก',
    newPlateNumber: '9999',
    newVehicleId: 'v-old',
    submitDate: new Date('2026-09-20T00:00:00.000Z'),
    numberSource: 'NEW_UNUSED',
    buyNormalPlate: false,
    buyAuctionPlate: false,
    billItems: [],
    noBillItems: [],
    billTotal: '575',
    noBillTotal: '210',
    returnedDate: null,
    cancelledAt: null,
    createdAt: new Date('2026-09-20T01:00:00.000Z'),
    updatedAt: new Date('2026-09-20T01:00:00.000Z'),
    newVehicle: null,
    receipts: [],
    ...overrides,
  };
}

const RETURNED = new Date('2026-09-22T00:00:00.000Z');
const oneReceipt = [{ id: 'r1', createdAt: new Date('2026-09-21T00:00:00.000Z') }];

// รถใหม่ในฐานข้อมูล - documentSubmissions/plateSwapsAsNew = สถานะที่ใช้ตัดสินว่าผูกได้ไหม (F51)
function vehicleHit(overrides: Record<string, unknown> = {}) {
  return { id: 'v-new', chassis: 'MRHNEW0001', documentSubmissions: [], plateSwapsAsNew: [], ...overrides };
}

function service(found: unknown, opts: { vehicle?: Record<string, unknown> | null } = {}) {
  let current = found as Record<string, unknown> | null;
  const create = vi.fn().mockImplementation(async ({ data }) => swapRow({ ...data }));
  const update = vi.fn().mockImplementation(async ({ data }) => {
    current = { ...current, ...data };
    return current;
  });
  const findUniqueOrThrow = vi.fn().mockImplementation(async () => current);
  const vehicle = opts.vehicle === undefined ? vehicleHit() : opts.vehicle;
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    plateSwap: {
      create,
      update,
      findUnique: vi.fn().mockImplementation(async () => current),
      findUniqueOrThrow,
      // lockSwap: สถานะล่าสุดหลังล็อกแถว (returnedDate / ทะเบียนใหม่ / จำนวนรูป)
      findFirst: vi.fn().mockImplementation(async () =>
        current && !current.cancelledAt
          ? {
              returnedDate: current.returnedDate,
              newPlateCategory: current.newPlateCategory,
              newPlateNumber: current.newPlateNumber,
              _count: { receipts: (current.receipts as unknown[]).length },
            }
          : null,
      ),
      findMany: vi.fn().mockResolvedValue([]),
    },
    vehicle: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => (vehicle && where.id === vehicle.id ? vehicle : null)),
      findMany: vi.fn().mockResolvedValue(vehicle ? [{ ...vehicle, plateCategory: null, plateNumber: null, brand: { name: 'BYD' }, customer: { name: 'ลูกค้า ก' } }] : []),
    },
    brand: { findFirst: vi.fn().mockImplementation(async ({ where }) => (where.name.equals.toLowerCase() === 'toyota' ? { name: 'Toyota' } : null)) },
    receiptImage: {
      create: vi.fn().mockResolvedValue({ id: 'r-new' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockImplementation(async ({ where }) => ({ id: where.id, storageKey: `receipts/${where.id}.jpg` })),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit1' }) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const storage: ReceiptStorage = { put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  return { svc: new PlateSwapService(prisma as unknown as PrismaService, storage), create, update, prisma, storage };
}

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

const validDto = {
  oldOwnerName: ' สมชาย ',
  oldEngine: ' 2AZ1234567 ',
  oldChassis: 'MR0FZ29G001234567',
  oldBrand: 'toyota',
  oldPlateCategory: 'กข',
  oldPlateNumber: '1234',
  newPlateCategory: '1กก',
  newPlateNumber: '9999',
  newVehicleId: 'v-new',
  submitDate: '2026-09-20',
  numberSource: 'NEW_UNUSED',
  buyNormalPlate: true,
  buyAuctionPlate: false,
};

const auditOf = (prisma: ReturnType<typeof service>['prisma']) => prisma.auditLog.create.mock.calls.map((c) => c[0].data);

describe('PlateSwapService.create', () => {
  it('บันทึกรถเก่าพร้อม snapshot ค่าใช้จ่าย (เลขไม่เคยออก + ซื้อป้าย 200)', async () => {
    const { svc, create, prisma } = service(null);
    const { swap } = await svc.create(validDto);
    const data = create.mock.calls[0][0].data;
    expect(data.oldOwnerName).toBe('สมชาย');
    expect(data.submitDate).toEqual(new Date('2026-09-20T00:00:00.000Z'));
    expect(data.billTotal).toBe(775);
    expect(data.noBillTotal).toBe(210); // ลงขัน 200 + ค่าอากร 10
    expect(data.newVehicleId).toBe('v-new');
    expect(data.oldBrand).toBe('Toyota');
    expect(data.oldEngine).toBe('2AZ1234567');
    expect(data.oldPlateCategory).toBe('กข');
    expect(data.newPlateCategory).toBe('1กก');
    expect(swap.submitDate).toBe('2026-09-20');
    expect(prisma.$queryRaw).toHaveBeenCalled(); // ล็อกแถวรถใหม่ก่อนตรวจกฎผูก
  });

  it('ต้องกรอกครบทุกช่องของรถเก่า', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, oldPlateNumber: '  ' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกเลขทะเบียนเก่า' } });
    await expect(svc.create({ ...validDto, oldPlateCategory: '' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกหมวดทะเบียนเก่า' } });
    await expect(svc.create({ ...validDto, oldChassis: '' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกเลขตัวถัง' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('เลขเครื่องบังคับกรอก (ผู้ใช้ 2026-09-23)', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, oldEngine: '   ' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกเลขเครื่อง' } });
    expect(create).not.toHaveBeenCalled();
  });

  it('ป้ายประมูลซื้อได้เฉพาะเลขประมูล/ชุดสงวน', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, buyAuctionPlate: true })).rejects.toMatchObject({ response: { error: expect.stringContaining('ป้ายประมูล') } });
  });

  it('วันที่ยื่นที่ไม่มีจริง (31 ก.พ.) ไม่ผ่าน', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, submitDate: '2026-02-31' })).rejects.toMatchObject({ response: { error: expect.stringContaining('วันที่ยื่น') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('ต้องลิงก์รถใหม่ทุกงาน', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, newVehicleId: null })).rejects.toMatchObject({ response: { error: expect.stringContaining('กรุณาลิงก์รถใหม่') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('ทะเบียนใหม่เว้นว่างตอนยื่นได้ (ยังไม่รู้เลข)', async () => {
    const { svc, create } = service(null);
    await svc.create({ ...validDto, newPlateCategory: '', newPlateNumber: '' });
    expect(create.mock.calls[0][0].data.newPlateCategory).toBeNull();
    expect(create.mock.calls[0][0].data.newPlateNumber).toBeNull();
  });

  it('ทะเบียนใหม่กรอกครึ่งเดียวไม่ได้', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, newPlateNumber: '' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ให้ครบทั้งหมวดทะเบียนและเลขทะเบียน') },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('ยี่ห้อต้องเป็นยี่ห้อในฐานข้อมูล', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, oldBrand: 'ไม่มีในระบบ' })).rejects.toMatchObject({ response: { error: 'กรุณาเลือกยี่ห้อจากรายการ' } });
  });

  it('รถใหม่ที่ลิงก์ต้องมีอยู่ในฐานข้อมูลรถจดใหม่', async () => {
    const { svc } = service(null);
    await expect(svc.create({ ...validDto, newVehicleId: 'missing' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่พบรถใหม่') } });
  });
});

// F51 (ผู้ใช้ 2026-09-27): ห้ามผูกรถที่ยื่นเอกสารแล้ว หรือรถที่เป็นรถใหม่ของงานอื่นที่ยังไม่รับเอกสารกลับ
describe('PlateSwapService - กฎผูกรถใหม่ (F51)', () => {
  it('รถที่ยื่นเอกสารแล้ว (รอใบเสร็จ) ผูกไม่ได้ ไม่บันทึกงาน', async () => {
    const { svc, create } = service(null, { vehicle: vehicleHit({ documentSubmissions: [{ status: 'PENDING' }] }) });
    await expect(svc.create(validDto)).rejects.toMatchObject({ response: { error: expect.stringContaining('ยื่นเอกสารจดทะเบียนไปแล้ว') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('รถที่ได้ใบเสร็จแล้วผูกไม่ได้', async () => {
    const { svc } = service(null, { vehicle: vehicleHit({ documentSubmissions: [{ status: 'RECEIPT_RECEIVED' }] }) });
    await expect(svc.create(validDto)).rejects.toMatchObject({ response: { error: expect.stringContaining('ได้ใบเสร็จจดทะเบียนแล้ว') } });
  });

  it('รถที่ผูกกับงานอื่นที่ยังเปิดอยู่ผูกซ้ำไม่ได้ (บอกชื่อเจ้าของรถเก่าของงานนั้น)', async () => {
    const other = { id: 's2', oldOwnerName: 'สมหญิง', oldPlateCategory: 'ขค', oldPlateNumber: '55' };
    const { svc, create } = service(null, { vehicle: vehicleHit({ plateSwapsAsNew: [other] }) });
    await expect(svc.create(validDto)).rejects.toMatchObject({ response: { error: expect.stringContaining('สมหญิง (ขค 55)') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('เปลี่ยนคัน: ตรวจงานอื่นที่ยังเปิดอยู่โดยไม่นับงานนี้เอง', async () => {
    const { svc, prisma } = service(swapRow());
    await svc.linkNewVehicle('s1', 'v-new');
    const select = prisma.vehicle.findFirst.mock.calls[0][0].select;
    expect(select.plateSwapsAsNew.where).toEqual({ returnedDate: null, cancelledAt: null, id: { not: 's1' } });
    expect(select.documentSubmissions.where).toEqual({ status: { in: ['PENDING', 'RECEIPT_RECEIVED'] } });
  });

  it('ค้นรถใหม่ส่งเหตุผลที่ผูกไม่ได้กลับไปให้หน้าเว็บปิดปุ่มเลือก', async () => {
    const { svc, prisma } = service(null, { vehicle: vehicleHit({ documentSubmissions: [{ status: 'PENDING' }] }) });
    const [hit] = await svc.searchNewVehicles('NEW', 's9');
    expect(hit.linkBlockedReason).toContain('ยื่นเอกสารจดทะเบียนไปแล้ว');
    expect(prisma.vehicle.findMany.mock.calls[0][0].select.plateSwapsAsNew.where).toEqual(openSwapWhere('s9'));
  });

  it('รถที่ยังไม่ยื่นและไม่มีงานอื่น = ผูกได้', () => {
    expect(plateSwapLinkBlockReason({ documentSubmissions: [], plateSwapsAsNew: [] })).toBeNull();
  });

  it('ข้อความตอนยกเลิกรับกลับบอกว่ายกเลิกรับกลับไม่ได้', () => {
    expect(plateSwapLinkBlockReason({ documentSubmissions: [{ status: 'PENDING' }], plateSwapsAsNew: [] }, 'reopen')).toContain(
      'ยกเลิกรับเอกสารกลับไม่ได้',
    );
  });
});

describe('PlateSwapService.linkNewVehicle', () => {
  it('ยกเลิกลิงก์ไม่ได้ เปลี่ยนเป็นคันอื่นได้เท่านั้น', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.linkNewVehicle('s1', null)).rejects.toMatchObject({ response: { error: expect.stringContaining('กรุณาลิงก์รถใหม่') } });
    expect(update).not.toHaveBeenCalled();
  });

  it('งานที่รับเอกสารกลับแล้ว เปลี่ยนคันต้องมีเหตุผลและบันทึกประวัติ', async () => {
    const { svc, update, prisma } = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt }));
    await expect(svc.linkNewVehicle('s1', 'v-new')).rejects.toMatchObject({ response: { error: expect.stringContaining('ระบุเหตุผล') } });
    expect(update).not.toHaveBeenCalled();
    await svc.linkNewVehicle('s1', 'v-new', 'ผูกผิดคัน');
    expect(update.mock.calls[0][0].data).toEqual({ newVehicleId: 'v-new' });
    expect(auditOf(prisma)[0]).toMatchObject({ entity: 'PlateSwap', entityId: 's1', action: 'relink', remark: 'ผูกผิดคัน' });
  });

  it('เลือกคันเดิม = ไม่เปลี่ยนอะไร', async () => {
    const { svc, update } = service(swapRow({ newVehicleId: 'v-new' }));
    await svc.linkNewVehicle('s1', 'v-new');
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PlateSwapService.setNewPlate', () => {
  it('กรอกทะเบียนใหม่ทีหลังได้ (ยังไม่รับกลับ ไม่ต้องมีเหตุผล)', async () => {
    const { svc, update, prisma } = service(swapRow({ newPlateCategory: null, newPlateNumber: null }));
    await svc.setNewPlate('s1', ' 2ขข ', ' 1111 ');
    expect(update.mock.calls[0][0].data).toEqual({ newPlateCategory: '2ขข', newPlateNumber: '1111' });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('ลบทะเบียนใหม่ของงานที่รับกลับแล้วไม่ได้', async () => {
    const { svc, update } = service(swapRow({ returnedDate: RETURNED }));
    await expect(svc.setNewPlate('s1', '', '')).rejects.toMatchObject({ response: { error: expect.stringContaining('ต้องมีทะเบียนใหม่') } });
    expect(update).not.toHaveBeenCalled();
  });

  it('แก้ทะเบียนใหม่หลังรับกลับต้องมีเหตุผลและบันทึกประวัติ', async () => {
    const { svc, update, prisma } = service(swapRow({ returnedDate: RETURNED }));
    await expect(svc.setNewPlate('s1', '2ขข', '1111')).rejects.toMatchObject({ response: { error: expect.stringContaining('ระบุเหตุผล') } });
    await svc.setNewPlate('s1', '2ขข', '1111', 'พิมพ์เลขผิด');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].where).toEqual({ id: 's1', cancelledAt: null, returnedDate: RETURNED });
    expect(auditOf(prisma)[0].changes).toEqual({ newPlateCategory: { from: '1กก', to: '2ขข' }, newPlateNumber: { from: '9999', to: '1111' } });
  });

  // พบ 2026-09-27: เดิมทางที่ไม่ต้องมีเหตุผลอัปเดตด้วย { id, cancelledAt: null } - ถ้ามีคนยืนยันรับกลับแทรกกลาง
  // เลขของงานที่รับกลับแล้วจะถูกแก้/ล้างโดยไม่มีเหตุผลและไม่มีประวัติ
  it('ก่อนรับกลับ: อัปเดตแบบมีเงื่อนไขว่ายังไม่รับกลับ - มีคนรับกลับแทรกกลาง = 409', async () => {
    const { svc, update, prisma } = service(swapRow());
    update.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(svc.setNewPlate('s1', '', '')).rejects.toMatchObject({ status: 409 });
    expect(update.mock.calls[0][0].where).toEqual({ id: 's1', cancelledAt: null, returnedDate: null });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('PlateSwapService.markReturned', () => {
  it('ต้องแนบรูปใบเสร็จก่อน', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: expect.stringContaining('แนบรูปใบเสร็จ') } });
    expect(update).not.toHaveBeenCalled();
  });

  it('วันที่รับกลับต้องไม่ก่อนวันที่ยื่น', async () => {
    const { svc } = service(swapRow({ receipts: oneReceipt }));
    await expect(svc.markReturned('s1', '2026-09-19')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ก่อนวันที่ยื่น') } });
  });

  it('วันที่รับกลับเป็นอนาคตไม่ได้ (พิมพ์ปีผิด)', async () => {
    const { svc, update } = service(swapRow({ receipts: oneReceipt }));
    await expect(svc.markReturned('s1', '2099-09-22')).rejects.toMatchObject({ response: { error: 'วันที่รับเอกสารกลับต้องไม่เกินวันนี้' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('รับกลับซ้ำไม่ได้', async () => {
    const { svc } = service(swapRow({ returnedDate: new Date('2026-09-21T00:00:00.000Z'), receipts: oneReceipt }));
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: 'งานนี้รับเอกสารกลับแล้ว' } });
  });

  it('มีรูปแล้วบันทึกวันที่รับกลับได้ (ใช้ทะเบียนใหม่ที่มีอยู่)', async () => {
    const { svc, update } = service(swapRow({ receipts: oneReceipt }));
    const { swap } = await svc.markReturned('s1', '2026-09-22');
    expect(update.mock.calls[0][0].where).toEqual({ id: 's1', cancelledAt: null, returnedDate: null });
    expect(update.mock.calls[0][0].data).toEqual({
      returnedDate: new Date('2026-09-22T00:00:00.000Z'),
      newPlateCategory: '1กก',
      newPlateNumber: '9999',
    });
    expect(swap.returnedDate).toBe('2026-09-22');
  });

  it('ยังไม่รู้ทะเบียนใหม่ ยืนยันรับกลับไม่ได้', async () => {
    const { svc, update } = service(swapRow({ newPlateCategory: null, newPlateNumber: null, receipts: oneReceipt }));
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: expect.stringContaining('ทะเบียนใหม่') } });
    expect(update).not.toHaveBeenCalled();
  });

  it('กรอกทะเบียนใหม่พร้อมยืนยันรับกลับได้', async () => {
    const { svc, update } = service(swapRow({ newPlateCategory: null, newPlateNumber: null, receipts: oneReceipt }));
    await svc.markReturned('s1', '2026-09-22', ' 2ขข ', ' 1111 ');
    expect(update.mock.calls[0][0].data.newPlateCategory).toBe('2ขข');
    expect(update.mock.calls[0][0].data.newPlateNumber).toBe('1111');
  });

  it('มีคนรับกลับ/ยกเลิกไปก่อน (อัปเดตแบบมีเงื่อนไขไม่เจอแถว) = 409', async () => {
    const { svc, update } = service(swapRow({ receipts: oneReceipt }));
    update.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ status: 409 });
  });

  // พบ 2026-09-27: เดิมนับรูปจากที่อ่านไว้ก่อน update - ลบรูปสุดท้ายแทรกกลางแล้วงานยังถูกรับกลับทั้งที่ไม่มีรูป
  it('ล็อกแถวแล้วนับรูปใหม่: รูปสุดท้ายถูกลบแทรกกลาง = ยืนยันรับกลับไม่ได้', async () => {
    const { svc, update, prisma } = service(swapRow({ receipts: oneReceipt }));
    prisma.plateSwap.findFirst.mockResolvedValueOnce({ returnedDate: null, newPlateCategory: '1กก', newPlateNumber: '9999', _count: { receipts: 0 } });
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: expect.stringContaining('แนบรูปใบเสร็จ') } });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('มีคนรับกลับไปก่อน (เห็นหลังล็อกแถว) = 409 ไม่เขียนทับ', async () => {
    const { svc, update, prisma } = service(swapRow({ receipts: oneReceipt }));
    prisma.plateSwap.findFirst.mockResolvedValueOnce({ returnedDate: RETURNED, newPlateCategory: '1กก', newPlateNumber: '9999', _count: { receipts: 1 } });
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
  });

  it('ใช้ทะเบียนใหม่ล่าสุดหลังล็อกแถว (มีคนกรอกเลขแทรกกลาง ไม่เอาเลขเก่าที่อ่านไว้ไปทับ)', async () => {
    const { svc, update, prisma } = service(swapRow({ receipts: oneReceipt }));
    prisma.plateSwap.findFirst.mockResolvedValueOnce({ returnedDate: null, newPlateCategory: '3คค', newPlateNumber: '3333', _count: { receipts: 1 } });
    await svc.markReturned('s1', '2026-09-22');
    expect(update.mock.calls[0][0].data).toMatchObject({ newPlateCategory: '3คค', newPlateNumber: '3333' });
  });
});

// F34 (ผู้ใช้ 2026-09-27): แก้ข้อมูลงาน/วันที่รับกลับได้ทั้งก่อนและหลังรับเอกสารกลับ ต้องมีเหตุผลและประวัติ
describe('PlateSwapService.update', () => {
  it('ต้องมีเหตุผลเสมอ', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.update('s1', { oldOwnerName: 'สมชาติ' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่แก้งานสลับเลข' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('แก้ชื่อเจ้าของรถ: บันทึกเฉพาะช่องที่เปลี่ยน ไม่คิดค่าใช้จ่ายใหม่', async () => {
    const { svc, update, prisma } = service(swapRow());
    await svc.update('s1', { oldOwnerName: ' สมชาติ ', oldEngine: '2AZ1234567', remark: 'สะกดชื่อผิด' });
    const { data, where } = update.mock.calls[0][0];
    expect(data.oldOwnerName).toBe('สมชาติ');
    expect(data).not.toHaveProperty('billTotal');
    expect(where).toMatchObject({ id: 's1', cancelledAt: null, updatedAt: new Date('2026-09-20T01:00:00.000Z') });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'update', remark: 'สะกดชื่อผิด', changes: { oldOwnerName: { from: 'สมชาย', to: 'สมชาติ' } } });
  });

  it('เปลี่ยนที่มาของเลข: คิด snapshot ค่าใช้จ่ายใหม่', async () => {
    const { svc, update } = service(swapRow());
    await svc.update('s1', { numberSource: 'AUCTION_RESERVED', buyAuctionPlate: true, remark: 'เลือกที่มาผิด' });
    const { data } = update.mock.calls[0][0];
    expect(data.numberSource).toBe('AUCTION_RESERVED');
    expect(Array.isArray(data.billItems)).toBe(true);
    expect(typeof data.billTotal).toBe('number');
  });

  it('ไม่มีอะไรเปลี่ยน = 400', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.update('s1', { oldOwnerName: 'สมชาย', remark: 'x' })).rejects.toMatchObject({ response: { error: 'ไม่มีข้อมูลที่เปลี่ยน' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('แก้วันที่รับกลับได้เฉพาะงานที่รับกลับแล้ว และต้องไม่เกินวันนี้', async () => {
    const pending = service(swapRow());
    await expect(pending.svc.update('s1', { returnedDate: '2026-09-23', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ยังไม่รับเอกสารกลับ') },
    });
    const returned = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt }));
    await expect(returned.svc.update('s1', { returnedDate: '2099-01-01', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'วันที่รับเอกสารกลับต้องไม่เกินวันนี้' },
    });
    await returned.svc.update('s1', { returnedDate: '2026-09-21', remark: 'กดวันผิด' });
    expect(returned.update.mock.calls[0][0].data.returnedDate).toEqual(new Date('2026-09-21T00:00:00.000Z'));
  });

  it('วันที่ยื่นใหม่ต้องไม่หลังวันที่รับกลับ', async () => {
    const { svc } = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt }));
    await expect(svc.update('s1', { submitDate: '2026-09-25', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ไม่หลังวันที่รับเอกสารกลับ') },
    });
  });

  it('งานที่ยกเลิกแล้วแก้ไม่ได้ (409)', async () => {
    const { svc } = service(swapRow({ cancelledAt: new Date() }));
    await expect(svc.update('s1', { oldOwnerName: 'ก', remark: 'x' })).rejects.toMatchObject({ status: 409 });
  });

  // พบ 2026-09-27: ฟอร์มส่งทุกช่องจากตอนเปิด เดิมเทียบกับ updatedAt ที่อ่านในคำขอเดียวกัน ฟอร์มที่เปิดค้างไว้จึงเอาค่าเก่าไปทับ
  // การแก้ของอีกคนได้โดยไม่มี 409 - ตอนนี้ฟอร์มส่ง expectedUpdatedAt (updatedAt ที่โหลดมา)
  it('ฟอร์มเปิดจากข้อมูลเก่า (expectedUpdatedAt ไม่ตรง) = 409 ไม่บันทึก ไม่เขียนประวัติ', async () => {
    const { svc, update, prisma } = service(swapRow({ updatedAt: new Date('2026-09-21T08:00:00.000Z') }));
    await expect(
      svc.update('s1', { oldOwnerName: 'สมชาติ', remark: 'x', expectedUpdatedAt: '2026-09-20T01:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('expectedUpdatedAt ตรง = ใช้ค่านั้นเป็นเงื่อนไขของการบันทึก', async () => {
    const { svc, update } = service(swapRow());
    await svc.update('s1', { oldOwnerName: 'สมชาติ', remark: 'x', expectedUpdatedAt: '2026-09-20T01:00:00.000Z' });
    expect(update.mock.calls[0][0].where).toEqual({ id: 's1', cancelledAt: null, updatedAt: new Date('2026-09-20T01:00:00.000Z') });
  });

  it('expectedUpdatedAt อ่านเป็นวันเวลาไม่ได้ = 400', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.update('s1', { oldOwnerName: 'สมชาติ', remark: 'x', expectedUpdatedAt: 'เมื่อวาน' })).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  it('รายการส่ง updatedAt ให้ฟอร์มใช้เป็น expectedUpdatedAt', () => {
    expect(serializePlateSwap(swapRow() as never).updatedAt).toBe('2026-09-20T01:00:00.000Z');
  });
});

describe('PlateSwapService.undoReturn', () => {
  it('ต้องมีเหตุผล และงานต้องรับกลับแล้ว', async () => {
    await expect(service(swapRow({ returnedDate: RETURNED })).svc.undoReturn('s1', ' ')).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่ยกเลิกรับเอกสารกลับ' },
    });
    await expect(service(swapRow()).svc.undoReturn('s1', 'x')).rejects.toMatchObject({ response: { error: 'งานนี้ยังไม่รับเอกสารกลับ' } });
  });

  it('งานกลับไปรอรับเอกสาร (returnedDate = null) พร้อมประวัติ', async () => {
    const { svc, update, prisma } = service(swapRow({ returnedDate: RETURNED, newVehicleId: 'v-new', receipts: oneReceipt }));
    const { swap } = await svc.undoReturn('s1', 'กดรับกลับผิดงาน');
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 's1', cancelledAt: null, returnedDate: RETURNED }, data: { returnedDate: null } });
    expect(swap.returnedDate).toBeNull();
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'undo-return', changes: { returnedDate: { from: '2026-09-22', to: null } } });
  });

  it('รถใหม่ที่ผูกไว้ยื่นเอกสารแล้ว = ยกเลิกรับกลับไม่ได้ (กฎเดียวกับการผูก)', async () => {
    const { svc, update } = service(swapRow({ returnedDate: RETURNED, newVehicleId: 'v-new' }), {
      vehicle: vehicleHit({ documentSubmissions: [{ status: 'PENDING' }] }),
    });
    await expect(svc.undoReturn('s1', 'x')).rejects.toMatchObject({ response: { error: expect.stringContaining('ยกเลิกรับเอกสารกลับไม่ได้') } });
    expect(update).not.toHaveBeenCalled();
  });
});

// ผู้ใช้ 2026-09-27: ไม่ลบงาน ยกเลิกแบบเก็บแถวไว้ + ล้าง hash รูปให้แนบรูปเดิมกับงานที่คีย์ใหม่ได้
describe('PlateSwapService.cancel', () => {
  it('ต้องมีเหตุผล', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.cancel('s1', '')).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่ยกเลิกงานสลับเลข' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('ตั้ง cancelledAt ไม่ลบแถว ล้าง contentHash ของรูป และเก็บ snapshot ลงประวัติ (ยกเลิกได้แม้รับกลับแล้ว)', async () => {
    const { svc, update, prisma } = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt }));
    await asUser(['STAFF_CAR'], () => svc.cancel('s1', 'คีย์ซ้ำ'));
    const { where, data } = update.mock.calls[0][0];
    expect(where).toEqual({ id: 's1', cancelledAt: null });
    expect(data).toMatchObject({ cancelReason: 'คีย์ซ้ำ', cancelledById: 'u1' });
    expect(data.cancelledAt).toBeInstanceOf(Date);
    expect(prisma.receiptImage.updateMany).toHaveBeenCalledWith({ where: { plateSwapId: 's1' }, data: { contentHash: null } });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'cancel', editedById: 'u1', changes: { oldOwnerName: 'สมชาย', returnedDate: '2026-09-22' } });
  });

  it('รายการไม่แสดงงานที่ยกเลิกแล้ว', async () => {
    const { svc, prisma } = service(null);
    await svc.list('all');
    expect(prisma.plateSwap.findMany.mock.calls[0][0].where).toMatchObject({ cancelledAt: null });
  });

  it('STAFF_MOTO อย่างเดียวยกเลิกงานสลับเลขรถยนต์ไม่ได้', async () => {
    const { svc } = service(swapRow());
    await expect(asUser(['STAFF_MOTO'], () => svc.cancel('s1', 'x'))).rejects.toMatchObject({ status: 403 });
  });

  it('ACCOUNTANT + STAFF_MOTO ดูรายการได้ (ขอบเขตการอ่าน)', async () => {
    const { svc } = service(null);
    await expect(asUser(['ACCOUNTANT', 'STAFF_MOTO'], () => svc.list('all'))).resolves.toEqual({ swaps: [] });
  });
});

describe('PlateSwapService.addReceipt / removeReceipt', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const file = { buffer: JPEG, size: JPEG.length, originalname: 'r.jpg' };

  it('รูปใหม่ = เก็บพร้อม hash', async () => {
    const { svc, prisma } = service(swapRow());
    await svc.addReceipt('s1', file);
    const data = prisma.receiptImage.create.mock.calls[0][0].data as { contentHash?: string; plateSwapId?: string };
    expect(data.plateSwapId).toBe('s1');
    expect(data.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('รูปเดียวกับใบเสร็จที่มีอยู่แล้ว (ตารางเดียวกับใบเสร็จ Step 5) = "อัพโหลดไปแล้ว" ไม่เก็บไฟล์', async () => {
    const { svc, prisma, storage } = service(swapRow());
    prisma.receiptImage.findUnique.mockResolvedValueOnce({ id: 'r0' } as never);
    await expect(svc.addReceipt('s1', file)).rejects.toMatchObject({ status: 409, response: { error: 'รูปนี้อัพโหลดไปแล้ว' } });
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.receiptImage.create).not.toHaveBeenCalled();
  });

  it('หลังรับกลับแนบรูปเพิ่มได้ แต่ต้องมีเหตุผล', async () => {
    const { svc, prisma, storage } = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt }));
    await expect(svc.addReceipt('s1', file)).rejects.toMatchObject({ response: { error: expect.stringContaining('ระบุเหตุผล') } });
    expect(storage.put).not.toHaveBeenCalled();
    await svc.addReceipt('s1', file, 'แนบรูปผิด ใส่รูปที่ถูก');
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'add-receipt', changes: { receipt: { from: null, to: 'r-new' } } });
  });

  it('หลังรับกลับลบรูปสุดท้ายไม่ได้ และลบรูปแล้วไม่ลบไฟล์ใน storage (เป็นหลักฐาน)', async () => {
    const one = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt }));
    await expect(one.svc.removeReceipt('s1', 'r1', 'รูปผิด')).rejects.toMatchObject({ response: { error: expect.stringContaining('อย่างน้อย 1 รูป') } });
    const two = service(swapRow({ returnedDate: RETURNED, receipts: [...oneReceipt, { id: 'r2', createdAt: new Date() }] }));
    await two.svc.removeReceipt('s1', 'r1', 'รูปผิด');
    expect(two.prisma.receiptImage.deleteMany).toHaveBeenCalledWith({ where: { id: 'r1', plateSwapId: 's1' } });
    expect(two.storage.delete).not.toHaveBeenCalled();
    expect(auditOf(two.prisma)[0]).toMatchObject({ action: 'remove-receipt', remark: 'รูปผิด' });
  });

  it('ก่อนรับกลับลบรูปได้เลย (ลบไฟล์ด้วย)', async () => {
    const { svc, storage, prisma } = service(swapRow({ receipts: oneReceipt }));
    await svc.removeReceipt('s1', 'r1');
    expect(storage.delete).toHaveBeenCalledWith('receipts/r1.jpg');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: เดิมตรวจสถานะนอก transaction - แนบรูปเข้างานที่เพิ่งรับกลับได้โดยไม่มีเหตุผล
  // และลบสองรูปพร้อมกันหลังรับกลับทำให้เหลือ 0 รูป
  it('แนบรูป: งานถูกยืนยันรับกลับระหว่างอัปโหลด = 409 ลบไฟล์ที่ขึ้นไปแล้วทิ้ง', async () => {
    const { svc, prisma, storage } = service(swapRow());
    prisma.plateSwap.findFirst.mockResolvedValueOnce({ returnedDate: RETURNED, newPlateCategory: '1กก', newPlateNumber: '9999', _count: { receipts: 1 } });
    await expect(svc.addReceipt('s1', file)).rejects.toMatchObject({ status: 409 });
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(prisma.receiptImage.create).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalled();
  });

  it('หลังรับกลับ: อีกคนลบรูปไปก่อนจนเหลือรูปเดียว (เห็นหลังล็อกแถว) = ลบไม่ได้', async () => {
    const { svc, prisma } = service(swapRow({ returnedDate: RETURNED, receipts: [...oneReceipt, { id: 'r2', createdAt: new Date() }] }));
    prisma.plateSwap.findFirst.mockResolvedValueOnce({ returnedDate: RETURNED, newPlateCategory: '1กก', newPlateNumber: '9999', _count: { receipts: 1 } });
    await expect(svc.removeReceipt('s1', 'r1', 'รูปผิด')).rejects.toMatchObject({ response: { error: expect.stringContaining('อย่างน้อย 1 รูป') } });
    expect(prisma.receiptImage.deleteMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('ก่อนรับกลับ: มีคนยืนยันรับกลับแทรกกลาง = 409 (ลบหลังรับกลับต้องมีเหตุผล)', async () => {
    const { svc, prisma, storage } = service(swapRow({ receipts: [...oneReceipt, { id: 'r2', createdAt: new Date() }] }));
    prisma.plateSwap.findFirst.mockResolvedValueOnce({ returnedDate: RETURNED, newPlateCategory: '1กก', newPlateNumber: '9999', _count: { receipts: 2 } });
    await expect(svc.removeReceipt('s1', 'r1')).rejects.toMatchObject({ status: 409 });
    expect(prisma.receiptImage.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('รูปถูกลบไปก่อนแล้ว (ลบไม่เจอแถว) = 404', async () => {
    const { svc, prisma } = service(swapRow({ receipts: oneReceipt }));
    prisma.receiptImage.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.removeReceipt('s1', 'r1')).rejects.toMatchObject({ status: 404 });
  });
});

// F20 (พบ 2026-09-27): แถวส่งสถานะการยื่นที่ยังมีผลของรถใหม่ ให้หน้าเว็บบอกว่าแก้ทะเบียนที่เติมผิดฝั่งได้ที่ไหน
describe('PlateSwapService - สถานะการยื่นของรถใหม่ที่ลิงก์', () => {
  const linked = (documentSubmissions: Array<{ status: string }>) => ({
    id: 'v1',
    chassis: 'X',
    plateCategory: '1กก',
    plateNumber: '9999',
    brand: { name: 'BYD' },
    customer: { name: 'ก' },
    documentSubmissions,
  });

  it('รอใบเสร็จ / ได้ใบเสร็จแล้ว / ไม่มีรายการที่ยังมีผล', () => {
    expect(serializePlateSwap(swapRow({ newVehicle: linked([{ status: 'PENDING' }]) }) as never).newVehicle?.activeSubmissionStatus).toBe('PENDING');
    expect(serializePlateSwap(swapRow({ newVehicle: linked([{ status: 'RECEIPT_RECEIVED' }]) }) as never).newVehicle?.activeSubmissionStatus).toBe(
      'RECEIPT_RECEIVED',
    );
    expect(serializePlateSwap(swapRow({ newVehicle: linked([]) }) as never).newVehicle?.activeSubmissionStatus).toBeNull();
  });

  it('รายการโหลดเฉพาะรายการยื่นที่ยังมีผลล่าสุดของรถใหม่', async () => {
    const { svc, prisma } = service(null);
    await svc.list('all');
    const { include } = prisma.plateSwap.findMany.mock.calls[0][0];
    expect(include.newVehicle.select.documentSubmissions).toMatchObject({
      where: { status: { in: ['PENDING', 'RECEIPT_RECEIVED'] } },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
  });
});

// F20 (ผู้ใช้ 2026-09-27): รถใหม่ต้องได้ทะเบียนเก่า - ธงเตือนรถที่ถูกเติม "ทะเบียนใหม่ของรถเก่า" ไว้ก่อนแก้
describe('linkedPlateIsNewPlate', () => {
  const vehicle = (plateCategory: string | null, plateNumber: string | null) => ({
    id: 'v1',
    chassis: 'X',
    plateCategory,
    plateNumber,
    brand: { name: 'BYD' },
    customer: { name: 'ก' },
  });

  it('รถใหม่ถูกบันทึกเป็นทะเบียนใหม่ของรถเก่า = ขึ้นธง', () => {
    expect(linkedPlateIsNewPlate(swapRow({ newVehicle: vehicle('1กก', '9999') }) as never)).toBe(true);
    expect(serializePlateSwap(swapRow({ newVehicle: vehicle('1กก', '9999') }) as never).linkedPlateIsNewPlate).toBe(true);
  });

  it('รถใหม่ได้ทะเบียนเก่า / ยังไม่มีทะเบียน / ไม่ได้ลิงก์ = ไม่ขึ้นธง', () => {
    expect(linkedPlateIsNewPlate(swapRow({ newVehicle: vehicle('กข', '1234') }) as never)).toBe(false);
    expect(linkedPlateIsNewPlate(swapRow({ newVehicle: vehicle(null, null) }) as never)).toBe(false);
    expect(linkedPlateIsNewPlate(swapRow() as never)).toBe(false);
  });
});
