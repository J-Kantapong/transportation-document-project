import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { BillingService, QUOTATION_REQUIRED_ERROR } from './billing.service.js';
import { assertYamahaMonthNotQuoted } from './quotation-lock.js';
import { QuotationService } from './quotation.service.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function quotationRow(over: Record<string, unknown> = {}) {
  return {
    id: 'q1',
    quotationNo: null as string | null,
    baseNo: null as string | null,
    revision: 0,
    replacesId: null as string | null,
    kind: 'JOB',
    status: 'DRAFT',
    customerId: 'c1' as string | null,
    customerSnapshot: { name: 'YM', branch: null, address: 'สมุทรปราการ', taxId: '0105500000000' },
    issueDate: day('2026-10-31'),
    validDays: 30,
    validUntil: day('2026-11-30'),
    title: 'งานแจ้งย้าย 10/2026',
    conditions: null,
    account: 'COMPANY',
    vatRate: 7,
    whtRate: 3,
    feeTotal: 0,
    serviceTotal: 19240,
    goodsTotal: 0,
    vatAmount: 1346.8,
    whtAmount: 577.2,
    netTotal: 20009.6,
    yamahaMonth: null as string | null,
    yamahaSize: null as string | null,
    yamahaCounts: null as unknown,
    approvedDate: null as Date | null,
    poNumber: null as string | null,
    storageKey: null as string | null,
    mimeType: null,
    originalName: null,
    rejectReason: null,
    cancelReason: null,
    ratesAppliedAt: null as Date | null,
    updatedAt: new Date('2026-10-31T03:00:00.000Z'),
    items: [
      { id: 'it1', quotationId: 'q1', kind: 'SERVICE', description: 'รถเล็ก', quantity: 512, unitPrice: 20, amount: 10240, cost: null, sortOrder: 0, rateKind: null, vehicleKind: null, ccMin: null, ccMax: null, chassisPrefix: null, vatInclusive: false, includesReceipt: false },
      { id: 'it2', quotationId: 'q1', kind: 'SERVICE', description: 'ค่าดูแลเอกสาร', quantity: 1, unitPrice: 9000, amount: 9000, cost: null, sortOrder: 1, rateKind: null, vehicleKind: null, ccMin: null, ccMax: null, chassisPrefix: null, vatInclusive: false, includesReceipt: false },
    ],
    invoices: [] as Array<{ id: string; invoiceNo: string }>,
    replaces: null,
    replacedBy: null as unknown,
    ...over,
  };
}

// ฐานข้อมูลปลอม: แถวใบเสนอราคาเก็บตาม id แก้ด้วย update แล้วอ่านกลับได้
function setup(rows: Array<ReturnType<typeof quotationRow>>, opts: { lastNumber?: number; yamaha?: { SMALL: number; LARGE: number }; liveForMonth?: { id: string; quotationNo: string } | null } = {}) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const audits: Array<Record<string, unknown>> = [];
  const seriesUpdates: number[] = [];
  const rates = { deleted: 0, created: [] as Array<Record<string, unknown>> };
  const db = {
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('QuotationSeries') ? [{ lastNumber: opts.lastNumber ?? 0 }] : [])),
    $executeRaw: vi.fn(async () => 1),
    quotation: {
      findUnique: vi.fn(async (a: { where: { id?: string; contentHash?: string } }) => (a.where.id ? (byId.get(a.where.id) ?? null) : null)),
      findFirst: vi.fn(async () => opts.liveForMonth ?? null),
      update: vi.fn(async (a: { where: { id: string }; data: Record<string, unknown> }) => {
        const next = { ...byId.get(a.where.id)!, ...a.data } as ReturnType<typeof quotationRow>;
        byId.set(a.where.id, next);
        return next;
      }),
    },
    quotationSeries: { update: vi.fn(async (a: { data: { lastNumber: number } }) => seriesUpdates.push(a.data.lastNumber)) },
    yamahaRelocationEntry: {
      groupBy: vi.fn(async () => [
        { size: 'SMALL', _sum: { count: opts.yamaha?.SMALL ?? 0 } },
        { size: 'LARGE', _sum: { count: opts.yamaha?.LARGE ?? 0 } },
      ]),
    },
    serviceFeeRate: {
      findMany: vi.fn(async () => [{ label: 'เดิม', kind: 'BASE', amount: 500 }]),
      deleteMany: vi.fn(async () => (rates.deleted += 1)),
      createMany: vi.fn(async (a: { data: Array<Record<string, unknown>> }) => rates.created.push(...a.data)),
    },
    auditLog: { create: vi.fn(async (a: { data: Record<string, unknown> }) => (audits.push(a.data), { id: 'a1' })) },
  };
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  const billing = { createCustomInvoice: vi.fn(async (_dto: unknown, ref: { link: (tx: unknown) => Promise<void> }) => (await ref.link(db), { id: 'i1', invoiceNo: 'IV2026-130' })) };
  const storage = { put: vi.fn(async () => undefined), get: vi.fn(), delete: vi.fn(async () => undefined) };
  const svc = new QuotationService(db as unknown as PrismaService, billing as unknown as BillingService, storage as unknown as ReceiptStorage);
  return { svc, db, byId, audits, seriesUpdates, rates, billing, storage };
}

