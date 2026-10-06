import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { round2 } from '../billing/billing-calculator.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fullNameOf } from './employees.service.js';
import { computePayroll, payrollTotals, SSO_RATE_PERCENT, ssoWageCapFor } from './payroll-calc.js';

// เงินเดือนรายเดือน (ผู้ใช้ 2026-10-05) - ADMIN เท่านั้น
// DRAFT (แก้รายการได้ คำนวณใหม่จากทะเบียนพนักงานได้) -> APPROVED (ล็อก) -> PAID (บันทึกวันที่จ่ายจริง)
// ย้อนสถานะ (ยกเลิกอนุมัติ / ยกเลิกการจ่าย) และยกเลิกทั้งรอบต้องมีเหตุผล + AuditLog entity 'PayrollRun'
// ยกเลิกรอบ = soft (cancelledAt) แล้วสร้างรอบเดือนเดิมใหม่ได้ - รอบที่จ่ายแล้วต้องยกเลิกการจ่ายก่อน

const bad = (error: string) => new BadRequestException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const nameOf = () => currentUser()?.name ?? null;

function parseMonth(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw)) throw bad('เดือนต้องเป็นรูปแบบ ค.ศ. YYYY-MM');
  return raw;
}

function money(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 99_999_999) throw bad(`${label}ต้องเป็นจำนวนเงินตั้งแต่ 0 ขึ้นไป`);
  return round2(raw);
}

function note(raw: unknown, label: string): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'string') throw bad(`${label}ต้องเป็นข้อความ`);
  const value = raw.trim();
  if (value.length > 200) throw bad(`${label}ยาวเกิน 200 ตัวอักษร`);
  return value || null;
}

const RUN_INCLUDE = { items: { orderBy: [{ sortOrder: 'asc' as const }, { code: 'asc' as const }] } };

type RunRow = Prisma.PayrollRunGetPayload<{ include: typeof RUN_INCLUDE }>;

function mapItem(i: RunRow['items'][number]) {
  return {
    id: i.id,
    employeeId: i.employeeId,
    code: i.code,
    fullName: i.fullName,
    position: i.position,
    salary: Number(i.salary),
    otherIncome: Number(i.otherIncome),
    otherIncomeNote: i.otherIncomeNote,
    ssoAmount: Number(i.ssoAmount),
    taxAmount: Number(i.taxAmount),
    otherDeduction: Number(i.otherDeduction),
    deductionNote: i.deductionNote,
    netPay: Number(i.netPay),
    ssoManual: i.ssoManual,
    taxManual: i.taxManual,
  };
}

function mapRun(r: RunRow) {
  const items = r.items.map(mapItem);
  return {
    id: r.id,
    month: r.month,
    status: r.cancelledAt ? 'CANCELLED' : r.status,
    payDate: iso(r.payDate),
    ssoRate: Number(r.ssoRate),
    ssoWageCap: Number(r.ssoWageCap),
    createdByName: r.createdByName,
    createdAt: r.createdAt.toISOString(),
    approvedAt: r.approvedAt?.toISOString() ?? null,
    approvedByName: r.approvedByName,
    paidAt: r.paidAt?.toISOString() ?? null,
    paidByName: r.paidByName,
    cancelledAt: r.cancelledAt?.toISOString() ?? null,
    cancelReason: r.cancelReason,
    cancelledByName: r.cancelledByName,
    updatedAt: r.updatedAt.toISOString(),
    items,
    totals: payrollTotals(items),
  };
}

type EmployeeTerms = { id: string; code: string; prefix: string | null; firstName: string; lastName: string | null; position: string | null; baseSalary: unknown; socialSecurity: boolean; withholdTax: boolean; otherAllowance: unknown };

// บรรทัดเงินเดือนตั้งต้นของพนักงาน 1 คน จากข้อมูลในทะเบียน
function itemFromEmployee(e: EmployeeTerms, cap: number, sortOrder: number) {
  const result = computePayroll({ salary: Number(e.baseSalary), otherIncome: 0, otherDeduction: 0 }, { socialSecurity: e.socialSecurity, withholdTax: e.withholdTax, otherAllowance: Number(e.otherAllowance) }, cap);
  return {
    employeeId: e.id,
    code: e.code,
    fullName: fullNameOf(e),
    position: e.position,
    salary: result.salary,
    otherIncome: 0,
    ssoAmount: result.ssoAmount,
    taxAmount: result.taxAmount,
    otherDeduction: 0,
    netPay: result.netPay,
    sortOrder,
  };
}

