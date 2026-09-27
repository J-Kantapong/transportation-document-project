import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from './billing.service.js';

// บัญชีรับเงินของลูกค้า (ผู้ใช้ 2026-09-27) - ตั้ง/ย้ายบัญชีพร้อมวันเริ่มใช้ และกันออกใบวางบิลบัญชีบุคคลในระบบ
const asAdmin = <T>(fn: () => T) => requestContext.run({ user: { id: 'u1', roles: ['ADMIN'], customerId: null, name: 'แอดมิน' } } as never, fn);
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);

function service(periods: Array<{ id: string; account: string; effectiveFrom: Date }>) {
  const created = vi.fn().mockResolvedValue({});
  const updated = vi.fn().mockResolvedValue({});
  const audit = vi.fn().mockResolvedValue({ id: 'a1' });
  const prisma = {
    customer: {
      findUnique: vi.fn().mockImplementation(async (args: { select?: { accountPeriods?: { include?: unknown } } }) =>
        args.select?.accountPeriods?.include
          ? { accountPeriods: periods.map((p) => ({ ...p, remark: 'r', createdBy: null, createdAt: new Date() })) }
          : { id: 'c1', accountPeriods: periods },
      ),
    },
    customerAccountPeriod: { create: created, update: updated },
    auditLog: { create: audit },
    $queryRaw: vi.fn().mockResolvedValue([]),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new BillingService(prisma), created, updated, audit };
}

describe('BillingService.setAccount', () => {
  it('moves a customer to the personal account from a date, with a reason and an audit row', async () => {
    const { svc, created, audit } = service([]);
    await asAdmin(() => svc.setAccount('c1', { account: 'PERSONAL', effectiveFrom: '2026-10-01', remark: 'แยกบัญชี' }));
    expect(created.mock.calls[0][0].data).toMatchObject({ customerId: 'c1', account: 'PERSONAL', effectiveFrom: day('2026-10-01'), createdById: 'u1' });
    expect(audit.mock.calls[0][0].data).toMatchObject({ entity: 'Customer', action: 'set-account', remark: 'แยกบัญชี' });
  });

  it('refuses to set the account that is already in effect on that date', async () => {
    const { svc, created } = service([{ id: 'p1', account: 'PERSONAL', effectiveFrom: day('2026-01-01') }]);
    await expect(asAdmin(() => svc.setAccount('c1', { account: 'PERSONAL', effectiveFrom: '2026-10-01', remark: 'x' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('อยู่แล้ว') } });
    expect(created).not.toHaveBeenCalled();
  });

  it('changes the row of the same start date instead of adding a second one', async () => {
    const { svc, created, updated } = service([{ id: 'p1', account: 'PERSONAL', effectiveFrom: day('2026-10-01') }]);
    await asAdmin(() => svc.setAccount('c1', { account: 'COMPANY', effectiveFrom: '2026-10-01', remark: 'ตั้งผิด' }));
    expect(updated.mock.calls[0][0]).toMatchObject({ where: { id: 'p1' }, data: { account: 'COMPANY' } });
    expect(created).not.toHaveBeenCalled();
  });

  it('needs a reason', async () => {
    const { svc } = service([]);
    await expect(asAdmin(() => svc.setAccount('c1', { account: 'PERSONAL', effectiveFrom: '2026-10-01', remark: '' }))).rejects.toThrow();
  });
});

describe('BillingService.createInvoice with collection accounts', () => {
  const periods = [{ account: 'PERSONAL', effectiveFrom: day('2026-09-01') }];
  const vehicleOn = (id: string, delivered: string) => ({
    id,
    customerId: 'c1',
    chassis: `CH-${id}`,
    body: null,
    plateCategory: null,
    plateNumber: null,
    deliveredDate: day(delivered),
    billingClosedAt: null,
    brand: { name: 'Toyota' },
    documentSubmissions: [],
    invoiceLines: [],
  });

  function invoiceService(vehicles: unknown[]) {
    const create = vi.fn().mockImplementation(async ({ data }) => ({
      id: 'i1',
      status: 'ISSUED',
      paidDate: null,
      taxInvoiceNo: null,
      voidReason: null,
      ...data,
      lines: data.lines.createMany.data.map((l: object, n: number) => ({ id: `l${n}`, ...l })),
    }));
    const prisma = {
      customer: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'c1',
          name: 'YMAC',
          billingVat: true, // ตั้ง VAT ไว้ก็ตาม บัญชีบุคคลไม่คิด VAT
          billingWhtRate: 0,
          billingWhtSpecialRate: null,
          billingWhtSpecialUntil: null,
          accountPeriods: periods,
        }),
      },
      invoice: { findUnique: vi.fn().mockResolvedValue(null), create },
      vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) },
      $queryRaw: vi.fn().mockResolvedValue([]),
      $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    } as unknown as PrismaService;
    return { svc: new BillingService(prisma), create };
  }

  const dto = (ids: string[]) => ({
    customerId: 'c1',
    invoiceNo: 'P2026-001',
    issueDate: '2026-09-27',
    jobLabel: 'จดทะเบียนรถยนต์',
    lines: ids.map((vehicleId) => ({ vehicleId, receiptAmount: 1000, serviceFee: 500 })),
  });

  it('issues a personal-account bill without VAT for vehicles delivered on the personal account', async () => {
    const { svc, create } = invoiceService([vehicleOn('v1', '2026-09-20')]);
    const invoice = await svc.createInvoice(dto(['v1']));
    expect(create.mock.calls[0][0].data.account).toBe('PERSONAL');
    expect(invoice).toMatchObject({ account: 'PERSONAL', vatRate: 0, vatAmount: 0, netTotal: 1500 });
  });

  it('keeps VAT for vehicles delivered before the customer moved to the personal account', async () => {
    const { svc } = invoiceService([vehicleOn('v1', '2026-08-20')]);
    const invoice = await svc.createInvoice(dto(['v1']));
    expect(invoice).toMatchObject({ account: 'COMPANY', vatRate: 7, vatAmount: 35 });
  });

  it('refuses one bill mixing vehicles from both accounts', async () => {
    const { svc, create } = invoiceService([vehicleOn('v1', '2026-08-20'), vehicleOn('v2', '2026-09-20')]);
    await expect(svc.createInvoice(dto(['v1', 'v2']))).rejects.toMatchObject({ response: { error: expect.stringContaining('แยก') } });
    expect(create).not.toHaveBeenCalled();
  });
});