describe('QuotationService.issue', () => {
  it('gives a draft the next number of the issue year', async () => {
    const { svc, seriesUpdates } = setup([quotationRow()], { lastNumber: 3 });
    const q = await svc.issue('q1');
    expect(q.quotationNo).toBe('QT2026-004');
    expect(q.status).toBe('ISSUED');
    expect(seriesUpdates).toEqual([4]);
  });

  it('numbers a revision after the quotation it replaces and supersedes it', async () => {
    const old = quotationRow({ id: 'old', status: 'ISSUED', quotationNo: 'QT2026-004', baseNo: 'QT2026-004' });
    const { svc, byId, seriesUpdates } = setup([old, quotationRow({ replacesId: 'old' })]);
    const q = await svc.issue('q1');
    expect(q.quotationNo).toBe('QT2026-004-R1');
    expect(byId.get('old')!.status).toBe('SUPERSEDED');
    expect(seriesUpdates).toEqual([]);
  });

  it('refuses a revision of a quotation that is already billed', async () => {
    const old = quotationRow({ id: 'old', status: 'APPROVED', quotationNo: 'QT2026-004', baseNo: 'QT2026-004', invoices: [{ id: 'i1', invoiceNo: 'IV2026-130' }] });
    const { svc } = setup([old, quotationRow({ replacesId: 'old' })]);
    await expect(svc.issue('q1')).rejects.toMatchObject({ response: { error: expect.stringContaining('IV2026-130') } });
  });

  it('refuses when the Yamaha counts changed after the draft pulled them', async () => {
    const { svc } = setup([quotationRow({ yamahaMonth: '2026-10', yamahaCounts: { SMALL: 512, LARGE: 0 } })], { yamaha: { SMALL: 520, LARGE: 0 } });
    await expect(svc.issue('q1')).rejects.toMatchObject({ response: { error: expect.stringContaining('520') } });
  });

  it('only compares the count of its own size when the quotation is split by size', async () => {
    // ใบรถใหญ่: รถเล็กเพิ่มขึ้นระหว่างนั้นไม่ทำให้ยอดเปลี่ยน
    const large = setup([quotationRow({ yamahaMonth: '2026-10', yamahaSize: 'LARGE', yamahaCounts: { SMALL: 512, LARGE: 40 } })], { yamaha: { SMALL: 600, LARGE: 40 } });
    await expect(large.svc.issue('q1')).resolves.toMatchObject({ status: 'ISSUED' });
    const changed = setup([quotationRow({ yamahaMonth: '2026-10', yamahaSize: 'LARGE', yamahaCounts: { SMALL: 512, LARGE: 40 } })], { yamaha: { SMALL: 512, LARGE: 41 } });
    await expect(changed.svc.issue('q1')).rejects.toMatchObject({ response: { error: expect.stringContaining('41') } });
  });

  it('looks for a live quotation of the same size or an old one covering both', async () => {
    const { svc, db } = setup([quotationRow({ yamahaMonth: '2026-10', yamahaSize: 'SMALL', yamahaCounts: { SMALL: 512, LARGE: 0 } })], { yamaha: { SMALL: 512, LARGE: 0 } });
    await svc.issue('q1');
    expect((db.quotation.findFirst.mock.calls as unknown[][])[0][0]).toMatchObject({ where: { yamahaMonth: '2026-10', OR: [{ yamahaSize: 'SMALL' }, { yamahaSize: null }] } });
  });

  it('refuses a second live quotation for the same Yamaha month', async () => {
    const { svc } = setup([quotationRow({ yamahaMonth: '2026-10', yamahaCounts: { SMALL: 512, LARGE: 0 } })], { yamaha: { SMALL: 512, LARGE: 0 }, liveForMonth: { id: 'x', quotationNo: 'QT2026-002' } });
    await expect(svc.issue('q1')).rejects.toMatchObject({ response: { error: expect.stringContaining('QT2026-002') } });
  });
});