@Injectable()
export class PayrollService {
  constructor(private readonly prisma: PrismaService) {}

  // รอบเงินเดือนทั้งหมด เดือนใหม่สุดก่อน (รวมที่ยกเลิก - หน้าจอแสดงขีดฆ่า) พร้อมยอดรวม
  async listRuns() {
    const runs = await this.prisma.payrollRun.findMany({ orderBy: [{ month: 'desc' }, { createdAt: 'desc' }], include: RUN_INCLUDE });
    return { runs: runs.map((r) => ({ ...mapRun(r), items: undefined, employeeCount: r.items.length })) };
  }

  async getRun(id: string) {
    const run = await this.prisma.payrollRun.findUnique({ where: { id }, include: RUN_INCLUDE });
    if (!run) throw new NotFoundException({ error: 'ไม่พบรอบเงินเดือน' });
    const mapped = mapRun(run);
    // ยอดสะสมตั้งแต่ต้นปี (ค.ศ.) ถึงเดือนของรอบนี้ ไว้พิมพ์บนสลิป: รวมรอบเดือนก่อนหน้าของปีเดียวกันที่ไม่ยกเลิก + รอบนี้
    const earlier = await this.prisma.payrollItem.findMany({
      where: { employeeId: { in: run.items.map((i) => i.employeeId) }, run: { id: { not: run.id }, cancelledAt: null, month: { gte: `${run.month.slice(0, 4)}-01`, lt: run.month } } },
      select: { employeeId: true, salary: true, otherIncome: true, ssoAmount: true, taxAmount: true },
    });
    const ytd = new Map<string, { income: number; sso: number; tax: number }>();
    for (const i of earlier) {
      const acc = ytd.get(i.employeeId) ?? { income: 0, sso: 0, tax: 0 };
      acc.income += Number(i.salary) + Number(i.otherIncome);
      acc.sso += Number(i.ssoAmount);
      acc.tax += Number(i.taxAmount);
      ytd.set(i.employeeId, acc);
    }
    return {
      ...mapped,
      items: mapped.items.map((i) => {
        const before = ytd.get(i.employeeId) ?? { income: 0, sso: 0, tax: 0 };
        return { ...i, ytd: { income: round2(before.income + i.salary + i.otherIncome), sso: round2(before.sso + i.ssoAmount), tax: round2(before.tax + i.taxAmount) } };
      }),
    };
  }

  // สร้างรอบเดือนใหม่ (DRAFT) จากพนักงานที่ทำงานอยู่ + ที่ลาออกในเดือนนั้นหรือหลังจากนั้น
  async createRun(dto: { month?: unknown }) {
    const month = parseMonth(dto?.month);
    const monthStart = new Date(`${month}-01T00:00:00.000Z`);
    const employees = await this.prisma.employee.findMany({
      where: { OR: [{ status: 'ACTIVE' }, { status: 'RESIGNED', resignedDate: { gte: monthStart } }] },
      orderBy: { code: 'asc' },
    });
    if (!employees.length) throw bad('ยังไม่มีพนักงานในทะเบียน');
    const cap = ssoWageCapFor(Number(month.slice(0, 4)));
    try {
      const run = await this.prisma.$transaction(async (tx) => {
        const created = await tx.payrollRun.create({
          data: { month, ssoRate: SSO_RATE_PERCENT, ssoWageCap: cap, createdByName: nameOf(), items: { create: employees.map((e, i) => itemFromEmployee(e, cap, i)) } },
          include: RUN_INCLUDE,
        });
        await writeAudit(tx, { entity: 'PayrollRun', entityId: created.id, action: 'create', remark: `สร้างรอบเงินเดือน ${month}`, changes: { month, employees: employees.length } });
        return created;
      });
      return mapRun(run);
    } catch (err) {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException({ error: `เดือน ${month} มีรอบเงินเดือนอยู่แล้ว (ยกเลิกรอบเดิมก่อนถ้าจะสร้างใหม่)` });
      throw err;
    }
  }

