import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { round2 } from '../billing/billing-calculator.js';
import { SELLER_PROFILE } from '../billing/seller-profile.js';
import type { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { fullNameOf } from './employees.service.js';
import {
  cleanItems,
  formatCertificateNo,
  isValidThaiId,
  MAX_AMOUNT,
  PAY_METHODS,
  periodLabel,
  totalsOf,
  type CleanItem,
  type FormType,
  type PayMethod,
} from './wht-issue-calc.js';

// 50 ทวิ ที่บริษัทออกให้ผู้รับเงิน (ผู้ใช้ 2026-10-06) - ADMIN เท่านั้น (อยู่ใต้ /api/hr)
// EMPLOYEE: ออกปลายปีจากเงินเดือนของรอบที่ "จ่ายแล้ว" (ยอดอ่านจาก PayrollItem ฝั่ง server เสมอ ไม่รับยอดจากหน้าจอ) -> ภ.ง.ด.1ก
// OTHER: บุคคลธรรมดาอื่น (ซับ/ผู้รับจ้าง) พิมพ์ข้อมูลเอง -> ภ.ง.ด.3
// ออกแล้วแก้ไม่ได้ ผิด = ยกเลิก (ต้องมีเหตุผล + AuditLog) แล้วออกใหม่ที่อ้างใบเดิม (replacesId)

const bad = (error: string) => new BadRequestException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const day = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);
const nameOf = () => currentUser()?.name ?? null;

const CERT_INCLUDE = {
  items: { orderBy: { sortOrder: 'asc' as const } },
  replacedBy: { select: { id: true, certificateNo: true } },
} satisfies Prisma.IssuedWhtCertificateInclude;

type CertRow = Prisma.IssuedWhtCertificateGetPayload<{ include: typeof CERT_INCLUDE }>;

function mapCert(c: CertRow) {
  return {
    id: c.id,
    certificateNo: c.certificateNo,
    taxYear: c.taxYear,
    issueDate: iso(c.issueDate),
    payeeKind: c.payeeKind as 'EMPLOYEE' | 'OTHER',
    employeeId: c.employeeId,
    supplierId: c.supplierId,
    payeeName: c.payeeName,
    payeeTaxId: c.payeeTaxId,
    payeeAddress: c.payeeAddress,
    formType: c.formType as FormType,
    payMethod: c.payMethod as PayMethod,
    totalPaid: Number(c.totalPaid),
    totalTax: Number(c.totalTax),
    ssoAmount: Number(c.ssoAmount),
    providentFund: Number(c.providentFund),
    payer: c.payerSnapshot,
    note: c.note,
    status: c.status as 'ISSUED' | 'CANCELLED',
    cancelledAt: c.cancelledAt?.toISOString() ?? null,
    cancelReason: c.cancelReason,
    cancelledByName: c.cancelledByName,
    replacesId: c.replacesId,
    replacedBy: c.replacedBy,
    createdByName: c.createdByName,
    createdAt: c.createdAt.toISOString(),
    items: c.items.map((i) => ({
      id: i.id,
      incomeType: i.incomeType,
      description: i.description,
      paidDate: iso(i.paidDate)!,
      dateLabel: i.dateLabel,
      amountPaid: Number(i.amountPaid),
      taxWithheld: Number(i.taxWithheld),
    })),
  };
}

interface YearPay {
  employeeId: string;
  income: number;
  sso: number;
  tax: number;
  payDates: string[];
}

function parseYear(raw: unknown): number {
  const year = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof year !== 'number' || !Number.isInteger(year) || year < 2020 || year > 2100) throw bad('ปีภาษีต้องเป็น ค.ศ. เช่น 2026');
  return year;
}

function parseIssueDate(raw: unknown, taxYear: number): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || day(raw).toISOString().slice(0, 10) !== raw) throw bad('วันที่ออกต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง');
  if (raw > bangkokToday()) throw bad('วันที่ออกต้องไม่เกินวันนี้');
  if (Number(raw.slice(0, 4)) < taxYear) throw bad('วันที่ออกต้องไม่ก่อนปีภาษีที่จ่ายเงิน');
  return raw;
}

