import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmployeesService } from './employees.service.js';
import { PayrollService } from './payroll.service.js';

const as = <T>(fn: () => T) => requestContext.run({ user: { id: 'admin1', roles: ['ADMIN'], customerId: null, name: 'ผู้ดูแล' } } as never, fn);

const employee = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  code: 'TI002',
  prefix: 'นาง',
  firstName: 'สมใจ',
  lastName: 'ใจดี',
  position: 'ที่ปรึกษา',
  baseSalary: 25_000,
  socialSecurity: true,
  withholdTax: true,
  otherAllowance: 0,
  status: 'ACTIVE',
  resignedDate: null,
  ...over,
});

const runRow = (over: Record<string, unknown> = {}) => ({
  id: 'r1',
  month: '2026-10',
  status: 'DRAFT',
  payDate: null,
  ssoRate: 5,
  ssoWageCap: 17_500,
  createdByName: null,
  approvedAt: null,
  approvedByName: null,
  paidAt: null,
  paidByName: null,
  cancelledAt: null,
  cancelReason: null,
  cancelledByName: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
  updatedAt: new Date('2026-10-01T00:00:00.000Z'),
  items: [],
  ...over,
});

function setup(overrides: { updateMany?: number } = {}) {
  const create = vi.fn().mockImplementation(async ({ data }) => runRow({ month: data.month, items: data.items.create.map((i: object, n: number) => ({ id: `i${n}`, otherIncomeNote: null, deductionNote: null, ssoManual: false, taxManual: false, ...i })) }));
  const updateMany = vi.fn().mockResolvedValue({ count: overrides.updateMany ?? 1 });
  const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
  const itemUpdate = vi.fn().mockResolvedValue({});
  const prisma = {
    employee: { findMany: vi.fn().mockResolvedValue([employee(), employee({ id: 'e2', code: 'TI001', baseSalary: 45_000, socialSecurity: false })]) },
    payrollRun: {
      create,
      updateMany,
      findUnique: vi.fn().mockResolvedValue(runRow()),
      findUniqueOrThrow: vi.fn().mockResolvedValue({ month: '2026-10', ssoWageCap: 17_500 }),
    },
    payrollItem: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(2),
      findFirst: vi.fn().mockResolvedValue({
        id: 'i1',
        runId: 'r1',
        salary: 25_000,
        otherIncome: 0,
        otherIncomeNote: null,
        otherDeduction: 0,
        deductionNote: null,
        ssoAmount: 875,
        taxAmount: 0,
        ssoManual: false,
        taxManual: false,
        employee: employee(),
        run: { ssoWageCap: 17_500, ssoRate: 5 },
      }),
      update: itemUpdate,
    },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new PayrollService(prisma), prisma, create, updateMany, auditCreate, itemUpdate };
}

describe('PayrollService.createRun', () => {
  it('builds one line per employee with SSO and tax worked out, in employee-code order', async () => {
    const { svc, create, auditCreate } = setup();
    const run = await as(() => svc.createRun({ month: '2026-10' }));
    const items = create.mock.calls[0][0].data.items.create;
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ code: 'TI002', salary: 25_000, ssoAmount: 875, taxAmount: 0, netPay: 24_125 });
    // พนักงานที่ไม่เข้าประกันสังคม และเงินเดือน 45,000 -> หักภาษี 1,291.67
    expect(items[1]).toMatchObject({ code: 'TI001', ssoAmount: 0, taxAmount: 1_291.67, netPay: 43_708.33 });
    expect(create.mock.calls[0][0].data.ssoWageCap).toBe(17_500);
    expect(run.totals.net).toBe(67_833.33);
    expect(auditCreate).toHaveBeenCalledTimes(1);
  });

  it('rejects a malformed month', async () => {
    const { svc } = setup();
    await expect(as(() => svc.createRun({ month: '2026-13' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('YYYY-MM') } });
  });

  it('answers 409 when the month already has a live run', async () => {
    const { svc, create } = setup();
    create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(as(() => svc.createRun({ month: '2026-10' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('มีรอบเงินเดือนอยู่แล้ว') } });
  });
});

describe('PayrollService.getRun year-to-date', () => {
  it('adds earlier months of the same year to this month for the payslip', async () => {
    const { svc, prisma } = setup();
    (prisma.payrollRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      runRow({ month: '2026-10', items: [{ id: 'i1', employeeId: 'e1', code: 'TI002', fullName: 'x', position: null, salary: 25_000, otherIncome: 0, otherIncomeNote: null, ssoAmount: 875, taxAmount: 0, otherDeduction: 0, deductionNote: null, netPay: 24_125, ssoManual: false, taxManual: false }] }),
    );
    (prisma.payrollItem.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { employeeId: 'e1', salary: 25_000, otherIncome: 1_000, ssoAmount: 875, taxAmount: 10 },
      { employeeId: 'e1', salary: 25_000, otherIncome: 0, ssoAmount: 875, taxAmount: 0 },
    ]);
    const run = await as(() => svc.getRun('r1'));
    expect(run.items[0].ytd).toEqual({ income: 76_000, sso: 2_625, tax: 10 });
    // เฉพาะรอบเดือนก่อนหน้าของปีเดียวกันที่ไม่ยกเลิก
    expect((prisma.payrollItem.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where.run).toMatchObject({ cancelledAt: null, month: { gte: '2026-01', lt: '2026-10' } });
  });
});

