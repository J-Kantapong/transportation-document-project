import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { needsTransferReceipt, sharesFor, splitEvenly, TransferNoticeReceiptsService } from './transfer-notice-receipts.service.js';

// ใบเสร็จแจ้งย้าย ขั้น 2 (ผู้ใช้ 2026-10-08): 1 ใบผูกได้หลายคัน หารยอดเท่ากัน เศษลงคันสุดท้าย

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const file = { buffer: JPEG, size: JPEG.length, originalname: 'receipt.jpg' };

function vehicle(o: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'CH1',
    body: 'รย.12-น้อยกว่า 300cc',
    registrationProvince: 'เชียงใหม่',
    transferDone: false,
    transferReceiptId: null,
    transferBillCost: null,
    invoiceLines: [] as unknown[],
    ...o,
  };
}

function setup(vehicles: Array<ReturnType<typeof vehicle>>, receipt: { totalAmount: number; storageKey: string } | null = null) {
  const vehicleUpdate = vi.fn().mockResolvedValue({});
  const receiptCreate = vi.fn().mockResolvedValue({ id: 'r1' });
  const receiptDelete = vi.fn().mockResolvedValue({});
  const receiptUpdate = vi.fn().mockResolvedValue({});
  const logCreate = vi.fn().mockResolvedValue({});
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    vehicle: {
      // lockReceiptVehicles อ่านรายการ id ก่อน (where.transferReceiptId) แล้วอ่านใต้ล็อก (where.id.in)
      findMany: vi.fn().mockImplementation((args: { where: { transferReceiptId?: string } }) =>
        Promise.resolve(args.where.transferReceiptId ? vehicles.filter((v) => v.transferReceiptId === args.where.transferReceiptId) : vehicles),
      ),
      update: vehicleUpdate,
    },
    transferNoticeReceipt: { create: receiptCreate, delete: receiptDelete, update: receiptUpdate, findUnique: vi.fn().mockResolvedValue(receipt) },
    vehicleEditLog: { create: logCreate },
  };
  const prisma = {
    transferNoticeReceipt: { findUnique: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const storage = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  return { svc: new TransferNoticeReceiptsService(prisma, storage as unknown as ReceiptStorage), vehicleUpdate, receiptCreate, receiptDelete, logCreate, storage };
}

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as { response?: { error?: string } }).response?.error ?? String(e);
  }
};

describe('การหารยอดใบเสร็จแจ้งย้าย', () => {
  it('หารเท่ากัน เศษสตางค์ลงคันสุดท้าย ผลรวมเท่ายอดใบเสมอ', () => {
    expect(splitEvenly(15, 3)).toEqual([5, 5, 5]);
    expect(splitEvenly(10, 3)).toEqual([3.33, 3.33, 3.34]);
    expect(splitEvenly(5, 1)).toEqual([5]);
    expect(splitEvenly(0.05, 3)).toEqual([0.01, 0.01, 0.03]);
  });

  it('ยอดรายคันต้องครบทุกคันและรวมเท่ายอดใบ', () => {
    expect(sharesFor(['a', 'b'], 15, new Map([['a', 5], ['b', 10]]))).toEqual([5, 10]);
    expect(() => sharesFor(['a', 'b'], 15, new Map([['a', 5], ['b', 5]]))).toThrow();
    expect(() => sharesFor(['a', 'b'], 15, new Map([['a', 15]]))).toThrow();
  });

  it('ต้องมีใบเสร็จเฉพาะงานแจ้งย้าย (จดจังหวัดอื่นนอกจากกรุงเทพฯ)', () => {
    expect(needsTransferReceipt('เชียงใหม่')).toBe(true);
    expect(needsTransferReceipt('สมุทรปราการ')).toBe(true);
    expect(needsTransferReceipt('กรุงเทพมหานคร')).toBe(false);
    expect(needsTransferReceipt(null)).toBe(false);
  });
});

