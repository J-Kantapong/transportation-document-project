import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptExtraction, ReceiptExtractor } from '../receipts/receipt-extractor.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { linkedPlateIsNewPlate, openSwapWhere, PlateSwapService, plateSwapLinkBlockReason, serializePlateSwap } from './plate-swap.service.js';

function swapRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    kind: 'OLD_NEW',
    // เจ้าของงาน (ลูกค้าที่ส่งงานมา) - คนละคนกับ oldOwnerName ซึ่งเป็นเจ้าของรถเก่าตามทะเบียน (ผู้ใช้ 2026-09-28)
    customerId: 'c1',
    customer: { id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก จำกัด' },
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
    receiptNo: null,
    receiptDate: null,
    receiptAmount: null,
    plateReceivedDate: null,
    platePhotoId: null,
    bookReceivedDate: null,
    bookPhotoId: null,
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

// ค่าเริ่มต้น = ไม่มี AI (เหมือน NoAiReceiptExtractor) - เทสต์ที่ต้องการ OCR จริงส่ง opts.extraction มาเอง
const noAiExtractor: ReceiptExtractor = { source: 'NONE', extract: vi.fn().mockResolvedValue(null) };

function service(
  found: unknown,
  opts: {
    vehicle?: Record<string, unknown> | null;
    extraction?: ReceiptExtraction | null;
    extractor?: ReceiptExtractor;
    partner?: Record<string, unknown> | null; // งานคู่ของเคสรถเก่า-รถเก่า (ผู้ใช้ 2026-09-28)
  } = {},
) {
  let current = found as Record<string, unknown> | null;
  const create = vi.fn().mockImplementation(async ({ data }) => swapRow({ ...data }));
  const update = vi.fn().mockImplementation(async ({ data }) => {
    current = { ...current, ...data };
    return current;
  });
  const updateMany = vi.fn().mockImplementation(async ({ where, data }) => {
    if (!current || current.id !== where.id) return { count: 0 };
    for (const [key, value] of Object.entries(where)) {
      if (key === 'id') continue;
      if (current[key] !== value) return { count: 0 };
    }
    current = { ...current, ...data };
    return { count: 1 };
  });
  const findUniqueOrThrow = vi.fn().mockImplementation(async () => current);
  const vehicle = opts.vehicle === undefined ? vehicleHit() : opts.vehicle;
  const extractor: ReceiptExtractor =
    opts.extractor ?? (opts.extraction !== undefined ? { source: 'claude-sonnet-5', extract: vi.fn().mockResolvedValue(opts.extraction) } : noAiExtractor);
  const prisma = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(),
    plateSwap: {
      create,
      update,
      updateMany,
      findUnique: vi.fn().mockImplementation(async () => current),
      findUniqueOrThrow,
      // where.pairId = findPartner (งานคู่ของเคสรถเก่า-รถเก่า) / ไม่มี = lockSwap ตามด้านล่าง
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
        where?.pairId
          ? (opts.partner ?? null)
          : // lockSwap: สถานะล่าสุดหลังล็อกแถว (returnedDate / ทะเบียนใหม่ / จำนวนรูป)
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
      count: vi.fn().mockResolvedValue(0),
    },
    vehicle: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => (vehicle && where.id === vehicle.id ? vehicle : null)),
      findMany: vi.fn().mockResolvedValue(vehicle ? [{ ...vehicle, plateCategory: null, plateNumber: null, brand: { name: 'BYD' }, customer: { name: 'ลูกค้า ก' } }] : []),
      count: vi.fn().mockResolvedValue(0),
    },
    brand: { findFirst: vi.fn().mockImplementation(async ({ where }) => (where.name.equals.toLowerCase() === 'toyota' ? { name: 'Toyota' } : null)) },
    // เจ้าของงาน - มีเฉพาะ c1 กับ c2 ในฐานข้อมูลจำลอง (ผู้ใช้ 2026-09-28)
    customer: { findUnique: vi.fn().mockImplementation(async ({ where }) => (['c1', 'c2'].includes(where.id) ? { id: where.id } : null)) },
    receiptImage: {
      create: vi.fn().mockResolvedValue({ id: 'r-new' }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockImplementation(async ({ where }) => ({ id: where.id, storageKey: `receipts/${where.id}.jpg` })),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    platePhoto: {
      create: vi.fn().mockResolvedValue({ id: 'plate-photo-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({ storageKey: 'plates/plate-photo-1.jpg' }),
    },
    bookPhoto: {
      create: vi.fn().mockResolvedValue({ id: 'book-photo-1' }),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue({ storageKey: 'books/book-photo-1.jpg' }),
    },
    auditLog: { create: vi.fn().mockResolvedValue({ id: 'audit1' }) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const storage: ReceiptStorage = { put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  return { svc: new PlateSwapService(prisma as unknown as PrismaService, storage, extractor), create, update, updateMany, prisma, storage };
}

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

const validDto = {
  customerId: 'c1',
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

  // เจ้าของงาน = ลูกค้าที่ส่งงานมา (ผู้ใช้ 2026-09-28 "เวลาจะส่งงานหรือวางบิลจะได้วางถูก") - บังคับเฉพาะงานที่บันทึกใหม่
  // คนละคนกับ oldOwnerName (เจ้าของรถเก่าตามทะเบียน) จึงห้ามเติมให้กันเอง
  it('ต้องเลือกเจ้าของงานทุกงาน', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, customerId: undefined })).rejects.toMatchObject({
      response: { error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' },
    });
    await expect(svc.create({ ...validDto, customerId: '  ' })).rejects.toMatchObject({
      response: { error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('เจ้าของงานต้องเป็นลูกค้าที่มีอยู่จริง', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, customerId: 'ไม่มีลูกค้านี้' })).rejects.toMatchObject({
      response: { error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('บันทึกเจ้าของงานลงงาน และไม่แตะชื่อเจ้าของรถเก่า', async () => {
    const { svc, create } = service(null);
    const { swap } = await svc.create(validDto);
    expect(create.mock.calls[0][0].data.customerId).toBe('c1');
    expect(create.mock.calls[0][0].data.oldOwnerName).toBe('สมชาย'); // เจ้าของรถเก่ายังเป็นของเดิม ไม่ถูกเติมจากลูกค้า
    expect(swap.customer).toEqual({ id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก จำกัด' });
  });

  it('งานเก่าที่ยังไม่มีเจ้าของงาน ส่งออกเป็น null ไม่ใช่ error', () => {
    expect(serializePlateSwap(swapRow({ customerId: null, customer: null }) as never).customer).toBeNull();
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

  // เจ้าของงาน (ผู้ใช้ 2026-09-28) - เปลี่ยนได้พร้อมเหตุผล เหมือนช่องอื่นของงาน
  it('เปลี่ยนเจ้าของงานได้พร้อมเหตุผล และบันทึกลงประวัติ', async () => {
    const { svc, update, prisma } = service(swapRow());
    await svc.update('s1', { customerId: 'c2', remark: 'ส่งงานมาคนละราย' });
    expect(update.mock.calls[0][0].data.customerId).toBe('c2');
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'update', remark: 'ส่งงานมาคนละราย', changes: { customerId: { from: 'c1', to: 'c2' } } });
  });

  it('เปลี่ยนเจ้าของงานเป็นลูกค้าที่ไม่มีอยู่ไม่ได้ และไม่ส่งมา = ไม่แก้', async () => {
    const missing = service(swapRow());
    await expect(missing.svc.update('s1', { customerId: 'ไม่มี', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' },
    });
    expect(missing.update).not.toHaveBeenCalled();
    // ไม่ส่ง customerId มา = คงเจ้าของงานเดิม ไม่ขึ้นในประวัติ
    const kept = service(swapRow());
    await kept.svc.update('s1', { oldOwnerName: 'สมชาติ', remark: 'สะกดชื่อผิด' });
    expect(kept.update.mock.calls[0][0].data.customerId).toBe('c1');
    expect(auditOf(kept.prisma)[0].changes).not.toHaveProperty('customerId');
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

// แยกขั้นรับเอกสารกลับเป็น 3 ขั้น (ผู้ใช้ 2026-09-28): รับใบเสร็จ (OCR จริง) / รับป้าย / รับเล่ม - เฉพาะฝั่งรถเก่าของงานเอง
describe('PlateSwapService.addReceipt - เติมข้อมูลใบเสร็จจาก OCR', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const file = { buffer: JPEG, size: JPEG.length, originalname: 'r.jpg' };
  const reading = { receiptNo: '69/0035358', date: '2026-09-20', total: 775, chassis: null, plateCategory: null, plateNumber: null, weightKg: null, items: [], uncertainFields: [] };

  it('อ่านสำเร็จและช่องยังว่างทั้ง 3 = เติมเลขที่ใบเสร็จ/วันที่/ยอดเงินให้อัตโนมัติ', async () => {
    const { svc, update } = service(swapRow(), { extraction: { reading, checks: { chassisValid: false, receiptNoValid: true, plateValid: false, itemsSumMatchesTotal: true }, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } } });
    const { swap } = await svc.addReceipt('s1', file);
    expect(update).not.toHaveBeenCalled(); // ไม่ใช่ update ตรงๆ - เติมผ่าน updateMany แบบมีเงื่อนไข
    expect(swap.receiptNo).toBe('69/0035358');
    expect(swap.receiptDate).toBe('2026-09-20');
    expect(swap.receiptAmount).toBe('775');
  });

  it('ช่องมีค่าอยู่แล้ว (พนักงานแก้ไปแล้ว) - OCR ไม่ทับ', async () => {
    const { svc } = service(swapRow({ receiptNo: '1/1' }), {
      extraction: { reading, checks: { chassisValid: false, receiptNoValid: true, plateValid: false, itemsSumMatchesTotal: true }, usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } },
    });
    const { swap } = await svc.addReceipt('s1', file);
    expect(swap.receiptNo).toBe('1/1');
    expect(swap.receiptDate).toBeNull();
  });

  it('อ่านไม่สำเร็จ - เก็บรูปได้ตามปกติ ไม่เติมข้อมูล', async () => {
    const { svc } = service(swapRow(), { extraction: { error: 'AI อ่านไม่สำเร็จ' } });
    const { swap } = await svc.addReceipt('s1', file);
    expect(swap.receiptNo).toBeNull();
  });

  it('ไม่มี ANTHROPIC_API_KEY (extractor.source = NONE) - ไม่เติมข้อมูล', async () => {
    const { svc } = service(swapRow());
    const { swap } = await svc.addReceipt('s1', file);
    expect(swap.receiptNo).toBeNull();
  });
});

describe('PlateSwapService.updateReceiptFields', () => {
  it('กรอก/แก้ก่อนรับกลับได้เลย ไม่ต้องมีเหตุผล', async () => {
    const { svc, update, prisma } = service(swapRow());
    const { swap } = await svc.updateReceiptFields('s1', { receiptNo: '69/1', receiptDate: '2026-09-20', receiptAmount: '775' });
    expect(update.mock.calls[0][0].data).toEqual({ receiptNo: '69/1', receiptDate: new Date('2026-09-20T00:00:00.000Z'), receiptAmount: 775 });
    expect(swap.receiptAmount).toBe('775');
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('แก้หลังรับกลับต้องมีเหตุผลและบันทึกประวัติ', async () => {
    const { svc, update, prisma } = service(swapRow({ returnedDate: RETURNED, receipts: oneReceipt, receiptNo: '1/1' }));
    await expect(svc.updateReceiptFields('s1', { receiptNo: '2/2' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ระบุเหตุผล') } });
    expect(update).not.toHaveBeenCalled();
    await svc.updateReceiptFields('s1', { receiptNo: '2/2', remark: 'พิมพ์เลขที่ผิด' });
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'update-receipt-fields', remark: 'พิมพ์เลขที่ผิด', changes: { receiptNo: { from: '1/1', to: '2/2' } } });
  });

  it('ไม่มีอะไรเปลี่ยน = ไม่บันทึก', async () => {
    const { svc, update } = service(swapRow({ receiptNo: '1/1' }));
    await svc.updateReceiptFields('s1', { receiptNo: '1/1' });
    expect(update).not.toHaveBeenCalled();
  });

  it('วันที่ใบเสร็จรูปแบบผิด = 400', async () => {
    const { svc } = service(swapRow());
    await expect(svc.updateReceiptFields('s1', { receiptDate: 'ไม่ใช่วันที่' })).rejects.toMatchObject({ status: 400 });
  });

  // พบ 2026-09-28: เดิมไม่ตรวจช่วงวันที่เลย พิมพ์ปีผิดเป็น 2000 ก็บันทึกผ่าน ทั้งที่วันที่รับป้าย/รับเล่มตรวจอยู่แล้ว
  it('วันที่ใบเสร็จนอกช่วงวันที่ยื่นถึงวันนี้ = 400', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.updateReceiptFields('s1', { receiptDate: '2000-01-01' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ไม่ก่อนวันที่ยื่น') },
    });
    await expect(svc.updateReceiptFields('s1', { receiptDate: '2999-01-01' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ไม่เกินวันนี้') },
    });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PlateSwapService.attachPlatePhoto / attachBookPhoto', () => {
  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const file = { buffer: JPEG, size: JPEG.length, originalname: 'plate.jpg' };

  it('แนบรูปป้าย: เก็บรูปแล้วตั้งวันที่รับป้าย', async () => {
    const { svc, prisma } = service(swapRow());
    const { swap } = await svc.attachPlatePhoto('s1', file, '2026-09-22');
    expect(prisma.platePhoto.create.mock.calls[0][0].data).toMatchObject({ kind: 'car' });
    expect(swap.plateReceivedDate).toBe('2026-09-22');
    expect(swap.platePhotoId).toBe('plate-photo-1');
  });

  it('แนบรูปเล่ม: เก็บรูปแล้วตั้งวันที่รับเล่ม', async () => {
    const { svc, prisma } = service(swapRow());
    const { swap } = await svc.attachBookPhoto('s1', file, '2026-09-22');
    expect(prisma.bookPhoto.create).toHaveBeenCalled();
    expect(swap.bookReceivedDate).toBe('2026-09-22');
    expect(swap.bookPhotoId).toBe('book-photo-1');
  });

  it('วันที่รับป้ายต้องไม่ก่อนวันที่ยื่นและไม่เกินวันนี้', async () => {
    const { svc } = service(swapRow());
    await expect(svc.attachPlatePhoto('s1', file, '2026-09-01')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ก่อนวันที่ยื่น') } });
    await expect(svc.attachPlatePhoto('s1', file, '2099-01-01')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่เกินวันนี้') } });
  });

  it('รับป้าย/รับเล่ม ไม่ต้องรอ returnedDate - แนบได้แม้ยังไม่รับเอกสารกลับ', async () => {
    const { svc } = service(swapRow({ returnedDate: null }));
    await expect(svc.attachPlatePhoto('s1', file, '2026-09-21')).resolves.toBeTruthy();
  });

  it('รูปซ้ำ (เคยอัปโหลดเป็นรูปป้ายมาแล้ว) = 409 ไม่เก็บไฟล์', async () => {
    const { svc, prisma, storage } = service(swapRow());
    prisma.platePhoto.findUnique.mockResolvedValueOnce({ id: 'p0' } as never);
    await expect(svc.attachPlatePhoto('s1', file, '2026-09-21')).rejects.toMatchObject({ status: 409 });
    expect(storage.put).not.toHaveBeenCalled();
    expect(prisma.platePhoto.create).not.toHaveBeenCalled();
  });

  it('แนบป้ายซ้ำสองครั้ง (แข่งกัน) - ครั้งที่สองได้ "รับป้ายไปแล้ว"', async () => {
    const { svc } = service(swapRow({ platePhotoId: 'existing-photo' }));
    await expect(svc.attachPlatePhoto('s1', file, '2026-09-21')).rejects.toMatchObject({ response: { error: 'งานนี้รับป้ายไปแล้ว' } });
  });
});

describe('PlateSwapService.updatePlateReceivedDate / updateBookReceivedDate', () => {
  it('ต้องมีเหตุผลเสมอ และงานต้องรับป้ายแล้ว', async () => {
    await expect(service(swapRow({ plateReceivedDate: new Date('2026-09-21T00:00:00.000Z') })).svc.updatePlateReceivedDate('s1', { date: '2026-09-21' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ระบุเหตุผล') },
    });
    await expect(service(swapRow()).svc.updatePlateReceivedDate('s1', { date: '2026-09-21', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'งานนี้ยังไม่ได้รับป้าย' },
    });
  });

  it('แก้วันที่รับป้ายสำเร็จพร้อมบันทึกประวัติ', async () => {
    const { svc, prisma } = service(swapRow({ plateReceivedDate: new Date('2026-09-21T00:00:00.000Z'), platePhotoId: 'p1' }));
    const { swap } = await svc.updatePlateReceivedDate('s1', { date: '2026-09-22', remark: 'พิมพ์วันผิด' });
    expect(swap.plateReceivedDate).toBe('2026-09-22');
    expect(auditOf(prisma)[0]).toMatchObject({ action: 'update-plate-date', remark: 'พิมพ์วันผิด' });
  });

  it('แก้วันที่รับเล่มสำเร็จ', async () => {
    const { svc } = service(swapRow({ bookReceivedDate: new Date('2026-09-21T00:00:00.000Z'), bookPhotoId: 'b1' }));
    const { swap } = await svc.updateBookReceivedDate('s1', { date: '2026-09-22', remark: 'พิมพ์วันผิด' });
    expect(swap.bookReceivedDate).toBe('2026-09-22');
  });

  it('วันที่ไม่ได้เปลี่ยน = 400', async () => {
    const { svc } = service(swapRow({ plateReceivedDate: new Date('2026-09-21T00:00:00.000Z'), platePhotoId: 'p1' }));
    await expect(svc.updatePlateReceivedDate('s1', { date: '2026-09-21', remark: 'x' })).rejects.toMatchObject({ response: { error: 'วันที่ไม่ได้เปลี่ยน' } });
  });
});

describe('PlateSwapService.detachPlatePhoto / detachBookPhoto', () => {
  it('ต้องมีเหตุผล และงานต้องรับป้ายแล้ว', async () => {
    await expect(service(swapRow({ plateReceivedDate: new Date('2026-09-21T00:00:00.000Z') })).svc.detachPlatePhoto('s1', {})).rejects.toMatchObject({
      response: { error: expect.stringContaining('ระบุเหตุผล') },
    });
    await expect(service(swapRow()).svc.detachPlatePhoto('s1', { remark: 'x' })).rejects.toMatchObject({ response: { error: 'งานนี้ยังไม่ได้รับป้าย' } });
  });

  it('ถอดรูปป้าย: ล้างวันที่ + รูป และลบแถวรูป (ไม่มีใครอ้างอิงแล้ว)', async () => {
    const { svc, prisma, storage } = service(swapRow({ plateReceivedDate: new Date('2026-09-21T00:00:00.000Z'), platePhotoId: 'p1' }));
    const { swap } = await svc.detachPlatePhoto('s1', { remark: 'แนบผิดคัน' });
    expect(swap.plateReceivedDate).toBeNull();
    expect(swap.platePhotoId).toBeNull();
    expect(prisma.platePhoto.delete).toHaveBeenCalledWith({ where: { id: 'p1' }, select: { storageKey: true } });
    expect(storage.delete).toHaveBeenCalledWith('plates/plate-photo-1.jpg');
  });

  it('ถอดรูปป้ายที่ยังผูกกับรถคันอื่นอยู่ (ไม่ลบแถวรูป)', async () => {
    const { svc, prisma, storage } = service(swapRow({ plateReceivedDate: new Date('2026-09-21T00:00:00.000Z'), platePhotoId: 'p1' }));
    prisma.vehicle.count.mockResolvedValueOnce(1);
    const { swap } = await svc.detachPlatePhoto('s1', { remark: 'แนบผิดคัน' });
    expect(swap.platePhotoId).toBeNull();
    expect(prisma.platePhoto.delete).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ถอดรูปเล่มสำเร็จ', async () => {
    const { svc, prisma } = service(swapRow({ bookReceivedDate: new Date('2026-09-21T00:00:00.000Z'), bookPhotoId: 'b1' }));
    const { swap } = await svc.detachBookPhoto('s1', { remark: 'แนบผิดคัน' });
    expect(swap.bookReceivedDate).toBeNull();
    expect(prisma.bookPhoto.delete).toHaveBeenCalled();
  });
});

describe('PlateSwapService.listByPlateStatus / listByBookStatus', () => {
  it('กรองด้วย plateReceivedDate/bookReceivedDate ไม่มี month', async () => {
    const { svc, prisma } = service(null);
    await svc.listByPlateStatus('pending');
    expect(prisma.plateSwap.findMany.mock.calls[0][0].where).toMatchObject({ cancelledAt: null, plateReceivedDate: null });
    await svc.listByBookStatus('received');
    expect(prisma.plateSwap.findMany.mock.calls[1][0].where).toMatchObject({ cancelledAt: null, bookReceivedDate: { not: null } });
  });

  it('status ไม่ถูกต้อง = 400', async () => {
    const { svc } = service(null);
    await expect(svc.listByPlateStatus('bogus')).rejects.toMatchObject({ status: 400 });
  });
});

// เคส "รถเก่า กับ รถเก่า" (ผู้ใช้ 2026-09-28): กรอก 2 คันในหน้าเดียว แต่ระบบเก็บแยกเป็น 2 งานที่ผูกกันด้วย pairId
describe('PlateSwapService.createPair', () => {
  const carA = { oldOwnerName: 'สมชาย', oldEngine: 'ENG-A', oldChassis: 'CHASSIS-A', oldBrand: 'toyota', oldPlateCategory: 'กข', oldPlateNumber: '1111' };
  const carB = { oldOwnerName: 'สมหญิง', oldEngine: 'ENG-B', oldChassis: 'CHASSIS-B', oldBrand: 'toyota', oldPlateCategory: 'งจ', oldPlateNumber: '2222' };
  const pairDto = { customerId: 'c1', submitDate: '2026-09-28', numberSource: 'NEW_UNUSED', carA, carB };

  it('สร้าง 2 งาน ผูกกันด้วย pairId เดียวกัน และทะเบียนไขว้กัน', async () => {
    const { svc, create } = service(null);
    const { swaps } = await asUser(['STAFF_CAR'], () => svc.createPair(pairDto));
    expect(create).toHaveBeenCalledTimes(2);
    const [a, b] = create.mock.calls.map((c) => c[0].data);
    expect(a.pairId).toBe(b.pairId);
    expect(a.kind).toBe('OLD_OLD');
    // คัน A ได้ทะเบียนของ B และ B ได้ทะเบียนของ A
    expect([a.oldPlateCategory, a.oldPlateNumber, a.newPlateCategory, a.newPlateNumber]).toEqual(['กข', '1111', 'งจ', '2222']);
    expect([b.oldPlateCategory, b.oldPlateNumber, b.newPlateCategory, b.newPlateNumber]).toEqual(['งจ', '2222', 'กข', '1111']);
    // ไม่ลิงก์ฐานข้อมูลรถจดใหม่เลย (ทั้งคู่เป็นรถเก่า) จึงไม่ล็อกรถคันไหนไม่ให้ยื่นจดทะเบียน
    expect(a.newVehicleId).toBeUndefined();
    expect(swaps).toHaveLength(2);
  });

  it('ค่าใช้จ่ายคิดคันละชุดด้วยสูตรเดียวกับเคสรถเก่า-รถใหม่', async () => {
    const { svc, create } = service(null);
    await asUser(['STAFF_CAR'], () => svc.createPair(pairDto));
    const [a, b] = create.mock.calls.map((c) => c[0].data);
    expect(a.billTotal).toBe(b.billTotal);
    expect(a.noBillTotal).toBe(b.noBillTotal);
    expect(Number(a.billTotal)).toBeGreaterThan(0);
  });

  it('เลขตัวถังซ้ำกัน / ทะเบียนซ้ำกัน = 400 (กรอกผิด ไม่มีอะไรให้สลับ)', async () => {
    const { svc, create } = service(null);
    await expect(asUser(['STAFF_CAR'], () => svc.createPair({ ...pairDto, carB: { ...carB, oldChassis: 'chassis-a' } }))).rejects.toMatchObject({
      status: 400,
    });
    await expect(
      asUser(['STAFF_CAR'], () => svc.createPair({ ...pairDto, carB: { ...carB, oldPlateCategory: 'กข', oldPlateNumber: '1111' } })),
    ).rejects.toMatchObject({ status: 400 });
    expect(create).not.toHaveBeenCalled();
  });

  it('เจ้าของงานบังคับเหมือนเคสเดิม และบอกด้วยว่าคันไหนกรอกไม่ครบ', async () => {
    const { svc } = service(null);
    await expect(asUser(['STAFF_CAR'], () => svc.createPair({ ...pairDto, customerId: undefined }))).rejects.toMatchObject({ status: 400 });
    await expect(
      asUser(['STAFF_CAR'], () => svc.createPair({ ...pairDto, carB: { ...carB, oldChassis: '' } })),
    ).rejects.toMatchObject({ response: { error: expect.stringContaining('คันที่ 2') } });
  });
});

describe('PlateSwapService - งานที่เป็นคู่ (รถเก่า กับ รถเก่า)', () => {
  const partner = { id: 's2', oldOwnerName: 'สมหญิง', oldChassis: 'CHASSIS-B', oldPlateCategory: 'งจ', oldPlateNumber: '2222' };
  const paired = () => swapRow({ kind: 'OLD_OLD', pairId: 'pair-1', newPlateCategory: 'งจ', newPlateNumber: '2222', newVehicleId: null });

  it('แก้ทะเบียนเก่าข้างหนึ่ง = ทะเบียนใหม่ของคู่ตามไปด้วย', async () => {
    const { svc, update } = service(paired(), { partner });
    await asUser(['STAFF_CAR'], () =>
      svc.update('s1', { oldPlateCategory: 'ฮฮ', oldPlateNumber: '9999', remark: 'กรอกทะเบียนผิด' }),
    );
    const partnerUpdate = update.mock.calls.find((c) => c[0].where.id === 's2');
    expect(partnerUpdate?.[0].data).toEqual({ newPlateCategory: 'ฮฮ', newPlateNumber: '9999' });
  });

  it('แก้ช่องอื่นที่ไม่ใช่ทะเบียน ไม่ไปยุ่งกับคู่', async () => {
    const { svc, update } = service(paired(), { partner });
    await asUser(['STAFF_CAR'], () => svc.update('s1', { oldOwnerName: 'สมชาย ใจดี', remark: 'แก้ชื่อผิด' }));
    expect(update.mock.calls.some((c) => c[0].where.id === 's2')).toBe(false);
  });

  it('ยกเลิกงานที่เป็นคู่ = ยกเลิกทั้ง 2 งาน (เป็นการยื่นครั้งเดียวกัน)', async () => {
    const { svc, update } = service(paired(), { partner });
    const res = await asUser(['STAFF_CAR'], () => svc.cancel('s1', 'ลูกค้ายกเลิก'));
    expect(res.cancelledIds).toEqual(['s1', 's2']);
    expect(update.mock.calls.filter((c) => c[0].data.cancelledAt).map((c) => c[0].where.id)).toEqual(['s1', 's2']);
  });

  it('งาน OLD_NEW ไม่มีคู่ = ยกเลิกแค่ตัวเอง', async () => {
    const { svc } = service(swapRow());
    const res = await asUser(['STAFF_CAR'], () => svc.cancel('s1', 'ลูกค้ายกเลิก'));
    expect(res.cancelledIds).toEqual(['s1']);
  });
});

// งานสลับเลขของรถจักรยานยนต์ (ผู้ใช้ให้อัตรา 2026-09-28) - ใช้ระบบเดียวกับรถยนต์ แยกด้วย vehicleClass
describe('PlateSwapService - รถจักรยานยนต์', () => {
  // validDto ติ๊กซื้อแผ่นป้ายไว้ - เทสต์อัตราพื้นฐานจึงสั่งไม่ซื้อป้ายให้ชัด
  const motoDto = { ...validDto, vehicleClass: 'MOTO', buyNormalPlate: false };

  it('STAFF_MOTO ยื่นงานมอเตอร์ไซค์ได้ และคิดค่าใช้จ่ายด้วยอัตรามอเตอร์ไซค์', async () => {
    const { svc, create } = service(null);
    await asUser(['STAFF_MOTO'], () => svc.create(motoDto));
    const data = create.mock.calls[0][0].data;
    expect(data.vehicleClass).toBe('MOTO');
    expect(data.billTotal).toBe(535); // 5+20+10+500 (รถยนต์คือ 575)
    expect(data.noBillTotal).toBe(110); // ลงขัน 100 + อากร 10 (รถยนต์คือ 210)
  });

  it('ซื้อแผ่นป้ายมอเตอร์ไซค์ = +100 (รถยนต์ 200)', async () => {
    const { svc, create } = service(null);
    await asUser(['STAFF_MOTO'], () => svc.create({ ...motoDto, buyNormalPlate: true }));
    expect(create.mock.calls[0][0].data.billTotal).toBe(635);
  });

  it('งานด่วนบวก 50 ใน No Bill (มีเฉพาะมอเตอร์ไซค์)', async () => {
    const { svc, create } = service(null);
    await asUser(['STAFF_MOTO'], () => svc.create({ ...motoDto, urgent: true }));
    expect(create.mock.calls[0][0].data.noBillTotal).toBe(160);
    expect(create.mock.calls[0][0].data.urgent).toBe(true);
  });

  it('STAFF_CAR ยื่นงานมอเตอร์ไซค์ไม่ได้ และ STAFF_MOTO ยื่นงานรถยนต์ไม่ได้', async () => {
    const { svc, create } = service(null);
    await expect(asUser(['STAFF_CAR'], () => svc.create(motoDto))).rejects.toMatchObject({ status: 403 });
    await expect(asUser(['STAFF_MOTO'], () => svc.create(validDto))).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });

  it('รายการแยกตามประเภทรถ - ไม่ส่ง vehicleClass = รถยนต์เหมือนเดิม', async () => {
    const { svc, prisma } = service(null);
    await asUser(['ADMIN'], () => svc.list('all'));
    expect(prisma.plateSwap.findMany.mock.calls.at(-1)?.[0].where.vehicleClass).toBe('CAR');
    await asUser(['ADMIN'], () => svc.list('all', undefined, undefined, 'MOTO'));
    expect(prisma.plateSwap.findMany.mock.calls.at(-1)?.[0].where.vehicleClass).toBe('MOTO');
  });

  it('ค้นรถใหม่เพื่อลิงก์ - มอเตอร์ไซค์ค้นเฉพาะ รย.12 ไม่ปนรถยนต์', async () => {
    const { svc, prisma } = service(null, { vehicle: null });
    await asUser(['STAFF_MOTO'], () => svc.searchNewVehicles('MLH', undefined, 'MOTO'));
    const where = prisma.vehicle.findMany.mock.calls.at(-1)?.[0].where;
    expect(JSON.stringify(where)).toContain('รย.12-');
  });

  it('แก้งานมอเตอร์ไซค์ด้วยบัญชีรถยนต์ไม่ได้ (เช็คจากประเภทของงานจริง)', async () => {
    const { svc } = service(swapRow({ vehicleClass: 'MOTO' }));
    await expect(asUser(['STAFF_CAR'], () => svc.update('s1', { oldOwnerName: 'x', remark: 'y' }))).rejects.toMatchObject({ status: 403 });
  });
});
