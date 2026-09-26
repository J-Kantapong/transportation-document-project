import { vi } from 'vitest';
import { DeliveryService, deliveryKind, stripPlateNote } from './delivery.service.js';
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

describe('stripPlateNote', () => {
  it('ตัดหมายเหตุการส่งป้ายตามทีหลังออก เก็บหมายเหตุเดิมไว้', () => {
    expect(stripPlateNote('ฝากไว้ที่ รปภ. · ส่งป้าย 21/09/2026 ผู้รับ คุณนก')).toBe('ฝากไว้ที่ รปภ.');
    expect(stripPlateNote('ส่งป้าย 21/09/2026 ผู้รับ คุณนก')).toBeNull();
    expect(stripPlateNote(null)).toBeNull();
  });
});

describe('DeliveryService แก้ / ยกเลิกใบส่งงาน', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  function slipItem(overrides: Record<string, unknown> = {}) {
    return {
      id: 'i1',
      vehicleId: 'v1',
      receipt: true,
      book: true,
      plate: true,
      chassis: 'CH1',
      brandName: 'Lexus',
      body: 'รย.1-เก๋ง 2 ตอน',
      plateText: '8ขง 363',
      receiptNo: null,
      cancelledAt: null,
      cancelReason: null,
      cancelledBy: null,
      vehicle: { invoiceLines: [] },
      ...overrides,
    };
  }
  function setup(items: unknown[], vehicles: unknown[], laterPlate: unknown[] = []) {
    const slip = {
      id: 's1',
      slipNo: 7,
      date: day('2026-09-21'),
      recipient: 'คุณนก',
      note: null,
      createdAt: new Date(),
      cancelledAt: null,
      cancelReason: null,
      customer: { id: 'c1', name: 'ลูกค้า', company: null, branch: null, address: null, phone: null },
      createdBy: null,
      cancelledBy: null,
      items,
    };
    const vehicleUpdate = vi.fn().mockImplementation((args) => ({ op: 'vehicle', ...args }));
    const itemUpdate = vi.fn().mockImplementation((args) => ({ op: 'item', ...args }));
    const slipUpdate = vi.fn().mockImplementation((args) => ({ op: 'slip', ...args }));
    const logCreate = vi.fn().mockImplementation((args) => ({ op: 'log', ...args }));
    const $transaction = vi.fn().mockResolvedValue([]);
    const prisma = {
      deliverySlip: { findUnique: vi.fn().mockResolvedValue(slip), update: slipUpdate },
      deliverySlipItem: { findMany: vi.fn().mockResolvedValue(laterPlate), update: itemUpdate },
      vehicle: { findMany: vi.fn().mockResolvedValue(vehicles), update: vehicleUpdate },
      vehicleEditLog: { create: logCreate },
      $transaction,
    } as unknown as PrismaService;
    return { svc: new DeliveryService(prisma), vehicleUpdate, itemUpdate, slipUpdate, logCreate, $transaction };
  }
  const delivered = { id: 'v1', deliveredDate: day('2026-09-21'), plateDeliveredDate: day('2026-09-21'), deliveryRecipient: 'คุณนก', deliveryNote: null };

  it('ยกเลิกครบทุกคัน: รถกลับเข้าคิว และทั้งใบขึ้นว่ายกเลิก', async () => {
    const { svc, vehicleUpdate, itemUpdate, slipUpdate, logCreate } = setup([slipItem()], [delivered]);
    await svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'ติ๊กผิดคัน' });
    expect(vehicleUpdate.mock.calls[0][0].data).toEqual({
      deliveredDate: null,
      deliveryRecipient: null,
      deliveryNote: null,
      plateDeliveredDate: null,
      deliveryConfirmedAt: null,
    });
    expect(itemUpdate.mock.calls[0][0].data).toMatchObject({ cancelReason: 'ติ๊กผิดคัน' });
    expect(slipUpdate.mock.calls[0][0].data).toMatchObject({ cancelReason: 'ติ๊กผิดคัน' });
    expect(logCreate.mock.calls[0][0].data.remark).toBe('ติ๊กผิดคัน');
  });

  it('ยกเลิกบางคัน: ใบยังไม่ถูกยกเลิกทั้งใบ', async () => {
    const { svc, slipUpdate } = setup([slipItem(), slipItem({ id: 'i2', vehicleId: 'v2', chassis: 'CH2' })], [delivered]);
    await svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'ติ๊กผิดคัน' });
    expect(slipUpdate).not.toHaveBeenCalled();
  });

  it('ยกเลิกใบส่งป้ายตามทีหลัง: ล้างเฉพาะวันที่ส่งป้าย', async () => {
    const { svc, vehicleUpdate } = setup(
      [slipItem({ receipt: false, book: false })],
      [{ ...delivered, deliveredDate: day('2026-09-19'), deliveryNote: 'ส่งป้าย 21/09/2026 ผู้รับ คุณนก' }],
    );
    await svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'ป้ายยังไม่ได้ส่งจริง' });
    expect(vehicleUpdate.mock.calls[0][0].data).toEqual({ plateDeliveredDate: null, deliveryNote: null });
  });

  it('วางบิลแล้ว ยกเลิกไม่ได้', async () => {
    const { svc, $transaction } = setup([slipItem({ vehicle: { invoiceLines: [{ invoice: { invoiceNo: 'IV-001' } }] } })], [delivered]);
    await expect(svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('วางบิลแล้ว') },
    });
    expect($transaction).not.toHaveBeenCalled();
  });

  it('ส่งป้ายตามไปแล้วในใบอื่น ต้องยกเลิกใบนั้นก่อน', async () => {
    const { svc } = setup([slipItem({ plate: false })], [delivered], [{ vehicleId: 'v1', slip: { slipNo: 9 } }]);
    await expect(svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('DL-00009') },
    });
  });

  it('ต้องมีเหตุผล', async () => {
    const { svc } = setup([slipItem()], [delivered]);
    await expect(svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: ' ' })).rejects.toMatchObject({ response: { error: 'ต้องใส่เหตุผล' } });
    await expect(svc.updateSlip('s1', { recipient: 'คุณเอก', date: '2026-09-21', remark: '' })).rejects.toMatchObject({
      response: { error: 'ต้องใส่เหตุผล' },
    });
  });

  it('แก้ผู้รับและวันที่: อัปเดตรถและใบ และบันทึกประวัติ', async () => {
    const { svc, vehicleUpdate, slipUpdate, logCreate } = setup([slipItem()], [delivered]);
    await svc.updateSlip('s1', { recipient: 'คุณเอก', date: '2026-09-22', remark: 'พิมพ์ชื่อผิด' });
    expect(vehicleUpdate.mock.calls[0][0].data).toEqual({
      deliveredDate: day('2026-09-22'),
      deliveryRecipient: 'คุณเอก',
      plateDeliveredDate: day('2026-09-22'),
    });
    expect(slipUpdate.mock.calls[0][0].data).toEqual({ recipient: 'คุณเอก', date: day('2026-09-22') });
    expect(JSON.parse(logCreate.mock.calls[0][0].data.changes)).toMatchObject({ deliveryRecipient: { from: 'คุณนก', to: 'คุณเอก' } });
  });

  it('วางบิลแล้ว เปลี่ยนวันที่ไม่ได้ แต่แก้ชื่อผู้รับได้', async () => {
    const billed = slipItem({ vehicle: { invoiceLines: [{ invoice: { invoiceNo: 'IV-001' } }] } });
    const a = setup([billed], [delivered]);
    await expect(a.svc.updateSlip('s1', { recipient: 'คุณนก', date: '2026-09-22', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('วางบิลแล้ว') },
    });
    const b = setup([billed], [delivered]);
    await b.svc.updateSlip('s1', { recipient: 'คุณเอก', date: '2026-09-21', remark: 'x' });
    expect(b.$transaction).toHaveBeenCalled();
  });
});
