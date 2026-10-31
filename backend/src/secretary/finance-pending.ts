// ข้อมูลของการ์ด "การเงินค้าง" (ผู้ใช้ 2026-10-31) - อ่านอย่างเดียว เงื่อนไขเดียวกับหน้าจอจริง:
// รอวางบิล = คิวของ BillingService.queue (รถ) + loadJobs (งานอื่นๆ: ส่งงานแล้ว ยังไม่อยู่ในบิลที่ไม่ VOID ไม่ได้ปิดงาน)
// 50 ทวิ = WHT_PENDING_WHERE ของหน้าใบกำกับภาษี · ใบเสนอราคา = stageOf ของหน้าใบเสนอราคา
import { WHT_OVERDUE_DAYS, WHT_PENDING_WHERE } from '../billing/tax-invoice.service.js';
import { daysBetween, overdueByCustomer } from '../overview/overview-calculator.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { previousMonth, type FinancePending, type PayrollStatus } from './finance-message.js';

// 50 ทวิ ที่อีกไม่เกินกี่วันจะเกินกำหนด (Claude เลือก)
const WHT_SOON_DAYS = 5;

const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);
const nameOf = (c: { company: string | null; name: string } | null | undefined) => c?.company?.trim() || c?.name || 'ไม่ระบุลูกค้า';

