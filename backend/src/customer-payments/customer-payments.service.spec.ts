import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomerPaymentsService, normalizeChassis } from './customer-payments.service.js';

const as = <T>(roles: string[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'พนักงาน' } } as never, fn);

const car = {
  id: 'v1',
  chassis: 'MR0AB12G300123456',
  body: 'รย.1-เก๋ง 4 ประตู',
  plateCategory: '1กก',
  plateNumber: '1234',
  deliveredDate: new Date('2026-09-20T00:00:00.000Z'),
  brand: { name: 'Toyota' },
  paymentLines: [{ amount: 500 }],
};
const moto = { ...car, id: 'v2', chassis: 'MLHJC123', body: 'รย.12-รถจักรยานยนต์', paymentLines: [] };

function service(vehicles: unknown[], periods: unknown[] = []) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({
    id: 'p1',
    createdAt: new Date('2026-09-27T03:00:00.000Z'),
    cancelledAt: null,
    cancelReason: null,
    createdBy: null,
    cancelledBy: null,
    ...data,
    lines: data.lines.createMany.data.map((l: object, n: number) => ({ id: `l${n}`, vehicle: null, ...l })),
  }));
  const updateMany = vi.fn().mockResolvedValue({ count: 1 });
  const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
  const findVehicles = vi.fn().mockResolvedValue(vehicles);
  const prisma = {
    customer: { findUnique: vi.fn().mockResolvedValue({ id: 'c1', accountPeriods: periods }) },
    vehicle: { findMany: findVehicles },
    customerPayment: {
      create,
      updateMany,
      findUnique: vi.fn().mockResolvedValue({
        id: 'p1',
        customerId: 'c1',
        account: 'PERSONAL',
        paidDate: new Date('2026-09-26T00:00:00.000Z'),
        amount: 1000,
        whtAmount: 0,
        reference: null,
        note: null,
        createdAt: new Date(),
        cancelledAt: null,
        cancelReason: null,
        createdBy: null,
        cancelledBy: null,
        lines: [],
      }),
    },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new CustomerPaymentsService(prisma), create, updateMany, auditCreate, findVehicles };
}

describe('normalizeChassis', () => {
  it('ignores case, spaces and dashes pasted from a spreadsheet', () => {
    expect(normalizeChassis(' mr0ab12-g300 123456 ')).toBe('MR0AB12G300123456');
  });
});

describe('CustomerPaymentsService.create', () => {
  it('matches pasted chassis to the customer vehicles and keeps unmatched rows', async () => {
    const { svc, create } = service([car], [{ account: 'PERSONAL', effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }]);
    const payment = await as(['ADMIN'], () =>
      svc.create({
        customerId: 'c1',
        paidDate: '2026-09-26',
        amount: 1500,
        lines: [
          { chassis: 'mr0ab12g300123456', amount: 1000 },
          { chassis: 'UNKNOWN1', amount: 500 },
        ],
      }),
    );
    const data = create.mock.calls[0][0].data;
    expect(data.account).toBe('PERSONAL'); // account on the paid date
    expect(data.lines.createMany.data.map((l: { vehicleId: string | null }) => l.vehicleId)).toEqual(['v1', null]);
    expect(payment.linesTotal).toBe(1500);
  });

  it('rejects the same chassis twice in one payment', async () => {
    const { svc } = service([car]);
    await expect(
      as(['ADMIN'], () =>
        svc.create({
          customerId: 'c1',
          paidDate: '2026-09-26',
          amount: 100,
          lines: [
            { chassis: 'ABC-1', amount: 50 },
            { chassis: 'abc1', amount: 50 },
          ],
        }),
      ),
    ).rejects.toThrow();
  });

  it('does not let STAFF_CAR record a payment line for a motorcycle', async () => {
    const { svc, create } = service([moto]);
    await expect(
      as(['STAFF_CAR'], () => svc.create({ customerId: 'c1', paidDate: '2026-09-26', amount: 100, lines: [{ chassis: 'MLHJC123', amount: 100 }] })),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a payment with only the transferred total', async () => {
    const { svc, create } = service([]);
    await as(['STAFF_CAR'], () => svc.create({ customerId: 'c1', paidDate: '2026-09-26', amount: 25000 }));
    expect(create.mock.calls[0][0].data.account).toBe('COMPANY');
  });

  it('rejects a paid date in the future', async () => {
    const { svc } = service([]);
    await expect(as(['ADMIN'], () => svc.create({ customerId: 'c1', paidDate: '2999-01-01', amount: 1 }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่เกินวันนี้') } });
  });
});

describe('CustomerPaymentsService.cancel', () => {
  it('needs a reason and writes an audit row', async () => {
    const { svc, auditCreate } = service([]);
    await expect(as(['ADMIN'], () => svc.cancel('p1', { remark: ' ' }))).rejects.toThrow();
    await as(['ADMIN'], () => svc.cancel('p1', { remark: 'คีย์ยอดผิด' }));
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'CustomerPayment', entityId: 'p1', action: 'cancel', remark: 'คีย์ยอดผิด' });
  });

  it('answers 409 when the payment was already cancelled', async () => {
    const { svc, updateMany } = service([]);
    updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(as(['ADMIN'], () => svc.cancel('p1', { remark: 'ซ้ำ' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ยกเลิกไปแล้ว') } });
  });
});
