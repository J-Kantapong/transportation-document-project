import { vi } from 'vitest';
import { BillingService } from './billing.service.js';
import { feeOf, jobItems, matchJobRate, type BillableJob, type JobRateRow } from './other-jobs.js';
import { PrismaService } from '../prisma/prisma.service.js';

const rate = (o: Partial<JobRateRow> = {}): JobRateRow => ({ id: 'r1', jobType: 'TRANSFER', vehicleClass: 'ANY', variant: null, label: '', amount: 500, sortOrder: 0, ...o });

const job = (o: Partial<BillableJob> = {}): BillableJob => ({
  type: 'TRANSFER',
  id: 't1',
  customerId: 'c1',
  vehicleClass: 'MOTO',
  variant: 'OWNER',
  chassis: 'CH1',
  plateText: '1กข 1234',
  brand: 'HONDA',
  ownerName: 'A → B',
  doneDate: '2026-10-05',
  receiptNo: 'R1',
  receiptAmount: 125,
  billTotal: 105,
  noBillTotal: 60,
  dutyAmount: 20,
  ...o,
});

describe('matchJobRate', () => {
  it('takes the first row (by sortOrder) matching job type, vehicle class and variant', () => {
    const rates = [
      rate({ id: 'a', jobType: 'TAX_RENEWAL', amount: 100, sortOrder: 0 }),
      rate({ id: 'b', vehicleClass: 'CAR', amount: 800, sortOrder: 1 }),
      rate({ id: 'c', vehicleClass: 'MOTO', variant: 'INSPECTION', amount: 700, sortOrder: 2 }),
      rate({ id: 'd', vehicleClass: 'MOTO', amount: 400, sortOrder: 3 }),
    ];
    expect(matchJobRate(rates, { jobType: 'TRANSFER', vehicleClass: 'MOTO', variant: 'OWNER' })?.id).toBe('d');
    expect(matchJobRate(rates, { jobType: 'TRANSFER', vehicleClass: 'MOTO', variant: 'INSPECTION' })?.id).toBe('c');
    expect(matchJobRate(rates, { jobType: 'TRANSFER', vehicleClass: 'CAR', variant: 'OWNER' })?.id).toBe('b');
  });

  it('returns null when nothing matches instead of guessing a price', () => {
    expect(matchJobRate([rate({ jobType: 'PLATE_COPY' })], { jobType: 'TRANSFER', vehicleClass: 'CAR', variant: null })).toBeNull();
    expect(matchJobRate([], { jobType: 'MOVE_OUT', vehicleClass: 'CAR', variant: null })).toBeNull();
  });
});

describe('feeOf', () => {
  it('uses the real receipt amount, falls back to the computed Bill (estimate), and tax renewal uses its tax', () => {
    expect(feeOf(job())).toEqual({ amount: 125, source: 'RECEIPT' });
    expect(feeOf(job({ receiptAmount: null }))).toEqual({ amount: 105, source: 'ESTIMATE' });
    expect(feeOf(job({ type: 'TAX_RENEWAL', receiptAmount: null, billTotal: 1234.5 }))).toEqual({ amount: 1234.5, source: 'TAX' });
  });
});

describe('jobItems', () => {
  it('makes a FEE line and a SERVICE line linked to the job, with cost = No Bill + duty', () => {
    const items = jobItems(job(), 400, 125, 'โอนปกติ', 0);
    expect(items).toEqual([
      expect.objectContaining({ kind: 'FEE', description: 'ค่าธรรมเนียมงานโอน 1กข 1234', unitPrice: 125, cost: null, sortOrder: 0, sourceType: 'TRANSFER', sourceId: 't1' }),
      expect.objectContaining({ kind: 'SERVICE', description: 'ค่าบริการงานโอน 1กข 1234 โอนปกติ', unitPrice: 400, cost: 80, sortOrder: 1, sourceType: 'TRANSFER', sourceId: 't1' }),
    ]);
  });

  it('leaves out a zero fee or a zero service price, and uses the chassis when there is no plate', () => {
    expect(jobItems(job({ plateText: '' }), 0, 125, '', 3).map((i) => [i.kind, i.sortOrder, i.description])).toEqual([['FEE', 3, 'ค่าธรรมเนียมงานโอน CH1']]);
    expect(jobItems(job(), 400, 0, '', 0).map((i) => i.kind)).toEqual(['SERVICE']);
  });
});

