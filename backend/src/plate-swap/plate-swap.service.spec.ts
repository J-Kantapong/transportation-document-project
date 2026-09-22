import { vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { PlateSwapService } from './plate-swap.service.js';

function swapRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    kind: 'OLD_NEW',
    oldOwnerName: 'สมชาย',
    oldChassis: 'MR0FZ29G001234567',
    oldBrand: 'Toyota',
    oldPlateNumber: 'กข 1234',
    newPlateNumber: '1กก 9999',
    submitDate: new Date('2026-09-20T00:00:00.000Z'),
    numberSource: 'NEW_UNUSED',
    buyNormalPlate: false,
    buyAuctionPlate: false,
    billItems: [],
    noBillItems: [],
    billTotal: '575',
    noBillTotal: '200',
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
    vehicle: { findFirst: vi.fn().mockImplementation(async ({ where }) => (where.id === 'v-new' ? { id: 'v-new' } : null)), findMany: vi.fn().mockResolvedValue([]) },
    brand: { findFirst: vi.fn().mockImplementation(async ({ where }) => (where.name.equals.toLowerCase() === 'toyota' ? { name: 'Toyota' } : null)) },
    receiptImage: { create: vi.fn(), delete: vi.fn(), findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  const storage: ReceiptStorage = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
  return { svc: new PlateSwapService(prisma, storage), create, update, prisma };
}

const validDto = {
  oldOwnerName: ' สมชาย ',
  oldChassis: 'MR0FZ29G001234567',
  oldBrand: 'toyota',
  oldPlateNumber: 'กข 1234',
  newPlateNumber: '1กก 9999',
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
    expect(data.noBillTotal).toBe(200);
    expect(data.newVehicleId).toBe('v-new');
    expect(data.oldBrand).toBe('Toyota');
    expect(swap.submitDate).toBe('2026-09-20');
  });

  it('ต้องกรอกครบทุกช่องของรถเก่า', async () => {
    const { svc, create } = service(null);
    await expect(svc.create({ ...validDto, oldPlateNumber: '  ' })).rejects.toMatchObject({ response: { error: 'กรุณากรอกเลขทะเบียนเก่า' } });
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

  it('มีรูปแล้วบันทึกวันที่รับกลับได้', async () => {
    const { svc, update } = service(swapRow({ receipts: [{ id: 'r1', createdAt: new Date() }] }));
    const { swap } = await svc.markReturned('s1', '2026-09-22');
    expect(update.mock.calls[0][0].data).toEqual({ returnedDate: new Date('2026-09-22T00:00:00.000Z') });
    expect(swap.returnedDate).toBe('2026-09-22');
  });
});

describe('PlateSwapService.remove', () => {
  it('ลบงานที่รับเอกสารกลับแล้วไม่ได้', async () => {
    const { svc, update } = service(swapRow({ returnedDate: new Date('2026-09-21T00:00:00.000Z') }));
    await expect(svc.remove('s1')).rejects.toMatchObject({ response: { error: expect.stringContaining('ลบไม่ได้') } });
    expect(update).not.toHaveBeenCalled();
  });
});