export async function loadFinancePending(prisma: PrismaService, today: string): Promise<FinancePending> {
  const month = today.slice(0, 7);
  const prevMonth = previousMonth(month);
  const doneJob = { customerId: { not: null }, cancelledAt: null, returnedDate: { not: null }, deliveredDate: { not: null } };
  const jobSelect = { id: true, customerId: true, deliveredDate: true } as const;

  const [runs, vehicles, transfers, cancels, copies, moveOuts, renewals, invoices, whts, quotations] = await Promise.all([
    prisma.payrollRun.findMany({ where: { month: { in: [month, prevMonth] }, cancelledAt: null }, select: { month: true, status: true } }),
    prisma.vehicle.findMany({
      where: { deletedAt: null, billingClosedAt: null, deliveredDate: { not: null }, invoiceLines: { none: NOT_VOID } },
      select: { customerId: true, deliveredDate: true },
    }),
    prisma.vehicleTransfer.findMany({ where: doneJob, select: jobSelect }),
    prisma.vehicleUseCancellation.findMany({ where: doneJob, select: jobSelect }),
    prisma.plateCopy.findMany({ where: doneJob, select: jobSelect }),
    prisma.vehicleMoveOut.findMany({ where: doneJob, select: jobSelect }),
    prisma.taxRenewal.findMany({ where: { customerId: { not: null }, cancelledAt: null, deliveredDate: { not: null }, paymentDate: { not: null } }, select: jobSelect }),
    prisma.invoice.findMany({
      where: { status: 'ISSUED' },
      select: { invoiceNo: true, issueDate: true, dueDate: true, netTotal: true, account: true, customerId: true, customer: { select: { name: true, company: true } } },
      orderBy: { issueDate: 'asc' },
    }),
    prisma.taxInvoice.findMany({ where: WHT_PENDING_WHERE, select: { issueDate: true, whtAmount: true } }),
    prisma.quotation.findMany({
      where: { status: { in: ['DRAFT', 'ISSUED', 'APPROVED'] } },
      select: { status: true, kind: true, validUntil: true, ratesAppliedAt: true, invoices: { where: { status: { not: 'VOID' } }, select: { id: true }, take: 1 } },
    }),
  ]);

  const statusOf = (m: string): PayrollStatus => {
    const run = runs.find((r) => r.month === m);
    return run ? (run.status as PayrollStatus) : 'NONE';
  };

  // งานอื่นๆ: ตัดที่ลงบิลแล้ว / ปิดงานนอกระบบแล้ว (ผูกด้วย sourceType/sourceId เหมือน loadJobs)
  const jobs = [
    ...transfers.map((j) => ({ ...j, type: 'TRANSFER' })),
    ...cancels.map((j) => ({ ...j, type: 'USE_CANCEL' })),
    ...copies.map((j) => ({ ...j, type: 'PLATE_COPY' })),
    ...moveOuts.map((j) => ({ ...j, type: 'MOVE_OUT' })),
    ...renewals.map((j) => ({ ...j, type: 'TAX_RENEWAL' })),
  ];
  const ids = jobs.map((j) => j.id);
  const [billedItems, closures] = ids.length
    ? await Promise.all([
        prisma.invoiceItem.findMany({ where: { sourceType: { not: null }, sourceId: { in: ids }, ...NOT_VOID }, select: { sourceType: true, sourceId: true } }),
        prisma.jobBillingClosure.findMany({ where: { jobId: { in: ids } }, select: { jobType: true, jobId: true } }),
      ])
    : [[], []];
  const taken = new Set([...billedItems.map((r) => `${r.sourceType}:${r.sourceId}`), ...closures.map((r) => `${r.jobType}:${r.jobId}`)]);
  const openJobs = jobs.filter((j) => !taken.has(`${j.type}:${j.id}`));

  const perCustomer = new Map<string, { vehicles: number; jobs: number }>();
  const bump = (id: string | null, field: 'vehicles' | 'jobs') => {
    const key = id ?? '';
    const row = perCustomer.get(key) ?? { vehicles: 0, jobs: 0 };
    row[field] += 1;
    perCustomer.set(key, row);
  };
  for (const v of vehicles) bump(v.customerId, 'vehicles');
  for (const j of openJobs) bump(j.customerId, 'jobs');
  const customerRows = perCustomer.size
    ? await prisma.customer.findMany({ where: { id: { in: [...perCustomer.keys()].filter(Boolean) } }, select: { id: true, name: true, company: true } })
    : [];
  const customers = [...perCustomer.entries()]
    .map(([id, counts]) => ({ customerName: nameOf(customerRows.find((c) => c.id === id)), ...counts }))
    .sort((a, b) => b.vehicles + b.jobs - (a.vehicles + a.jobs));
  const delivered = [...vehicles, ...openJobs].map((r) => iso(r.deliveredDate!)).filter((d) => d <= today);
  const oldestDelivered = delivered.length ? delivered.reduce((a, b) => (a < b ? a : b)) : null;

  const sumOf = (rows: typeof invoices) => ({ count: rows.length, amount: Math.round(rows.reduce((s, r) => s + num(r.netTotal), 0) * 100) / 100 });
  const first = invoices[0];

  const whtAges = whts.map((t) => daysBetween(iso(t.issueDate), today));

  let waiting = 0;
  let expired = 0;
  let approvedUnused = 0;
  let drafts = 0;
  for (const q of quotations) {
    if (q.status === 'DRAFT') drafts += 1;
    else if (q.status === 'ISSUED') {
      if (iso(q.validUntil) < today) expired += 1;
      else waiting += 1;
    } else if (q.kind === 'RATE' ? !q.ratesAppliedAt : q.invoices.length === 0) approvedUnused += 1;
  }

  return {
    today,
    payroll: { month, status: statusOf(month) },
    previousPayroll: { month: prevMonth, status: statusOf(prevMonth) },
    unbilled: {
      vehicles: vehicles.length,
      jobs: openJobs.length,
      oldestDays: oldestDelivered ? daysBetween(oldestDelivered, today) : null,
      customers,
    },
    receivables: {
      ...sumOf(invoices),
      company: sumOf(invoices.filter((i) => i.account !== 'PERSONAL')),
      personal: sumOf(invoices.filter((i) => i.account === 'PERSONAL')),
      oldest: first
        ? { invoiceNo: first.invoiceNo, customerName: nameOf(first.customer), amount: num(first.netTotal), days: daysBetween(iso(first.issueDate), today) }
        : null,
      // เลยวันคาดรับเงิน (dueDate จากรอบจ่าย / เครดิตของลูกค้า, ผู้ใช้ 2026-10-31) - กฎเดียวกับ workingCapital.overdue ของภาพรวม
      pastDue: (({ count, amount, customers }) => ({ count, amount, customers: customers.map(({ customerName, count: c, amount: a, maxDaysOver }) => ({ customerName, count: c, amount: a, maxDaysOver })) }))(
        overdueByCustomer(
          invoices.map((i) => ({ customerId: i.customerId, customerName: nameOf(i.customer), dueDate: i.dueDate ? iso(i.dueDate) : null, amount: num(i.netTotal) })),
          today,
        ),
      ),
    },
    wht: {
      count: whts.length,
      amount: Math.round(whts.reduce((s, t) => s + num(t.whtAmount), 0) * 100) / 100,
      overdue: whtAges.filter((d) => d > WHT_OVERDUE_DAYS).length,
      soon: whtAges.filter((d) => d <= WHT_OVERDUE_DAYS && d > WHT_OVERDUE_DAYS - WHT_SOON_DAYS).length,
    },
    quotations: { waiting, expired, approvedUnused, drafts },
  };
}
