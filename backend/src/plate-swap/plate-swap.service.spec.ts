import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { PlateSwapService } from './plate-swap.service.js';

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
    submitDate: new Date('2026-09-20T00:00:00.000Z'),
    numberSource: 'NEW_UNUSED',
    buyNormalPlate: false,
    buyAuctionPlate: false,
    billItems: [],
    noBillItems: [],
    billTotal: '575',
    noBillTotal: '210',
    returnedDate: null,
    createdAt: new Date('2026-09-20T01:00:00.000Z'),
    newVehicle: null,
    receipts: [],
    ...overrides,
  };
}

function service(found: unknown) {
  const create = vi.fn().mockImplementation(async ({ data }) => swapRow({ ...data }));
  const update = vi.fn().mockResolvedValue(undefined);
  const findUniqueOrThrow = vi.fn().mockImplementation(async () => ({ ...(found as object), returnedDate: new Date('2026-09-22T00:00:00.000Z') }));
  const prisma = {
    plateSwap: { create, update, findUnique: vi.fn().mockResolvedValue(found), findUniqueOrThrow, findMany: vi.fn().mockResolvedValue([]) },
    vehicle: {
      findFirst: vi.fn().mockImplementation(async ({ where }) => (where.id === 'v-new' ? { id: 'v-new' } : null)),
      findMany: vi.fn().mockResolvedValue([]),
    },
    brand: { findFirst: vi.fn().mockImplementation(async ({ where }) => (where.name.equals.toLowerCase() === 'toyota' ? { name: 'Toyota' } : null)) },
    receiptImage: { create: vi.fn(), delete: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const storage: ReceiptStorage = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
  return { svc: new PlateSwapService(prisma, storage), create, update, prisma };
}

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

describe('PlateSwapService.create', () => {
  it('บันทึกรถเก่าพร้อม snapshot ค่าใช้จ่าย (เลขไม่เคยออก + ซื้อป้าย 200)', async () => {
    const { svc, create } = service(null);
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

describe('PlateSwapService.linkNewVehicle', () => {
  it('ยกเลิกลิงก์ไม่ได้ เปลี่ยนเป็นคันอื่นได้เท่านั้น', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.linkNewVehicle('s1', null)).rejects.toMatchObject({ response: { error: expect.stringContaining('กรุณาลิงก์รถใหม่') } });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PlateSwapService.setNewPlate', () => {
  it('กรอกทะเบียนใหม่ทีหลังได้', async () => {
    const { svc, update } = service(swapRow({ newPlateCategory: null, newPlateNumber: null }));
    await svc.setNewPlate('s1', ' 2ขข ', ' 1111 ');
    expect(update.mock.calls[0][0].data).toEqual({ newPlateCategory: '2ขข', newPlateNumber: '1111' });
  });

  it('ลบทะเบียนใหม่ของงานที่รับกลับแล้วไม่ได้', async () => {
    const { svc, update } = service(swapRow({ returnedDate: new Date('2026-09-22T00:00:00.000Z') }));
    await expect(svc.setNewPlate('s1', '', '')).rejects.toMatchObject({ response: { error: expect.stringContaining('ต้องมีทะเบียนใหม่') } });
    expect(update).not.toHaveBeenCalled();
  });
});

describe('PlateSwapService.markReturned', () => {
  it('ต้องแนบรูปใบเสร็จก่อน', async () => {
    const { svc, update } = service(swapRow());
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: expect.stringContaining('แนบรูปใบเสร็จ') } });
    expect(update).not.toHaveBeenCalled();
  });

  it('วันที่รับกลับต้องไม่ก่อนวันที่ยื่น', async () => {
    const { svc } = service(swapRow({ receipts: [{ id: 'r1', createdAt: new Date() }] }));
    await expect(svc.markReturned('s1', '2026-09-19')).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ก่อนวันที่ยื่น') } });
  });

  it('รับกลับซ้ำไม่ได้', async () => {
    const { svc } = service(swapRow({ returnedDate: new Date('2026-09-21T00:00:00.000Z'), receipts: [{ id: 'r1', createdAt: new Date() }] }));
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: 'งานนี้รับเอกสารกลับแล้ว' } });
  });

  it('มีรูปแล้วบันทึกวันที่รับกลับได้ (ใช้ทะเบียนใหม่ที่มีอยู่)', async () => {
    const { svc, update } = service(swapRow({ receipts: [{ id: 'r1', createdAt: new Date() }] }));
    const { swap } = await svc.markReturned('s1', '2026-09-22');
    expect(update.mock.calls[0][0].data).toEqual({
      returnedDate: new Date('2026-09-22T00:00:00.000Z'),
      newPlateCategory: '1กก',
      newPlateNumber: '9999',
    });
    expect(swap.returnedDate).toBe('2026-09-22');
  });

  it('ยังไม่รู้ทะเบียนใหม่ ยืนยันรับกลับไม่ได้', async () => {
    const { svc, update } = service(swapRow({ newPlateCategory: null, newPlateNumber: null, receipts: [{ id: 'r1', createdAt: new Date() }] }));
    await expect(svc.markReturned('s1', '2026-09-22')).rejects.toMatchObject({ response: { error: expect.stringContaining('ทะเบียนใหม่') } });
    expect(update).not.toHaveBeenCalled();
  });

  it('กรอกทะเบียนใหม่พร้อมยืนยันรับกลับได้', async () => {
    const { svc, update } = service(swapRow({ newPlateCategory: null, newPlateNumber: null, receipts: [{ id: 'r1', createdAt: new Date() }] }));
    await svc.markReturned('s1', '2026-09-22', ' 2ขข ', ' 1111 ');
    expect(update.mock.calls[0][0].data.newPlateCategory).toBe('2ขข');
    expect(update.mock.calls[0][0].data.newPlateNumber).toBe('1111');
  });
});

describe('PlateSwapService.remove', () => {
  it('ลบงานที่รับเอกสารกลับแล้วไม่ได้', async () => {
    const { svc, update } = service(swapRow({ returnedDate: new Date('2026-09-21T00:00:00.000Z') }));
    await expect(svc.remove('s1')).rejects.toMatchObject({ response: { error: expect.stringContaining('ลบไม่ได้') } });
    expect(update).not.toHaveBeenCalled();
  });
});
