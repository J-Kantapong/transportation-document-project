import { vi } from 'vitest';
import { DeliveryService, deliveryKind } from './delivery.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: '8ขง',
    plateNumber: '363',
    plateReceivedDate: new Date('2026-09-20T00:00:00.000Z'),
    bookReceivedDate: new Date('2026-09-20T00:00:00.000Z'),
    deliveredDate: null,
    plateDeliveredDate: null,
    deliveryRecipient: null,
    deliveryNote: null,
    customer: { id: 'c1', name: 'ลูกค้า', company: null },
    brand: { name: 'Lexus' },
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED', receiptNo: '69/0035358' }],
    invoiceLines: [],
    ...overrides,
  };
}

function service(found: unknown[]) {
  const update = vi.fn().mockImplementation((args) => args);
  const create = vi.fn().mockImplementation((args) => args);
  // ตัวสุดท้ายของ transaction = การสร้างใบส่งงาน
  const $transaction = vi.fn().mockImplementation(async (ops: unknown[]) => ops.map((op, i) => (i === ops.length - 1 ? { id: 's1', slipNo: 7 } : op)));
  const prisma = { vehicle: { findMany: vi.fn().mockResolvedValue(found), update }, deliverySlip: { create }, $transaction } as unknown as PrismaService;
  return { svc: new DeliveryService(prisma), update, create, $transaction };
}

const dto = (ids: string[]) => ({ vehicleIds: ids, date: '2026-09-21', recipient: 'คุณนก', note: '' });

describe('deliveryKind', () => {
  it('แยกชนิดงานส่งจากสถานะป้ายและการส่งงาน', () => {
    expect(deliveryKind({ deliveredDate: null, plateReceivedDate: new Date() })).toBe('FULL');
    expect(deliveryKind({ deliveredDate: null, plateReceivedDate: null })).toBe('NO_PLATE');
    expect(deliveryKind({ deliveredDate: new Date(), plateReceivedDate: new Date() })).toBe('PLATE_ONLY');
    expect(deliveryKind({ deliveredDate: new Date(), plateReceivedDate: null })).toBe('WAITING_PLATE');
  });
});

describe('DeliveryService.submit', () => {
  it('ส่งครบ: ตั้งวันที่ส่งงานและวันที่ส่งป้ายพร้อมกัน', async () => {
    const { svc, update } = service([vehicle()]);
    const result = await svc.submit(dto(['v1']));
    expect(update).toHaveBeenCalledWith({
      where: { id: 'v1' },
      data: { deliveredDate: new Date('2026-09-21T00:00:00.000Z'), deliveryRecipient: 'คุณนก', deliveryNote: null, plateDeliveredDate: new Date('2026-09-21T00:00:00.000Z') },
    });
    expect(result).toEqual({ slipId: 's1', slipNo: 7, delivered: 1, plateOnly: 0, platePending: 0 });
  });

  it('ป้ายยังไม่ออก: ส่งใบเสร็จกับเล่มได้ และป้ายค้างส่ง', async () => {
    const { svc, update } = service([vehicle({ plateReceivedDate: null })]);
    const result = await svc.submit(dto(['v1']));
    expect(update.mock.calls[0][0].data.plateDeliveredDate).toBeNull();
    expect(result).toEqual({ slipId: 's1', slipNo: 7, delivered: 1, plateOnly: 0, platePending: 1 });
  });

  it('ส่งป้ายตามทีหลัง: ไม่แตะวันที่ส่งงานและผู้รับเดิม', async () => {
    const { svc, update } = service([vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z'), deliveryRecipient: 'คุณเอก' })]);
    const result = await svc.submit(dto(['v1']));
    expect(update.mock.calls[0][0].data).toEqual({ plateDeliveredDate: new Date('2026-09-21T00:00:00.000Z'), deliveryNote: 'ส่งป้าย 21/09/2026 ผู้รับ คุณนก' });
    expect(result).toEqual({ slipId: 's1', slipNo: 7, delivered: 0, plateOnly: 1, platePending: 0 });
  });

  it('ยังไม่ได้รับเล่ม ส่งงานไม่ได้', async () => {
    const { svc, $transaction } = service([vehicle({ bookReceivedDate: null })]);
    await expect(svc.submit(dto(['v1']))).rejects.toMatchObject({ response: { error: expect.stringContaining('เล่มทะเบียน') } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it('ใบส่งงานบอกแยกรายคันว่ารอบนี้ส่งอะไร', async () => {
    const { svc, create } = service([
      vehicle(),
      vehicle({ id: 'v2', chassis: 'CH2', plateReceivedDate: null }),
      vehicle({ id: 'v3', chassis: 'CH3', deliveredDate: new Date('2026-09-19T00:00:00.000Z') }),
    ]);
    await svc.submit(dto(['v1', 'v2', 'v3']));
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ customerId: 'c1', recipient: 'คุณนก', note: null, date: new Date('2026-09-21T00:00:00.000Z') });
    expect(data.items.create.map((i: Record<string, unknown>) => [i.vehicleId, i.receipt, i.book, i.plate])).toEqual([
      ['v1', true, true, true],
      ['v2', true, true, false],
      ['v3', false, false, true],
    ]);
    expect(data.items.create[0]).toMatchObject({ chassis: 'CH1', brandName: 'Lexus', plateText: '8ขง 363', receiptNo: '69/0035358' });
  });

  it('ส่งงานได้ครั้งละ 1 ลูกค้า', async () => {
    const { svc, $transaction } = service([vehicle(), vehicle({ id: 'v2', customer: { id: 'c2', name: 'อีกราย', company: null } })]);
    await expect(svc.submit(dto(['v1', 'v2']))).rejects.toMatchObject({ response: { error: expect.stringContaining('1 ลูกค้า') } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it('ต้องมีผู้รับงาน', async () => {
    const { svc } = service([vehicle()]);
    await expect(svc.submit({ ...dto(['v1']), recipient: ' ' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ผู้รับ') } });
  });
});
