import { vi } from 'vitest';
import { BillingService, flipOtherProvince, isInvoiceNoConflict } from './billing.service.js';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';

// คำขอของผู้ใช้ u1 (ADMIN) - ประวัติ (AuditLog / VehicleEditLog) เก็บผู้ทำจาก request context
const asUser = <T>(fn: () => T) => requestContext.run({ user: { id: 'u1', roles: ['ADMIN'], customerId: null, name: 'แอดมิน' } }, fn);

const customer = {
  id: 'c1',
  name: 'Lexus',
  company: 'บริษัท เลกซัส ออโต้ ซิตี้ จำกัด',
  branch: 'สาขา 00001',
  address: 'ที่อยู่',
  taxId: '0105547142882',
  billingVat: true,
  billingWhtRate: 3,
  billingWhtSpecialRate: 1,
  billingWhtSpecialUntil: new Date('2026-12-31T00:00:00.000Z'),
};

function vehicle(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    customerId: 'c1',
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: 'กก',
    plateNumber: '7733',
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    brand: { name: 'Lexus' },
    documentSubmissions: [{ receiptNo: '69/0035371' }],
    invoiceLines: [],
    ...overrides,
  };
}

function service(vehicles: unknown[], existingInvoice: unknown = null, swaps: unknown[] = []) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({
    id: 'i1',
    status: 'ISSUED',
    paidDate: null,
    taxInvoiceNo: null,
    voidReason: null,
    ...data,
    lines: data.lines.createMany.data.map((l: object, n: number) => ({ id: `l${n}`, ...l })),
    items: data.items ? data.items.createMany.data.map((it: object, n: number) => ({ id: `it${n}`, ...it })) : [],
  }));
  const queryRaw = vi.fn().mockResolvedValue([]);
  const findVehicles = vi.fn().mockResolvedValue(vehicles);
  const findSwaps = vi.fn().mockResolvedValue(swaps);
  const prisma = {
    customer: { findUnique: vi.fn().mockResolvedValue(customer) },
    invoice: { findUnique: vi.fn().mockResolvedValue(existingInvoice), create },
    vehicle: { findMany: findVehicles },
    plateSwap: { findMany: findSwaps },
    $queryRaw: queryRaw,
    // interactive transaction: ใช้ mock ตัวเดียวกันแทน tx
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new BillingService(prisma), create, queryRaw, findVehicles, findSwaps };
}

const dto = (o: Record<string, unknown> = {}) => ({
  customerId: 'c1',
  invoiceNo: 'IV2026-121',
  issueDate: '2026-09-21',
  jobLabel: 'จดทะเบียนรถยนต์',
  lines: [{ vehicleId: 'v1', receiptAmount: 3745, serviceFee: 700, deduction: 500, deductionNote: 'ลูกค้าชำระค่าขอใช้เลขเอง' }],
  extras: [{ label: 'ค่าส่งเอกสาร', amount: 200 }],
  ...o,
});

