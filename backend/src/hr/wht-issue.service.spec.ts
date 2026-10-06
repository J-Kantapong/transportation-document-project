import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { thaiIdCheckDigit } from './wht-issue-calc.js';
import { WhtIssueService } from './wht-issue.service.js';

const as = <T>(fn: () => T) => requestContext.run({ user: { id: 'admin1', roles: ['ADMIN'], customerId: null, name: 'ผู้ดูแล' } } as never, fn);
const withCheckDigit = (first12: string) => first12 + String(thaiIdCheckDigit(first12));
const ID_OK = withCheckDigit('123456789012');
const ID_OK_2 = withCheckDigit('210987654321');

const employee = (over: Record<string, unknown> = {}) => ({ id: 'e1', code: 'TI001', prefix: 'นาย', firstName: 'ทดสอบ', lastName: 'ระบบ', idType: 'CITIZEN', idNumber: ID_OK, ...over });
const payItem = (over: Record<string, unknown> = {}) => ({ employeeId: 'e1', salary: 25000, otherIncome: 0, ssoAmount: 875, taxAmount: 0, run: { payDate: new Date('2025-01-31T00:00:00.000Z') }, ...over });

function setup(opts: { employees?: unknown[]; items?: unknown[]; existing?: unknown[]; maxNumber?: number | null; replaces?: unknown; updateCount?: number; seriesLast?: number | null; certCount?: number } = {}) {
  const certCreate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `c-${String(data.number)}`, certificateNo: data.certificateNo }));
  const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
  const prisma = {
    employee: { findMany: vi.fn().mockResolvedValue(opts.employees ?? [employee()]) },
    payrollItem: { findMany: vi.fn().mockResolvedValue(opts.items ?? [payItem()]) },
    issuedWhtCertificate: {
      findMany: vi.fn().mockResolvedValue(opts.existing ?? []),
      findFirst: vi.fn().mockResolvedValue(opts.replaces ?? null),
      findUnique: vi.fn().mockResolvedValue({ certificateNo: '2026-001', status: 'ISSUED', payeeName: 'x', totalPaid: 1, totalTax: 0 }),
      count: vi.fn().mockResolvedValue(opts.certCount ?? 0),
      aggregate: vi.fn().mockResolvedValue({ _max: { number: opts.maxNumber ?? null } }),
      create: certCreate,
      updateMany: vi.fn().mockResolvedValue({ count: opts.updateCount ?? 1 }),
    },
    supplier: { findUnique: vi.fn().mockResolvedValue({ id: 's1' }) },
    issuedWhtSeries: { findUnique: vi.fn().mockResolvedValue(opts.seriesLast == null ? null : { year: 2026, lastNumber: opts.seriesLast }), upsert: vi.fn().mockResolvedValue({}) },
    auditLog: { create: auditCreate },
    $executeRaw: vi.fn().mockResolvedValue(0),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  return { svc: new WhtIssueService(prisma), prisma, certCreate, auditCreate };
}

