import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SupplierService } from './supplier.service.js';
import { thaiIdCheckDigit } from './wht-issue-calc.js';

const as = <T>(fn: () => T) => requestContext.run({ user: { id: 'admin1', roles: ['ADMIN'], customerId: null, name: 'ผู้ดูแล' } } as never, fn);
const ID_OK = '123456789012' + String(thaiIdCheckDigit('123456789012'));

const row = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  name: 'นาย ซับ ทดสอบ',
  taxId: ID_OK,
  address: null,
  defaultIncomeType: 'SERVICE',
  defaultDescription: 'ค่าจ้างทำของ',
  defaultRate: 3,
  status: 'ACTIVE',
  note: null,
  updatedAt: new Date('2026-10-06T00:00:00.000Z'),
  _count: { whtCertificates: 0 },
  ...over,
});

function setup(opts: { existing?: unknown; updateCount?: number; createError?: unknown } = {}) {
  const create = vi.fn(async (_args: { data: Record<string, unknown> }) => {
    if (opts.createError) throw opts.createError;
    return row();
  });
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => row(data));
  const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
  const prisma = {
    supplier: {
      create,
      update,
      findUnique: vi.fn().mockResolvedValue(opts.existing === undefined ? row() : opts.existing),
      findUniqueOrThrow: vi.fn().mockResolvedValue(row({ status: 'INACTIVE' })),
      updateMany: vi.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
    },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new SupplierService(prisma), create, update, auditCreate };
}

const input = (over: Record<string, unknown> = {}) => ({ name: ' นาย  ซับ ทดสอบ ', taxId: ID_OK, address: ' 99/9 ', defaultIncomeType: 'SERVICE', defaultDescription: 'ค่าจ้างทำของ', defaultRate: 3, ...over });

describe('SupplierService.create', () => {
  it('normalises the fields (spaces, dashes in the tax id) and writes an audit row', async () => {
    const { svc, create, auditCreate } = setup();
    await as(() => svc.create(input({ taxId: `${ID_OK.slice(0, 1)}-${ID_OK.slice(1, 5)}-${ID_OK.slice(5)}` })));
    expect(create.mock.calls[0][0].data).toMatchObject({ name: 'นาย ซับ ทดสอบ', taxId: ID_OK, address: '99/9', defaultRate: 3 });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'Supplier', action: 'add' });
  });

  it.each([
    ['empty name', { name: ' ' }, 'ชื่อ'],
    ['bad checksum', { taxId: '1234567890123' }, '13 หลัก'],
    ['salary as default type', { defaultIncomeType: 'SALARY' }, 'ประเภทเงินได้'],
    ['rate over 100', { defaultRate: 101 }, 'อัตราภาษี'],
  ])('rejects %s', async (_name, over, message) => {
    const { svc, create } = setup();
    await expect(as(() => svc.create(input(over)))).rejects.toMatchObject({ response: { error: expect.stringContaining(message) } });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 409 when the tax id is already registered', async () => {
    const { svc } = setup({ createError: { code: 'P2002' } });
    await expect(as(() => svc.create(input()))).rejects.toMatchObject({ response: { error: expect.stringContaining('อยู่แล้ว') } });
  });
});

describe('SupplierService.update', () => {
  it('needs a reason, logs only the changed fields, and refuses a no-op', async () => {
    const { svc, auditCreate } = setup();
    await expect(as(() => svc.update('s1', input({ address: 'ที่ใหม่' })))).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
    await as(() => svc.update('s1', { ...input({ address: 'ที่ใหม่' }), remark: 'ย้ายบ้าน', expectedUpdatedAt: '2026-10-06T00:00:00.000Z' }));
    expect(auditCreate.mock.calls[0][0].data.changes).toEqual({ address: { from: null, to: 'ที่ใหม่' } });
    await expect(as(() => svc.update('s1', { ...input({ address: null }), remark: 'x' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่มีข้อมูลที่เปลี่ยน') } });
  });

  it('answers 409 when the row was changed since the form loaded', async () => {
    const { svc } = setup();
    await expect(as(() => svc.update('s1', { ...input({ address: 'ที่ใหม่' }), remark: 'x', expectedUpdatedAt: '2026-01-01T00:00:00.000Z' }))).rejects.toMatchObject({
      response: { error: expect.stringContaining('ถูกแก้ไปแล้ว') },
    });
  });
});

describe('SupplierService.setStatus', () => {
  it('deactivates with a reason and an audit row; 409 when already in that state', async () => {
    const { svc, auditCreate } = setup();
    await expect(as(() => svc.setStatus('s1', 'INACTIVE', {}))).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
    await as(() => svc.setStatus('s1', 'INACTIVE', { remark: 'เลิกจ้างแล้ว' }));
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'Supplier', action: 'deactivate' });
    const dup = setup({ updateCount: 0 });
    await expect(as(() => dup.svc.setStatus('s1', 'INACTIVE', { remark: 'x' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('เลิกใช้ไปแล้ว') } });
  });
});
