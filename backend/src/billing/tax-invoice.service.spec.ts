import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { TaxInvoiceService } from './tax-invoice.service.js';

const asUser = <T>(fn: () => T) => requestContext.run({ user: { id: 'u1', roles: ['ACCOUNTANT'], customerId: null, name: 'บัญชี' } }, fn);

const customer = { id: 'c1', name: 'TWE', company: 'บริษัท ทีดับเบิ้ลอี มอเตอร์ จำกัด', branch: null, address: 'สมุทรปราการ', taxId: '0105560000000' };

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'i1',
    invoiceNo: 'IV2026-121',
    issueDate: new Date('2026-10-01T00:00:00.000Z'),
    status: 'ISSUED',
    account: 'COMPANY',
    vatRate: 7,
    feeTotal: 20435,
    serviceTotal: 38290,
    goodsTotal: 0,
    vatAmount: 2680.3,
    whtAmount: 1148.7,
    customerId: 'c1',
    customer,
    updatedAt: new Date('2026-10-01T05:00:00.000Z'),
    ...over,
  };
}

// ฐานข้อมูลปลอมพอให้ issue / cancel ทำงาน - เก็บแถวที่สร้างไว้ตรวจ
function fakeDb(opts: { invoice?: Record<string, unknown>; lastNumber?: number | null; lastTv?: { taxInvoiceNo: string; issueDate: Date } | null; replaceable?: Record<string, unknown> | null } = {}) {
  const created: Array<Record<string, unknown>> = [];
  const invoiceUpdates: Array<Record<string, unknown>> = [];
  const seriesUpdates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const enabled = opts.lastNumber !== null;
  const invoice = invoiceRow(opts.invoice);
  const db: Record<string, unknown> = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => (strings.join('?').includes('TaxInvoiceSeries') ? [{ lastNumber: opts.lastNumber ?? 0 }] : [])),
    $executeRaw: vi.fn(async () => 1),
    invoice: {
      findUnique: vi.fn(async () => invoice),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => {
        invoiceUpdates.push(a.data);
        return invoice;
      }),
    },
    taxInvoiceSeries: {
      count: vi.fn(async () => (enabled ? 1 : 0)),
      update: vi.fn(async (a: { data: Record<string, unknown> }) => seriesUpdates.push(a.data)),
    },
    taxInvoice: {
      findFirst: vi.fn(async (a: { where: Record<string, unknown> }) => (a.where.status === 'CANCELLED' ? (opts.replaceable ?? null) : (opts.lastTv ?? null))),
      create: vi.fn(async (a: { data: Record<string, unknown> }) => {
        created.push(a.data);
        return { id: 'tv-new', ...a.data };
      }),
      update: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => ({ id: 'tv1', invoiceId: 'i1', status: 'ISSUED', taxInvoiceNo: 'TV2026-005' })),
    },
    auditLog: { create: vi.fn(async (a: { data: Record<string, unknown> }) => audits.push(a.data)) },
  };
  db.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(db));
  const svc = new TaxInvoiceService(db as unknown as PrismaService, {} as ReceiptStorage);
  // ไม่ต้องอ่านใบที่เพิ่งออกกลับ - ทดสอบแค่สิ่งที่เขียน
  vi.spyOn(svc, 'get').mockImplementation(async (id: string) => ({ id }) as never);
  return { svc, created, invoiceUpdates, seriesUpdates, audits };
}