describe('PayrollService.updateItem', () => {
  it('recomputes net pay and keeps SSO/tax automatic unless typed over', async () => {
    const { svc, itemUpdate } = setup();
    await as(() => svc.updateItem('r1', 'i1', { otherIncome: 2_000, otherDeduction: 500 }));
    // รายได้ 27,000 x 12 = 324,000 - 100,000 - 60,000 - 9,000 = 155,000 -> ภาษี 250/ปี = 20.83/เดือน
    expect(itemUpdate.mock.calls[0][0].data).toMatchObject({ ssoAmount: 875, taxAmount: 20.83, ssoManual: false, taxManual: false, netPay: 25_604.17 });
  });

  it('flags a typed-over SSO amount', async () => {
    const { svc, itemUpdate } = setup();
    await as(() => svc.updateItem('r1', 'i1', { sso: 750 }));
    expect(itemUpdate.mock.calls[0][0].data).toMatchObject({ ssoAmount: 750, ssoManual: true, netPay: 24_250 });
  });

  it('refuses once the run has left DRAFT', async () => {
    const { svc, itemUpdate } = setup({ updateMany: 0 });
    await expect(as(() => svc.updateItem('r1', 'i1', { otherIncome: 1 }))).rejects.toMatchObject({ response: { error: expect.stringContaining('แก้ไม่ได้') } });
    expect(itemUpdate).not.toHaveBeenCalled();
  });

  it('refuses a negative net pay', async () => {
    const { svc, itemUpdate } = setup();
    await expect(as(() => svc.updateItem('r1', 'i1', { otherDeduction: 99_999 }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ติดลบ') } });
    expect(itemUpdate).not.toHaveBeenCalled();
  });
});

describe('PayrollService status changes', () => {
  it('approve moves DRAFT to APPROVED conditionally and writes the audit row', async () => {
    const { svc, updateMany, auditCreate } = setup();
    await as(() => svc.approve('r1'));
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'r1', status: 'DRAFT', cancelledAt: null }, data: { status: 'APPROVED' } });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'PayrollRun', action: 'approve' });
  });

  it('answers 409 when someone else already changed the status', async () => {
    const { svc, auditCreate } = setup({ updateMany: 0 });
    await expect(as(() => svc.approve('r1'))).rejects.toMatchObject({ response: { error: expect.stringContaining('เปลี่ยนสถานะไปแล้ว') } });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('needs a reason to undo an approval or a payment', async () => {
    const { svc } = setup();
    await expect(as(() => svc.unapprove('r1', {}))).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
    await expect(as(() => svc.unpay('r1', { remark: '  ' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
  });

  it('refuses a pay date in the future', async () => {
    const { svc } = setup();
    await expect(as(() => svc.pay('r1', { payDate: '2999-01-01' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่เกินวันนี้') } });
  });

  it('will not cancel a run that is already paid', async () => {
    const { svc, prisma } = setup();
    (prisma.payrollRun.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ month: '2026-10', status: 'PAID', cancelledAt: null });
    await expect(as(() => svc.cancel('r1', { remark: 'ผิดเดือน' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ยกเลิกการจ่ายก่อน') } });
  });
});

describe('EmployeesService.importMany', () => {
  const row = (code: string, idNumber: string) => ({ code, firstName: 'ทดสอบ', idType: 'CITIZEN', idNumber, baseSalary: 15_000, socialSecurity: true, withholdTax: true });
  const make = (existing: Array<{ code: string; idNumber: string }> = []) => {
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { employee: { findMany: vi.fn().mockResolvedValue(existing), createMany } } as unknown as PrismaService;
    return { svc: new EmployeesService(prisma), createMany };
  };

  it('creates new rows and skips codes or ID numbers that already exist', async () => {
    const { svc, createMany } = make([{ code: 'TI001', idNumber: '1000000000001' }]);
    const r = await svc.importMany({ rows: [row('TI001', '1000000000009'), row('TI002', '1000000000001'), row('TI003', '1000000000003')] });
    expect(r.created).toBe(1);
    expect(r.skipped.map((s) => s.code)).toEqual(['TI001', 'TI002']);
    expect(createMany.mock.calls[0][0].data).toHaveLength(1);
  });

  it('imports nothing when any row is invalid', async () => {
    const { svc, createMany } = make();
    await expect(svc.importMany({ rows: [row('TI001', '1000000000001'), row('TI002', '123')] })).rejects.toMatchObject({ response: { error: expect.stringContaining('แถวที่ 2') } });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('rejects the same code twice in one paste', async () => {
    const { svc } = make();
    await expect(svc.importMany({ rows: [row('TI001', '1000000000001'), row('ti001', '1000000000002')] })).rejects.toMatchObject({ response: { error: expect.stringContaining('ซ้ำ') } });
  });

  it('takes a foreign worker with an 11-digit number as type OTHER', async () => {
    const { svc, createMany } = make();
    await svc.importMany({ rows: [{ ...row('TI005', '11012012590'), idType: 'OTHER' }] });
    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({ idType: 'OTHER', idNumber: '11012012590' });
  });
});