const customer = {
  id: 'c1',
  name: 'Lexus',
  company: 'บริษัท เลกซัส ออโต้ ซิตี้ จำกัด',
  branch: 'สาขา 00001',
  address: 'ที่อยู่',
  taxId: '0105547142882',
  billingVat: true,
  billingWhtRate: 3,
  billingWhtSpecialRate: null,
  billingWhtSpecialUntil: null,
  billingCreditDays: 30,
  billingRequiresQuotation: false,
  billingWhtMethod: 'PAPER',
  accountPeriods: [],
  jobFeeRates: [{ id: 'r1', jobType: 'TRANSFER', vehicleClass: 'MOTO', variant: null, label: '', amount: 400, sortOrder: 0 }],
};

const transferRow = {
  id: 't1',
  customerId: 'c1',
  vehicleClass: 'MOTO',
  chassis: 'CH1',
  brand: 'HONDA',
  plateCategory: '1กข',
  plateNumber: '1234',
  returnedDate: new Date('2026-10-05T00:00:00.000Z'),
  receiptNo: 'R1',
  receiptAmount: 125,
  billTotal: 105,
  noBillTotal: 60,
  dutyAmount: 20,
  transferType: 'OWNER',
  transferorName: 'A',
  transfereeName: 'B',
};

function setup(opts: { billedBy?: string; transfers?: unknown[]; customerOverride?: Record<string, unknown> } = {}) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({
    id: 'i1',
    status: 'ISSUED',
    paidDate: null,
    taxInvoiceNo: null,
    voidReason: null,
    ...data,
    lines: [],
    items: data.items.createMany.data.map((it: object, n: number) => ({ id: `it${n}`, ...it })),
  }));
  const queryRawUnsafe = vi.fn().mockResolvedValue([]);
  const prisma = {
    customer: { findUnique: vi.fn().mockResolvedValue({ ...customer, ...opts.customerOverride }), findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => (where.id.in.includes('c1') ? [customer] : [])) },
    invoice: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue({ invoiceNo: 'IV2026-120' }), create },
    invoiceItem: {
      findMany: vi.fn().mockResolvedValue(opts.billedBy ? [{ sourceType: 'TRANSFER', sourceId: 't1', invoice: { invoiceNo: opts.billedBy } }] : []),
    },
    vehicleTransfer: { findMany: vi.fn().mockResolvedValue(opts.transfers ?? [transferRow]) },
    vehicleUseCancellation: { findMany: vi.fn().mockResolvedValue([]) },
    plateCopy: { findMany: vi.fn().mockResolvedValue([]) },
    vehicleMoveOut: { findMany: vi.fn().mockResolvedValue([]) },
    taxRenewal: { findMany: vi.fn().mockResolvedValue([]) },
    $queryRawUnsafe: queryRawUnsafe,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new BillingService(prisma), create, queryRawUnsafe };
}

const dto = (o: Record<string, unknown> = {}) => ({
  customerId: 'c1',
  invoiceNo: 'IV2026-121',
  issueDate: '2026-10-07',
  jobs: [{ type: 'TRANSFER', id: 't1', serviceFee: 400, serviceLabel: 'โอนปกติ' }],
  ...o,
});

describe('BillingService.otherJobsQueue', () => {
  it('lists billable jobs per customer with the fee from the receipt and the price from the customer table', async () => {
    const { svc } = setup();
    const queue = await svc.otherJobsQueue();
    expect(queue.suggestedInvoiceNo).toBe('IV2026-121');
    expect(queue.customers).toHaveLength(1);
    expect(queue.customers[0].jobs[0]).toMatchObject({
      type: 'TRANSFER',
      id: 't1',
      typeLabel: 'งานโอน',
      fee: 125,
      feeSource: 'RECEIPT',
      suggestedServiceFee: 400,
      suggestedRateId: 'r1',
    });
    // ใบเสร็จ 125 ไม่ตรงกับยอด Bill ที่คิดไว้ 105 -> เตือน (ไม่บล็อก)
    expect(queue.customers[0].jobs[0].warnings[0]).toContain('ไม่ตรง');
  });

  it('leaves out jobs that are already in a live invoice and warns when no price is set', async () => {
    const billed = setup({ billedBy: 'IV2026-100' });
    expect((await billed.svc.otherJobsQueue()).customers).toHaveLength(0);

    const noPrice = setup({ transfers: [{ ...transferRow, vehicleClass: 'CAR' }] });
    const job0 = (await noPrice.svc.otherJobsQueue()).customers[0].jobs[0];
    expect(job0.suggestedServiceFee).toBeNull();
    expect(job0.warnings.join(' ')).toContain('ยังไม่ได้ตั้งราคา');
  });
});