  // คำนวณใหม่จากทะเบียนพนักงาน (เงินเดือน/ประกันสังคม/ภาษี/พนักงานเข้า-ออก เปลี่ยนหลังสร้างรอบ) - ทับรายการที่แก้ไว้ทั้งหมด จึงทำได้เฉพาะ DRAFT
  async recalculate(id: string) {
    return this.inDraft(id, async (tx, run) => {
      const monthStart = new Date(`${run.month}-01T00:00:00.000Z`);
      const employees = await tx.employee.findMany({
        where: { OR: [{ status: 'ACTIVE' }, { status: 'RESIGNED', resignedDate: { gte: monthStart } }] },
        orderBy: { code: 'asc' },
      });
      if (!employees.length) throw bad('ไม่มีพนักงานในทะเบียน');
      await tx.payrollItem.deleteMany({ where: { runId: id } });
      await tx.payrollItem.createMany({ data: employees.map((e, i) => ({ runId: id, ...itemFromEmployee(e, Number(run.ssoWageCap), i) })) });
      await writeAudit(tx, { entity: 'PayrollRun', entityId: id, action: 'recalculate', remark: 'คำนวณใหม่จากทะเบียนพนักงาน', changes: { employees: employees.length } });
    });
  }

  // แก้รายการรายคัน (DRAFT เท่านั้น): ประกันสังคม/ภาษีไม่ส่งมา = ระบบคำนวณใหม่จากยอดที่แก้ ส่งตัวเลขมา = พิมพ์ทับ, ส่ง null = กลับไปให้ระบบคำนวณ
  async updateItem(runId: string, itemId: string, dto: Record<string, unknown>) {
    return this.inDraft(runId, async (tx) => {
      const item = await tx.payrollItem.findFirst({ where: { id: itemId, runId }, include: { employee: true, run: { select: { ssoWageCap: true, ssoRate: true } } } });
      if (!item) throw new NotFoundException({ error: 'ไม่พบรายการเงินเดือน' });
      const pick = <T>(key: string, parse: (v: unknown) => T, current: T): T => (dto[key] === undefined ? current : parse(dto[key]));
      const salary = pick('salary', (v) => money(v, 'เงินเดือน'), Number(item.salary));
      if (salary <= 0) throw bad('เงินเดือนต้องมากกว่า 0');
      const otherIncome = pick('otherIncome', (v) => money(v, 'รายได้อื่น'), Number(item.otherIncome));
      const otherDeduction = pick('otherDeduction', (v) => money(v, 'รายการหัก'), Number(item.otherDeduction));
      // ช่อง sso / tax: ไม่ส่ง = คงสถานะเดิม (พิมพ์ทับอยู่ก็ยังทับ), ส่ง null = ให้ระบบคำนวณ, ส่งตัวเลข = พิมพ์ทับ
      const override = (key: 'sso' | 'tax', current: number, manual: boolean): number | null => {
        if (dto[key] === undefined) return manual ? current : null;
        return dto[key] === null ? null : money(dto[key], key === 'sso' ? 'ประกันสังคม' : 'ภาษีหัก ณ ที่จ่าย');
      };
      const result = computePayroll(
        { salary, otherIncome, otherDeduction, sso: override('sso', Number(item.ssoAmount), item.ssoManual), tax: override('tax', Number(item.taxAmount), item.taxManual) },
        { socialSecurity: item.employee.socialSecurity, withholdTax: item.employee.withholdTax, otherAllowance: Number(item.employee.otherAllowance) },
        Number(item.run.ssoWageCap),
        Number(item.run.ssoRate),
      );
      if (result.netPay < 0) throw bad('ยอดสุทธิติดลบ - ตรวจรายการหักอีกครั้ง');
      await tx.payrollItem.update({
        where: { id: itemId },
        data: {
          salary: result.salary,
          otherIncome: result.otherIncome,
          otherIncomeNote: dto.otherIncomeNote === undefined ? item.otherIncomeNote : note(dto.otherIncomeNote, 'หมายเหตุรายได้อื่น'),
          otherDeduction: result.otherDeduction,
          deductionNote: dto.deductionNote === undefined ? item.deductionNote : note(dto.deductionNote, 'หมายเหตุรายการหัก'),
          ssoAmount: result.ssoAmount,
          taxAmount: result.taxAmount,
          netPay: result.netPay,
          ssoManual: result.ssoManual,
          taxManual: result.taxManual,
        },
      });
    });
  }

  async approve(id: string) {
    return this.transition(id, 'DRAFT', 'APPROVED', 'approve', 'อนุมัติรอบเงินเดือน', { approvedAt: new Date(), approvedByName: nameOf() }, async (tx) => {
      if ((await tx.payrollItem.count({ where: { runId: id } })) === 0) throw bad('รอบนี้ไม่มีรายการเงินเดือน');
    });
  }

  async unapprove(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิกการอนุมัติ');
    return this.transition(id, 'APPROVED', 'DRAFT', 'unapprove', remark, { approvedAt: null, approvedByName: null });
  }

