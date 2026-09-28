import { vi } from 'vitest';
import { DeliveryService, deliveryKind, stripPlateNote } from './delivery.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

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
    documentSubmissions: [
      { status: 'RECEIPT_RECEIVED', receiptNo: '69/0035358', submitDate: new Date('2026-09-10T00:00:00.000Z'), urgent: false, createdAt: new Date('2026-09-10T03:00:00.000Z') },
    ],
    invoiceLines: [],
    deliverySlipItems: [],
    ...overrides,
  };
}

// updateMany ตอบจำนวนแถวที่ตรงเงื่อนไข - ปกติ = ทุกคันที่ขอ, ส่ง count มา = จำลองว่ามีคำขออื่นบันทึกไปก่อน
function service(found: unknown[], count?: number) {
  const updateMany = vi.fn().mockImplementation(async (args: { where: { id: string | { in: string[] } } }) => ({
    count: count ?? (typeof args.where.id === 'string' ? 1 : args.where.id.in.length),
  }));
  const create = vi.fn().mockResolvedValue({ id: 's1', slipNo: 7 });
  // งานสลับเลขใช้ตาราง PlateSwap - ไม่มีงานสลับเลขในเทสต์ชุดนี้ จึงตอบ 0 แถว/ลิสต์ว่างพอ
  const tx = { vehicle: { updateMany }, plateSwap: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) }, deliverySlip: { create } };
  const $transaction = vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
  const findMany = vi.fn().mockResolvedValue(found);
  const prisma = { vehicle: { findMany }, plateSwap: { findMany: vi.fn().mockResolvedValue([]) }, $transaction } as unknown as PrismaService;
  return { svc: new DeliveryService(prisma), updateMany, create, $transaction, findMany };
}

const dto = (ids: string[]) => ({ vehicleIds: ids, date: '2026-09-21', recipient: 'คุณนก', note: '' });
const itemsDto = (items: Array<[string, string]>) => ({
  items: items.map(([vehicleId, kind]) => ({ vehicleId, kind })),
  vehicleIds: items.map(([id]) => id),
  date: '2026-09-21',
  recipient: 'คุณนก',
  note: '',
});

describe('deliveryKind', () => {
  it('แยกชนิดงานส่งจากสถานะป้ายและการส่งงาน', () => {
    const d = new Date();
    expect(deliveryKind({ deliveredDate: null, plateReceivedDate: d, plateDeliveredDate: null })).toBe('FULL');
    expect(deliveryKind({ deliveredDate: null, plateReceivedDate: null, plateDeliveredDate: null })).toBe('NO_PLATE');
    expect(deliveryKind({ deliveredDate: d, plateReceivedDate: d, plateDeliveredDate: null })).toBe('PLATE_ONLY');
    expect(deliveryKind({ deliveredDate: d, plateReceivedDate: null, plateDeliveredDate: null })).toBe('WAITING_PLATE');
    expect(deliveryKind({ deliveredDate: d, plateReceivedDate: d, plateDeliveredDate: d })).toBe('DONE');
  });
});