describe('TransferNoticeReceiptsService.attach', () => {
  it('ใบเดียวผูก 3 คัน: เก็บไฟล์ครั้งเดียว หารยอดให้ทุกคัน และบันทึกประวัติทุกคัน', async () => {
    const { svc, vehicleUpdate, receiptCreate, logCreate, storage } = setup([vehicle(), vehicle({ id: 'v2', chassis: 'CH2' }), vehicle({ id: 'v3', chassis: 'CH3' })]);
    const result = await svc.attach(file, { vehicleIds: 'v1,v2,v3', totalAmount: '10' });
    expect(storage.put).toHaveBeenCalledTimes(1);
    expect(receiptCreate.mock.calls[0][0].data).toMatchObject({ totalAmount: 10, mimeType: 'image/jpeg' });
    expect(vehicleUpdate.mock.calls.map((c) => c[0].data.transferBillCost)).toEqual([3.33, 3.33, 3.34]);
    expect(logCreate).toHaveBeenCalledTimes(3);
    expect(result.vehicles).toEqual([
      { id: 'v1', amount: 3.33 },
      { id: 'v2', amount: 3.33 },
      { id: 'v3', amount: 3.34 },
    ]);
  });

  it('ปฏิเสธรถกรุงเทพฯ (ตัดบัญชี) รถที่มีใบเสร็จแล้ว และรถที่อยู่ในบิลแล้ว - ไม่ทิ้งไฟล์ค้างใน storage', async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ registrationProvince: 'กรุงเทพมหานคร' }, 'ไม่ใช่งานแจ้งย้าย'],
      [{ transferReceiptId: 'old' }, 'มีใบเสร็จแจ้งย้ายแล้ว'],
      [{ invoiceLines: [{ invoice: { invoiceNo: 'IV1' } }] }, 'อยู่ในบิล IV1'],
    ];
    for (const [override, message] of cases) {
      const { svc, storage, receiptCreate } = setup([vehicle(override)]);
      expect(await errorOf(svc.attach(file, { vehicleIds: 'v1', totalAmount: '5' }))).toContain(message);
      expect(receiptCreate).not.toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledTimes(1);
    }
  });

  it('ต้องมีไฟล์ ยอดรวม และรถอย่างน้อย 1 คัน', async () => {
    const { svc } = setup([vehicle()]);
    expect(await errorOf(svc.attach(undefined, { vehicleIds: 'v1', totalAmount: '5' }))).toContain('แนบไฟล์');
    expect(await errorOf(svc.attach(file, { vehicleIds: 'v1', totalAmount: '' }))).toContain('ยอดรวมของใบเสร็จ');
    expect(await errorOf(svc.attach(file, { vehicleIds: '', totalAmount: '5' }))).toContain('อย่างน้อย 1 คัน');
    expect(await errorOf(svc.attach({ ...file, buffer: Buffer.from('hello world, not an image') }, { vehicleIds: 'v1', totalAmount: '5' }))).toContain('รูป');
  });
});

describe('TransferNoticeReceiptsService.detach', () => {
  const linked = (o: Record<string, unknown> = {}) => vehicle({ transferReceiptId: 'r1', transferBillCost: 5, ...o });

  it('ถอด 1 คันจากใบ 3 คัน: ยอดรวมคงเดิม หารใหม่ให้คันที่เหลือ', async () => {
    const { svc, vehicleUpdate, receiptDelete } = setup(
      [linked(), linked({ id: 'v2', chassis: 'CH2' }), linked({ id: 'v3', chassis: 'CH3' })],
      { totalAmount: 15, storageKey: 'transfer-notice/x.jpg' },
    );
    const result = await svc.detach('r1', { vehicleId: 'v1', remark: 'ติ๊กผิดคัน' });
    expect(vehicleUpdate.mock.calls[0][0]).toEqual({ where: { id: 'v1' }, data: { transferReceiptId: null, transferBillCost: null } });
    expect(result).toEqual({ id: 'r1', deleted: false, vehicles: [{ id: 'v2', amount: 7.5 }, { id: 'v3', amount: 7.5 }] });
    expect(receiptDelete).not.toHaveBeenCalled();
  });

  it('ถอดคันสุดท้าย = ลบใบเสร็จและไฟล์', async () => {
    const { svc, receiptDelete, storage } = setup([linked()], { totalAmount: 5, storageKey: 'transfer-notice/x.jpg' });
    expect(await svc.detach('r1', { vehicleId: 'v1', remark: 'แนบผิดใบ' })).toMatchObject({ deleted: true });
    expect(receiptDelete).toHaveBeenCalledWith({ where: { id: 'r1' } });
    expect(storage.delete).toHaveBeenCalledWith('transfer-notice/x.jpg');
  });

  it('ต้องมีเหตุผล · คันที่ติ๊กดำเนินการแล้วถอดไม่ได้ · ใบที่มีรถอยู่ในบิลแล้วแก้ไม่ได้', async () => {
    const receipt = { totalAmount: 5, storageKey: 'k' };
    expect(await errorOf(setup([linked()], receipt).svc.detach('r1', { vehicleId: 'v1', remark: ' ' }))).toContain('เหตุผล');
    expect(await errorOf(setup([linked({ transferDone: true })], receipt).svc.detach('r1', { vehicleId: 'v1', remark: 'x' }))).toContain('ยกเลิกสถานะ');
    expect(
      await errorOf(setup([linked({ invoiceLines: [{ invoice: { invoiceNo: 'IV9' } }] })], receipt).svc.detach('r1', { vehicleId: 'v1', remark: 'x' })),
    ).toContain('อยู่ในบิล IV9');
  });
});