  // บันทึกว่าจ่ายแล้ว: วันที่จ่ายจริงต้องไม่เกินวันนี้ (กดหลังโอนเงินแล้วเท่านั้น)
  async pay(id: string, dto: { payDate?: unknown }) {
    if (typeof dto?.payDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dto.payDate) || !Number.isFinite(Date.parse(dto.payDate))) throw bad('วันที่จ่ายต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง');
    if (dto.payDate > bangkokToday()) throw bad('วันที่จ่ายต้องไม่เกินวันนี้ (บันทึกหลังจ่ายแล้วเท่านั้น)');
    return this.transition(id, 'APPROVED', 'PAID', 'pay', `จ่ายเงินเดือนวันที่ ${dto.payDate}`, { payDate: new Date(`${dto.payDate}T00:00:00.000Z`), paidAt: new Date(), paidByName: nameOf() });
  }

  async unpay(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิกการจ่าย');
    return this.transition(id, 'PAID', 'APPROVED', 'unpay', remark, { payDate: null, paidAt: null, paidByName: null });
  }

  async cancel(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิกรอบเงินเดือน');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    await this.prisma.$transaction(async (tx) => {
      const run = await tx.payrollRun.findUnique({ where: { id }, select: { month: true, status: true, cancelledAt: true } });
      if (!run) throw new NotFoundException({ error: 'ไม่พบรอบเงินเดือน' });
      if (run.status === 'PAID') throw bad('รอบนี้จ่ายแล้ว - ยกเลิกการจ่ายก่อนจึงจะยกเลิกรอบได้');
      const { count } = await tx.payrollRun.updateMany({
        where: { id, status: { in: ['DRAFT', 'APPROVED'] }, cancelledAt: null },
        data: { cancelledAt: new Date(), cancelReason: remark, cancelledByName: nameOf() },
      });
      if (count === 0) throw new ConflictException({ error: 'รอบนี้เปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่' });
      await writeAudit(tx, { entity: 'PayrollRun', entityId: id, action: 'cancel', remark, changes: { month: run.month, status: { from: run.status, to: 'CANCELLED' } } });
    });
    return this.getRun(id);
  }

  async history(id: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: { entity: 'PayrollRun', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    return { history: logs.map((l) => ({ id: l.id, action: l.action, remark: l.remark, by: l.editedBy ? l.editedBy.displayName || l.editedBy.name : null, at: l.createdAt.toISOString() })) };
  }

  // เปลี่ยนสถานะแบบมีเงื่อนไข (updateMany where status เดิม) - สองคนกดพร้อมกันหรือหน้าจอค้าง = คนที่สองได้ 409
  private async transition(id: string, from: string, to: string, action: string, remark: string, data: Prisma.PayrollRunUpdateManyMutationInput, check?: (tx: Prisma.TransactionClient) => Promise<void>) {
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.payrollRun.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException({ error: 'ไม่พบรอบเงินเดือน' });
      await check?.(tx);
      const { count } = await tx.payrollRun.updateMany({ where: { id, status: from, cancelledAt: null }, data: { ...data, status: to } });
      if (count === 0) throw new ConflictException({ error: 'รอบนี้เปลี่ยนสถานะไปแล้ว กรุณาโหลดใหม่' });
      await writeAudit(tx, { entity: 'PayrollRun', entityId: id, action, remark, changes: { status: { from, to } } });
    });
    return this.getRun(id);
  }

  // งานที่แก้ได้เฉพาะ DRAFT: แตะแถวรอบก่อน (updateMany where DRAFT) เพื่อล็อกแถวไว้จนจบ transaction - กดอนุมัติพร้อมกันกับแก้รายการจะไม่ปนกัน
  private async inDraft(id: string, work: (tx: Prisma.TransactionClient, run: { month: string; ssoWageCap: unknown }) => Promise<void>) {
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.payrollRun.updateMany({ where: { id, status: 'DRAFT', cancelledAt: null }, data: { updatedAt: new Date() } });
      if (count === 0) {
        if (!(await tx.payrollRun.findUnique({ where: { id }, select: { id: true } }))) throw new NotFoundException({ error: 'ไม่พบรอบเงินเดือน' });
        throw new ConflictException({ error: 'รอบนี้อนุมัติหรือยกเลิกไปแล้ว แก้ไม่ได้ (ยกเลิกการอนุมัติก่อนถ้าต้องการแก้)' });
      }
      const run = await tx.payrollRun.findUniqueOrThrow({ where: { id }, select: { month: true, ssoWageCap: true } });
      await work(tx, run);
    });
    return this.getRun(id);
  }
}