describe('WhtIssueService.issueEmployeeYear', () => {
  it('issues a ภ.ง.ด.1ก salary certificate from the paid payroll, numbered after the highest existing number', async () => {
    const { svc, certCreate, auditCreate } = setup({
      items: [payItem(), payItem({ otherIncome: 5000, taxAmount: 100, run: { payDate: new Date('2025-12-30T00:00:00.000Z') } })],
      maxNumber: 4,
    });
    const r = await as(() => svc.issueEmployeeYear({ year: 2025, issueDate: '2026-01-15', employeeIds: ['e1'] }));
    expect(r.created).toEqual([{ id: 'c-5', employeeId: 'e1', certificateNo: '2025-005' }]);
    const data = certCreate.mock.calls[0][0].data as { totalPaid: number; totalTax: number; ssoAmount: number; formType: string; payeeKind: string; items: { create: Array<Record<string, unknown>> } };
    expect(data).toMatchObject({ formType: 'PND1K', payeeKind: 'EMPLOYEE', totalPaid: 55000, totalTax: 100, ssoAmount: 1750 });
    expect(data.items.create).toHaveLength(1);
    expect(data.items.create[0]).toMatchObject({ incomeType: 'SALARY', dateLabel: 'ม.ค. - ธ.ค. 2025', amountPaid: 55000, taxWithheld: 100 });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'IssuedWhtCertificate', action: 'issue' });
  });

  it('skips employees that already have a live certificate, have no paid salary, or have a bad citizen id', async () => {
    const employees = [employee(), employee({ id: 'e2', code: 'TI002', idNumber: ID_OK_2 }), employee({ id: 'e3', code: 'TI003', idNumber: '1234567890123' })];
    const { svc, certCreate } = setup({ employees, items: [payItem(), payItem({ employeeId: 'e3' })], existing: [{ employeeId: 'e1' }] });
    const r = await as(() => svc.issueEmployeeYear({ year: 2025, issueDate: '2026-01-15', employeeIds: ['e1', 'e2', 'e3'] }));
    expect(r.created).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual([expect.stringContaining('ออกใบของปีนี้ไปแล้ว'), expect.stringContaining('ไม่มีเงินเดือนที่จ่ายแล้ว'), expect.stringContaining('เลขประจำตัวไม่ถูกต้อง')]);
    expect(certCreate).not.toHaveBeenCalled();
  });

  it('links a reissue to the cancelled certificate it replaces', async () => {
    const { svc, certCreate } = setup({ replaces: { id: 'old1' } });
    await as(() => svc.issueEmployeeYear({ year: 2025, issueDate: '2026-01-15', employeeIds: ['e1'] }));
    expect((certCreate.mock.calls[0][0].data as { replacesId: string }).replacesId).toBe('old1');
  });

  it('rejects a future issue date, a bad year and an empty selection', async () => {
    const { svc } = setup();
    await expect(as(() => svc.issueEmployeeYear({ year: 2026, issueDate: '2999-01-01', employeeIds: ['e1'] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่เกินวันนี้') } });
    await expect(as(() => svc.issueEmployeeYear({ year: 1999, issueDate: '2026-01-15', employeeIds: ['e1'] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ปีภาษี') } });
    await expect(as(() => svc.issueEmployeeYear({ year: 2025, issueDate: '2026-01-15', employeeIds: [] }))).rejects.toMatchObject({ response: { error: expect.stringContaining('อย่างน้อย 1 คน') } });
  });
});

describe('WhtIssueService.issueOther', () => {
  const base = () => ({ taxYear: 2026, issueDate: '2026-06-30', payeeName: ' ผู้รับ  จ้าง ', payeeTaxId: ID_OK, items: [{ incomeType: 'SERVICE', description: 'ค่าจ้างทำของ', paidDate: '2026-06-10', amountPaid: 10000, taxWithheld: 300 }] });

  it('issues a ภ.ง.ด.3 certificate with server-computed totals and a normalised name', async () => {
    const { svc, certCreate } = setup();
    // get() อ่านใบที่เพิ่งสร้างกลับ
    (svc as unknown as { get: () => Promise<unknown> }).get = vi.fn().mockResolvedValue({ id: 'c-1' });
    await as(() => svc.issueOther({ ...base(), totalPaid: 1, totalTax: 1 }));
    expect(certCreate.mock.calls[0][0].data).toMatchObject({ payeeName: 'ผู้รับ จ้าง', formType: 'PND3', payeeKind: 'OTHER', totalPaid: 10000, totalTax: 300, certificateNo: '2026-001' });
  });

  it('rejects a tax id with a wrong checksum, and a withholding certificate with no tax at all', async () => {
    const { svc, certCreate } = setup();
    await expect(as(() => svc.issueOther({ ...base(), payeeTaxId: '1234567890123' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('13 หลัก') } });
    const noTax = { ...base(), items: [{ ...base().items[0], taxWithheld: 0 }] };
    await expect(as(() => svc.issueOther(noTax))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่มีภาษีที่หักเลย') } });
    expect(certCreate).not.toHaveBeenCalled();
  });
});

describe('WhtIssueService.issueOther with a registered supplier', () => {
  const dto = () => ({
    taxYear: 2026,
    issueDate: '2026-06-30',
    payeeName: 'ผู้รับ',
    payeeTaxId: ID_OK,
    supplierId: 's1',
    items: [{ incomeType: 'SERVICE', description: 'ค่าจ้างทำของ', paidDate: '2026-06-10', amountPaid: 10000, taxWithheld: 300 }],
  });

  it('stores the supplier link next to the typed snapshot', async () => {
    const { svc, certCreate } = setup();
    (svc as unknown as { get: () => Promise<unknown> }).get = vi.fn().mockResolvedValue({ id: 'c-1' });
    await as(() => svc.issueOther(dto()));
    expect(certCreate.mock.calls[0][0].data).toMatchObject({ supplierId: 's1', payeeName: 'ผู้รับ' });
  });

  it('rejects a supplier id that is not in the register', async () => {
    const { svc, prisma } = setup();
    (prisma.supplier.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(as(() => svc.issueOther(dto()))).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่พบ Supplier ในทะเบียน') } });
  });
});

describe('WhtIssueService.cancel', () => {
  it('needs a reason, cancels with a conditional update and writes an audit row', async () => {
    const { svc, auditCreate, prisma } = setup();
    await expect(as(() => svc.cancel('c1', {}))).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
    (svc as unknown as { get: () => Promise<unknown> }).get = vi.fn().mockResolvedValue({ id: 'c1' });
    await as(() => svc.cancel('c1', { remark: 'ชื่อผิด' }));
    expect((prisma.issuedWhtCertificate.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where).toEqual({ id: 'c1', status: 'ISSUED' });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'IssuedWhtCertificate', action: 'cancel', remark: 'ชื่อผิด' });
  });

  it('answers 409 when the certificate was already cancelled', async () => {
    const { svc } = setup({ updateCount: 0 });
    await expect(as(() => svc.cancel('c1', { remark: 'x' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ยกเลิกไปแล้ว') } });
  });
});

describe('WhtIssueService numbering and series', () => {
  it('continues after the number used outside the system (series 8 -> 2025-009)', async () => {
    const { svc, certCreate } = setup({ seriesLast: 8, maxNumber: null });
    await as(() => svc.issueEmployeeYear({ year: 2025, issueDate: '2026-01-15', employeeIds: ['e1'] }));
    expect((certCreate.mock.calls[0][0].data as { certificateNo: string }).certificateNo).toBe('2025-009');
  });

  it('never goes below the highest number already in the system', async () => {
    const { svc, certCreate } = setup({ seriesLast: 3, maxNumber: 12 });
    await as(() => svc.issueEmployeeYear({ year: 2025, issueDate: '2026-01-15', employeeIds: ['e1'] }));
    expect((certCreate.mock.calls[0][0].data as { certificateNo: string }).certificateNo).toBe('2025-013');
  });

  it('sets the last number with a reason and an audit row, and refuses once the year has certificates', async () => {
    const { svc, prisma, auditCreate } = setup({ seriesLast: 8 });
    await as(() => svc.setSeries({ year: 2026, lastNumber: 8, remark: 'ออกจากไฟล์เดิม 2026-001 ถึง 008' }));
    expect((prisma.issuedWhtSeries.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ create: { year: 2026, lastNumber: 8 } });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'IssuedWhtSeries', action: 'set-last-number' });
    await expect(as(() => svc.setSeries({ year: 2026, lastNumber: 8 }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ที่มา') } });
    const used = setup({ certCount: 2 });
    await expect(as(() => used.svc.setSeries({ year: 2026, lastNumber: 8, remark: 'x' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ในระบบไปแล้ว') } });
  });
});