function optionalText(raw: unknown, max: number, label: string): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw bad(`${label}ต้องเป็นข้อความ`);
  const t = raw.trim();
  if (t.length > max) throw bad(`${label}ยาวเกิน ${max} ตัวอักษร`);
  return t || null;
}

@Injectable()
export class WhtIssueService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: { year?: string; kind?: string; q?: string }) {
    const where: Prisma.IssuedWhtCertificateWhereInput = {};
    if (query.year) where.taxYear = parseYear(query.year);
    if (query.kind === 'EMPLOYEE' || query.kind === 'OTHER') where.payeeKind = query.kind;
    const q = query.q?.trim();
    if (q) where.OR = [{ payeeName: { contains: q, mode: 'insensitive' } }, { payeeTaxId: { contains: q } }, { certificateNo: { contains: q, mode: 'insensitive' } }];
    const rows = await this.prisma.issuedWhtCertificate.findMany({ where, orderBy: [{ taxYear: 'desc' }, { number: 'desc' }], take: 500, include: CERT_INCLUDE });
    return { certificates: rows.map(mapCert), truncated: rows.length === 500 };
  }

  async get(id: string) {
    const row = await this.prisma.issuedWhtCertificate.findUnique({ where: { id }, include: CERT_INCLUDE });
    if (!row) throw new NotFoundException({ error: 'ไม่พบ 50 ทวิ' });
    return mapCert(row);
  }

  async history(id: string) {
    const logs = await this.prisma.auditLog.findMany({
      where: { entity: 'IssuedWhtCertificate', entityId: id },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    return { history: logs.map((l) => ({ id: l.id, action: l.action, remark: l.remark, by: l.editedBy ? l.editedBy.displayName || l.editedBy.name : null, at: l.createdAt.toISOString() })) };
  }

  // ---------- เลขที่ ----------

  // เลขล่าสุดที่ใช้นอกระบบของปีนั้น + เลขถัดไปที่ระบบจะออก + จำนวนใบในระบบ
  async series(rawYear: unknown) {
    const year = parseYear(rawYear);
    const [row, max, count] = await Promise.all([
      this.prisma.issuedWhtSeries.findUnique({ where: { year } }),
      this.prisma.issuedWhtCertificate.aggregate({ where: { taxYear: year }, _max: { number: true } }),
      this.prisma.issuedWhtCertificate.count({ where: { taxYear: year } }),
    ]);
    const lastNumber = row?.lastNumber ?? 0;
    return { year, lastNumber, systemCount: count, nextNo: formatCertificateNo(year, Math.max(lastNumber, max._max.number ?? 0) + 1) };
  }

  // ตั้งเลขล่าสุดที่ใช้ไปแล้วนอกระบบ (เช่น 8 = ใบ 2026-001 ถึง 2026-008 ออกจากไฟล์เดิม) ทำได้เฉพาะปีที่ยังไม่มีใบในระบบ
  async setSeries(dto: { year?: unknown; lastNumber?: unknown; remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุที่มาของเลขเริ่ม');
    const year = parseYear(dto?.year);
    const lastNumber = dto?.lastNumber;
    if (typeof lastNumber !== 'number' || !Number.isInteger(lastNumber) || lastNumber < 0 || lastNumber > 99_999) throw bad('เลขล่าสุดต้องเป็นจำนวนเต็มตั้งแต่ 0');
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issued-wht-${year}`}))`;
      if ((await tx.issuedWhtCertificate.count({ where: { taxYear: year } })) > 0) throw bad(`ปี ${year} ออก 50 ทวิ ในระบบไปแล้ว - แก้เลขเริ่มไม่ได้`);
      const before = await tx.issuedWhtSeries.findUnique({ where: { year } });
      await tx.issuedWhtSeries.upsert({ where: { year }, create: { year, lastNumber }, update: { lastNumber } });
      await writeAudit(tx, { entity: 'IssuedWhtSeries', entityId: String(year), action: 'set-last-number', remark, changes: { lastNumber: { from: before?.lastNumber ?? null, to: lastNumber } } });
    });
    return this.series(year);
  }

  // ---------- พนักงานรายปี ----------

  // เงินเดือนที่จ่ายแล้วของแต่ละคนในปีภาษี (รอบที่ไม่ยกเลิก สถานะ PAID วันที่จ่ายอยู่ในปีนั้น)
  private async paidByEmployee(db: Prisma.TransactionClient | PrismaService, year: number, employeeIds?: string[]): Promise<Map<string, YearPay>> {
    const rows = await db.payrollItem.findMany({
      where: {
        ...(employeeIds ? { employeeId: { in: employeeIds } } : {}),
        run: { cancelledAt: null, status: 'PAID', payDate: { gte: day(`${year}-01-01`), lt: day(`${year + 1}-01-01`) } },
      },
      select: { employeeId: true, salary: true, otherIncome: true, ssoAmount: true, taxAmount: true, run: { select: { payDate: true } } },
    });
    const map = new Map<string, YearPay>();
    for (const r of rows) {
      const acc = map.get(r.employeeId) ?? { employeeId: r.employeeId, income: 0, sso: 0, tax: 0, payDates: [] };
      acc.income = round2(acc.income + Number(r.salary) + Number(r.otherIncome));
      acc.sso = round2(acc.sso + Number(r.ssoAmount));
      acc.tax = round2(acc.tax + Number(r.taxAmount));
      acc.payDates.push(iso(r.run.payDate)!);
      map.set(r.employeeId, acc);
    }
    return map;
  }

  // ตารางตัวอย่างก่อนออก: ใครมีเงินเดือนที่จ่ายแล้วในปีนี้ ยอดรวม และออกใบไปแล้วหรือยัง
  async employeeYear(rawYear: unknown) {
    const year = parseYear(rawYear);
    const paid = await this.paidByEmployee(this.prisma, year);
    const ids = [...paid.keys()];
    const [employees, certs, unpaidRuns] = await Promise.all([
      this.prisma.employee.findMany({ where: { id: { in: ids } }, orderBy: { code: 'asc' } }),
      this.prisma.issuedWhtCertificate.findMany({ where: { taxYear: year, status: 'ISSUED', employeeId: { in: ids } }, select: { id: true, employeeId: true, certificateNo: true } }),
      this.prisma.payrollRun.count({ where: { cancelledAt: null, status: { in: ['DRAFT', 'APPROVED'] }, month: { startsWith: `${year}-` } } }),
    ]);
    const certOf = new Map(certs.map((c) => [c.employeeId, c]));
    return {
      year,
      unpaidRuns,
      rows: employees.map((e) => {
        const p = paid.get(e.id)!;
        const sorted = [...p.payDates].sort();
        return {
          employeeId: e.id,
          code: e.code,
          fullName: fullNameOf(e),
          idType: e.idType,
          idNumber: e.idNumber,
          idValid: e.idType === 'CITIZEN' ? isValidThaiId(e.idNumber) : e.idNumber.trim().length > 0,
          income: p.income,
          sso: p.sso,
          tax: p.tax,
          months: p.payDates.length,
          periodLabel: periodLabel(p.payDates),
          lastPayDate: sorted[sorted.length - 1],
          certificate: certOf.get(e.id) ? { id: certOf.get(e.id)!.id, certificateNo: certOf.get(e.id)!.certificateNo } : null,
        };
      }),
    };
  }

  // ออกให้พนักงานที่เลือก (ยอดอ่านจากเงินเดือนที่จ่ายแล้ว) - คนที่ออกแล้ว/ไม่มีเงินเดือนจ่าย/เลขประจำตัวผิด ข้ามพร้อมเหตุผล
  async issueEmployeeYear(dto: { year?: unknown; issueDate?: unknown; employeeIds?: unknown }) {
    const year = parseYear(dto?.year);
    const issueDate = parseIssueDate(dto?.issueDate, year);
    if (!Array.isArray(dto?.employeeIds) || dto.employeeIds.length === 0 || dto.employeeIds.some((v) => typeof v !== 'string')) throw bad('เลือกพนักงานอย่างน้อย 1 คน');
    const employeeIds = [...new Set(dto.employeeIds as string[])];
    if (employeeIds.length > 200) throw bad('ออกครั้งละไม่เกิน 200 คน');

    const result = await this.prisma.$transaction(async (tx) => {
      const [employees, paid, existing] = await Promise.all([
        tx.employee.findMany({ where: { id: { in: employeeIds } }, orderBy: { code: 'asc' } }),
        this.paidByEmployee(tx, year, employeeIds),
        tx.issuedWhtCertificate.findMany({ where: { taxYear: year, status: 'ISSUED', employeeId: { in: employeeIds } }, select: { employeeId: true } }),
      ]);
      const issued = new Set(existing.map((c) => c.employeeId));
      const created: Array<{ id: string; employeeId: string; certificateNo: string }> = [];
      const skipped: Array<{ employeeId: string; name: string; reason: string }> = [];
      const nextNumber = await this.numberTaker(tx, year);
      for (const e of employees) {
        const name = fullNameOf(e);
        const p = paid.get(e.id);
        if (issued.has(e.id)) {
          skipped.push({ employeeId: e.id, name, reason: 'ออกใบของปีนี้ไปแล้ว (ยกเลิกใบเดิมก่อนถ้าต้องการออกใหม่)' });
          continue;
        }
        if (!p) {
          skipped.push({ employeeId: e.id, name, reason: 'ไม่มีเงินเดือนที่จ่ายแล้วในปีนี้' });
          continue;
        }
        if (e.idType === 'CITIZEN' ? !isValidThaiId(e.idNumber) : !e.idNumber.trim()) {
          skipped.push({ employeeId: e.id, name, reason: 'เลขประจำตัวไม่ถูกต้อง - แก้ในทะเบียนพนักงานก่อน' });
          continue;
        }
        const sorted = [...p.payDates].sort();
        const item: CleanItem = { incomeType: 'SALARY', description: null, paidDate: sorted[sorted.length - 1], dateLabel: periodLabel(p.payDates), amountPaid: p.income, taxWithheld: p.tax };
        const replaces = await tx.issuedWhtCertificate.findFirst({ where: { employeeId: e.id, taxYear: year, status: 'CANCELLED', replacedBy: { is: null } }, orderBy: { number: 'desc' }, select: { id: true } });
        const cert = await this.create(tx, {
          taxYear: year,
          taken: await nextNumber(),
          issueDate,
          payeeKind: 'EMPLOYEE',
          employeeId: e.id,
          supplierId: null,
          payeeName: name,
          payeeTaxId: e.idNumber.trim(),
          payeeAddress: null,
          formType: 'PND1K',
          payMethod: 'WITHHOLD',
          items: [item],
          ssoAmount: p.sso,
          providentFund: 0,
          note: null,
          replacesId: replaces?.id ?? null,
        });
        created.push({ id: cert.id, employeeId: e.id, certificateNo: cert.certificateNo });
      }
      return { created, skipped };
    }).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException({ error: 'มีการออกใบของพนักงานคนเดียวกันพร้อมกัน กรุณาโหลดหน้าใหม่' });
      throw err;
    });
    return result;
  }

  // ---------- ผู้รับเงินอื่นๆ (ซับ บุคคลธรรมดา) ----------

  async issueOther(dto: Record<string, unknown>) {
    const taxYear = parseYear(dto?.taxYear);
    if (taxYear > Number(bangkokToday().slice(0, 4))) throw bad('ปีภาษีต้องไม่เกินปีปัจจุบัน');
    const issueDate = parseIssueDate(dto.issueDate, taxYear);
    const payeeName = typeof dto.payeeName === 'string' ? dto.payeeName.replace(/\s+/g, ' ').trim() : '';
    if (!payeeName || payeeName.length > 150) throw bad('กรุณาระบุชื่อผู้รับเงิน (ไม่เกิน 150 ตัวอักษร)');
    const payeeTaxId = typeof dto.payeeTaxId === 'string' ? dto.payeeTaxId.replace(/[\s-]/g, '') : '';
    if (!isValidThaiId(payeeTaxId)) throw bad('เลขประจำตัวผู้เสียภาษี/บัตรประชาชนต้องเป็นเลข 13 หลักที่ถูกต้อง');
    const payeeAddress = optionalText(dto.payeeAddress, 300, 'ที่อยู่');
    const note = optionalText(dto.note, 200, 'หมายเหตุ');
    const payMethod = (dto.payMethod ?? 'WITHHOLD') as PayMethod;
    if (!PAY_METHODS.includes(payMethod)) throw bad('รูปแบบการหักภาษีไม่ถูกต้อง');
    const cleaned = cleanItems(dto.items, taxYear, 'OTHER');
    if ('error' in cleaned) throw bad(cleaned.error);
    if (payMethod === 'WITHHOLD' && cleaned.items.every((i) => i.taxWithheld === 0)) {
      throw bad('ไม่มีภาษีที่หักเลย - ถ้าไม่ได้หักภาษี ไม่ต้องออก 50 ทวิ (หรือเลือกออกให้ตลอดไป/ครั้งเดียว)');
    }
    // ผู้รับเงินจากทะเบียน (ไม่บังคับ): ชื่อ/เลข/ที่อยู่ในใบมาจากที่ส่งมาเสมอ (snapshot) ทะเบียนใช้แค่ผูกอ้างอิง
    let supplierId: string | null = null;
    if (dto.supplierId !== undefined && dto.supplierId !== null && dto.supplierId !== '') {
      if (typeof dto.supplierId !== 'string' || !(await this.prisma.supplier.findUnique({ where: { id: dto.supplierId }, select: { id: true } }))) throw bad('ไม่พบ Supplier ในทะเบียน');
      supplierId = dto.supplierId;
    }
    let replacesId: string | null = null;
    if (dto.replacesId !== undefined && dto.replacesId !== null && dto.replacesId !== '') {
      if (typeof dto.replacesId !== 'string') throw bad('ใบที่ออกแทนไม่ถูกต้อง');
      const old = await this.prisma.issuedWhtCertificate.findUnique({ where: { id: dto.replacesId }, select: { id: true, status: true, payeeKind: true, taxYear: true, replacedBy: { select: { id: true } } } });
      if (!old || old.payeeKind !== 'OTHER') throw bad('ไม่พบใบที่ต้องการออกแทน');
      if (old.status !== 'CANCELLED') throw bad('ออกแทนได้เฉพาะใบที่ยกเลิกแล้ว');
      if (old.replacedBy) throw bad('ใบนี้มีใบที่ออกแทนไปแล้ว');
      replacesId = old.id;
    }
    const created = await this.prisma.$transaction(async (tx) => {
      const nextNumber = await this.numberTaker(tx, taxYear);
      const cert = await this.create(tx, {
        taxYear,
        taken: await nextNumber(),
        issueDate,
        payeeKind: 'OTHER',
        employeeId: null,
        supplierId,
        payeeName,
        payeeTaxId,
        payeeAddress,
        formType: 'PND3',
        payMethod,
        items: cleaned.items,
        ssoAmount: 0,
        providentFund: 0,
        note,
        replacesId,
      });
      return cert;
    }).catch((err: unknown) => {
      if ((err as { code?: string }).code === 'P2002') throw new ConflictException({ error: 'ใบนี้มีใบที่ออกแทนไปแล้ว หรือเลขที่ซ้ำ กรุณาโหลดหน้าใหม่' });
      throw err;
    });
    // อ่านกลับหลัง commit (ใน transaction ต้องอ่านผ่าน tx เท่านั้น - connection อื่นมองไม่เห็นใบที่ยังไม่ commit)
    return this.get(created.id);
  }

  async cancel(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิก 50 ทวิ');
    if (remark.length > 500) throw bad('เหตุผลยาวเกิน 500 ตัวอักษร');
    await this.prisma.$transaction(async (tx) => {
      const cert = await tx.issuedWhtCertificate.findUnique({ where: { id }, select: { certificateNo: true, status: true, payeeName: true, totalPaid: true, totalTax: true } });
      if (!cert) throw new NotFoundException({ error: 'ไม่พบ 50 ทวิ' });
      const { count } = await tx.issuedWhtCertificate.updateMany({ where: { id, status: 'ISSUED' }, data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: remark, cancelledByName: nameOf() } });
      if (count === 0) throw new ConflictException({ error: 'ใบนี้ถูกยกเลิกไปแล้ว กรุณาโหลดใหม่' });
      await writeAudit(tx, { entity: 'IssuedWhtCertificate', entityId: id, action: 'cancel', remark, changes: { certificateNo: cert.certificateNo, payeeName: cert.payeeName, totalPaid: cert.totalPaid, totalTax: cert.totalTax } });
    });
    return this.get(id);
  }

  // ---------- ภายใน ----------

  // เลขถัดไปของปีภาษี: advisory lock ตามปี (ออกพร้อมกัน 2 หน้าจอได้เลขต่อกันไม่ซ้ำ) แล้วอ่านเลขสูงสุดครั้งเดียว เรียกซ้ำเพื่อเอาเลขต่อไปในรอบเดียวกัน
  private async numberTaker(tx: Prisma.TransactionClient, taxYear: number): Promise<() => Promise<{ number: number; certificateNo: string }>> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`issued-wht-${taxYear}`}))`;
    const [max, series] = await Promise.all([tx.issuedWhtCertificate.aggregate({ where: { taxYear }, _max: { number: true } }), tx.issuedWhtSeries.findUnique({ where: { year: taxYear } })]);
    let last = Math.max(max._max.number ?? 0, series?.lastNumber ?? 0);
    return async () => {
      last += 1;
      return { number: last, certificateNo: formatCertificateNo(taxYear, last) };
    };
  }

  private async create(
    tx: Prisma.TransactionClient,
    d: {
      taxYear: number;
      taken: { number: number; certificateNo: string };
      issueDate: string;
      payeeKind: 'EMPLOYEE' | 'OTHER';
      employeeId: string | null;
      supplierId: string | null;
      payeeName: string;
      payeeTaxId: string;
      payeeAddress: string | null;
      formType: FormType;
      payMethod: PayMethod;
      items: CleanItem[];
      ssoAmount: number;
      providentFund: number;
      note: string | null;
      replacesId: string | null;
    },
  ) {
    const totals = totalsOf(d.items);
    if (totals.totalPaid > MAX_AMOUNT * 12) throw bad('ยอดรวมสูงเกินไป');
    const cert = await tx.issuedWhtCertificate.create({
      data: {
        certificateNo: d.taken.certificateNo,
        taxYear: d.taxYear,
        number: d.taken.number,
        issueDate: day(d.issueDate),
        payeeKind: d.payeeKind,
        employeeId: d.employeeId,
        supplierId: d.supplierId,
        payeeName: d.payeeName,
        payeeTaxId: d.payeeTaxId,
        payeeAddress: d.payeeAddress,
        formType: d.formType,
        payMethod: d.payMethod,
        totalPaid: totals.totalPaid,
        totalTax: totals.totalTax,
        ssoAmount: d.ssoAmount,
        providentFund: d.providentFund,
        payerSnapshot: SELLER_PROFILE,
        note: d.note,
        replacesId: d.replacesId,
        createdByName: nameOf(),
        items: {
          create: d.items.map((i, sortOrder) => ({
            incomeType: i.incomeType,
            description: i.description,
            paidDate: day(i.paidDate),
            dateLabel: i.dateLabel,
            amountPaid: i.amountPaid,
            taxWithheld: i.taxWithheld,
            sortOrder,
          })),
        },
      },
      select: { id: true, certificateNo: true },
    });
    await writeAudit(tx, {
      entity: 'IssuedWhtCertificate',
      entityId: cert.id,
      action: 'issue',
      remark: `ออก 50 ทวิ ${cert.certificateNo} ให้ ${d.payeeName}`,
      changes: { certificateNo: cert.certificateNo, payeeKind: d.payeeKind, taxYear: d.taxYear, totalPaid: totals.totalPaid, totalTax: totals.totalTax, replacesId: d.replacesId },
    });
    return cert;
  }
}