describe('QuotationService.approve', () => {
  const issued = () => quotationRow({ status: 'ISSUED', quotationNo: 'QT2026-004', baseNo: 'QT2026-004' });
  beforeEach(() => void vi.useFakeTimers({ now: new Date('2026-11-05T03:00:00.000Z') }));
  afterEach(() => void vi.useRealTimers());

  it('needs a PO number or a file', async () => {
    const { svc } = setup([issued()]);
    await expect(svc.approve('q1', { approvedDate: '2026-11-03' }, undefined)).rejects.toMatchObject({ response: { error: expect.stringContaining('เลข PO') } });
  });

  it('stores the PO and logs the approval', async () => {
    const { svc, audits } = setup([issued()]);
    const q = await svc.approve('q1', { approvedDate: '2026-11-03', poNumber: '4500123456' }, undefined);
    expect(q).toMatchObject({ status: 'APPROVED', stage: 'APPROVED', approvedDate: '2026-11-03', poNumber: '4500123456' });
    expect(audits[0]).toMatchObject({ entity: 'Quotation', action: 'approve' });
  });

  it('refuses an approval date before the quotation date', async () => {
    const { svc } = setup([issued()]);
    await expect(svc.approve('q1', { approvedDate: '2026-10-30', poNumber: 'P1' }, undefined)).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่ก่อน') } });
  });
});