describe('DeliveryService.submit', () => {
  it('ส่งครบ: ตั้งวันที่ส่งงานและวันที่ส่งป้ายพร้อมกัน แบบมีเงื่อนไข (ยังไม่เคยส่ง)', async () => {
    const { svc, updateMany, findMany } = service([vehicle()]);
    const result = await svc.submit(dto(['v1']));
    expect(findMany.mock.calls[0][0].where).toEqual({ id: { in: ['v1'] }, deletedAt: null });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['v1'] }, deletedAt: null, deliveredDate: null },
      data: { deliveredDate: new Date('2026-09-21T00:00:00.000Z'), deliveryRecipient: 'คุณนก', deliveryNote: null, plateDeliveredDate: new Date('2026-09-21T00:00:00.000Z') },
    });
    expect(result).toEqual({ slipId: 's1', slipNo: 7, delivered: 1, plateOnly: 0, platePending: 0 });
  });

  it('ป้ายยังไม่ออก: ส่งเล่มได้ และป้ายค้างส่ง', async () => {
    const { svc, updateMany } = service([vehicle({ plateReceivedDate: null })]);
    const result = await svc.submit(dto(['v1']));
    expect(updateMany.mock.calls[0][0].data.plateDeliveredDate).toBeNull();
    expect(result).toEqual({ slipId: 's1', slipNo: 7, delivered: 1, plateOnly: 0, platePending: 1 });
  });

  it('ส่งป้ายตามทีหลัง: ไม่แตะวันที่ส่งงานและผู้รับเดิม และเขียนเฉพาะคันที่ป้ายยังไม่ได้ส่ง', async () => {
    const { svc, updateMany } = service([vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z'), deliveryRecipient: 'คุณเอก' })]);
    const result = await svc.submit(dto(['v1']));
    expect(updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'v1', deletedAt: null, deliveredDate: { not: null }, plateReceivedDate: { not: null }, plateDeliveredDate: null },
      data: { plateDeliveredDate: new Date('2026-09-21T00:00:00.000Z'), deliveryNote: 'ส่งป้าย 21/09/2026 ผู้รับ คุณนก' },
    });
    expect(result).toEqual({ slipId: 's1', slipNo: 7, delivered: 0, plateOnly: 1, platePending: 0 });
  });

  it('วันที่ส่งป้ายก่อนวันส่งเล่มไม่ได้ (กติกาเดียวกับตอนแก้ใบ)', async () => {
    const { svc, $transaction } = service([vehicle({ deliveredDate: new Date('2026-09-25T00:00:00.000Z') })]);
    await expect(svc.submit(dto(['v1']))).rejects.toMatchObject({ response: { error: expect.stringContaining('ส่งเล่มเมื่อ 25/09/2026') } });
    expect($transaction).not.toHaveBeenCalled();
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
      ['v1', false, true, true],
      ['v2', false, true, false],
      ['v3', false, false, true],
    ]);
    expect(data.items.create[0]).toMatchObject({ chassis: 'CH1', brandName: 'Lexus', plateText: '8ขง 363', receiptNo: '69/0035358' });
  });

  it('ส่งงานได้ครั้งละ 1 ลูกค้า', async () => {
    const { svc, $transaction } = service([vehicle(), vehicle({ id: 'v2', customer: { id: 'c2', name: 'อีกราย', company: null } })]);
    await expect(svc.submit(dto(['v1', 'v2']))).rejects.toMatchObject({ response: { error: expect.stringContaining('1 ลูกค้า') } });
    expect($transaction).not.toHaveBeenCalled();
  });

  // ผู้ใช้ 2026-09-27: ใบรวมสองประเภท พนักงานประเภทเดียวพิมพ์ซ้ำได้ไม่ครบและแก้ใบไม่ได้ -> ห้ามรวมตั้งแต่ตอนบันทึก
  it('ส่งรถยนต์กับจักรยานยนต์ในใบเดียวไม่ได้ แม้ลูกค้าเดียวกันและผู้ใช้ส่งได้ทุกประเภท', async () => {
    const moto = vehicle({ id: 'v2', chassis: 'CH2', body: 'รย.12-รถจักรยานยนต์' });
    const { svc, $transaction } = service([vehicle(), moto]);
    await expect(asUser(['ADMIN'], () => svc.submit(dto(['v1', 'v2'])))).rejects.toMatchObject({
      status: 400,
      response: { error: 'ส่งรถยนต์กับจักรยานยนต์คนละใบ' },
    });
    await expect(asUser(['DELIVERY'], () => svc.submit(dto(['v1', 'v2'])))).rejects.toMatchObject({ status: 400 });
    expect($transaction).not.toHaveBeenCalled();
  });

  it('จักรยานยนต์หลายคันของลูกค้าเดียวกัน ส่งในใบเดียวได้ (body ว่าง = รถยนต์)', async () => {
    const motos = service([
      vehicle({ body: 'รย.12-รถจักรยานยนต์' }),
      vehicle({ id: 'v2', chassis: 'CH2', body: 'รย.12-รถจักรยานยนต์' }),
    ]);
    await expect(motos.svc.submit(dto(['v1', 'v2']))).resolves.toMatchObject({ delivered: 2 });
    const cars = service([vehicle(), vehicle({ id: 'v2', chassis: 'CH2', body: null })]);
    await expect(cars.svc.submit(dto(['v1', 'v2']))).resolves.toMatchObject({ delivered: 2 });
  });

  it('ต้องมีผู้รับงาน', async () => {
    const { svc } = service([vehicle()]);
    await expect(svc.submit({ ...dto(['v1']), recipient: ' ' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ผู้รับ') } });
  });

  // พบ 2026-09-27: หน้าที่เปิดค้างไว้บันทึกคันที่ส่งครบแล้วซ้ำ -> ได้ใบส่งป้ายซ้อนและวันที่ส่งป้ายถูกทับ
  it('คันที่ส่งเล่มและป้ายครบแล้ว บันทึกซ้ำไม่ได้ (409) แม้ส่งมาแบบเดิม', async () => {
    const done = vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z'), plateDeliveredDate: new Date('2026-09-19T00:00:00.000Z') });
    const { svc, $transaction } = service([done]);
    await expect(svc.submit(dto(['v1']))).rejects.toMatchObject({ status: 409, response: { error: expect.stringContaining('รถ CH1 ส่งครบแล้ว') } });
    expect($transaction).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: ป้ายเพิ่งแนบหลังเปิดหน้า -> ผู้ใช้ยืนยัน "เล่ม (ป้ายตามทีหลัง)" แต่ระบบบันทึกว่าส่งป้ายไปด้วย
  it('ชนิดงานไม่ตรงกับที่ผู้ใช้ยืนยัน ไม่บันทึกเลยสักคัน (409)', async () => {
    const { svc, $transaction } = service([vehicle(), vehicle({ id: 'v2', chassis: 'CH2' })]);
    await expect(svc.submit(itemsDto([['v1', 'FULL'], ['v2', 'NO_PLATE']]))).rejects.toMatchObject({
      status: 409,
      response: { error: expect.stringContaining('รถ CH2 เพิ่งรับป้ายเข้ามา') },
    });
    expect($transaction).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: หน้า Delivery โหลดรายการใหม่ให้เองและเก็บคันที่ติ๊ก/ผู้รับ/หมายเหตุไว้ - บอกให้กด F5 แล้วที่พิมพ์ไว้หาย
  it('ข้อความ 409 ให้ตรวจรายการแล้วบันทึกใหม่ ไม่บอกให้โหลดหน้าใหม่', async () => {
    const { svc } = service([vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z') })]);
    const refused = () => svc.submit(itemsDto([['v1', 'FULL']]));
    await expect(refused()).rejects.toMatchObject({ status: 409, response: { error: expect.stringContaining('กรุณาตรวจรายการแล้วบันทึกใหม่') } });
    await expect(refused()).rejects.toMatchObject({ response: { error: expect.not.stringContaining('โหลดหน้าใหม่') } });
  });

  it('ส่งเล่มจากหน้าที่ค้างไว้ แต่อีกคนส่งเล่มไปแล้ว (409)', async () => {
    const { svc } = service([vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z') })]);
    await expect(svc.submit(itemsDto([['v1', 'FULL']]))).rejects.toMatchObject({
      status: 409,
      response: { error: expect.stringContaining('รถ CH1 ส่งเล่มไปแล้ว') },
    });
  });

  it('ชนิดงานตรงกับที่ยืนยัน บันทึกตามนั้น', async () => {
    const { svc, create } = service([vehicle(), vehicle({ id: 'v2', chassis: 'CH2', plateReceivedDate: null })]);
    const result = await svc.submit(itemsDto([['v1', 'FULL'], ['v2', 'NO_PLATE']]));
    expect(result).toMatchObject({ delivered: 2, platePending: 1 });
    expect(create).toHaveBeenCalled();
  });

  it('ชนิดงานที่ติ๊กไม่ได้ (รอป้าย) ส่งมาไม่ได้', async () => {
    const { svc, findMany } = service([vehicle()]);
    await expect(svc.submit(itemsDto([['v1', 'WAITING_PLATE']]))).rejects.toMatchObject({ status: 400 });
    expect(findMany).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: 2 คนกดบันทึกคันเดียวกันพร้อมกัน -> ได้ใบส่งเล่ม 2 ใบ
  it('มีคำขออื่นบันทึกไปก่อนระหว่างตรวจกับเขียน: ย้อนทั้งชุด ไม่สร้างใบ', async () => {
    const { svc, create } = service([vehicle()], 0);
    await expect(svc.submit(itemsDto([['v1', 'FULL']]))).rejects.toMatchObject({ status: 409 });
    expect(create).not.toHaveBeenCalled();
  });

  it('ส่งป้ายซ้ำพร้อมกัน: คำขอหลังเขียนไม่ได้ ไม่สร้างใบ', async () => {
    const { svc, create } = service([vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z') })], 0);
    await expect(svc.submit(itemsDto([['v1', 'PLATE_ONLY']]))).rejects.toMatchObject({
      status: 409,
      response: { error: expect.stringContaining('บันทึกส่งป้ายไปแล้ว') },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('STAFF_MOTO + DELIVERY บันทึกส่งรถยนต์ได้ (DELIVERY ส่งได้ทุกคัน)', async () => {
    const { svc } = service([vehicle()]);
    await expect(asUser(['STAFF_MOTO', 'DELIVERY'], () => svc.submit(dto(['v1'])))).resolves.toMatchObject({ delivered: 1 });
  });

  it('STAFF_MOTO บันทึกส่งรถยนต์ไม่ได้', async () => {
    const { svc } = service([vehicle()]);
    await expect(asUser(['STAFF_MOTO'], () => svc.submit(dto(['v1'])))).rejects.toMatchObject({ status: 403 });
  });
});

describe('DeliveryService.slips (รายงานส่งงาน)', () => {
  function slipRow(n: number, items: unknown[] = [slipItemRow()]) {
    return {
      id: `s${n}`,
      slipNo: n,
      date: new Date('2026-09-21T00:00:00.000Z'),
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
  }
  function slipItemRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'i1',
      vehicleId: 'v1',
      receipt: false,
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
      vehicle: { invoiceLines: [], owner: null },
      ...overrides,
    };
  }
  function setup(slips: unknown[], later: unknown[] = []) {
    const slipFindMany = vi.fn().mockResolvedValue(slips);
    const itemFindMany = vi.fn().mockResolvedValue(later);
    const prisma = {
      deliverySlip: { findMany: slipFindMany },
      deliverySlipItem: { findMany: itemFindMany },
      plateSwap: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    return { svc: new DeliveryService(prisma), slipFindMany, itemFindMany };
  }

  it('เกิน 500 ใบ: ส่งแค่ 500 ใบ และบอก truncated', async () => {
    const { svc, slipFindMany } = setup(Array.from({ length: 501 }, (_, i) => slipRow(i + 1)));
    const result = await svc.slips({});
    expect(slipFindMany.mock.calls[0][0].take).toBe(501);
    expect(result.slips).toHaveLength(500);
    expect(result.truncated).toBe(true);
    const small = await setup([slipRow(1)]).svc.slips({});
    expect(small.truncated).toBe(false);
  });

  it('STAFF_CAR: นับเพดานเฉพาะใบที่มีรถยนต์ (กรองใน query)', async () => {
    const { svc, slipFindMany } = setup([slipRow(1)]);
    await asUser(['STAFF_CAR'], () => svc.slips({}));
    // ตั้งแต่ 2026-09-28 แถวมี vehicleKind ของตัวเอง (งานสลับเลขไม่มี body) - แถวเก่าที่ยังไม่มีค่าให้ตกไปดู body เหมือนเดิม
    expect(slipFindMany.mock.calls[0][0].where.items).toEqual({
      some: {
        OR: [{ vehicleKind: 'car' }, { vehicleKind: null, AND: [{ OR: [{ body: null }, { NOT: { body: { startsWith: 'รย.12-' } } }] }] }],
      },
    });
    const all = setup([slipRow(1)]);
    await asUser(['DELIVERY'], () => all.svc.slips({}));
    expect(all.slipFindMany.mock.calls[0][0].where.items).toBeUndefined();
  });

  // ผู้ใช้ 2026-09-27: ใบส่งเล่มที่ช่องป้ายว่าง บอกว่าป้ายส่งตามไปในใบไหน
  it('ใบส่งเล่มที่ป้ายส่งตามไปในใบอื่น: บอกเลขที่และวันที่ของใบส่งป้าย', async () => {
    const { svc, itemFindMany } = setup(
      [slipRow(10, [slipItemRow({ plate: false }), slipItemRow({ id: 'i2', vehicleId: 'v2', chassis: 'CH2', plate: false })])],
      [{ vehicleId: 'v1', plateSwapId: null, slip: { slipNo: 18, date: new Date('2026-09-25T00:00:00.000Z') } }],
    );
    const result = await svc.slips({});
    // ค้นทั้งแถวรถจดใหม่และแถวงานสลับเลข (ผู้ใช้ 2026-09-28) - ชุดนี้ไม่มีงานสลับเลข จึงเหลือเงื่อนไขเดียว
    expect(itemFindMany.mock.calls[0][0].where).toEqual({
      OR: [{ vehicleId: { in: ['v1', 'v2'] } }],
      book: false,
      plate: true,
      cancelledAt: null,
    });
    const byId = Object.fromEntries(result.slips[0].items.map((i) => [i.vehicleId, i.plateSentLater]));
    expect(byId).toEqual({ v1: { slipNo: 18, date: '2026-09-25' }, v2: null });
  });

  // ใบเก่าที่รวมรถยนต์ + จักรยานยนต์ (ก่อนห้ามรวม ผู้ใช้ 2026-09-27): บอกว่ามีคันที่ผู้ใช้นี้ไม่เห็นกี่คัน
  describe('ใบเก่าที่รวมสองประเภท', () => {
    const mixed = () =>
      slipRow(40, [
        slipItemRow(),
        slipItemRow({ id: 'i2', vehicleId: 'v2', chassis: 'CH2', body: 'รย.12-รถจักรยานยนต์' }),
        slipItemRow({ id: 'i3', vehicleId: 'v3', chassis: 'CH3', body: 'รย.12-รถจักรยานยนต์' }),
        // ยกเลิกแล้ว = ไม่นับเป็นคันที่ซ่อน (ไม่อยู่ในใบเต็มแล้ว)
        slipItemRow({ id: 'i4', vehicleId: 'v4', chassis: 'CH4', body: 'รย.12-รถจักรยานยนต์', cancelledAt: new Date() }),
      ]);

    it('STAFF_CAR เห็นเฉพาะรถยนต์ และ hiddenItems = จักรยานยนต์ที่ยังไม่ยกเลิก', async () => {
      const { svc } = setup([mixed()]);
      const result = await asUser(['STAFF_CAR'], () => svc.slips({}));
      expect(result.slips[0].items.map((i) => i.vehicleId)).toEqual(['v1']);
      expect(result.slips[0].hiddenItems).toBe(2);
    });

    it('ADMIN / ACCOUNTANT / DELIVERY / STAFF_CAR + STAFF_MOTO เห็นครบทุกคัน (hiddenItems = 0)', async () => {
      for (const roles of [['ADMIN'], ['ACCOUNTANT'], ['DELIVERY'], ['STAFF_CAR', 'STAFF_MOTO']] as UserRole[][]) {
        const { svc } = setup([mixed()]);
        const result = await asUser(roles, () => svc.slips({}));
        expect(result.slips[0].items).toHaveLength(4);
        expect(result.slips[0].hiddenItems).toBe(0);
      }
    });
  });
});

describe('DeliveryService.queue', () => {
  it('ไม่แสดงรถที่ถูกลบ และบอกใบที่ส่งเล่มไปของคันที่ป้ายค้างส่ง', async () => {
    const findMany = vi.fn().mockResolvedValue([
      vehicle({
        deliveredDate: new Date('2026-09-19T00:00:00.000Z'),
        deliverySlipItems: [{ slip: { id: 's5', slipNo: 5, date: new Date('2026-09-19T00:00:00.000Z') } }],
      }),
    ]);
    const svc = new DeliveryService({ vehicle: { findMany }, plateSwap: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService);
    const rows = await svc.queue();
    expect(findMany.mock.calls[0][0].where.deletedAt).toBeNull();
    expect(rows[0]).toMatchObject({ kind: 'PLATE_ONLY', bookSlip: { id: 's5', slipNo: 5, date: '2026-09-19' } });
  });

  // F47 (ผู้ใช้ 2026-09-27): ใบยื่นแบ่งด้วย customerId - แถวต้องมีชื่อ/บริษัท/สาขา ให้หน้าเว็บแยกลูกค้าชื่อซ้ำกันตอนแสดง
  it('แถวมี customer { id, name, company, branch } และยังส่ง customerName แบบเดิม', async () => {
    const findMany = vi.fn().mockResolvedValue([
      vehicle({ customer: { id: 'c9', name: 'คุณเอ', company: 'บจก. เอ', branch: 'สาขาบางนา' } }),
      vehicle({ id: 'v2', customer: { id: 'c1', name: 'ลูกค้า', company: null } }),
    ]);
    const svc = new DeliveryService({ vehicle: { findMany }, plateSwap: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService);
    const rows = await svc.queue();
    expect(findMany.mock.calls[0][0].include.customer.select).toMatchObject({ id: true, name: true, company: true, branch: true });
    expect(rows[0]).toMatchObject({
      customerId: 'c9',
      customerName: 'บจก. เอ',
      customer: { id: 'c9', name: 'คุณเอ', company: 'บจก. เอ', branch: 'สาขาบางนา' },
    });
    expect(rows[1].customer).toEqual({ id: 'c1', name: 'ลูกค้า', company: null, branch: null });
  });
});

// พบ 2026-09-27: รายงานส่งงานใช้คิวหน้า Delivery (ขอบเขตการส่ง) เป็นรายการป้ายค้างส่ง แต่ใบส่งงานใช้ขอบเขตการอ่าน
// STAFF_CAR + ACCOUNTANT จึงเห็นใบส่งงานจักรยานยนต์ แต่จักรยานยนต์หายจากป้ายค้างส่ง
describe('DeliveryService.platePending (ป้ายค้างส่งในรายงาน)', () => {
  const CAR_ONLY = { AND: [{ OR: [{ body: null }, { NOT: { body: { startsWith: 'รย.12-' } } }] }] };
  const setup = () => {
    const findMany = vi.fn().mockResolvedValue([
      vehicle({ deliveredDate: new Date('2026-09-19T00:00:00.000Z'), plateReceivedDate: null }),
    ]);
    return { svc: new DeliveryService({ vehicle: { findMany }, plateSwap: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService), findMany };
  };

  it('เฉพาะคันที่ส่งเล่มแล้วแต่ป้ายยังไม่ได้ส่ง และไม่แสดงรถที่ถูกลบ', async () => {
    const { svc, findMany } = setup();
    const rows = await svc.platePending();
    expect(findMany.mock.calls[0][0].where).toEqual({ deliveredDate: { not: null }, plateDeliveredDate: null, deletedAt: null });
    expect(rows[0]).toMatchObject({ id: 'v1', kind: 'WAITING_PLATE', deliveredDate: '2026-09-19' });
  });

  it('STAFF_CAR + ACCOUNTANT: ป้ายค้างส่งเห็นทุกประเภทรถเหมือนใบส่งงาน แต่คิวที่ติ๊กส่งได้ยังเป็นรถยนต์อย่างเดียว', async () => {
    const report = setup();
    await asUser(['STAFF_CAR', 'ACCOUNTANT'], () => report.svc.platePending());
    expect(report.findMany.mock.calls[0][0].where.AND).toBeUndefined();
    const slips = vi.fn().mockResolvedValue([]);
    const slipSvc = new DeliveryService({ deliverySlip: { findMany: slips } } as unknown as PrismaService);
    await asUser(['STAFF_CAR', 'ACCOUNTANT'], () => slipSvc.slips({}));
    expect(slips.mock.calls[0][0].where.items).toBeUndefined();
    const queue = setup();
    await asUser(['STAFF_CAR', 'ACCOUNTANT'], () => queue.svc.queue());
    expect(queue.findMany.mock.calls[0][0].where.AND).toEqual(CAR_ONLY.AND);
  });

  it('STAFF_CAR อย่างเดียว: เฉพาะรถยนต์', async () => {
    const { svc, findMany } = setup();
    await asUser(['STAFF_CAR'], () => svc.platePending());
    expect(findMany.mock.calls[0][0].where).toMatchObject(CAR_ONLY);
  });

  // งานสลับเลขก็ส่งเล่มก่อนแล้วส่งป้ายตามทีหลังได้ (ผู้ใช้ 2026-09-28) - ต้องอยู่ในรายการป้ายค้างส่งเดียวกัน
  it('รวมงานสลับเลขที่ส่งเล่มแล้วแต่ป้ายยังค้าง และคิดขอบเขตจาก vehicleClass', async () => {
    const swapFindMany = vi.fn().mockResolvedValue([
      {
        id: 'ps1',
        customerId: 'c1',
        vehicleClass: 'MOTO',
        oldChassis: 'SWAPCHASSIS1',
        oldBrand: 'Honda',
        oldOwnerName: 'สมชาย',
        newPlateCategory: '9กก',
        newPlateNumber: '1234',
        receiptNo: '69/1',
        submitDate: new Date('2026-09-20T00:00:00.000Z'),
        returnedDate: new Date('2026-09-22T00:00:00.000Z'),
        bookReceivedDate: new Date('2026-09-23T00:00:00.000Z'),
        plateReceivedDate: null,
        deliveredDate: new Date('2026-09-24T00:00:00.000Z'),
        plateDeliveredDate: null,
        deliveryNote: null,
        deliveryRecipient: 'คุณนก',
        customer: { id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก', branch: null },
        deliverySlipItems: [{ slip: { id: 's9', slipNo: 9, date: new Date('2026-09-24T00:00:00.000Z') } }],
      },
    ]);
    const svc = new DeliveryService({
      vehicle: { findMany: vi.fn().mockResolvedValue([]) },
      plateSwap: { findMany: swapFindMany },
    } as unknown as PrismaService);
    const rows = await svc.platePending();
    expect(swapFindMany.mock.calls[0][0].where).toEqual({ cancelledAt: null, deliveredDate: { not: null }, plateDeliveredDate: null });
    // ปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ต้องรู้ว่าเล่มไปในใบไหน และหน้าเว็บต้องเห็นว่าเป็นจักรยานยนต์
    expect(rows[0]).toMatchObject({
      id: 'ps1',
      source: 'PLATE_SWAP',
      kind: 'WAITING_PLATE',
      vehicleKind: 'moto',
      deliveredDate: '2026-09-24',
      bookSlip: { id: 's9', slipNo: 9, date: '2026-09-24' },
    });
  });

  it('STAFF_MOTO: งานสลับเลขในรายการป้ายค้างส่งกรองด้วย vehicleClass', async () => {
    const swapFindMany = vi.fn().mockResolvedValue([]);
    const svc = new DeliveryService({
      vehicle: { findMany: vi.fn().mockResolvedValue([]) },
      plateSwap: { findMany: swapFindMany },
    } as unknown as PrismaService);
    await asUser(['STAFF_MOTO'], () => svc.platePending());
    expect(swapFindMany.mock.calls[0][0].where).toMatchObject({ vehicleClass: 'MOTO' });
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
  function setup(items: unknown[], vehicles: unknown[], laterPlate: unknown[] = [], vehicleCount = 1) {
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
    // updateMany ตอบ count ตาม vehicleCount - 0 = จำลองว่าบัญชีเพิ่งออกบิลให้รถคันนี้ระหว่างนั้น
    const vehicleUpdate = vi.fn().mockResolvedValue({ count: vehicleCount });
    const itemUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const slipUpdate = vi.fn().mockResolvedValue({});
    const logCreate = vi.fn().mockResolvedValue({});
    const tx = {
      vehicle: { update: vehicleUpdate, updateMany: vehicleUpdate },
      // งานสลับเลขเขียนที่ตาราง PlateSwap และเก็บประวัติลง AuditLog (VehicleEditLog บังคับผูกกับ Vehicle)
      plateSwap: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      deliverySlipItem: { updateMany: itemUpdate },
      deliverySlip: { update: slipUpdate },
      vehicleEditLog: { create: logCreate },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const $transaction = vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const prisma = {
      deliverySlip: { findUnique: vi.fn().mockResolvedValue(slip) },
      deliverySlipItem: { findMany: vi.fn().mockResolvedValue(laterPlate) },
      vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) },
      plateSwap: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null) },
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

  // ใบเก่าที่รวมรถยนต์ + จักรยานยนต์ (ก่อนแยกใบ ผู้ใช้ 2026-09-27): ยกเลิกตรวจขอบเขตการแก้เฉพาะคันที่เลือก
  // หน้ารายงานจึงให้ STAFF_CAR (+ ACCOUNTANT/DELIVERY ที่เห็นทุกคัน) ยกเลิกคันรถยนต์ของตัวเองได้ - ใบยังไม่ยกเลิกทั้งใบ
  // เพราะจักรยานยนต์ยังอยู่ (หน้ารายงานถือว่าใบนั้นยกเลิกครบสำหรับบัญชีที่ไม่เห็นคันที่เหลือ)
  describe('ใบเก่าที่รวมสองประเภท', () => {
    const moto = () => slipItem({ id: 'i2', vehicleId: 'v2', chassis: 'CH2', body: 'รย.12-รถจักรยานยนต์' });

    it('STAFF_CAR + ACCOUNTANT ยกเลิกคันรถยนต์ได้ ใบยังไม่ยกเลิกทั้งใบ', async () => {
      const { svc, itemUpdate, slipUpdate } = setup([slipItem(), moto()], [delivered]);
      await asUser(['STAFF_CAR', 'ACCOUNTANT'], () => svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'ติ๊กผิดคัน' }));
      expect(itemUpdate).toHaveBeenCalledTimes(1);
      expect(slipUpdate).not.toHaveBeenCalled();
    });

    it('STAFF_CAR ยกเลิกรถยนต์ครบทุกคันที่เห็น: ใบยังไม่ยกเลิกทั้งใบ (จักรยานยนต์ยังไม่ได้ยกเลิก)', async () => {
      const { svc, slipUpdate } = setup([slipItem(), moto()], [delivered]);
      await asUser(['STAFF_CAR'], () => svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'ติ๊กผิดคัน' }));
      expect(slipUpdate).not.toHaveBeenCalled();
    });

    it('คันอีกประเภทยกเลิกไม่ได้ (403) แม้เห็นทุกคัน', async () => {
      for (const roles of [['STAFF_CAR', 'ACCOUNTANT'], ['STAFF_CAR', 'DELIVERY']] as UserRole[][]) {
        const { svc, $transaction } = setup([slipItem(), moto()], [delivered]);
        await expect(asUser(roles, () => svc.cancelSlip('s1', { vehicleIds: ['v2'], remark: 'x' }))).rejects.toMatchObject({ status: 403 });
        expect($transaction).not.toHaveBeenCalled();
      }
    });
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

// ผู้ใช้ 2026-09-27: บิลเก็บเฉพาะวันส่งเล่ม - ใบส่งป้ายตามทีหลังของรถที่วางบิลแล้วแก้/ยกเลิกได้
  it('รถวางบิลแล้ว: ใบส่งป้ายตามทีหลังยังแก้วันที่และยกเลิกได้', async () => {
    const billedPlate = slipItem({ receipt: false, book: false, vehicle: { invoiceLines: [{ invoice: { invoiceNo: 'IV-001' } }] } });
    const plateDelivered = { ...delivered, deliveredDate: day('2026-09-19'), deliveryNote: 'ส่งป้าย 21/09/2026 ผู้รับ คุณนก' };
    const a = setup([billedPlate], [plateDelivered]);
    await a.svc.updateSlip('s1', { recipient: 'คุณนก', date: '2026-09-22', remark: 'วันที่ผิด' });
    expect(a.vehicleUpdate.mock.calls[0][0]).toMatchObject({ where: { id: 'v1' }, data: { plateDeliveredDate: day('2026-09-22') } });
    const b = setup([billedPlate], [plateDelivered]);
    await b.svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'ป้ายยังไม่ได้ส่งจริง' });
    expect(b.vehicleUpdate.mock.calls[0][0].data).toEqual({ plateDeliveredDate: null, deliveryNote: null });
  });

  // พบ 2026-09-27: บัญชีออกบิลให้รถคันนี้ระหว่างที่กำลังยกเลิก/แก้วันที่ใบส่งเล่ม - ต้องไม่ผ่าน
  it('บิลออกระหว่างยกเลิกหรือแก้วันที่ใบส่งเล่ม: ปฏิเสธ (409) ทั้งรายการ', async () => {
    const a = setup([slipItem()], [delivered], [], 0);
    await expect(a.svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'x' })).rejects.toMatchObject({
      status: 409,
      response: { error: expect.stringContaining('เพิ่งวางบิล') },
    });
    expect(a.vehicleUpdate.mock.calls[0][0].where).toEqual({ id: 'v1', invoiceLines: { none: { invoice: { status: { not: 'VOID' } } } }, billingClosedAt: null });
    expect(a.itemUpdate).not.toHaveBeenCalled();
    const b = setup([slipItem()], [delivered], [], 0);
    await expect(b.svc.updateSlip('s1', { recipient: 'คุณนก', date: '2026-09-22', remark: 'x' })).rejects.toMatchObject({ status: 409 });
    expect(b.slipUpdate).not.toHaveBeenCalled();
  });

  // 2026-09-27: รถที่ปิดงาน - วางบิลนอกระบบ ไม่กลับเข้าคิววางบิลอีก - ห้ามยกเลิก/เปลี่ยนวันที่ใบส่งเล่มจนกว่า ADMIN เปิดงานกลับ
  it('ปิดงาน - วางบิลนอกระบบแล้ว: ใบส่งเล่มยกเลิกหรือเปลี่ยนวันที่ไม่ได้ แต่แก้ชื่อผู้รับได้', async () => {
    const closed = slipItem({ vehicle: { invoiceLines: [], billingClosedAt: day('2026-09-25') } });
    const a = setup([closed], [delivered]);
    await expect(a.svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ปิดงาน - วางบิลนอกระบบแล้ว') },
    });
    await expect(a.svc.updateSlip('s1', { recipient: 'คุณนก', date: '2026-09-22', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('เปิดงานกลับก่อน') },
    });
    expect(a.$transaction).not.toHaveBeenCalled();
    const b = setup([closed], [delivered]);
    await b.svc.updateSlip('s1', { recipient: 'คุณเอก', date: '2026-09-21', remark: 'x' });
    expect(b.$transaction).toHaveBeenCalled();
  });

  it('รายการถูกยกเลิกไปแล้วจากอีกเครื่อง: ไม่ยกเลิกซ้ำ', async () => {
    const { svc, itemUpdate } = setup([slipItem()], [delivered]);
    itemUpdate.mockResolvedValueOnce({ count: 0 });
    await expect(svc.cancelSlip('s1', { vehicleIds: ['v1'], remark: 'x' })).rejects.toMatchObject({ status: 409 });
  });

  // พบ 2026-09-27: แก้ใบส่งป้ายแล้วหมายเหตุ "ส่งป้าย ... ผู้รับ ..." ในหน้า Delivery ยังเป็นของเดิม
  it('แก้ใบส่งป้ายตามทีหลัง: เขียนหมายเหตุการส่งป้ายใหม่ตามวันที่/ผู้รับที่แก้', async () => {
    const { svc, vehicleUpdate } = setup(
      [slipItem({ receipt: false, book: false })],
      [{ ...delivered, deliveredDate: day('2026-09-19'), deliveryNote: 'ฝากไว้ที่ รปภ. · ส่งป้าย 21/09/2026 ผู้รับ คุณนก' }],
    );
    await svc.updateSlip('s1', { recipient: 'คุณเอก', date: '2026-09-22', remark: 'พิมพ์ผิด' });
    expect(vehicleUpdate.mock.calls[0][0].data).toEqual({
      plateDeliveredDate: day('2026-09-22'),
      deliveryNote: 'ฝากไว้ที่ รปภ. · ส่งป้าย 22/09/2026 ผู้รับ คุณเอก',
    });
  });
});

// ผู้ใช้ 2026-09-27: ใบส่งเล่มที่บันทึกว่าป้ายตามทีหลัง แต่ป้ายไปพร้อมเล่มจริง (แนบรูปป้ายช้า)
describe('DeliveryService.addPlate (ป้ายไปพร้อมเล่มแล้ว)', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const bookItem = (overrides: Record<string, unknown> = {}) => ({
    id: 'i1',
    vehicleId: 'v1',
    receipt: false,
    book: true,
    plate: false,
    chassis: 'CH1',
    brandName: 'Lexus',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateText: '8ขง 363',
    receiptNo: null,
    cancelledAt: null,
    cancelReason: null,
    cancelledBy: null,
    vehicle: { invoiceLines: [], owner: null },
    ...overrides,
  });
  const waiting = { id: 'v1', deliveredDate: day('2026-09-21'), plateReceivedDate: day('2026-09-24'), plateDeliveredDate: null };
  function setup(item: unknown, v: unknown, slipOverrides: Record<string, unknown> = {}) {
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
      items: [item],
      ...slipOverrides,
    };
    const itemUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const vehicleUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
    const logCreate = vi.fn().mockResolvedValue({});
    const tx = { deliverySlipItem: { updateMany: itemUpdateMany }, vehicle: { updateMany: vehicleUpdateMany }, vehicleEditLog: { create: logCreate } };
    const $transaction = vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx));
    const prisma = {
      deliverySlip: { findUnique: vi.fn().mockResolvedValue(slip) },
      deliverySlipItem: { findMany: vi.fn().mockResolvedValue([]) },
      vehicle: { findFirst: vi.fn().mockResolvedValue(v) },
      $transaction,
    } as unknown as PrismaService;
    return { svc: new DeliveryService(prisma), itemUpdateMany, vehicleUpdateMany, logCreate, $transaction };
  }

  it('ติ๊กป้ายในใบเดิม วันที่ส่งป้าย = วันที่ในใบ และบันทึกประวัติ (เหตุผลเริ่มต้น)', async () => {
    const { svc, itemUpdateMany, vehicleUpdateMany, logCreate } = setup(bookItem(), waiting);
    await svc.addPlate('s1', { vehicleId: 'v1' });
    expect(itemUpdateMany).toHaveBeenCalledWith({ where: { id: 'i1', cancelledAt: null, book: true, plate: false }, data: { plate: true } });
    // รับป้าย 24/09 หลังวันส่งเล่ม 21/09 (แนบรูปช้า) -> ปรับวันที่รับป้ายเป็นวันส่งเล่มด้วย
    expect(vehicleUpdateMany).toHaveBeenCalledWith({
      where: { id: 'v1', deletedAt: null, deliveredDate: day('2026-09-21'), plateReceivedDate: day('2026-09-24'), plateDeliveredDate: null },
      data: { plateDeliveredDate: day('2026-09-21'), plateReceivedDate: day('2026-09-21') },
    });
    expect(logCreate.mock.calls[0][0].data.remark).toBe('ป้ายไปพร้อมเล่มในใบ DL-00007');
    expect(JSON.parse(logCreate.mock.calls[0][0].data.changes)).toMatchObject({
      plateDeliveredDate: { from: null, to: '2026-09-21' },
      plateReceivedDate: { from: '2026-09-24', to: '2026-09-21' },
    });
  });

  it('รับป้ายก่อนวันส่งเล่มอยู่แล้ว: ไม่แตะวันที่รับป้าย', async () => {
    const { svc, vehicleUpdateMany, logCreate } = setup(bookItem(), { ...waiting, plateReceivedDate: day('2026-09-20') });
    await svc.addPlate('s1', { vehicleId: 'v1' });
    expect(vehicleUpdateMany.mock.calls[0][0].data).toEqual({ plateDeliveredDate: day('2026-09-21') });
    expect(JSON.parse(logCreate.mock.calls[0][0].data.changes).plateReceivedDate).toBeUndefined();
  });

  it('ใส่หมายเหตุได้ และทำกับคันที่วางบิลแล้วได้', async () => {
    const billed = bookItem({ vehicle: { invoiceLines: [{ invoice: { invoiceNo: 'IV-001' } }], owner: null } });
    const { svc, logCreate } = setup(billed, waiting);
    await svc.addPlate('s1', { vehicleId: 'v1', remark: 'แนบรูปป้ายช้า' });
    expect(logCreate.mock.calls[0][0].data.remark).toBe('ป้ายไปพร้อมเล่มในใบ DL-00007: แนบรูปป้ายช้า');
  });

  it.each([
    ['ยังไม่ได้รับป้าย', bookItem(), { ...waiting, plateReceivedDate: null }, {}, 'ยังไม่ได้รับป้าย'],
    ['ส่งป้ายไปแล้ว', bookItem(), { ...waiting, plateDeliveredDate: day('2026-09-25') }, {}, 'บันทึกส่งป้ายไปแล้ว'],
    ['รายการถูกยกเลิก', bookItem({ cancelledAt: new Date() }), waiting, {}, 'ถูกยกเลิกจากใบ'],
    ['ใบถูกยกเลิก', bookItem(), waiting, { cancelledAt: new Date() }, 'ใบส่งงานนี้ถูกยกเลิกไปแล้ว'],
    ['เป็นใบส่งป้ายอยู่แล้ว', bookItem({ book: false, plate: true }), waiting, {}, 'เป็นใบส่งป้าย'],
    ['ใบนี้ส่งป้ายไปแล้ว', bookItem({ plate: true }), waiting, {}, 'ส่งป้ายของรถ CH1 ไปแล้ว'],
  ])('ไม่ได้: %s', async (_label, item, v, slipOverrides, message) => {
    const { svc, $transaction } = setup(item, v, slipOverrides);
    await expect(svc.addPlate('s1', { vehicleId: 'v1' })).rejects.toMatchObject({ response: { error: expect.stringContaining(message) } });
    expect($transaction).not.toHaveBeenCalled();
  });

  it('ข้อมูลเปลี่ยนระหว่างตรวจกับเขียน: ย้อนทั้งหมด (409)', async () => {
    const { svc, vehicleUpdateMany, logCreate } = setup(bookItem(), waiting);
    vehicleUpdateMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.addPlate('s1', { vehicleId: 'v1' })).rejects.toMatchObject({ status: 409 });
    expect(logCreate).not.toHaveBeenCalled();
  });

  it('STAFF_MOTO ทำกับรถยนต์ไม่ได้ แม้ถือ DELIVERY ด้วย', async () => {
    const { svc, $transaction } = setup(bookItem(), waiting);
    await expect(asUser(['STAFF_MOTO', 'DELIVERY'], () => svc.addPlate('s1', { vehicleId: 'v1' }))).rejects.toMatchObject({ status: 403 });
    expect($transaction).not.toHaveBeenCalled();
  });
});


// งานสลับเลขส่งคืนลูกค้าในใบเดียวกับรถจดใหม่ได้ (ผู้ใช้ 2026-09-28: "สลับเลขลืม Delivery")
describe('DeliveryService - งานสลับเลข', () => {
  const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const swapRow = (o: Record<string, unknown> = {}) => ({
    id: 'ps1',
    customerId: 'c1',
    vehicleClass: 'CAR',
    oldChassis: 'SWAPCHASSIS1',
    oldBrand: 'Toyota',
    oldOwnerName: 'สมชาย',
    newPlateCategory: '9กก',
    newPlateNumber: '1234',
    receiptNo: '69/1',
    submitDate: day('2026-09-20'),
    returnedDate: day('2026-09-22'),
    bookReceivedDate: day('2026-09-23'),
    plateReceivedDate: day('2026-09-23'),
    deliveredDate: null,
    plateDeliveredDate: null,
    deliveryNote: null,
    deliveryRecipient: null,
    customer: { id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก', branch: null },
    deliverySlipItems: [],
    ...o,
  });

  function setup(vehicles: unknown[], swaps: unknown[]) {
    const vehicleUpdateMany = vi.fn().mockImplementation(async (a: { where: { id: string | { in: string[] } } }) => ({
      count: typeof a.where.id === 'string' ? 1 : a.where.id.in.length,
    }));
    const swapUpdateMany = vi.fn().mockImplementation(async (a: { where: { id: string | { in: string[] } } }) => ({
      count: typeof a.where.id === 'string' ? 1 : a.where.id.in.length,
    }));
    const create = vi.fn().mockResolvedValue({ id: 's1', slipNo: 9 });
    const tx = { vehicle: { updateMany: vehicleUpdateMany }, plateSwap: { updateMany: swapUpdateMany }, deliverySlip: { create } };
    const prisma = {
      vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) },
      plateSwap: { findMany: vi.fn().mockResolvedValue(swaps) },
      $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
    } as unknown as PrismaService;
    return { svc: new DeliveryService(prisma), vehicleUpdateMany, swapUpdateMany, create };
  }

  const submitSwap = (extra: Record<string, unknown> = {}) => ({
    items: [{ source: 'PLATE_SWAP', id: 'ps1', kind: 'FULL' }],
    date: '2026-09-24',
    recipient: 'คุณนก',
    note: '',
    ...extra,
  });

  it('ส่งงานสลับเลข: เขียนที่ตาราง PlateSwap และใบส่งงานผูกด้วย plateSwapId', async () => {
    const { svc, swapUpdateMany, vehicleUpdateMany, create } = setup([], [swapRow()]);
    const res = await asUser(['STAFF_CAR'], () => svc.submit(submitSwap()));
    expect(swapUpdateMany.mock.calls[0][0].data).toMatchObject({ deliveredDate: day('2026-09-24'), deliveryRecipient: 'คุณนก' });
    expect(vehicleUpdateMany).not.toHaveBeenCalled();
    const item = create.mock.calls[0][0].data.items.create[0];
    expect(item).toMatchObject({
      vehicleId: null,
      plateSwapId: 'ps1',
      book: true,
      plate: true,
      receipt: false,
      chassis: 'SWAPCHASSIS1',
      // ทะเบียนบนใบ = เลขใหม่ที่รถเก่าได้รับ และชื่อเจ้าของเก็บ snapshot ไว้ (ไม่มี VehicleOwner ให้อ่านสด)
      plateText: '9กก 1234',
      ownerName: 'สมชาย',
      vehicleKind: 'car',
    });
    expect(res.delivered).toBe(1);
  });

  it('ยังไม่ได้ใบเสร็จ (returnedDate ว่าง) = ส่งไม่ได้', async () => {
    const { svc } = setup([], [swapRow({ returnedDate: null })]);
    await expect(asUser(['STAFF_CAR'], () => svc.submit(submitSwap()))).rejects.toMatchObject({ status: 400 });
  });

  it('ยังไม่รับเล่ม = ส่งไม่ได้', async () => {
    const { svc } = setup([], [swapRow({ bookReceivedDate: null })]);
    await expect(asUser(['STAFF_CAR'], () => svc.submit(submitSwap()))).rejects.toMatchObject({ status: 400 });
  });

  it('ยังไม่รับป้าย = ส่งเล่มก่อนได้ (ป้ายตามทีหลัง)', async () => {
    const { svc, create } = setup([], [swapRow({ plateReceivedDate: null })]);
    const res = await asUser(['STAFF_CAR'], () =>
      svc.submit(submitSwap({ items: [{ source: 'PLATE_SWAP', id: 'ps1', kind: 'NO_PLATE' }] })),
    );
    expect(create.mock.calls[0][0].data.items.create[0]).toMatchObject({ book: true, plate: false });
    expect(res.platePending).toBe(1);
  });

  it('STAFF_MOTO ส่งงานสลับเลขรถยนต์ไม่ได้', async () => {
    const { svc } = setup([], [swapRow()]);
    await expect(asUser(['STAFF_MOTO'], () => svc.submit(submitSwap()))).rejects.toMatchObject({ status: 403 });
  });

  it('งานสลับเลขมอเตอร์ไซค์บันทึก vehicleKind = moto (ขอบเขตสิทธิ์ใช้ค่านี้ ไม่ใช่ body)', async () => {
    const { svc, create } = setup([], [swapRow({ vehicleClass: 'MOTO' })]);
    await asUser(['STAFF_MOTO'], () => svc.submit(submitSwap()));
    expect(create.mock.calls[0][0].data.items.create[0].vehicleKind).toBe('moto');
  });

  it('รถยนต์จดใหม่กับงานสลับเลขรถยนต์อยู่ใบเดียวกันได้ (ลูกค้าเดียวกัน)', async () => {
    const v = {
      id: 'v1',
      chassis: 'CH1',
      body: 'รย.1-เก๋ง 2 ตอน',
      plateCategory: '8ขง',
      plateNumber: '363',
      plateReceivedDate: day('2026-09-23'),
      deliveredDate: null,
      plateDeliveredDate: null,
      deliveryRecipient: null,
      deliveryNote: null,
      bookReceivedDate: day('2026-09-23'),
      customer: { id: 'c1', name: 'ลูกค้า ก', company: 'บริษัท ก', branch: null },
      brand: { name: 'Toyota' },
      documentSubmissions: [{ status: 'RECEIPT_RECEIVED', receiptNo: '69/2', submitDate: day('2026-09-20'), urgent: false, createdAt: day('2026-09-20') }],
      invoiceLines: [],
      deliverySlipItems: [],
    };
    const { svc, create, vehicleUpdateMany, swapUpdateMany } = setup([v], [swapRow()]);
    await asUser(['STAFF_CAR'], () =>
      svc.submit(
        submitSwap({
          items: [
            { source: 'VEHICLE', id: 'v1', kind: 'FULL' },
            { source: 'PLATE_SWAP', id: 'ps1', kind: 'FULL' },
          ],
        }),
      ),
    );
    expect(vehicleUpdateMany).toHaveBeenCalled();
    expect(swapUpdateMany).toHaveBeenCalled();
    expect(create.mock.calls[0][0].data.items.create).toHaveLength(2);
  });

  it('คนละลูกค้าอยู่ใบเดียวกันไม่ได้ แม้คนละที่มา', async () => {
    const { svc } = setup([], [swapRow({ customerId: 'c2', customer: { id: 'c2', name: 'ลูกค้า ข', company: null, branch: null } })]);
    const other = swapRow({ id: 'ps2', oldChassis: 'SWAPCHASSIS2' });
    const two = setup([], [swapRow({ customerId: 'c2', customer: { id: 'c2', name: 'ลูกค้า ข', company: null, branch: null } }), other]);
    await expect(
      asUser(['STAFF_CAR'], () =>
        two.svc.submit(
          submitSwap({
            items: [
              { source: 'PLATE_SWAP', id: 'ps1', kind: 'FULL' },
              { source: 'PLATE_SWAP', id: 'ps2', kind: 'FULL' },
            ],
          }),
        ),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(svc).toBeTruthy();
  });
});