describe('TaxInvoiceService.issue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-20T03:00:00.000Z'));
  });
  afterEach(() => vi.useRealTimers());

  const ok = { paidDate: '2026-10-20', whtAmount: 1148.7, whtMethod: 'PAPER' };

  it('gives the next number of the paid-date year, snapshots amounts and marks the bill paid', async () => {
    const { svc, created, invoiceUpdates, seriesUpdates } = fakeDb({ lastNumber: 157 });
    await asUser(() => svc.issue('i1', ok));
    expect(seriesUpdates).toEqual([{ lastNumber: 158 }]);
    expect(created[0]).toMatchObject({
      taxInvoiceNo: 'TV2026-158',
      year: 2026,
      number: 158,
      grandTotal: 61405.3,
      whtAmount: 1148.7,
      receivedAmount: 60256.6,
      whtMethod: 'PAPER',
      createdById: 'u1',
      customerSnapshot: { name: 'บริษัท ทีดับเบิ้ลอี มอเตอร์ จำกัด', branch: null, address: 'สมุทรปราการ', taxId: '0105560000000' },
    });
    expect(invoiceUpdates[0]).toMatchObject({ status: 'PAID', taxInvoiceNo: 'TV2026-158' });
  });

  it('refuses before ADMIN has set the starting number', async () => {
    const { svc, created } = fakeDb({ lastNumber: null });
    await expect(svc.issue('i1', ok)).rejects.toMatchObject({ response: { error: 'ยังไม่ได้เปิดใช้ใบกำกับในระบบ - ADMIN ต้องตั้งเลขเริ่มก่อน' } });
    expect(created).toHaveLength(0);
  });

  it('keeps numbers in date order: a date before the latest tax invoice is refused', async () => {
    const { svc, created } = fakeDb({ lastNumber: 10, lastTv: { taxInvoiceNo: 'TV2026-010', issueDate: new Date('2026-10-20T00:00:00.000Z') } });
    await expect(svc.issue('i1', { ...ok, paidDate: '2026-10-19' })).rejects.toMatchObject({ status: 400 });
    expect(created).toHaveLength(0);
  });

  it('personal-account and no-VAT bills have no tax invoice', async () => {
    await expect(fakeDb({ lastNumber: 1, invoice: { account: 'PERSONAL' } }).svc.issue('i1', ok)).rejects.toMatchObject({ status: 400 });
    await expect(fakeDb({ lastNumber: 1, invoice: { vatRate: 0 } }).svc.issue('i1', ok)).rejects.toMatchObject({ status: 400 });
  });

  it('a bill already paid (other screen) = 409', async () => {
    await expect(fakeDb({ lastNumber: 1, invoice: { status: 'PAID' } }).svc.issue('i1', ok)).rejects.toMatchObject({ status: 409 });
  });

  it('requires the buyer tax id unless the buyer is not VAT registered', async () => {
    const noTaxId = { customer: { ...customer, taxId: null } };
    await expect(fakeDb({ lastNumber: 1, invoice: noTaxId }).svc.issue('i1', ok)).rejects.toMatchObject({ status: 400 });
    const { svc, created } = fakeDb({ lastNumber: 1, invoice: noTaxId });
    await svc.issue('i1', { ...ok, buyerNotVatRegistered: true });
    expect(created[0]).toMatchObject({ buyerNotVatRegistered: true });
  });

  it('WHT deducted must say paper or e-WHT; the actual amount may differ from the bill', async () => {
    await expect(fakeDb({ lastNumber: 1 }).svc.issue('i1', { ...ok, whtMethod: 'NONE' })).rejects.toMatchObject({ status: 400 });
    const { svc, created } = fakeDb({ lastNumber: 1 });
    await svc.issue('i1', { ...ok, whtAmount: 382.9, whtMethod: 'EWHT' });
    expect(created[0]).toMatchObject({ whtAmount: 382.9, receivedAmount: 61022.4, whtMethod: 'EWHT' });
  });

  it('reissue after a cancel refers to the cancelled one and carries its 50 ทวิ', async () => {
    const { svc, created } = fakeDb({ lastNumber: 5, replaceable: { id: 'tv-old', taxInvoiceNo: 'TV2026-005', cancelReason: 'ชื่อผิด', whtCertificateId: 'cert1' } });
    await svc.issue('i1', ok);
    expect(created[0]).toMatchObject({ replacesId: 'tv-old', whtCertificateId: 'cert1', taxInvoiceNo: 'TV2026-006' });
  });
});

describe('TaxInvoiceService.cancel', () => {
  it('needs a reason, keeps the number, returns the bill to waiting and logs it', async () => {
    const { svc, invoiceUpdates, audits } = fakeDb({ lastNumber: 5, invoice: { status: 'PAID', paidDate: new Date('2026-10-20T00:00:00.000Z') } });
    await expect(svc.cancel('tv1', { remark: ' ' })).rejects.toMatchObject({ status: 400 });
    await asUser(() => svc.cancel('tv1', { remark: 'ชื่อลูกค้าผิด' }));
    expect(invoiceUpdates[0]).toEqual({ status: 'ISSUED', paidDate: null, taxInvoiceNo: null });
    expect(audits[0]).toMatchObject({ entity: 'Invoice', entityId: 'i1', action: 'cancel-tax-invoice', remark: 'ชื่อลูกค้าผิด', editedById: 'u1' });
  });
});