describe('QuotationService.createInvoice', () => {
  const approved = (over: Record<string, unknown> = {}) =>
    quotationRow({ status: 'APPROVED', quotationNo: 'QT2026-004', baseNo: 'QT2026-004', approvedDate: day('2026-11-03'), poNumber: '4500123456', ...over });

  it('copies the lines to a bill that carries the QT and PO numbers', async () => {
    const { svc, billing, audits } = setup([approved()]);
    await svc.createInvoice('q1', { invoiceNo: 'IV2026-130', issueDate: '2026-11-05' });
    const [dto, ref] = billing.createCustomInvoice.mock.calls[0] as unknown as [Record<string, unknown>, Record<string, unknown>];
    expect(dto).toMatchObject({ customerId: 'c1', invoiceNo: 'IV2026-130', jobLabel: 'งานแจ้งย้าย 10/2026', whtRate: 3 });
    expect(dto.items).toEqual([
      { kind: 'SERVICE', description: 'รถเล็ก', quantity: 512, unitPrice: 20, cost: null },
      { kind: 'SERVICE', description: 'ค่าดูแลเอกสาร', quantity: 1, unitPrice: 9000, cost: null },
    ]);
    expect(ref).toMatchObject({ quotationId: 'q1', quotationNo: 'QT2026-004', poNumber: '4500123456' });
    expect(audits[0]).toMatchObject({ action: 'invoice' });
  });

  it('refuses before approval, twice, before the approval date and without a linked customer', async () => {
    await expect(setup([quotationRow({ status: 'ISSUED' })]).svc.createInvoice('q1', { invoiceNo: 'IV1', issueDate: '2026-11-05' })).rejects.toMatchObject({ status: 409 });
    await expect(setup([approved({ invoices: [{ id: 'i1', invoiceNo: 'IV2026-130' }] })]).svc.createInvoice('q1', { invoiceNo: 'IV2', issueDate: '2026-11-05' })).rejects.toMatchObject({ status: 409 });
    await expect(setup([approved()]).svc.createInvoice('q1', { invoiceNo: 'IV1', issueDate: '2026-11-02' })).rejects.toMatchObject({ status: 400 });
    await expect(setup([approved({ customerId: null })]).svc.createInvoice('q1', { invoiceNo: 'IV1', issueDate: '2026-11-05' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('QuotationService.applyRates', () => {
  it('replaces the customer rate table with the quoted rows', async () => {
    const item = { ...quotationRow().items[0], description: 'จดทะเบียนรถจักรยานยนต์ ต่ำกว่า 300 cc', quantity: 1, unitPrice: 520, amount: 520, rateKind: 'BASE', vehicleKind: 'MOTO', ccMax: 300 };
    const { svc, rates, audits } = setup([quotationRow({ kind: 'RATE', status: 'APPROVED', quotationNo: 'QT2026-005', items: [item] })]);
    const q = await svc.applyRates('q1');
    expect(rates.deleted).toBe(1);
    expect(rates.created).toEqual([expect.objectContaining({ customerId: 'c1', label: 'จดทะเบียนรถจักรยานยนต์ ต่ำกว่า 300 cc', kind: 'BASE', vehicleKind: 'MOTO', amount: 520, ccMax: 300, sortOrder: 0 })]);
    expect(q.stage).toBe('DONE');
    expect(audits.map((a) => a.entity)).toEqual(['Customer', 'Quotation']);
  });

  it('refuses a job quotation and a second apply', async () => {
    await expect(setup([quotationRow({ status: 'APPROVED' })]).svc.applyRates('q1')).rejects.toMatchObject({ status: 400 });
    await expect(setup([quotationRow({ kind: 'RATE', status: 'APPROVED', ratesAppliedAt: new Date() })]).svc.applyRates('q1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('cancel / unapprove guards', () => {
  it('cannot cancel or unapprove a quotation with a live bill', async () => {
    const billed = () => quotationRow({ status: 'APPROVED', quotationNo: 'QT2026-004', invoices: [{ id: 'i1', invoiceNo: 'IV2026-130' }] });
    await expect(setup([billed()]).svc.cancel('q1', { remark: 'ผิด' })).rejects.toMatchObject({ status: 409 });
    await expect(setup([billed()]).svc.unapprove('q1', { remark: 'ผิด' })).rejects.toMatchObject({ status: 409 });
  });

  it('needs a reason', async () => {
    await expect(setup([quotationRow({ status: 'ISSUED' })]).svc.cancel('q1', {})).rejects.toMatchObject({ status: 400 });
    await expect(setup([quotationRow({ status: 'ISSUED' })]).svc.reject('q1', { remark: ' ' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('assertYamahaMonthNotQuoted', () => {
  it('blocks entries of a month with a live quotation', async () => {
    const db = { quotation: { findFirst: vi.fn(async () => ({ quotationNo: 'QT2026-004', yamahaMonth: '2026-10' })) } };
    await expect(assertYamahaMonthNotQuoted(db as never, [{ date: day('2026-10-15'), size: 'LARGE' }])).rejects.toMatchObject({ response: { error: expect.stringContaining('QT2026-004') } });
    // ล็อกเฉพาะขนาดเดียวกัน (หรือใบเก่าที่ไม่ระบุขนาด)
    expect(db.quotation.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({ where: { status: { in: ['ISSUED', 'APPROVED'] }, OR: [{ yamahaMonth: '2026-10', OR: [{ yamahaSize: 'LARGE' }, { yamahaSize: null }] }] } }),
    ]);
  });
});

describe('billing gate for customers that need a quotation', () => {
  it('refuses a custom bill that does not come from a quotation', async () => {
    const prisma = {
      customer: { findUnique: vi.fn(async () => ({ id: 'c1', name: 'YM', company: null, billingRequiresQuotation: true, billingVat: true, billingWhtRate: 3, billingWhtSpecialRate: null, billingWhtSpecialUntil: null, billingCreditDays: null, accountPeriods: [] })) },
    };
    const svc = new BillingService(prisma as unknown as PrismaService);
    const dto = { customerId: 'c1', invoiceNo: 'IV2026-130', issueDate: '2026-11-05', jobLabel: '', items: [{ kind: 'SERVICE', description: 'x', quantity: 1, unitPrice: 100 }] };
    await expect(svc.createCustomInvoice(dto)).rejects.toMatchObject({ response: { error: QUOTATION_REQUIRED_ERROR } });
  });
});
