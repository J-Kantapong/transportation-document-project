import { vi } from 'vitest';
import { BillingService, isInvoiceNoConflict } from './billing.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

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

function service(vehicles: unknown[], existingInvoice: unknown = null) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({
    id: 'i1',
    status: 'ISSUED',
    paidDate: null,
    taxInvoiceNo: null,
    voidReason: null,
    ...data,
    lines: data.lines.createMany.data.map((l: object, n: number) => ({ id: `l${n}`, ...l })),
  }));
  const queryRaw = vi.fn().mockResolvedValue([]);
  const findVehicles = vi.fn().mockResolvedValue(vehicles);
  const prisma = {
    customer: { findUnique: vi.fn().mockResolvedValue(customer) },
    invoice: { findUnique: vi.fn().mockResolvedValue(existingInvoice), create },
    vehicle: { findMany: findVehicles },
    $queryRaw: queryRaw,
    // interactive transaction: ใช้ mock ตัวเดียวกันแทน tx
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new BillingService(prisma), create, queryRaw, findVehicles };
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

describe('BillingService.createInvoice', () => {
  it('คำนวณยอดฝั่ง server ตามเงื่อนไขลูกค้า ณ วันออกบิล (หัก 1% ถึงสิ้นปี)', async () => {
    const { svc } = service([vehicle()]);
    const invoice = await svc.createInvoice(dto());
    expect(invoice).toMatchObject({ feeTotal: 3745, serviceTotal: 900, vatAmount: 63, whtRate: 1, whtAmount: 9, netTotal: 4699 });
    expect(invoice.lines[0]).toMatchObject({ chassis: 'CH1', plateText: 'กก 7733', receiptNo: '69/0035371', serviceFee: 700, deduction: 500 });
    expect(invoice.customer.name).toBe('บริษัท เลกซัส ออโต้ ซิตี้ จำกัด');
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
  function listService(issued: unknown[], history: unknown[], aggregate = { _count: { _all: issued.length }, _sum: { netTotal: 0 } }) {
    const findMany = vi.fn().mockImplementation(async ({ where }) => (where.status === 'ISSUED' ? issued : history));
    const prisma: Record<string, unknown> = { invoice: { findMany, aggregate: vi.fn().mockResolvedValue(aggregate) } };
    const $transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    prisma.$transaction = $transaction;
    return { svc: new BillingService(prisma as unknown as PrismaService), findMany, $transaction };
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
    const prisma = { invoice: { findUnique, updateMany } } as unknown as PrismaService;
    return { svc: new BillingService(prisma), updateMany };
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
    await expect(svc.markPaid('i1', { paidDate: '2026-09-27' })).rejects.toMatchObject({ response: { error: 'บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน' } });
    await expect(svc.voidInvoice('i1', { reason: 'คีย์ผิด' })).rejects.toMatchObject({ response: { error: 'ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน' } });
  });

  it('บิลที่รับเงินแล้วบันทึกรับเงินซ้ำหรือยกเลิกไม่ได้', async () => {
    const { svc, updateMany } = payService('PAID');
    await expect(svc.markPaid('i1', { paidDate: '2026-09-27' })).rejects.toMatchObject({ response: { error: 'บันทึกรับเงินได้เฉพาะบิลที่รอรับเงิน' } });
    await expect(svc.voidInvoice('i1', { reason: 'คีย์ผิด' })).rejects.toMatchObject({ response: { error: 'ยกเลิกได้เฉพาะบิลที่ยังไม่รับเงิน' } });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ยกเลิกบิลเปลี่ยนสถานะแบบมีเงื่อนไข ISSUED พร้อมเหตุผล', async () => {
    const { svc, updateMany } = payService();
    await svc.voidInvoice('i1', { reason: ' ออกซ้ำ ' });
    expect(updateMany).toHaveBeenCalledWith({ where: { id: 'i1', status: 'ISSUED' }, data: { status: 'VOID', voidReason: 'ออกซ้ำ' } });
  });
});