describe('BillingService.createJobInvoice', () => {
  it('builds FEE + SERVICE items linked to the job, computes tax on the service only, and locks the job row', async () => {
    const { svc, create, queryRawUnsafe } = setup();
    const invoice = await svc.createJobInvoice(dto());
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('"VehicleTransfer"'), ['t1']);
    expect(invoice).toMatchObject({ feeTotal: 125, serviceTotal: 400, vatAmount: 28, whtAmount: 12, netTotal: 541, jobLabel: 'งานโอน', account: 'COMPANY' });
    const items = create.mock.calls[0][0].data.items.createMany.data;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: 'FEE', unitPrice: 125, sourceType: 'TRANSFER', sourceId: 't1' });
    expect(items[1]).toMatchObject({ kind: 'SERVICE', unitPrice: 400, cost: 80, sourceType: 'TRANSFER', sourceId: 't1' });
  });

  it('refuses a job that is already in a live invoice', async () => {
    const { svc, create } = setup({ billedBy: 'IV2026-100' });
    await expect(svc.createJobInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('IV2026-100') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses a job that is not billable for this customer (cancelled, not returned or someone else’s)', async () => {
    const { svc, create } = setup({ transfers: [] });
    await expect(svc.createJobInvoice(dto())).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่พร้อมวางบิล') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses customers that need a quotation, empty picks, duplicates and a job with nothing to bill', async () => {
    await expect(setup({ customerOverride: { billingRequiresQuotation: true } }).svc.createJobInvoice(dto())).rejects.toMatchObject({
      response: { error: expect.stringContaining('ใบเสนอราคา') },
    });
    const { svc } = setup();
    await expect(svc.createJobInvoice(dto({ jobs: [] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('อย่างน้อย 1 งาน') } });
    await expect(svc.createJobInvoice(dto({ jobs: [dto().jobs[0], dto().jobs[0]] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ซ้ำ') } });
    const zero = setup({ transfers: [{ ...transferRow, receiptAmount: null, billTotal: 0 }] });
    await expect(zero.svc.createJobInvoice(dto({ jobs: [{ type: 'TRANSFER', id: 't1', serviceFee: 0 }] }))).rejects.toMatchObject({
      response: { error: expect.stringContaining('ไม่มียอดให้วางบิล') },
    });
  });
});

// งานอื่นๆ พ่วงในบิลเดียวกับรถจดใหม่ (ผู้ใช้ 2026-10-07)
describe('BillingService.createInvoice with other jobs', () => {
  const vehicle = {
    id: 'v1',
    customerId: 'c1',
    chassis: 'CH9',
    body: 'รย.1-เก๋ง 2 ตอน',
    plateCategory: 'กก',
    plateNumber: '7733',
    deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
    brand: { name: 'Lexus' },
    documentSubmissions: [{ receiptNo: '69/0035371' }],
    invoiceLines: [],
    billingClosedAt: null,
  };
  function mixedSetup(opts: { periods?: Array<{ account: string; effectiveFrom: Date }> } = {}) {
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'i2',
      status: 'ISSUED',
      paidDate: null,
      taxInvoiceNo: null,
      voidReason: null,
      faceLayout: 'SUMMARY',
      ...data,
      lines: data.lines.createMany.data.map((l: object, n: number) => ({ id: `l${n}`, ...l })),
      items: data.items ? data.items.createMany.data.map((it: object, n: number) => ({ id: `it${n}`, ...it })) : [],
    }));
    const queryRawUnsafe = vi.fn().mockResolvedValue([]);
    const prisma = {
      customer: { findUnique: vi.fn().mockResolvedValue({ ...customer, accountPeriods: opts.periods ?? [] }) },
      invoice: { findUnique: vi.fn().mockResolvedValue(null), create },
      invoiceItem: { findMany: vi.fn().mockResolvedValue([]) },
      vehicle: { findMany: vi.fn().mockResolvedValue([vehicle]) },
      plateSwap: { findMany: vi.fn().mockResolvedValue([]) },
      vehicleTransfer: { findMany: vi.fn().mockResolvedValue([transferRow]) },
      vehicleUseCancellation: { findMany: vi.fn().mockResolvedValue([]) },
      plateCopy: { findMany: vi.fn().mockResolvedValue([]) },
      vehicleMoveOut: { findMany: vi.fn().mockResolvedValue([]) },
      taxRenewal: { findMany: vi.fn().mockResolvedValue([]) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $queryRawUnsafe: queryRawUnsafe,
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    return { svc: new BillingService(prisma), create, queryRawUnsafe };
  }
  const mixedDto = (o: Record<string, unknown> = {}) => ({
    customerId: 'c1',
    invoiceNo: 'IV2026-122',
    issueDate: '2026-10-07',
    jobLabel: 'จดทะเบียนรถยนต์',
    lines: [{ vehicleId: 'v1', receiptAmount: 3745, serviceFee: 700, deduction: 0, deductionNote: null }],
    extras: [],
    items: [{ kind: 'GOODS', description: 'ขายอะไหล่', quantity: 1, unitPrice: 1000 }],
    jobs: [{ type: 'TRANSFER', id: 't1', serviceFee: 400, serviceLabel: '' }],
    ...o,
  });

  it('adds the job lines (with a snapshot for the attachment) before the typed lines and totals everything together', async () => {
    const { svc, create, queryRawUnsafe } = mixedSetup();
    const invoice = await svc.createInvoice(mixedDto());
    expect(queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('"VehicleTransfer"'), ['t1']);
    // ค่าธรรมเนียม 3745 + 125 · ค่าบริการ 700 + 400 · สินค้า 1000 · VAT 7% ของ 2100 = 147 · หัก 3% ของ 1100 = 33
    expect(invoice).toMatchObject({ feeTotal: 3870, serviceTotal: 1100, goodsTotal: 1000, vatAmount: 147, whtAmount: 33, netTotal: 6084, faceLayout: 'SUMMARY' });
    const items = create.mock.calls[0][0].data.items.createMany.data;
    expect(items.map((it: { kind: string; sortOrder: number; sourceType?: string }) => [it.kind, it.sortOrder, it.sourceType ?? null])).toEqual([
      ['FEE', 0, 'TRANSFER'],
      ['SERVICE', 1, 'TRANSFER'],
      ['GOODS', 2, null],
    ]);
    expect(items[0].sourceSnapshot).toMatchObject({ chassis: 'CH1', plateText: '1กข 1234', brand: 'HONDA', receiptNo: 'R1', vehicleClass: 'MOTO', variant: 'OWNER' });
    expect(invoice.items[1].sourceSnapshot).toMatchObject({ chassis: 'CH1' });
  });

  it('refuses jobs whose account at the issue date differs from the vehicles\u2019 account', async () => {
    // รถส่งงาน 2026-09-20 (บัญชีบริษัท) แต่ลูกค้าย้ายไปบัญชีบุคคลตั้งแต่ 2026-10-01 -> งานอื่นที่ออกบิล 2026-10-07 อยู่บัญชีบุคคล
    const { svc, create } = mixedSetup({ periods: [{ account: 'PERSONAL', effectiveFrom: new Date('2026-10-01T00:00:00.000Z') }] });
    await expect(svc.createInvoice(mixedDto())).rejects.toMatchObject({ response: { error: expect.stringContaining('คนละบัญชี') } });
    expect(create).not.toHaveBeenCalled();
  });

  it('still issues a plain vehicle bill when no jobs are sent', async () => {
    const { svc, create } = mixedSetup();
    const invoice = await svc.createInvoice(mixedDto({ jobs: undefined, items: undefined }));
    expect(invoice).toMatchObject({ feeTotal: 3745, serviceTotal: 700 });
    expect(create.mock.calls[0][0].data.items).toBeUndefined();
  });
});

// หน้าแก้บิล: บรรทัดที่มาจากงานอื่นๆ คงไว้เสมอ items ที่ส่งมาแทนที่เฉพาะบรรทัดที่พิมพ์เอง (ผู้ใช้ 2026-10-07)
describe('BillingService.updateInvoice keeps linked job lines', () => {
  const UPDATED_AT = new Date('2026-10-07T05:00:00.000Z');
  const snap = { chassis: 'CH1', plateText: '1กข 1234', brand: 'HONDA', ownerName: 'A', receiptNo: 'R1', doneDate: '2026-10-05', vehicleClass: 'MOTO', variant: 'OWNER', serviceLabel: '' };
  const invoice = () => ({
    id: 'i3', invoiceNo: 'IV2026-130', issueDate: new Date('2026-10-07T00:00:00.000Z'), customerId: 'c1', customerSnapshot: {}, jobLabel: 'งานโอน', extras: [],
    vatRate: 7, whtRate: 3, feeTotal: 125, serviceTotal: 400, goodsTotal: 1000, vatAmount: 98, whtAmount: 12, netTotal: 1611, status: 'ISSUED', paidDate: null, taxInvoiceNo: null, voidReason: null,
    account: 'COMPANY', dueDate: null, updatedAt: UPDATED_AT, faceLayout: 'SUMMARY', taxInvoices: [], lines: [],
    items: [
      { id: 'a', kind: 'FEE', description: 'ค่าธรรมเนียมงานโอน 1กข 1234', quantity: 1, unitPrice: 125, amount: 125, cost: null, sortOrder: 0, sourceType: 'TRANSFER', sourceId: 't1', sourceSnapshot: snap },
      { id: 'b', kind: 'SERVICE', description: 'ค่าบริการงานโอน 1กข 1234', quantity: 1, unitPrice: 400, amount: 400, cost: 80, sortOrder: 1, sourceType: 'TRANSFER', sourceId: 't1', sourceSnapshot: snap },
      { id: 'c', kind: 'GOODS', description: 'ขายอะไหล่', quantity: 1, unitPrice: 1000, amount: 1000, cost: null, sortOrder: 2, sourceType: null, sourceId: null, sourceSnapshot: null },
    ],
  });
  function editService() {
    const inv = invoice();
    const invoiceUpdate = vi.fn().mockResolvedValue(inv);
    const itemDelete = vi.fn().mockResolvedValue({ count: 1 });
    const itemCreate = vi.fn().mockResolvedValue({ count: 1 });
    const prisma: Record<string, unknown> = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      invoice: { findUnique: vi.fn().mockResolvedValue(inv), update: invoiceUpdate },
      invoiceItem: { deleteMany: itemDelete, createMany: itemCreate },
      invoiceLine: { update: vi.fn(), deleteMany: vi.fn() },
      vehicle: { findMany: vi.fn().mockResolvedValue([]) },
      customer: { findUnique: vi.fn().mockResolvedValue(customer) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: 'a1' }) },
    };
    prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
    return { svc: new BillingService(prisma as unknown as PrismaService), invoiceUpdate, itemDelete, itemCreate };
  }

  it('replaces only the typed lines, keeps the job lines and still counts them in the totals', async () => {
    const { svc, invoiceUpdate, itemDelete, itemCreate } = editService();
    await svc.updateInvoice('i3', { items: [{ kind: 'GOODS', description: 'ขายอะไหล่', quantity: 2, unitPrice: 1000 }], remark: 'จำนวนผิด', expectedUpdatedAt: UPDATED_AT.toISOString() });
    expect(itemDelete).toHaveBeenCalledWith({ where: { invoiceId: 'i3', sourceType: null } });
    const created = itemCreate.mock.calls[0][0].data;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: 'GOODS', quantity: 2, amount: 2000, sortOrder: 2, invoiceId: 'i3' });
    // ค่าธรรมเนียม 125 (งาน) · ค่าบริการ 400 (งาน) · สินค้า 2,000 · VAT 7% ของ 2,400 = 168 · หัก 3% ของ 400 = 12
    expect(invoiceUpdate.mock.calls[0][0].data).toMatchObject({ feeTotal: 125, serviceTotal: 400, goodsTotal: 2000, vatAmount: 168, whtAmount: 12, netTotal: 2681 });
  });

  it('does not touch items when the typed lines are unchanged', async () => {
    const { svc, itemDelete } = editService();
    await expect(
      svc.updateInvoice('i3', { items: [{ kind: 'GOODS', description: 'ขายอะไหล่', quantity: 1, unitPrice: 1000 }], remark: 'ไม่มีอะไรเปลี่ยน', expectedUpdatedAt: UPDATED_AT.toISOString() }),
    ).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่มีข้อมูลที่เปลี่ยน') } });
    expect(itemDelete).not.toHaveBeenCalled();
  });
});