describe('BillingService.createCustomInvoice', () => {
  function customService() {
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'i9',
      status: 'ISSUED',
      paidDate: null,
      taxInvoiceNo: null,
      voidReason: null,
      ...data,
      lines: [],
      items: data.items.createMany.data.map((it: object, n: number) => ({ id: `it${n}`, ...it })),
    }));
    const prisma = {
      customer: { findUnique: vi.fn().mockResolvedValue({ ...customer, accountPeriods: [] }) },
      invoice: { create },
    } as unknown as PrismaService;
    return { svc: new BillingService(prisma), create };
  }
  const customDto = (o: Record<string, unknown> = {}) => ({
    customerId: 'c1',
    invoiceNo: 'IV2026-130',
    issueDate: '2027-02-01',
    items: [
      { kind: 'FEE', description: 'ค่าใบเสร็จกรมขนส่ง 1กข 1234', quantity: 1, unitPrice: 340, cost: 999 },
      { kind: 'SERVICE', description: 'ค่าบริการจดทะเบียน 1กข 1234', quantity: 1, unitPrice: 1000, cost: 200 },
      { kind: 'GOODS', description: 'ขายรถ Toyota Vios', quantity: 1, unitPrice: 280000, cost: null },
    ],
    ...o,
  });

  it('prices each kind with its own tax rule and keeps cost internal (none for fees)', async () => {
    const { svc, create } = customService();
    const invoice = await svc.createCustomInvoice(customDto());
    expect(invoice).toMatchObject({ feeTotal: 340, serviceTotal: 1000, goodsTotal: 280000, vatAmount: 19670, whtRate: 3, whtAmount: 30, netTotal: 300980, jobLabel: '', account: 'COMPANY' });
    expect(invoice.items.map((it) => it.cost)).toEqual([null, 200, null]);
    expect(create.mock.calls[0][0].data.items.createMany.data[1]).toMatchObject({ kind: 'SERVICE', sortOrder: 1 });
  });

  it('multiplies quantity by unit price on the server (motorcycle tax renewal 100 x 12)', async () => {
    const { svc, create } = customService();
    const invoice = await svc.createCustomInvoice(
      customDto({ items: [{ kind: 'SERVICE', description: 'ค่าบริการต่อภาษีรถจักรยานยนต์', quantity: 12, unitPrice: 100, cost: 40, amount: 1 }] }),
    );
    expect(invoice).toMatchObject({ serviceTotal: 1200, vatAmount: 84, whtAmount: 36 });
    expect(invoice.items[0]).toMatchObject({ quantity: 12, unitPrice: 100, amount: 1200, cost: 40 });
    expect(create.mock.calls[0][0].data.items.createMany.data[0].amount).toBe(1200);
    await expect(svc.createCustomInvoice(customDto({ items: [{ kind: 'SERVICE', description: 'x', quantity: 1.5, unitPrice: 100 }] }))).rejects.toMatchObject({
      response: { error: expect.stringContaining('จำนวนต้องเป็นจำนวนเต็ม') },
    });
  });

  // เครดิตเทอมของลูกค้า ณ วันออกบิล -> วันครบกำหนดชำระ (ผู้ใช้ 2026-09-28) - ไม่ตั้ง = ไม่มีวันครบกำหนด
  it('sets the due date from the customer credit days at issue, none when the customer has no credit terms', async () => {
    const withCredit = customService();
    withCredit.svc = new BillingService({
      customer: { findUnique: vi.fn().mockResolvedValue({ ...customer, billingCreditDays: 30, accountPeriods: [] }) },
      invoice: { create: withCredit.create },
    } as unknown as PrismaService);
    const invoice = await withCredit.svc.createCustomInvoice(customDto());
    expect(withCredit.create.mock.calls[0][0].data.dueDate).toEqual(new Date('2027-03-03T00:00:00.000Z'));
    expect(invoice.dueDate).toBe('2027-03-03');

    const none = customService();
    const noCredit = await none.svc.createCustomInvoice(customDto());
    expect(none.create.mock.calls[0][0].data.dueDate).toBeNull();
    expect(noCredit.dueDate).toBeNull();
  });

  it('takes the WHT rate chosen for the bill', async () => {
    const { svc } = customService();
    const invoice = await svc.createCustomInvoice(customDto({ whtRate: 1 }));
    expect(invoice).toMatchObject({ whtRate: 1, whtAmount: 10 });
  });

  it('refuses empty bills, unknown kinds, blank descriptions and zero amounts', async () => {
    const { svc, create } = customService();
    await expect(svc.createCustomInvoice(customDto({ items: [] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('อย่างน้อย 1 บรรทัด') } });
    await expect(svc.createCustomInvoice(customDto({ items: [{ kind: 'OTHER', description: 'x', quantity: 1, unitPrice: 1 }] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ประเภทต้องเป็น') } });
    await expect(svc.createCustomInvoice(customDto({ items: [{ kind: 'GOODS', description: ' ', quantity: 1, unitPrice: 1 }] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ต้องใส่รายละเอียด') } });
    await expect(svc.createCustomInvoice(customDto({ items: [{ kind: 'GOODS', description: 'x', quantity: 1, unitPrice: 0 }] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ต้องมากกว่า 0') } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('BillingService.createInvoice', () => {
  it('คำนวณยอดฝั่ง server ตามเงื่อนไขลูกค้า ณ วันออกบิล (หัก 1% ถึงสิ้นปี)', async () => {
    const { svc } = service([vehicle()]);
    const invoice = await svc.createInvoice(dto());
    expect(invoice).toMatchObject({ feeTotal: 3745, serviceTotal: 900, vatAmount: 63, whtRate: 1, whtAmount: 9, netTotal: 4699 });
    expect(invoice.lines[0]).toMatchObject({ chassis: 'CH1', plateText: 'กก 7733', receiptNo: '69/0035371', serviceFee: 700, deduction: 500 });
    expect(invoice.customer.name).toBe('บริษัท เลกซัส ออโต้ ซิตี้ จำกัด');
  });

  it('bills custom lines together with vehicles, each kind taxed by its own rule', async () => {
    const { svc, create } = service([vehicle()]);
    const invoice = await svc.createInvoice(
      dto({
        extras: [],
        items: [
          { kind: 'FEE', description: 'ค่าธรรมเนียมงานเก่า', quantity: 1, unitPrice: 255 },
          { kind: 'SERVICE', description: 'ค่าบริการงานเก่า', quantity: 1, unitPrice: 800, cost: 300 },
        ],
      }),
    );
    // รถ: ใบเสร็จ 3,745 ค่าบริการ 700 · งานเก่า: ธรรมเนียม 255 บริการ 800 · VAT 7% ของ 1,500 · หัก 1% (อัตราพิเศษ) ของ 1,500
    expect(invoice).toMatchObject({ feeTotal: 4000, serviceTotal: 1500, goodsTotal: 0, vatAmount: 105, whtAmount: 15, netTotal: 5590 });
    expect(invoice.items.map((it) => it.description)).toEqual(['ค่าธรรมเนียมงานเก่า', 'ค่าบริการงานเก่า']);
    expect(create.mock.calls[0][0].data.lines.createMany.data).toHaveLength(1);
  });

  it('uses the WHT rate chosen for this bill instead of the customer default', async () => {
    const { svc } = service([vehicle()]);
    const invoice = await svc.createInvoice(dto({ whtRate: 3 }));
    expect(invoice).toMatchObject({ whtRate: 3, whtAmount: 27 });
    await expect(svc.createInvoice(dto({ whtRate: 150 }))).rejects.toMatchObject({ response: { error: expect.stringContaining('อัตราหัก ณ ที่จ่ายต้องอยู่ระหว่าง 0 ถึง 100') } });
  });

  it('พ้นวันสิ้นสุดอัตราพิเศษแล้วกลับไปหัก 3%', async () => {
    const { svc } = service([vehicle()]);
    const invoice = await svc.createInvoice(dto({ issueDate: '2027-01-05' }));
    expect(invoice).toMatchObject({ whtRate: 3, whtAmount: 27 });
  });

  it('รถที่อยู่ในบิลอื่นแล้ววางบิลซ้ำไม่ได้', async () => {
    const { svc, create } = service([vehicle({ invoiceLines: [{ invoice: { invoiceNo: 'IV2026-117' } }] })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('IV2026-117') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('ล็อกแถวรถในบิลก่อนแล้วค่อยอ่านว่ารถอยู่ในบิลอื่นหรือยัง (กันออกบิลพร้อมกัน 2 หน้าจอ)', async () => {
    const { svc, queryRaw, findVehicles } = service([vehicle()]);
    await svc.createInvoice(dto());
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(queryRaw.mock.calls[0][1]).toEqual(['v1']);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findVehicles.mock.invocationCallOrder[0]);
  });

  it('รถที่ยังไม่ได้บันทึกส่งงานวางบิลไม่ได้', async () => {
    const { svc } = service([vehicle({ deliveredDate: null })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ส่งงาน') } });
  });

  it('เลขที่บิลซ้ำไม่ได้', async () => {
    const { svc } = service([vehicle()], { id: 'old' });
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ถูกใช้ไปแล้ว') } });
  });

  it('เลขที่บิลเดียวกันบันทึกพร้อมกัน ชน unique index (P2002) ได้ข้อความเลขที่บิลถูกใช้แล้ว ไม่ใช่ 500', async () => {
    const { svc, create } = service([vehicle()]);
    create.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002', meta: { target: ['invoiceNo'] } }));
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: 'เลขที่บิล IV2026-121 ถูกใช้ไปแล้ว' } });
  });

  it('รถของลูกค้ารายอื่นลงบิลนี้ไม่ได้', async () => {
    const { svc } = service([vehicle({ customerId: 'c2' })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ใช่ของลูกค้า') } });
  });

  // ผู้ใช้ 2026-09-27: รถที่ปิดงาน - วางบิลนอกระบบแล้วลงบิลในระบบซ้ำไม่ได้ (ต้องให้ ADMIN เปิดกลับก่อน)
  it('รถที่ปิดงาน - วางบิลนอกระบบแล้วลงบิลไม่ได้', async () => {
    const { svc, create } = service([vehicle({ billingClosedAt: new Date('2026-09-22T03:00:00.000Z') })]);
    await expect(svc.createInvoice(dto())).rejects.toMatchObject({ response: { error: 'รถ CH1 ปิดงาน (วางบิลนอกระบบ) ไปแล้ว' } });
    expect(create).not.toHaveBeenCalled();
  });
});

describe('BillingService.queue', () => {
  // ผู้ใช้ 2026-09-27: คิวรอวางบิลไม่รวมรถที่ปิดงาน - วางบิลนอกระบบ (และรถที่ถูกลบ)
  it('ไม่รวมรถที่ปิดงาน - วางบิลนอกระบบ', async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const prisma = { customer: { findMany }, invoice: { findFirst: vi.fn().mockResolvedValue(null) }, plateSwap: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    await new BillingService(prisma).queue();
    const args = findMany.mock.calls[0][0];
    const waiting = { deletedAt: null, billingClosedAt: null, deliveredDate: { not: null } };
    expect(args.where.vehicles.some).toMatchObject(waiting);
    expect(args.include.vehicles.where).toMatchObject(waiting);
  });

  // ผู้ใช้ 2026-09-27: SWAP_NORMAL / SWAP_AUCTION (มีคนทำสลับเลขมาให้) ไม่ใช่การขอใช้เลข
  it('ขอใช้เลข = NORMAL / AUCTION เท่านั้น ไม่นับ SWAP_* และ NONE', async () => {
    const sub = (plateNumberOption: string) => [{ receiptNo: 'R', receiptAmount: 1000, taxAmount: null, billFeeTotal: 0, plateNumberOption }];
    const vehicles = ['NORMAL', 'AUCTION', 'SWAP_NORMAL', 'SWAP_AUCTION', 'NONE'].map((opt, n) =>
      vehicle({ id: `v${n}`, cc: null, deliveryRecipient: null, plateDeliveredDate: null, documentSubmissions: sub(opt) }),
    );
    const findMany = vi.fn().mockResolvedValue([{ ...customer, serviceFeeRates: [], vehicles }]);
    const prisma = { customer: { findMany }, invoice: { findFirst: vi.fn().mockResolvedValue(null) }, plateSwap: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaService;
    const res = await new BillingService(prisma).queue();
    expect(res.customers[0].vehicles.map((v) => v.requestedPlateNumber)).toEqual([true, true, false, false, false]);
  });
});

describe('isInvoiceNoConflict', () => {
  it('P2002 ของ invoiceNo (หรือไม่รู้คอลัมน์) = เลขที่บิลซ้ำ', () => {
    expect(isInvoiceNoConflict({ code: 'P2002', meta: { target: ['invoiceNo'] } })).toBe(true);
    expect(isInvoiceNoConflict({ code: 'P2002', meta: { driverAdapterError: { cause: { constraint: { fields: ['invoiceNo'] } } } } })).toBe(true);
    expect(isInvoiceNoConflict({ code: 'P2002' })).toBe(true);
  });

  it('error อื่นไม่ใช่เลขที่บิลซ้ำ', () => {
    expect(isInvoiceNoConflict({ code: 'P2002', meta: { target: ['id'] } })).toBe(false);
    expect(isInvoiceNoConflict({ code: 'P2025' })).toBe(false);
    expect(isInvoiceNoConflict(new Error('x'))).toBe(false);
    expect(isInvoiceNoConflict(null)).toBe(false);
  });
});

function invoiceRow(id: string, status: string, issueDate: string, o: Record<string, unknown> = {}) {
  return {
    id,
    invoiceNo: `IV-${id}`,
    issueDate: new Date(`${issueDate}T00:00:00.000Z`),
    createdAt: new Date(`${issueDate}T03:00:00.000Z`),
    customerId: 'c1',
    customerSnapshot: { name: 'Lexus', branch: null, address: null, taxId: null },
    jobLabel: 'จดทะเบียนรถยนต์',
    extras: [],
    items: [],
    goodsTotal: 0,
    vatRate: 7,
    whtRate: 3,
    feeTotal: 0,
    serviceTotal: 0,
    vatAmount: 0,
    whtAmount: 0,
    netTotal: 100,
    status,
    paidDate: null,
    taxInvoiceNo: null,
    voidReason: null,
    lines: [],
    ...o,
  };
}

describe('BillingService.listInvoices', () => {
  function listService(
    issued: unknown[],
    history: unknown[],
    aggregate = { _count: { _all: issued.length }, _sum: { netTotal: 0 } },
    audits: Array<{ entityId: string; _count: { _all: number } }> = [],
  ) {
    const findMany = vi.fn().mockImplementation(async ({ where }) => (where.status === 'ISSUED' ? issued : history));
    const groupBy = vi.fn().mockResolvedValue(audits);
    const prisma: Record<string, unknown> = { invoice: { findMany, aggregate: vi.fn().mockResolvedValue(aggregate) }, auditLog: { groupBy } };
    const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.$transaction = $transaction;
    return { svc: new BillingService(prisma as unknown as PrismaService), findMany, $transaction, groupBy };
  }

  it('อ่านใน snapshot เดียวกัน - บิลที่เพิ่งรับเงินระหว่างอ่านมาแถวเดียว (สถานะใหม่)', async () => {
    const { svc, $transaction } = listService(
      [invoiceRow('i1', 'ISSUED', '2026-09-25'), invoiceRow('i2', 'ISSUED', '2026-09-24')],
      [invoiceRow('i1', 'PAID', '2026-09-25'), invoiceRow('p1', 'PAID', '2026-09-20')],
    );
    const result = await svc.listInvoices();
    expect(result.invoices.map((i) => [i.id, i.status])).toEqual([
      ['i1', 'PAID'],
      ['i2', 'ISSUED'],
      ['p1', 'PAID'],
    ]);
    expect($transaction).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ isolationLevel: 'RepeatableRead' }));
  });

  it('บิลรอรับเงินทุกใบ (รวมใบเก่ามาก) + ประวัติ เรียงวันที่ออกใหม่สุดก่อน ยอดรอรับเงินนับจากทั้งตาราง', async () => {
    const { svc, findMany } = listService(
      [invoiceRow('old', 'ISSUED', '2025-01-10'), invoiceRow('new', 'ISSUED', '2026-09-25')],
      [invoiceRow('paid', 'PAID', '2026-09-20'), invoiceRow('void', 'VOID', '2026-09-01')],
      { _count: { _all: 2 }, _sum: { netTotal: 12345.678 } },
    );
    const result = await svc.listInvoices();
    expect(result.invoices.map((i) => i.id)).toEqual(['new', 'paid', 'void', 'old']);
    expect(result.outstanding).toEqual({ count: 2, total: 12345.68 });
    expect(result.hasMore).toBe(false);
    // ประวัติเท่านั้นที่จำกัดจำนวน (ขอเกินมา 1 ใบเพื่อรู้ว่ายังมีต่อ) บิลรอรับเงินไม่จำกัด
    const historyQuery = findMany.mock.calls.find(([a]) => a.where.status !== 'ISSUED')![0];
    expect(historyQuery).toMatchObject({ where: { status: { not: 'ISSUED' } }, skip: 0, take: 201 });
    const issuedQuery = findMany.mock.calls.find(([a]) => a.where.status === 'ISSUED')![0];
    expect(issuedQuery.take).toBeUndefined();
  });

  it('ประวัติเกินหน้าที่ขอ = hasMore และตัดใบที่เกินออก', async () => {
    const history = [invoiceRow('p1', 'PAID', '2026-09-20'), invoiceRow('p2', 'PAID', '2026-09-19'), invoiceRow('p3', 'PAID', '2026-09-18')];
    const { svc } = listService([], history);
    const result = await svc.listInvoices({ limit: '2' });
    expect(result.hasMore).toBe(true);
    expect(result.invoices.map((i) => i.id)).toEqual(['p1', 'p2']);
  });

  it('บอกจำนวนประวัติแก้/ยกเลิก/ย้อนรับเงินของแต่ละใบ (AuditLog) ในคำขอเดียว', async () => {
    const { svc, groupBy } = listService([invoiceRow('i1', 'ISSUED', '2026-09-25')], [invoiceRow('p1', 'PAID', '2026-09-20')], undefined, [
      { entityId: 'p1', _count: { _all: 2 } },
    ]);
    const result = await svc.listInvoices();
    expect(result.invoices.map((i) => [i.id, i.historyCount])).toEqual([
      ['i1', 0],
      ['p1', 2],
    ]);
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0][0]).toMatchObject({ by: ['entityId'], where: { entity: 'Invoice', entityId: { in: ['i1', 'p1'] } } });
  });

  it('โหลดเพิ่ม (offset) ส่งเฉพาะประวัติ ไม่ส่งบิลรอรับเงินซ้ำ', async () => {
    const { svc, findMany } = listService([invoiceRow('i1', 'ISSUED', '2026-09-25')], [invoiceRow('p9', 'PAID', '2026-01-01')]);
    const result = await svc.listInvoices({ offset: '200' });
    expect(result.invoices.map((i) => i.id)).toEqual(['p9']);
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 200, take: 201 });
  });
});

describe('BillingService.markPaid / voidInvoice', () => {
  function payService(status = 'ISSUED', updatedCount = 1) {
    const current = invoiceRow('i1', status, '2026-09-21');
    const findUnique = vi.fn().mockImplementation(async ({ include }) => (include ? { ...current, status: 'PAID' } : current));
    const updateMany = vi.fn().mockResolvedValue({ count: updatedCount });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
    const prisma: Record<string, unknown> = { invoice: { findUnique, updateMany }, auditLog: { create: auditCreate } };
    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return { svc: new BillingService(prisma as unknown as PrismaService), updateMany, auditCreate };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // 27/09/2026 03:00 เวลาไทย = ยังเป็นวันที่ 26 ตาม UTC
    vi.setSystemTime(new Date('2026-09-26T20:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('รับเงินได้ตั้งแต่วันออกบิลถึงวันนี้ตามเวลาไทย เปลี่ยนสถานะแบบมีเงื่อนไข ISSUED', async () => {
    const { svc, updateMany } = payService();
    const invoice = await svc.markPaid('i1', { paidDate: '2026-09-27', taxInvoiceNo: 'TV2026-001' });
    expect(invoice.status).toBe('PAID');
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', status: 'ISSUED' },
      data: { status: 'PAID', paidDate: new Date('2026-09-27T00:00:00.000Z'), taxInvoiceNo: 'TV2026-001' },
    });
    await expect(svc.markPaid('i1', { paidDate: '2026-09-21' })).resolves.toBeTruthy();
  });

  it('วันที่รับเงินก่อนวันออกบิลไม่ได้', async () => {
    const { svc, updateMany } = payService();
    await expect(svc.markPaid('i1', { paidDate: '2026-09-20' })).rejects.toMatchObject({
      response: { error: 'วันที่รับเงินต้องไม่ก่อนวันที่ออกบิล (21/09/2026)' },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('วันที่รับเงินหลังวันนี้ (เวลาไทย) ไม่ได้', async () => {
    const { svc, updateMany } = payService();
    await expect(svc.markPaid('i1', { paidDate: '2026-09-28' })).rejects.toMatchObject({ response: { error: 'วันที่รับเงินต้องไม่เกินวันนี้' } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('บิลเปลี่ยนสถานะไปก่อน (อีกหน้าจอยกเลิก/รับเงินพร้อมกัน) = บันทึกไม่ได้ ไม่เขียนทับ', async () => {
    const { svc } = payService('ISSUED', 0);
    // 409 = หน้าจอเก่า หน้ารายการบิลโหลดใหม่ (พบ 2026-09-27: เดิมตอบ 400 บิลค้างสถานะเก่าบนจอ)
    await expect(svc.markPaid('i1', { paidDate: '2026-09-27' })).rejects.toMatchObject({ status: 409, response: { error: 'บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน' } });
    await expect(svc.voidInvoice('i1', { reason: 'คีย์ผิด' })).rejects.toMatchObject({ status: 409, response: { error: 'ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน' } });
  });

  it('บิลที่รับเงินแล้วบันทึกรับเงินซ้ำหรือยกเลิกไม่ได้ (409 ให้หน้าจอโหลดใหม่)', async () => {
    const { svc, updateMany } = payService('PAID');
    await expect(svc.markPaid('i1', { paidDate: '2026-09-27' })).rejects.toMatchObject({ status: 409, response: { error: 'บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน' } });
    await expect(svc.voidInvoice('i1', { reason: 'คีย์ผิด' })).rejects.toMatchObject({ status: 409, response: { error: 'ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน' } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ยกเลิกบิลเปลี่ยนสถานะแบบมีเงื่อนไข ISSUED พร้อมเหตุผล', async () => {
    const { svc, updateMany, auditCreate } = payService();
    await asUser(() => svc.voidInvoice('i1', { reason: ' ออกซ้ำ ' }));
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'i1', status: 'ISSUED' }, data: { status: 'VOID', voidReason: 'ออกซ้ำ' } });
    // ผู้ใช้ 2026-09-27: ทุกการยกเลิกมีประวัติว่าใครทำ
    expect(auditCreate).toHaveBeenCalledWith({
      data: { entity: 'Invoice', entityId: 'i1', action: 'void', remark: 'ออกซ้ำ', changes: { status: { from: 'ISSUED', to: 'VOID' } }, editedById: 'u1' },
      select: { id: true },
    });
  });

  it('ยกเลิกบิลไม่สำเร็จ (สถานะเปลี่ยนไปก่อน) ไม่เขียนประวัติ', async () => {
    const { svc, auditCreate } = payService('ISSUED', 0);
    await expect(svc.voidInvoice('i1', { reason: 'คีย์ผิด' })).rejects.toMatchObject({ status: 409 });
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

// ---------- F23: ยกเลิกการรับเงิน (ผู้ใช้ 2026-09-27: ADMIN + ACCOUNTANT พร้อมเหตุผล) ----------
describe('BillingService.unpayInvoice', () => {
  function unpayService(status = 'PAID', updatedCount = 1, activeTaxInvoice: { taxInvoiceNo: string } | null = null) {
    const current = invoiceRow('i1', status, '2026-09-21', { paidDate: new Date('2026-09-25T00:00:00.000Z'), taxInvoiceNo: 'TV2026-010' });
    const findUnique = vi.fn().mockImplementation(async ({ include }) => (include ? { ...current, status: 'ISSUED', paidDate: null, taxInvoiceNo: null } : current));
    const updateMany = vi.fn().mockResolvedValue({ count: updatedCount });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
    const prisma: Record<string, unknown> = {
      invoice: { findUnique, updateMany },
      auditLog: { create: auditCreate },
      taxInvoice: { findFirst: vi.fn().mockResolvedValue(activeTaxInvoice) },
    };
    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return { svc: new BillingService(prisma as unknown as PrismaService), updateMany, auditCreate };
  }

  it('บิลที่รับเงินแล้วกลับเป็นรอรับเงิน ล้างวันที่รับเงิน + เลข TV และเก็บค่าเดิมในประวัติ', async () => {
    const { svc, updateMany, auditCreate } = unpayService();
    const invoice = await asUser(() => svc.unpayInvoice('i1', { remark: ' กดรับเงินผิดใบ ' }));
    expect(invoice).toMatchObject({ status: 'ISSUED', paidDate: null, taxInvoiceNo: null });
    // เปลี่ยนแบบมีเงื่อนไขรวมค่าที่อ่านมา กันกด 2 หน้าจอพร้อมกัน
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'i1', status: 'PAID', paidDate: new Date('2026-09-25T00:00:00.000Z'), taxInvoiceNo: 'TV2026-010' },
      data: { status: 'ISSUED', paidDate: null, taxInvoiceNo: null },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        entity: 'Invoice',
        entityId: 'i1',
        action: 'unpay',
        remark: 'กดรับเงินผิดใบ',
        changes: {
          status: { from: 'PAID', to: 'ISSUED' },
          paidDate: { from: '2026-09-25', to: null },
          taxInvoiceNo: { from: 'TV2026-010', to: null },
        },
        editedById: 'u1',
      },
      select: { id: true },
    });
  });

  it('ต้องมีเหตุผล - ไม่มีแล้วไม่แตะฐานข้อมูล', async () => {
    const { svc, updateMany } = unpayService();
    await expect(svc.unpayInvoice('i1', { remark: '  ' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่ยกเลิกการรับเงิน' } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ใช้ได้เฉพาะบิลที่รับเงินแล้ว - สถานะอื่น = หน้าจอเก่า ตอบ 409 ให้โหลดรายการใหม่', async () => {
    for (const status of ['ISSUED', 'VOID']) {
      const { svc, updateMany } = unpayService(status);
      await expect(svc.unpayInvoice('i1', { remark: 'ผิด' })).rejects.toMatchObject({ status: 409, response: { error: 'ยกเลิกการรับเงินได้เฉพาะบิลที่รับเงินแล้ว' } });
      expect(updateMany).not.toHaveBeenCalled();
    }
  });

  it('มีคนเปลี่ยนสถานะไปก่อน = 409 ไม่เขียนประวัติ', async () => {
    const { svc, auditCreate } = unpayService('PAID', 0);
    await expect(svc.unpayInvoice('i1', { remark: 'ผิด' })).rejects.toMatchObject({ status: 409 });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('บิลที่มีใบกำกับออกในระบบ ย้อนรับเงินไม่ได้ (เลข TV ห้ามหาย) - ต้องยกเลิกใบกำกับแทน', async () => {
    const { svc, updateMany } = unpayService('PAID', 1, { taxInvoiceNo: 'TV2026-001' });
    await expect(svc.unpayInvoice('i1', { remark: 'ผิด' })).rejects.toMatchObject({
      status: 400,
      response: { error: 'บิลนี้มีใบกำกับ TV2026-001 ในระบบ - ใช้ "ยกเลิกใบกำกับ" แทน' },
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

// ---------- F53(a): แก้บิลที่ยังไม่รับเงินโดยใช้เลขที่เดิม (ผู้ใช้ 2026-09-27) ----------
describe('BillingService.updateInvoice', () => {
  const UPDATED_AT = new Date('2026-09-21T05:00:00.000Z');
  const line = (id: string, o: Record<string, unknown>) => ({
    id,
    invoiceId: 'i1',
    vehicleId: `v-${id}`,
    brandName: 'Lexus',
    body: 'รย.1-เก๋ง 2 ตอน',
    receiptNo: null,
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    serviceLabel: null,
    deduction: 0,
    deductionNote: null,
    ...o,
  });
  // ค่าใบเสร็จ 3,745 + 2,000 / ค่าดำเนินการ 700 + 500 + ค่าส่ง 200 = 1,400 / VAT 98 / หัก 1% (อัตราพิเศษตอนออกบิล) 14
  const issued = () =>
    invoiceRow('i1', 'ISSUED', '2026-09-21', {
      invoiceNo: 'IV2026-121',
      updatedAt: UPDATED_AT,
      extras: [{ label: 'ค่าส่งเอกสาร', amount: 200 }],
      vatRate: 7,
      whtRate: 1,
      feeTotal: 5745,
      serviceTotal: 1400,
      vatAmount: 98,
      whtAmount: 14,
      netTotal: 7229,
      lines: [
        line('l1', { chassis: 'CH1', plateText: 'กก 7733', receiptAmount: 3745, serviceFee: 700 }),
        line('l2', { chassis: 'CH2', plateText: '', receiptAmount: 2000, serviceFee: 500 }),
      ],
    });

  // liveVehicles = ข้อมูลรถปัจจุบัน (ใช้ตอนดึงข้อมูลรถล่าสุดลงบิล refreshLineIds)
  function editService(invoice: Record<string, unknown> = issued(), liveVehicles: unknown[] = []) {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue(invoice);
    const invoiceUpdate = vi.fn().mockResolvedValue(invoice);
    const lineUpdate = vi.fn().mockResolvedValue({});
    const lineDelete = vi.fn().mockResolvedValue({ count: 1 });
    const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
    const vehicleFindMany = vi.fn().mockResolvedValue(liveVehicles);
    const prisma: Record<string, unknown> = {
      $queryRaw: queryRaw,
      invoice: { findUnique, update: invoiceUpdate },
      invoiceLine: { update: lineUpdate, deleteMany: lineDelete },
      vehicle: { findMany: vehicleFindMany },
      customer: { findUnique: vi.fn().mockResolvedValue(customer) },
      auditLog: { create: auditCreate },
    };
    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return { svc: new BillingService(prisma as unknown as PrismaService), queryRaw, findUnique, invoiceUpdate, lineUpdate, lineDelete, auditCreate, vehicleFindMany };
  }

  const lineInput = (id: string, o: Record<string, unknown> = {}) => ({ id, receiptAmount: 2000, serviceFee: 500, serviceLabel: null, deduction: 0, deductionNote: null, ...o });

  it('แก้ยอดรายคัน คำนวณยอดใหม่ฝั่ง server ด้วยอัตราเดิมของบิล เลขที่บิลไม่เปลี่ยน และเก็บค่าก่อน/หลังในประวัติ', async () => {
    const { svc, queryRaw, findUnique, invoiceUpdate, lineUpdate, auditCreate } = editService();
    await asUser(() =>
      svc.updateInvoice('i1', { lines: [lineInput('l2', { serviceFee: 600 })], remark: ' ค่าดำเนินการคีย์ผิด ', expectedUpdatedAt: UPDATED_AT.toISOString() }),
    );
    // ล็อกแถวบิลก่อนอ่าน
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findUnique.mock.invocationCallOrder[0]);
    expect(lineUpdate).toHaveBeenCalledWith({ where: { id: 'l2' }, data: { receiptAmount: 2000, serviceFee: 600, serviceLabel: null, deduction: 0, deductionNote: null } });
    const data = invoiceUpdate.mock.calls[0][0].data;
    // ค่าดำเนินการ 1,500 -> VAT 105, หัก 1% เดิม 15 -> สุทธิ 5,745 + 1,500 + 105 - 15
    expect(data).toMatchObject({ feeTotal: 5745, serviceTotal: 1500, vatRate: 7, vatAmount: 105, whtRate: 1, whtAmount: 15, netTotal: 7335 });
    expect(data.invoiceNo).toBeUndefined();
    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit).toMatchObject({ entity: 'Invoice', entityId: 'i1', action: 'update', remark: 'ค่าดำเนินการคีย์ผิด', editedById: 'u1' });
    expect(audit.changes).toEqual({
      'รถ CH2 · serviceFee': { from: 500, to: 600 },
      serviceTotal: { from: 1400, to: 1500 },
      vatAmount: { from: 98, to: 105 },
      whtAmount: { from: 14, to: 15 },
      netTotal: { from: 7229, to: 7335 },
    });
  });

  it('เปลี่ยนวันที่ออกบิลแล้วยังใช้อัตราหัก ณ ที่จ่ายเดิมของบิล เว้นแต่เลือกใช้เงื่อนไขปัจจุบันของลูกค้า', async () => {
    const keep = editService();
    await keep.svc.updateInvoice('i1', { issueDate: '2027-01-05', remark: 'วันที่ผิด' });
    expect(keep.invoiceUpdate.mock.calls[0][0].data).toMatchObject({ issueDate: new Date('2027-01-05T00:00:00.000Z'), whtRate: 1, whtAmount: 14 });

    // ลูกค้า: หัก 3% อัตราพิเศษ 1% ถึง 31/12/2026 -> ออกบิล 05/01/2027 = หัก 3% ของ 1,400 = 42
    const current = editService();
    await current.svc.updateInvoice('i1', { issueDate: '2027-01-05', applyCurrentTerms: true, remark: 'วันที่ผิด' });
    expect(current.invoiceUpdate.mock.calls[0][0].data).toMatchObject({ whtRate: 3, whtAmount: 42, netTotal: 5745 + 1400 + 98 - 42 });
  });

  it('เอารถออกจากบิล (รถกลับเข้าคิว) ต้องเหลืออย่างน้อย 1 คัน', async () => {
    const { svc, lineDelete, invoiceUpdate, auditCreate } = editService();
    await svc.updateInvoice('i1', { removeLineIds: ['l1'], remark: 'ลงผิดคัน' });
    expect(lineDelete).toHaveBeenCalledWith({ where: { invoiceId: 'i1', id: { in: ['l1'] } } });
    expect(invoiceUpdate.mock.calls[0][0].data).toMatchObject({ feeTotal: 2000, serviceTotal: 700 });
    expect(auditCreate.mock.calls[0][0].data.changes['รถ กก 7733 · เอาออกจากบิล']).toMatchObject({ from: { chassis: 'CH1', receiptAmount: 3745 }, to: null });

    const all = editService();
    await expect(all.svc.updateInvoice('i1', { removeLineIds: ['l1', 'l2'], remark: 'ผิด' })).rejects.toMatchObject({
      response: { error: 'บิลต้องเหลือรถอย่างน้อย 1 คัน - ถ้าจะเอาออกทั้งหมดให้ยกเลิกบิล' },
    });
    expect(all.lineDelete).not.toHaveBeenCalled();
  });

  it('แก้ชื่องานและค่าใช้จ่ายอื่นๆ', async () => {
    const { svc, invoiceUpdate, auditCreate } = editService();
    await svc.updateInvoice('i1', { jobLabel: 'จดทะเบียนรถยนต์ใหม่', extras: [], remark: 'ไม่มีค่าส่ง' });
    expect(invoiceUpdate.mock.calls[0][0].data).toMatchObject({ jobLabel: 'จดทะเบียนรถยนต์ใหม่', extras: [], serviceTotal: 1200 });
    expect(auditCreate.mock.calls[0][0].data.changes).toMatchObject({
      jobLabel: { from: 'จดทะเบียนรถยนต์', to: 'จดทะเบียนรถยนต์ใหม่' },
      extras: { from: [{ label: 'ค่าส่งเอกสาร', amount: 200 }], to: [] },
    });
  });

  it('ต้องมีเหตุผล / แก้ได้เฉพาะบิลรอรับเงิน / ไม่มีอะไรเปลี่ยน / มีคนแก้ไปก่อน', async () => {
    const blank = editService();
    await expect(blank.svc.updateInvoice('i1', { jobLabel: 'x' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่แก้ไขบิล' } });
    expect(blank.queryRaw).not.toHaveBeenCalled();

    for (const status of ['PAID', 'VOID']) {
      const done = editService({ ...issued(), status });
      await expect(done.svc.updateInvoice('i1', { jobLabel: 'x', remark: 'r' })).rejects.toMatchObject({ status: 409, response: { error: 'แก้ไขได้เฉพาะบิลที่ยังไม่รับเงิน' } });
      expect(done.invoiceUpdate).not.toHaveBeenCalled();
      // หน้าแก้ที่เปิดค้างไว้ (updatedAt เก่า) แล้วอีกคนรับเงิน/ยกเลิก = 409 ข้อความให้เปิดหน้าแก้ใหม่ (เทียบ updatedAt ก่อนสถานะ)
      const stalePaid = editService({ ...issued(), status, updatedAt: new Date('2026-09-22T00:00:00.000Z') });
      await expect(stalePaid.svc.updateInvoice('i1', { jobLabel: 'x', remark: 'r', expectedUpdatedAt: UPDATED_AT.toISOString() })).rejects.toMatchObject({
        status: 409,
        response: { error: 'บิลนี้ถูกแก้ไขหรือเปลี่ยนสถานะไปแล้ว กรุณาเปิดหน้าแก้ใหม่' },
      });
      expect(stalePaid.invoiceUpdate).not.toHaveBeenCalled();
    }

    const same = editService();
    await expect(same.svc.updateInvoice('i1', { lines: [lineInput('l2')], remark: 'r' })).rejects.toMatchObject({ response: { error: 'ไม่มีข้อมูลที่เปลี่ยน' } });
    expect(same.auditCreate).not.toHaveBeenCalled();

    const stale = editService();
    await expect(stale.svc.updateInvoice('i1', { jobLabel: 'x', remark: 'r', expectedUpdatedAt: '2026-09-20T00:00:00.000Z' })).rejects.toMatchObject({ status: 409 });
    expect(stale.invoiceUpdate).not.toHaveBeenCalled();

    const foreign = editService();
    await expect(foreign.svc.updateInvoice('i1', { lines: [lineInput('other')], remark: 'r' })).rejects.toMatchObject({ status: 400 });
    expect(foreign.invoiceUpdate).not.toHaveBeenCalled();
  });

  // ดึงข้อมูลรถล่าสุดลงบิล (ผู้ใช้ 2026-09-27, F53a): ทะเบียน / เลขที่ใบเสร็จที่แก้หลังออกบิล ไม่ต้องยกเลิกบิลแล้วออกเลขใหม่
  const liveVehicle = (id: string, o: Record<string, unknown> = {}) => ({
    id,
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: 'กก',
    plateNumber: '7733',
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    brand: { name: 'Lexus' },
    documentSubmissions: [],
    ...o,
  });

  it('ดึงทะเบียน / เลขที่ใบเสร็จล่าสุดลงบิล อ่านรถใต้ล็อกบิล ยอดไม่เปลี่ยน และเก็บค่าก่อน/หลังรายช่องในประวัติ', async () => {
    const live = liveVehicle('v-l1', { plateCategory: '1กข', plateNumber: '1234', documentSubmissions: [{ receiptNo: '69/0035371', receiptAmount: 3745 }] });
    const { svc, queryRaw, lineUpdate, invoiceUpdate, auditCreate, vehicleFindMany } = editService(issued(), [live]);
    await svc.updateInvoice('i1', { refreshLineIds: ['l1'], remark: 'AI อ่านทะเบียนผิด แก้แล้ว', expectedUpdatedAt: UPDATED_AT.toISOString() });
    expect(vehicleFindMany.mock.calls[0][0].where).toEqual({ id: { in: ['v-l1'] } });
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(vehicleFindMany.mock.invocationCallOrder[0]);
    expect(lineUpdate).toHaveBeenCalledTimes(1);
    expect(lineUpdate).toHaveBeenCalledWith({
      where: { id: 'l1' },
      data: {
        chassis: 'CH1',
        brandName: 'Lexus',
        body: 'รย.1-เก๋ง 2 ตอน',
        plateText: '1กข 1234',
        receiptNo: '69/0035371',
        deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
      },
    });
    // เลขที่บิลและยอดเดิม
    expect(invoiceUpdate.mock.calls[0][0].data).toMatchObject({ feeTotal: 5745, serviceTotal: 1400, netTotal: 7229 });
    expect(invoiceUpdate.mock.calls[0][0].data.invoiceNo).toBeUndefined();
    expect(auditCreate.mock.calls[0][0].data.changes).toEqual({
      'รถ กก 7733 · plateText': { from: 'กก 7733', to: '1กข 1234' },
      'รถ กก 7733 · receiptNo': { from: null, to: '69/0035371' },
    });
  });

  it('แก้ยอดและดึงข้อมูลล่าสุดคันเดียวกัน = เขียนแถวเดียว', async () => {
    const live = liveVehicle('v-l2', { chassis: 'CH2', plateCategory: '2กข', plateNumber: '5' });
    const { svc, lineUpdate, auditCreate } = editService(issued(), [live]);
    await svc.updateInvoice('i1', { lines: [lineInput('l2', { serviceFee: 600 })], refreshLineIds: ['l2'], remark: 'ได้ทะเบียนแล้ว' });
    expect(lineUpdate).toHaveBeenCalledTimes(1);
    expect(lineUpdate.mock.calls[0][0]).toMatchObject({ where: { id: 'l2' }, data: { serviceFee: 600, receiptAmount: 2000, plateText: '2กข 5', chassis: 'CH2' } });
    expect(auditCreate.mock.calls[0][0].data.changes).toMatchObject({
      'รถ CH2 · serviceFee': { from: 500, to: 600 },
      'รถ CH2 · plateText': { from: '', to: '2กข 5' },
    });
  });

  it('รถไม่มีวันที่ส่งงานแล้ว = เก็บวันที่ส่งงานเดิมของบิล', async () => {
    const live = liveVehicle('v-l1', { plateNumber: '7734', deliveredDate: null });
    const { svc, lineUpdate, auditCreate } = editService(issued(), [live]);
    await svc.updateInvoice('i1', { refreshLineIds: ['l1'], remark: 'ทะเบียนผิด' });
    expect(lineUpdate.mock.calls[0][0].data.deliveredDate).toEqual(new Date('2026-09-20T00:00:00.000Z'));
    expect(Object.keys(auditCreate.mock.calls[0][0].data.changes)).toEqual(['รถ กก 7733 · plateText']);
  });

  it('ข้อมูลรถตรงกับบิลอยู่แล้ว / ดึงล่าสุดพร้อมเอาออก / รูปแบบผิด / ไม่พบรถ = 400 ไม่เขียนอะไร', async () => {
    const same = editService(issued(), [liveVehicle('v-l1')]);
    await expect(same.svc.updateInvoice('i1', { refreshLineIds: ['l1'], remark: 'r' })).rejects.toMatchObject({
      status: 400,
      response: { error: 'ไม่มีข้อมูลที่เปลี่ยน - ข้อมูลรถในบิลตรงกับข้อมูลล่าสุดอยู่แล้ว' },
    });
    expect(same.lineUpdate).not.toHaveBeenCalled();
    expect(same.auditCreate).not.toHaveBeenCalled();

    const both = editService();
    await expect(both.svc.updateInvoice('i1', { refreshLineIds: ['l1'], removeLineIds: ['l1'], remark: 'r' })).rejects.toMatchObject({
      response: { error: 'รถคันเดียวกันดึงข้อมูลล่าสุดและเอาออกจากบิลพร้อมกันไม่ได้' },
    });
    expect(both.queryRaw).not.toHaveBeenCalled();

    const shape = editService();
    await expect(shape.svc.updateInvoice('i1', { refreshLineIds: 'l1', remark: 'r' })).rejects.toMatchObject({ response: { error: 'refreshLineIds ต้องเป็นรายการ id' } });

    const other = editService();
    await expect(other.svc.updateInvoice('i1', { refreshLineIds: ['other'], remark: 'r' })).rejects.toMatchObject({ status: 400 });
    expect(other.vehicleFindMany).not.toHaveBeenCalled();

    const gone = editService(issued(), []);
    await expect(gone.svc.updateInvoice('i1', { refreshLineIds: ['l1'], remark: 'r' })).rejects.toMatchObject({ response: { error: 'ไม่พบข้อมูลรถ CH1' } });
    expect(gone.invoiceUpdate).not.toHaveBeenCalled();
  });
});

describe('BillingService.invoiceLiveLines', () => {
  it('ข้อมูลรถปัจจุบันของแต่ละคันในบิล (ทะเบียน เลขที่ใบเสร็จ ยอดใบเสร็จที่กรอกไว้) ข้ามคันที่ไม่พบ', async () => {
    const prisma = {
      invoice: { findUnique: vi.fn().mockResolvedValue({ lines: [{ id: 'l1', vehicleId: 'v1' }, { id: 'l2', vehicleId: 'gone' }] }) },
      vehicle: { findMany: vi.fn().mockResolvedValue([vehicle({ documentSubmissions: [{ receiptNo: 'R1', receiptAmount: 3745 }] })]) },
    } as unknown as PrismaService;
    await expect(new BillingService(prisma).invoiceLiveLines('i1')).resolves.toEqual([
      { id: 'l1', chassis: 'CH1', brandName: 'Lexus', body: 'รย.1-เก๋ง 2 ตอน', plateText: 'กก 7733', receiptNo: 'R1', deliveredDate: '2026-09-20', receiptAmount: 3745 },
    ]);
  });

  it('ไม่พบบิล = 404', async () => {
    const prisma = { invoice: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as PrismaService;
    await expect(new BillingService(prisma).invoiceLiveLines('x')).rejects.toMatchObject({ status: 404 });
  });
});

// ---------- F53(b): ปิดงาน - วางบิลนอกระบบ / เปิดงานกลับ (ผู้ใช้ 2026-09-27) ----------
describe('BillingService.closeVehicleBilling / reopenVehicleBilling', () => {
  const closedRow = {
    id: 'v1',
    chassis: 'CH1',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: 'กก',
    plateNumber: '7733',
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    billingClosedAt: new Date('2026-09-27T03:00:00.000Z'),
    billingClosedNote: 'วางบิลใน Google Sheet IV2026-130',
    brand: { name: 'Lexus' },
    customer: { id: 'c1', name: 'Lexus', company: 'บริษัท เลกซัส จำกัด' },
    billingClosedBy: { name: 'สมชาย', displayName: 'ชาย' },
  };

  function closeService(v: Record<string, unknown> | null, updatedCount = 1) {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue(v);
    const updateMany = vi.fn().mockResolvedValue({ count: updatedCount });
    const findMany = vi.fn().mockResolvedValue([closedRow]);
    const editLog = vi.fn().mockResolvedValue({ id: 'e1' });
    const prisma: Record<string, unknown> = { $queryRaw: queryRaw, vehicle: { findUnique, updateMany, findMany }, vehicleEditLog: { create: editLog } };
    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return { svc: new BillingService(prisma as unknown as PrismaService), queryRaw, findUnique, updateMany, findMany, editLog };
  }

  const delivered = (o: Record<string, unknown> = {}) => ({
    chassis: 'CH1',
    deletedAt: null,
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    billingClosedAt: null,
    billingClosedNote: null,
    invoiceLines: [],
    ...o,
  });

  it('ปิดงานพร้อมหมายเหตุ: ล็อกแถวรถ บันทึกผู้ปิด และเขียนประวัติรถ', async () => {
    const { svc, queryRaw, findUnique, updateMany, editLog } = closeService(delivered());
    const row = await asUser(() => svc.closeVehicleBilling('v1', { note: ' วางบิลใน Google Sheet IV2026-130 ' }));
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findUnique.mock.invocationCallOrder[0]);
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', billingClosedAt: null },
      data: { billingClosedAt: expect.any(Date), billingClosedNote: 'วางบิลใน Google Sheet IV2026-130', billingClosedById: 'u1' },
    });
    const log = editLog.mock.calls[0][0].data;
    expect(log).toMatchObject({ vehicleId: 'v1', editedById: 'u1', remark: 'ปิดงาน - วางบิลนอกระบบ: วางบิลใน Google Sheet IV2026-130' });
    expect(JSON.parse(log.changes)).toMatchObject({ billingClosedNote: { from: null, to: 'วางบิลใน Google Sheet IV2026-130' } });
    expect(row).toMatchObject({ id: 'v1', plateText: 'กก 7733', customerName: 'บริษัท เลกซัส จำกัด', note: 'วางบิลใน Google Sheet IV2026-130', closedBy: 'ชาย' });
  });

  it('ต้องมีหมายเหตุ / ส่งงานแล้ว / ยังไม่อยู่ในบิล / ยังไม่ปิด', async () => {
    const blank = closeService(delivered());
    await expect(blank.svc.closeVehicleBilling('v1', { note: '' })).rejects.toMatchObject({ status: 400 });
    expect(blank.queryRaw).not.toHaveBeenCalled();

    const notDelivered = closeService(delivered({ deliveredDate: null }));
    await expect(notDelivered.svc.closeVehicleBilling('v1', { note: 'n' })).rejects.toMatchObject({ response: { error: 'รถ CH1 ยังไม่ได้บันทึกส่งงาน' } });

    const billed = closeService(delivered({ invoiceLines: [{ invoice: { invoiceNo: 'IV2026-117' } }] }));
    await expect(billed.svc.closeVehicleBilling('v1', { note: 'n' })).rejects.toMatchObject({ response: { error: 'รถ CH1 อยู่ในบิล IV2026-117 แล้ว' } });

    const closed = closeService(delivered({ billingClosedAt: new Date() }));
    await expect(closed.svc.closeVehicleBilling('v1', { note: 'n' })).rejects.toMatchObject({ response: { error: 'รถ CH1 ปิดงานไปแล้ว' } });

    const deleted = closeService(delivered({ deletedAt: new Date() }));
    await expect(deleted.svc.closeVehicleBilling('v1', { note: 'n' })).rejects.toMatchObject({ status: 404 });

    for (const s of [notDelivered, billed, closed, deleted]) expect(s.updateMany).not.toHaveBeenCalled();
  });

  it('ปิดพร้อมกัน 2 หน้าจอ = 409 ไม่เขียนประวัติซ้ำ', async () => {
    const { svc, editLog } = closeService(delivered(), 0);
    await expect(svc.closeVehicleBilling('v1', { note: 'n' })).rejects.toMatchObject({ status: 409 });
    expect(editLog).not.toHaveBeenCalled();
  });

  it('เปิดงานกลับ: ล้างทั้ง 3 ช่องแบบมีเงื่อนไข พร้อมเหตุผลในประวัติรถ', async () => {
    const closedAt = new Date('2026-09-27T03:00:00.000Z');
    const { svc, updateMany, editLog } = closeService(delivered({ billingClosedAt: closedAt, billingClosedNote: 'Google Sheet' }));
    await expect(asUser(() => svc.reopenVehicleBilling('v1', { remark: ' ปิดผิดคัน ' }))).resolves.toEqual({ id: 'v1', reopened: true });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'v1', billingClosedAt: closedAt },
      data: { billingClosedAt: null, billingClosedNote: null, billingClosedById: null },
    });
    const log = editLog.mock.calls[0][0].data;
    expect(log.remark).toBe('เปิดงานกลับ (ยกเลิกปิดงาน - วางบิลนอกระบบ): ปิดผิดคัน');
    expect(log.editedById).toBe('u1');
    expect(JSON.parse(log.changes)).toMatchObject({ billingClosedNote: { from: 'Google Sheet', to: null } });
  });

  it('เปิดงานกลับต้องมีเหตุผล และใช้ได้เฉพาะรถที่ปิดไว้', async () => {
    const blank = closeService(delivered({ billingClosedAt: new Date() }));
    await expect(blank.svc.reopenVehicleBilling('v1', { remark: ' ' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่เปิดงานกลับ' } });
    const open = closeService(delivered());
    await expect(open.svc.reopenVehicleBilling('v1', { remark: 'r' })).rejects.toMatchObject({ response: { error: 'รถ CH1 ไม่ได้ปิดงานไว้' } });
    expect(open.updateMany).not.toHaveBeenCalled();
  });

  it('รายการรถที่ปิดงาน ใหม่สุดก่อนทีละ 100 คัน', async () => {
    const { svc, findMany } = closeService(null);
    const result = await svc.listClosedVehicles({ offset: '100' });
    expect(result).toMatchObject({ hasMore: false, vehicles: [{ id: 'v1', closedAt: '2026-09-27T03:00:00.000Z' }] });
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { deletedAt: null, billingClosedAt: { not: null } }, skip: 100, take: 101 });
  });
});

// ---------- F25: แก้เงื่อนไขวางบิลต้องมีเหตุผลและประวัติ (ผู้ใช้ 2026-09-27) ----------

describe('BillingService.updateTerms', () => {
  function termsService(row: typeof customer | null = customer) {
    const queryRaw = vi.fn().mockResolvedValue([]);
    const findUnique = vi.fn().mockResolvedValue(row);
    const update = vi.fn().mockImplementation(async ({ data }) => ({ ...row, ...data }));
    const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
    const prisma: Record<string, unknown> = { $queryRaw: queryRaw, customer: { findUnique, update }, auditLog: { create: auditCreate } };
    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return { svc: new BillingService(prisma as unknown as PrismaService), queryRaw, findUnique, update, auditCreate };
  }

  it('บันทึกเงื่อนไขใหม่ ล็อกแถวลูกค้าก่อนอ่าน และเก็บเฉพาะช่องที่เปลี่ยนลงประวัติลูกค้า', async () => {
    const { svc, queryRaw, findUnique, update, auditCreate } = termsService();
    const terms = await asUser(() => svc.updateTerms('c1', { vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null, remark: ' หมดโปรอัตราพิเศษ ' }));
    expect(terms).toEqual({ vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null, requiresQuotation: false, whtMethod: 'PAPER' });
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findUnique.mock.invocationCallOrder[0]);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'c1' },
      data: { billingVat: true, billingWhtRate: 3, billingWhtSpecialRate: null, billingWhtSpecialUntil: null },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        entity: 'Customer',
        entityId: 'c1',
        action: 'update-terms',
        remark: 'หมดโปรอัตราพิเศษ',
        changes: { billingWhtSpecialRate: { from: 1, to: null }, billingWhtSpecialUntil: { from: '2026-12-31', to: null } },
        editedById: 'u1',
      },
      select: { id: true },
    });
  });

  // ประเภท 50 ทวิ ตั้งต้นของลูกค้า (ผู้ใช้ 2026-10-06: YM / Lexus = e-WHT ที่เหลือกระดาษ)
  it('ตั้งประเภท 50 ทวิ ตั้งต้นเป็น e-WHT ได้ และไม่ส่ง = คงเดิม ค่าอื่นห้ามรับ', async () => {
    const { svc, update } = termsService();
    const terms = await asUser(() => svc.updateTerms('c1', { vat: true, whtRate: 3, whtSpecialRate: 1, whtSpecialUntil: '2026-12-31', whtMethod: 'EWHT', remark: 'ลูกค้าหักผ่านธนาคาร' }));
    expect(terms.whtMethod).toBe('EWHT');
    expect(update.mock.calls[0][0].data).toMatchObject({ billingWhtMethod: 'EWHT' });
    await expect(svc.updateTerms('c1', { vat: true, whtRate: 3, whtMethod: 'CASH', remark: 'x' })).rejects.toMatchObject({ response: { error: 'ประเภท 50 ทวิ ต้องเป็นกระดาษหรือ e-WHT' } });
    const keep = termsService();
    await asUser(() => keep.svc.updateTerms('c1', { vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null, remark: 'ไม่แตะ 50 ทวิ' }));
    expect(keep.update.mock.calls[0][0].data).not.toHaveProperty('billingWhtMethod');
  });

  it('ต้องมีเหตุผล - ไม่มีแล้วไม่แตะฐานข้อมูล', async () => {
    const { svc, queryRaw, update } = termsService();
    await expect(svc.updateTerms('c1', { vat: true, whtRate: 3, remark: '  ' })).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่แก้เงื่อนไขวางบิล' },
    });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('ค่าเหมือนเดิม = 400 ไม่เขียนประวัติ / ไม่พบลูกค้า = 404', async () => {
    const same = termsService();
    await expect(
      same.svc.updateTerms('c1', { vat: true, whtRate: 3, whtSpecialRate: 1, whtSpecialUntil: '2026-12-31', remark: 'ลองกด' }),
    ).rejects.toMatchObject({ response: { error: 'เงื่อนไขวางบิลเหมือนเดิม - ไม่มีอะไรต้องแก้' } });
    expect(same.update).not.toHaveBeenCalled();
    expect(same.auditCreate).not.toHaveBeenCalled();

    const missing = termsService(null);
    await expect(missing.svc.updateTerms('c9', { vat: false, whtRate: 0, remark: 'r' })).rejects.toMatchObject({ status: 404 });
  });
});

// วางบิลงานสลับเลข (ผู้ใช้ 2026-09-28): ค่าใบเสร็จกรมฯ ของรถเก่าเก็บแยกในบรรทัดเดียวกับรถใหม่
describe('BillingService.createInvoice - งานสลับเลข', () => {
  const swapLine = (o: Record<string, unknown> = {}) => ({
    lines: [{ vehicleId: 'v1', receiptAmount: 1000, serviceFee: 1607.48, plateSwapId: 'ps1', swapReceiptAmount: 250, ...o }],
    extras: [],
  });
  const swapRow = (o: Record<string, unknown> = {}) => ({ id: 'ps1', newVehicleId: 'v1', invoiceLines: [], ...o });

  it('เก็บงานสลับเลขและค่าใบเสร็จของรถเก่าไว้ในบรรทัด และรวมเข้ายอดค่าธรรมเนียม', async () => {
    const { svc } = service([vehicle()], undefined, [swapRow()]);
    const invoice = await svc.createInvoice(dto(swapLine()));
    expect(invoice.lines[0]).toMatchObject({ plateSwapId: 'ps1', swapReceiptAmount: 250 });
    expect(invoice.feeTotal).toBe(1250); // 1,000 ของรถใหม่ + 250 ของรถเก่า
    expect(invoice.serviceTotal).toBe(1607.48);
  });

  it('งานสลับเลขที่อยู่ในบิลอื่นแล้ว วางบิลซ้ำไม่ได้', async () => {
    const { svc, create } = service([vehicle()], undefined, [swapRow({ invoiceLines: [{ invoice: { invoiceNo: 'IV2026-100' } }] })]);
    await expect(svc.createInvoice(dto(swapLine()))).rejects.toMatchObject({ response: { error: expect.stringContaining('IV2026-100') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('งานสลับเลขที่ไม่ใช่ของรถคันนี้ (หรือถูกยกเลิกไปแล้ว) วางบิลไม่ได้', async () => {
    const other = service([vehicle()], undefined, [swapRow({ newVehicleId: 'v9' })]);
    await expect(other.svc.createInvoice(dto(swapLine()))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ถูกต้อง') } });
    const gone = service([vehicle()], undefined, []);
    await expect(gone.svc.createInvoice(dto(swapLine()))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ถูกต้อง') } });
  });

  it('ล็อกแถวงานสลับเลขก่อนอ่าน (กันวางบิลงานเดียวกันพร้อมกัน 2 หน้าจอ)', async () => {
    const { svc, queryRaw } = service([vehicle()], undefined, [swapRow()]);
    await svc.createInvoice(dto(swapLine()));
    const swapLock = queryRaw.mock.calls.find((c) => c[0].join('?').includes('PlateSwap'));
    expect(swapLock).toBeTruthy();
    expect(swapLock![0].join('?')).toContain('FOR UPDATE');
    expect(swapLock![1]).toEqual(['ps1']);
  });

  it('ส่งยอดมาโดยไม่บอกว่าเป็นงานไหน (หรือกลับกัน) = ปฏิเสธ', async () => {
    const { svc } = service([vehicle()], undefined, [swapRow()]);
    await expect(svc.createInvoice(dto(swapLine({ plateSwapId: undefined })))).rejects.toMatchObject({
      response: { error: expect.stringContaining('ต้องมาคู่กับงานสลับเลข') },
    });
    await expect(svc.createInvoice(dto(swapLine({ swapReceiptAmount: undefined })))).rejects.toMatchObject({
      response: { error: expect.stringContaining('ต้องมาคู่กับงานสลับเลข') },
    });
  });
});

// ผู้ใช้ 2026-10-09 "ใบเสร็จถูกเสมอ": ยอด Bill อีกแบบ (ขอใช้กลับเป็นตรงข้าม) ใช้เทียบกับใบเสร็จจริงในหน้าวางบิล
describe('flipOtherProvince', () => {
  // เงื่อนไขขอใช้เดียวกับ document-fee-calculator / queue()
  const other = (v: { registrationProvince: string | null; ownerProvince: string | null }) =>
    !!v.registrationProvince && !!v.ownerProvince && v.registrationProvince !== v.ownerProvince;

  it('ขอใช้ -> ไม่ขอใช้ และกลับกัน โดยไม่แตะจังหวัดที่จด', () => {
    const asking = { id: 'v1', registrationProvince: 'กรุงเทพมหานคร', ownerProvince: 'ชลบุรี' };
    const flipped = flipOtherProvince(asking, other(asking));
    expect(other(flipped)).toBe(false);
    expect(flipped).toMatchObject({ id: 'v1', registrationProvince: 'กรุงเทพมหานคร' });
    expect(asking.ownerProvince).toBe('ชลบุรี'); // ไม่แก้ของเดิม

    const normal = { registrationProvince: 'กรุงเทพมหานคร', ownerProvince: 'กรุงเทพมหานคร' };
    expect(other(flipOtherProvince(normal, other(normal)))).toBe(true);
    // ไม่มีจังหวัดเจ้าของรถ = ข้อมูลรถนับเป็นไม่ขอใช้ สลับแล้วต้องเป็นขอใช้
    const noOwner = { registrationProvince: 'สมุทรปราการ', ownerProvince: null };
    expect(other(flipOtherProvince(noOwner, other(noOwner)))).toBe(true);
  });

  it('ไม่มีจังหวัดที่จด: สลับไม่ได้ ยอดสองแบบเท่ากัน หน้าวางบิลจึงไม่เสนอปุ่ม', () => {
    const unknown = { registrationProvince: null, ownerProvince: 'ชลบุรี' };
    expect(other(flipOtherProvince(unknown, other(unknown)))).toBe(false);
  });
});
