import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { MAX_RECEIPT_BYTES, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { detectAttachmentType } from '../yamaha-relocation/yamaha-relocation.service.js';
import { accountOn } from './billing-account.js';
import { computeInvoiceTotals, RATE_KINDS, VAT_RATE, type BillingTerms } from './billing-calculator.js';
import {
  BillingService,
  optionalText,
  parseIsoDate,
  parseItems,
  parseMoney,
  parseWhtOverride,
  termsFor,
  toPeriods,
  toTerms,
  withWht,
} from './billing.service.js';
import {
  formatQuotationNo,
  isMonth,
  QUOTATION_KINDS,
  QUOTATION_STAGES,
  revisionNo,
  stageOf,
  yamahaQuoteItems,
  type QuotationKind,
  type QuotationStage,
  type YamahaCounts,
} from './quotation-calc.js';

// ใบเสนอราคา (ผู้ใช้ 2026-10-01): งานของ YM ต้องเสนอราคาและได้ PO กลับมาก่อนออกใบวางบิลทุกครั้ง และใช้กับลูกค้ารายอื่นได้
// - JOB = ยอดงาน: อนุมัติแล้ว "ออกใบวางบิลจากใบนี้" (รายการคัดลอกไปบิลแบบแก้ไม่ได้ บิลอ้างเลข QT + PO)
// - RATE = ราคาต่อคัน: อนุมัติแล้ว "ตั้งเป็นราคาลูกค้า" (แทนที่ตาราง ServiceFeeRate ของลูกค้า)
// - ร่างยังไม่มีเลข แก้/ลบได้อิสระ · ออกเลขแล้วแก้ไม่ได้ ต้องทำฉบับแก้ไข (-R1) ซึ่งแทนที่ฉบับเดิมตอนออกเลข
// - ลูกค้าใหม่ที่ยังไม่อยู่ในระบบ: พิมพ์ชื่อ/ที่อยู่เอง (customerId null) ผูกกับลูกค้าในระบบทีหลังได้ ก่อนออกบิล/ตั้งราคา
// - ยกเลิก/ไม่อนุมัติ/ถอนอนุมัติ ต้องมีเหตุผล ทุกการเปลี่ยนสถานะลง AuditLog (entity 'Quotation')
// สิทธิ์: ADMIN + ACCOUNTANT ตามกฎ /api/billing

const bad = (error: string) => new BadRequestException({ error });
const conflict = (error: string) => new ConflictException({ error });
const iso = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;
const num = (d: unknown) => (d === null || d === undefined ? null : Number(d));
const utc = (isoDate: string) => new Date(`${isoDate}T00:00:00.000Z`);
const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
const nameOf = (u: { name: string; displayName: string | null } | null) => (u ? u.displayName || u.name : null);

const PAGE = 100;
const VEHICLE_KINDS = ['CAR', 'MOTO', 'ANY'];
const LIVE_INVOICE = { status: { not: 'VOID' } } as const;
const STALE = 'ใบเสนอราคานี้ถูกแก้หรือเปลี่ยนสถานะไปแล้ว - โหลดใหม่ก่อน';
// เงื่อนไขตั้งต้นของลูกค้าใหม่ที่ยังไม่อยู่ในระบบ = ค่าตั้งต้นของลูกค้าในระบบ (VAT 7% หัก ณ ที่จ่าย 3%)
const DEFAULT_TERMS: BillingTerms = { vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null };

const Q_INCLUDE = {
  items: true,
  invoices: { where: LIVE_INVOICE, select: { id: true, invoiceNo: true } },
  replaces: { select: { id: true, quotationNo: true } },
  replacedBy: { select: { id: true, quotationNo: true, status: true } },
} as const;
type QRow = Prisma.QuotationGetPayload<{ include: typeof Q_INCLUDE }>;

type Snapshot = { name: string; branch: string | null; address: string | null; taxId: string | null };

type ItemData = {
  kind: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  cost: number | null;
  sortOrder: number;
  rateKind?: string | null;
  vehicleKind?: string | null;
  ccMin?: number | null;
  ccMax?: number | null;
  chassisPrefix?: string | null;
  vatInclusive?: boolean;
  includesReceipt?: boolean;
};

// บรรทัดราคาต่อคัน - กติกาเดียวกับตารางราคาลูกค้า (BillingService.replaceRates) เพราะอนุมัติแล้วจะกลายเป็นตารางนั้น
function parseRateItems(raw: unknown): ItemData[] {
  if (!Array.isArray(raw)) throw bad('items ต้องเป็นรายการ');
  if (raw.length > 100) throw bad('ใบเสนอราคาหนึ่งใบมีราคาได้ไม่เกิน 100 แถว');
  return (raw as Array<Record<string, unknown>>).map((r, i) => {
    const row = `แถวที่ ${i + 1}: `;
    const label = optionalText(r?.label, `${row}ชื่อรายการ`);
    if (!label) throw bad(`${row}ต้องใส่ชื่อรายการ`);
    if (label.length > 300) throw bad(`${row}ชื่อรายการยาวเกิน 300 ตัวอักษร`);
    const rateKind = r.kind === undefined || r.kind === null ? 'BASE' : (RATE_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as string) : null;
    if (!rateKind) throw bad(`${row}ประเภทราคาไม่ถูกต้อง`);
    const vehicleKind = typeof r.vehicleKind === 'string' && VEHICLE_KINDS.includes(r.vehicleKind) ? r.vehicleKind : null;
    if (!vehicleKind) throw bad(`${row}ชนิดรถต้องเป็นรถยนต์ จักรยานยนต์ หรือทุกชนิด`);
    const ccMin = r.ccMin === null || r.ccMin === undefined ? null : parseMoney(r.ccMin, `${row}CC ตั้งแต่`);
    const ccMax = r.ccMax === null || r.ccMax === undefined ? null : parseMoney(r.ccMax, `${row}CC น้อยกว่า`);
    if (ccMin !== null && ccMax !== null && ccMin >= ccMax) throw bad(`${row}ช่วง CC ไม่ถูกต้อง`);
    const amount = parseMoney(r.amount, `${row}ราคา`);
    if (amount <= 0) throw bad(`${row}ราคาต้องมากกว่า 0`);
    return {
      kind: 'SERVICE',
      description: label,
      quantity: 1,
      unitPrice: amount,
      amount,
      cost: null,
      sortOrder: i,
      rateKind,
      vehicleKind,
      ccMin,
      ccMax,
      chassisPrefix: optionalText(r.chassisPrefix, `${row}เลขตัวถังขึ้นต้น`),
      vatInclusive: r.vatInclusive === true,
      includesReceipt: r.includesReceipt === true,
    };
  });
}

function parseTypedCustomer(raw: unknown): Snapshot {
  const c = (raw ?? {}) as Record<string, unknown>;
  const name = optionalText(c.name, 'ชื่อลูกค้า');
  if (!name) throw bad('ต้องเลือกลูกค้า หรือพิมพ์ชื่อลูกค้าใหม่');
  if (name.length > 200) throw bad('ชื่อลูกค้ายาวเกิน 200 ตัวอักษร');
  const taxId = optionalText(c.taxId, 'เลขผู้เสียภาษี');
  if (taxId && !/^\d{13}$/.test(taxId)) throw bad('เลขผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก (เว้นว่างได้)');
  return { name, branch: optionalText(c.branch, 'สาขา'), address: optionalText(c.address, 'ที่อยู่'), taxId };
}

export interface QuotationDto {
  kind?: unknown;
  customerId?: unknown;
  customer?: unknown; // { name, branch, address, taxId } เมื่อยังไม่มีลูกค้าในระบบ
  issueDate?: unknown;
  validDays?: unknown;
  title?: unknown;
  conditions?: unknown;
  items?: unknown;
  whtRate?: unknown;
  yamahaMonth?: unknown;
  expectedUpdatedAt?: unknown;
}

@Injectable()
export class QuotationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
  ) {}

  private map(q: QRow, today = bangkokToday()) {
    const validUntil = iso(q.validUntil)!;
    const invoice = q.invoices[0] ?? null;
    return {
      id: q.id,
      quotationNo: q.quotationNo,
      revision: q.revision,
      kind: q.kind as QuotationKind,
      status: q.status,
      stage: stageOf({ status: q.status, validUntil, hasLiveInvoice: !!invoice, ratesApplied: !!q.ratesAppliedAt }, today),
      customerId: q.customerId,
      customer: q.customerSnapshot as Snapshot,
      issueDate: iso(q.issueDate)!,
      validDays: q.validDays,
      validUntil,
      title: q.title,
      conditions: q.conditions,
      account: q.account,
      vatRate: Number(q.vatRate),
      whtRate: Number(q.whtRate),
      feeTotal: Number(q.feeTotal),
      serviceTotal: Number(q.serviceTotal),
      goodsTotal: Number(q.goodsTotal),
      vatAmount: Number(q.vatAmount),
      whtAmount: Number(q.whtAmount),
      netTotal: Number(q.netTotal),
      yamahaMonth: q.yamahaMonth,
      yamahaCounts: (q.yamahaCounts as YamahaCounts | null) ?? null,
      approvedDate: iso(q.approvedDate),
      poNumber: q.poNumber,
      hasFile: !!q.storageKey,
      rejectReason: q.rejectReason,
      cancelReason: q.cancelReason,
      ratesAppliedAt: q.ratesAppliedAt?.toISOString() ?? null,
      invoice,
      replaces: q.replaces,
      replacedBy: q.replacedBy,
      updatedAt: q.updatedAt.toISOString(),
      items: [...q.items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((it) => ({
          id: it.id,
          kind: it.kind,
          description: it.description,
          quantity: it.quantity,
          unitPrice: Number(it.unitPrice),
          amount: Number(it.amount),
          cost: num(it.cost),
          rateKind: it.rateKind,
          vehicleKind: it.vehicleKind,
          ccMin: num(it.ccMin),
          ccMax: num(it.ccMax),
          chassisPrefix: it.chassisPrefix,
          vatInclusive: it.vatInclusive,
          includesReceipt: it.includesReceipt,
        })),
    };
  }

  private async load(id: string): Promise<QRow> {
    const q = await this.prisma.quotation.findUnique({ where: { id }, include: Q_INCLUDE });
    if (!q) throw new NotFoundException({ error: 'ไม่พบใบเสนอราคา' });
    return q;
  }

  // ล็อกแถวแล้วอ่านใหม่ใน transaction - การเปลี่ยนสถานะพร้อมกัน 2 หน้าจอต้องรอกัน
  private async lock(tx: Prisma.TransactionClient, id: string): Promise<QRow> {
    await tx.$queryRaw`SELECT "id" FROM "Quotation" WHERE "id" = ${id} FOR UPDATE`;
    const q = await tx.quotation.findUnique({ where: { id }, include: Q_INCLUDE });
    if (!q) throw new NotFoundException({ error: 'ไม่พบใบเสนอราคา' });
    return q;
  }

  private stageWhere(stage: QuotationStage, today: string): Prisma.QuotationWhereInput {
    const day = utc(today);
    switch (stage) {
      case 'WAITING':
        return { status: 'ISSUED', validUntil: { gte: day } };
      case 'EXPIRED':
        return { status: 'ISSUED', validUntil: { lt: day } };
      case 'APPROVED':
        return { status: 'APPROVED', ratesAppliedAt: null, invoices: { none: LIVE_INVOICE } };
      case 'DONE':
        return { status: 'APPROVED', OR: [{ ratesAppliedAt: { not: null } }, { invoices: { some: LIVE_INVOICE } }] };
      default:
        return { status: stage };
    }
  }

  // { quotations, hasMore, counts } ใหม่สุดก่อน ทีละ 100 ใบ · stage = กลุ่มที่กรอง (ไม่ส่ง = ทั้งหมด) · q ค้นเลขที่ / ชื่องาน / PO / ลูกค้า
  async list(params: { stage?: string; q?: string; offset?: string } = {}) {
    const today = bangkokToday();
    const stage = (QUOTATION_STAGES as readonly string[]).includes(params.stage ?? '') ? (params.stage as QuotationStage) : null;
    const text = (params.q ?? '').trim();
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);
    const search: Prisma.QuotationWhereInput = text
      ? {
          OR: [
            { quotationNo: { contains: text, mode: 'insensitive' } },
            { title: { contains: text, mode: 'insensitive' } },
            { poNumber: { contains: text, mode: 'insensitive' } },
            { customer: { is: { OR: [{ name: { contains: text, mode: 'insensitive' } }, { company: { contains: text, mode: 'insensitive' } }] } } },
            { customerSnapshot: { path: ['name'], string_contains: text } },
          ],
        }
      : {};
    const where: Prisma.QuotationWhereInput = stage ? { AND: [search, this.stageWhere(stage, today)] } : search;
    const [rows, ...counts] = await Promise.all([
      this.prisma.quotation.findMany({ where, include: Q_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: offset, take: PAGE + 1 }),
      ...QUOTATION_STAGES.map((s) => this.prisma.quotation.count({ where: { AND: [search, this.stageWhere(s, today)] } })),
    ]);
    return {
      quotations: rows.slice(0, PAGE).map((r) => this.map(r, today)),
      hasMore: rows.length > PAGE,
      counts: Object.fromEntries(QUOTATION_STAGES.map((s, i) => [s, counts[i]])) as Record<QuotationStage, number>,
    };
  }

  async get(id: string) {
    return this.map(await this.load(id));
  }

  async history(id: string) {
    const entries = await this.prisma.auditLog.findMany({
      where: { entity: 'Quotation', entityId: id },
      orderBy: { createdAt: 'desc' },
      include: { editedBy: { select: { name: true, displayName: true } } },
    });
    return entries.map((e) => ({ id: e.id, action: e.action, remark: e.remark, changes: e.changes, editedBy: nameOf(e.editedBy), createdAt: e.createdAt.toISOString() }));
  }

  // ลูกค้าที่ตั้ง "ต้องมีใบเสนอราคาก่อนวางบิล" พร้อมใบที่อนุมัติแล้วและยังไม่ออกบิล - หน้าวางบิลใช้บอกทางไปออกบิลจากใบเสนอราคา
  async readyToInvoice(customerId: string) {
    const rows = await this.prisma.quotation.findMany({
      where: { customerId, kind: 'JOB', status: 'APPROVED', invoices: { none: LIVE_INVOICE } },
      include: Q_INCLUDE,
      orderBy: { approvedDate: 'asc' },
    });
    return rows.map((r) => this.map(r));
  }

  // ---------- งานแจ้งย้ายยามาฮ่า ----------
  private async countYamaha(month: string): Promise<YamahaCounts> {
    const start = utc(`${month}-01`);
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    const groups = await this.prisma.yamahaRelocationEntry.groupBy({
      by: ['size'],
      where: { date: { gte: start, lt: end }, cancelledAt: null },
      _sum: { count: true },
    });
    const of = (size: string) => groups.find((g) => g.size === size)?._sum.count ?? 0;
    return { SMALL: of('SMALL'), LARGE: of('LARGE') };
  }

  // ใบเสนอราคาที่ยังใช้อยู่ (ออกเลขแล้ว ยังไม่ถูกปฏิเสธ/ยกเลิก/แทนที่) ของเดือนนั้น - มีได้ใบเดียว และล็อกรายการแจ้งย้ายของเดือน
  private liveForMonth(db: Pick<Prisma.TransactionClient, 'quotation'>, month: string, exceptIds: string[]) {
    return db.quotation.findFirst({
      where: { yamahaMonth: month, status: { in: ['ISSUED', 'APPROVED'] }, id: { notIn: exceptIds } },
      select: { id: true, quotationNo: true },
    });
  }

  // ยอดแจ้งย้ายของเดือน + บรรทัดที่เสนอ (รถเล็ก / รถใหญ่ / ค่าดูแลเอกสารรายเดือน) สำหรับปุ่ม "ดึงยอดแจ้งย้ายยามาฮ่า"
  async yamahaMonth(monthRaw: unknown) {
    if (!isMonth(monthRaw)) throw bad('เดือนต้องเป็น ค.ศ. YYYY-MM');
    const [counts, quoted] = await Promise.all([this.countYamaha(monthRaw), this.liveForMonth(this.prisma, monthRaw, [])]);
    return { month: monthRaw, counts, items: yamahaQuoteItems(monthRaw, counts), quotedBy: quoted };
  }

  // ---------- ร่าง ----------
  private async build(dto: QuotationDto, kind: QuotationKind) {
    const issueDate = parseIsoDate(dto.issueDate, 'วันที่ออกใบเสนอราคา');
    const issueIso = iso(issueDate)!;
    const validDays = dto.validDays === undefined || dto.validDays === null ? 30 : dto.validDays;
    if (typeof validDays !== 'number' || !Number.isInteger(validDays) || validDays < 1 || validDays > 365) throw bad('ยืนราคาต้องเป็นจำนวนวัน 1 ถึง 365');
    const title = optionalText(dto.title, 'ชื่องาน') ?? '';
    if (title.length > 200) throw bad('ชื่องานยาวเกิน 200 ตัวอักษร');
    const conditions = optionalText(dto.conditions, 'เงื่อนไข');
    if (conditions && conditions.length > 1000) throw bad('เงื่อนไขยาวเกิน 1,000 ตัวอักษร');

    let customerId: string | null = null;
    let snapshot: Snapshot;
    let terms = DEFAULT_TERMS;
    let account = 'COMPANY';
    if (typeof dto.customerId === 'string' && dto.customerId) {
      const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, include: { accountPeriods: { select: { account: true, effectiveFrom: true } } } });
      if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
      customerId = customer.id;
      snapshot = { name: customer.company || customer.name, branch: customer.branch, address: customer.address, taxId: customer.taxId };
      account = accountOn(toPeriods(customer.accountPeriods ?? []), issueIso);
      terms = toTerms(customer);
    } else {
      snapshot = parseTypedCustomer(dto.customer);
    }
    terms = withWht(termsFor(account, terms), kind === 'JOB' ? parseWhtOverride(dto.whtRate) : null);

    const items: ItemData[] = kind === 'JOB' ? parseItems(dto.items) : parseRateItems(dto.items);
    const totals =
      kind === 'JOB'
        ? computeInvoiceTotals({ lines: [], extras: [], items, terms, issueDate: issueIso })
        : { feeTotal: 0, serviceTotal: 0, goodsTotal: 0, vatRate: terms.vat ? VAT_RATE : 0, vatAmount: 0, whtRate: 0, whtAmount: 0, netTotal: 0 };

    let yamahaMonth: string | null = null;
    let yamahaCounts: YamahaCounts | null = null;
    if (dto.yamahaMonth !== undefined && dto.yamahaMonth !== null && dto.yamahaMonth !== '') {
      if (kind !== 'JOB') throw bad('ยอดแจ้งย้ายยามาฮ่าใช้กับใบเสนอราคาแบบยอดงานเท่านั้น');
      if (!isMonth(dto.yamahaMonth)) throw bad('เดือนของงานแจ้งย้ายต้องเป็น ค.ศ. YYYY-MM');
      yamahaMonth = dto.yamahaMonth;
      yamahaCounts = await this.countYamaha(yamahaMonth);
    }

    return {
      items,
      data: {
        customerId,
        customerSnapshot: snapshot,
        issueDate,
        validDays,
        validUntil: addDays(issueDate, validDays),
        title,
        conditions,
        account,
        vatRate: totals.vatRate,
        whtRate: totals.whtRate,
        feeTotal: totals.feeTotal,
        serviceTotal: totals.serviceTotal,
        goodsTotal: totals.goodsTotal,
        vatAmount: totals.vatAmount,
        whtAmount: totals.whtAmount,
        netTotal: totals.netTotal,
        yamahaMonth,
        yamahaCounts: (yamahaCounts ?? null) as Prisma.InputJsonValue | null,
      },
    };
  }

  async create(dto: QuotationDto) {
    if (!(QUOTATION_KINDS as readonly unknown[]).includes(dto?.kind)) throw bad('แบบใบเสนอราคาต้องเป็นยอดงานหรือราคาต่อคัน');
    const kind = dto.kind as QuotationKind;
    const { items, data } = await this.build(dto, kind);
    const q = await this.prisma.quotation.create({
      data: {
        ...data,
        yamahaCounts: data.yamahaCounts ?? undefined,
        kind,
        status: 'DRAFT',
        createdById: currentUser()?.id ?? null,
        items: { createMany: { data: items } },
      },
      include: Q_INCLUDE,
    });
    return this.map(q);
  }

  // แก้ร่าง (ยังไม่มีเลข) - แทนที่ทุกช่องและทุกบรรทัด · expectedUpdatedAt ไม่ตรง = อีกหน้าจอแก้/ออกเลขไปก่อน (409)
  async update(id: string, dto: QuotationDto) {
    const current = await this.load(id);
    if (current.status !== 'DRAFT') throw conflict('ใบเสนอราคาออกเลขแล้ว แก้ไม่ได้ - ทำฉบับแก้ไขแทน');
    const { items, data } = await this.build(dto, current.kind as QuotationKind);
    const q = await this.prisma.$transaction(async (tx) => {
      const locked = await this.lock(tx, id);
      if (locked.status !== 'DRAFT') throw conflict(STALE);
      if (typeof dto.expectedUpdatedAt === 'string' && dto.expectedUpdatedAt !== locked.updatedAt.toISOString()) throw conflict(STALE);
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      return tx.quotation.update({
        where: { id },
        data: { ...data, yamahaCounts: data.yamahaCounts ?? Prisma.DbNull, items: { createMany: { data: items } } },
        include: Q_INCLUDE,
      });
    });
    return this.map(q);
  }

  // ลบร่าง - ยังไม่มีเลข ไม่มีเอกสารออกไปถึงลูกค้า จึงลบจริงได้
  async remove(id: string) {
    const { count } = await this.prisma.quotation.deleteMany({ where: { id, status: 'DRAFT' } });
    if (!count) throw conflict('ลบได้เฉพาะร่างที่ยังไม่ออกเลข');
    return { id };
  }

  // ---------- ออกเลข ----------
  // ร่าง -> ISSUED: ให้เลข QT{ปี}-{3 หลัก} ตามปีของวันที่ออก (ล็อกแถวชุดเลขกันเลขซ้ำ) · ฉบับแก้ไขใช้เลขเดิม + -R{n} และแทนที่ฉบับเดิม
  async issue(id: string, dto: { expectedUpdatedAt?: unknown } = {}) {
    const q = await this.prisma.$transaction(async (tx) => {
      const draft = await this.lock(tx, id);
      if (draft.status !== 'DRAFT') throw conflict('ใบเสนอราคานี้ออกเลขไปแล้ว');
      if (typeof dto.expectedUpdatedAt === 'string' && dto.expectedUpdatedAt !== draft.updatedAt.toISOString()) throw conflict(STALE);
      if (draft.items.length === 0) throw bad('ต้องมีอย่างน้อย 1 บรรทัด');

      if (draft.yamahaMonth) {
        const other = await this.liveForMonth(tx, draft.yamahaMonth, [id, ...(draft.replacesId ? [draft.replacesId] : [])]);
        if (other) throw conflict(`งานแจ้งย้ายเดือนนี้มีใบเสนอราคา ${other.quotationNo} อยู่แล้ว - ทำฉบับแก้ไขของใบนั้น หรือยกเลิกก่อน`);
        const now = await this.countYamaha(draft.yamahaMonth);
        const saved = draft.yamahaCounts as YamahaCounts | null;
        if (!saved || saved.SMALL !== now.SMALL || saved.LARGE !== now.LARGE) {
          throw conflict(`ยอดแจ้งย้ายของเดือนนี้เปลี่ยนไปแล้ว (รถเล็ก ${now.SMALL} คัน รถใหญ่ ${now.LARGE} คัน) - เปิดร่างแล้วกดดึงยอดใหม่ก่อนออกเลข`);
        }
      }

      let baseNo: string;
      let revision = 0;
      if (draft.replacesId) {
        const old = await this.lock(tx, draft.replacesId);
        if (!['ISSUED', 'APPROVED', 'REJECTED'].includes(old.status) || !old.baseNo) throw conflict(`ฉบับเดิม ${old.quotationNo ?? ''} ถูกยกเลิกหรือถูกแทนที่ไปแล้ว - ออกฉบับแก้ไขไม่ได้`);
        if (old.invoices.length) throw conflict(`ฉบับเดิมออกใบวางบิล ${old.invoices[0].invoiceNo} ไปแล้ว - ยกเลิกบิลก่อนจึงจะออกฉบับแก้ไขได้`);
        if (old.ratesAppliedAt) throw conflict('ฉบับเดิมตั้งเป็นราคาลูกค้าไปแล้ว - ออกใบเสนอราคาใบใหม่แทน');
        baseNo = old.baseNo;
        revision = old.revision + 1;
        await tx.quotation.update({ where: { id: old.id }, data: { status: 'SUPERSEDED' } });
      } else {
        const year = draft.issueDate.getUTCFullYear();
        await tx.$executeRaw`INSERT INTO "QuotationSeries" ("year", "lastNumber", "updatedAt") VALUES (${year}, 0, NOW()) ON CONFLICT ("year") DO NOTHING`;
        const [series] = await tx.$queryRaw<Array<{ lastNumber: number }>>`SELECT "lastNumber" FROM "QuotationSeries" WHERE "year" = ${year} FOR UPDATE`;
        const number = series.lastNumber + 1;
        await tx.quotationSeries.update({ where: { year }, data: { lastNumber: number } });
        baseNo = formatQuotationNo(year, number);
      }
      return tx.quotation.update({ where: { id }, data: { status: 'ISSUED', baseNo, revision, quotationNo: revisionNo(baseNo, revision) }, include: Q_INCLUDE });
    });
    return this.map(q);
  }

  // ---------- คำตอบจากลูกค้า ----------
  // อนุมัติ (multipart): approvedDate, poNumber, file (PDF/รูป PO หรือใบที่เซ็นกลับ) - ต้องมีเลข PO หรือไฟล์อย่างน้อยอย่างหนึ่งเป็นหลักฐาน
  async approve(id: string, dto: Record<string, unknown>, file: UploadedReceiptFile | undefined) {
    const approvedDate = parseIsoDate(dto?.approvedDate, 'วันที่อนุมัติ');
    if (iso(approvedDate)! > bangkokToday()) throw bad('วันที่อนุมัติเป็นวันในอนาคตไม่ได้');
    const poNumber = optionalText(dto.poNumber, 'เลข PO');
    if (poNumber && poNumber.length > 100) throw bad('เลข PO ยาวเกิน 100 ตัวอักษร');
    if (!poNumber && !file) throw bad('ต้องใส่เลข PO หรือแนบไฟล์หลักฐานการอนุมัติอย่างน้อยหนึ่งอย่าง');

    let upload: { storageKey: string; mimeType: string; sizeBytes: number; originalName: string | null; contentHash: string } | null = null;
    if (file) {
      if (file.size > MAX_RECEIPT_BYTES) throw bad('ไฟล์ใหญ่เกิน 8MB');
      const type = detectAttachmentType(file.buffer);
      if (!type) throw bad('ไฟล์ต้องเป็น PDF หรือรูป JPEG/PNG/WebP');
      const contentHash = contentHashOf(file.buffer);
      if (await this.prisma.quotation.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload('ไฟล์นี้แนบกับใบเสนอราคาอื่นไปแล้ว');
      const now = new Date();
      const ym = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
      upload = { storageKey: `quotations/${ym}/${randomUUID()}.${type.ext}`, mimeType: type.mimeType, sizeBytes: file.size, originalName: file.originalname || null, contentHash };
      await this.storage.put(upload.storageKey, file.buffer, upload.mimeType);
    }

    try {
      const q = await this.prisma.$transaction(async (tx) => {
        const current = await this.lock(tx, id);
        if (current.status !== 'ISSUED') throw conflict(current.status === 'APPROVED' ? 'ใบเสนอราคานี้บันทึกอนุมัติไปแล้ว' : 'บันทึกอนุมัติได้เฉพาะใบที่ออกเลขแล้วและยังรอคำตอบ');
        if (typeof dto.expectedUpdatedAt === 'string' && dto.expectedUpdatedAt !== current.updatedAt.toISOString()) throw conflict(STALE);
        if (approvedDate < current.issueDate) throw bad('วันที่อนุมัติต้องไม่ก่อนวันที่ออกใบเสนอราคา');
        const updated = await tx.quotation.update({ where: { id }, data: { status: 'APPROVED', approvedDate, poNumber, rejectReason: null, ...upload }, include: Q_INCLUDE });
        await writeAudit(tx, {
          entity: 'Quotation',
          entityId: id,
          action: 'approve',
          remark: `ลูกค้าอนุมัติ${poNumber ? ` PO ${poNumber}` : ''}`,
          changes: { approvedDate, poNumber, file: upload?.originalName ?? null },
        });
        return updated;
      });
      return this.map(q);
    } catch (err) {
      if (upload) await this.storage.delete(upload.storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload('ไฟล์นี้แนบกับใบเสนอราคาอื่นไปแล้ว');
      throw err;
    }
  }

  // ถอนการอนุมัติที่บันทึกผิด -> กลับเป็นรอคำตอบ (ได้เฉพาะก่อนออกบิล/ตั้งราคา) ไฟล์ที่แนบถูกลบ แนบใหม่ได้
  async unapprove(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ถอนการอนุมัติ');
    let oldKey: string | null = null;
    const q = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status !== 'APPROVED') throw conflict('ถอนได้เฉพาะใบที่อนุมัติแล้ว');
      if (current.invoices.length) throw conflict(`ออกใบวางบิล ${current.invoices[0].invoiceNo} ไปแล้ว - ยกเลิกบิลก่อน`);
      if (current.ratesAppliedAt) throw conflict('ตั้งเป็นราคาลูกค้าไปแล้ว ถอนการอนุมัติไม่ได้');
      oldKey = current.storageKey;
      const updated = await tx.quotation.update({
        where: { id },
        data: { status: 'ISSUED', approvedDate: null, poNumber: null, storageKey: null, mimeType: null, sizeBytes: null, originalName: null, contentHash: null },
        include: Q_INCLUDE,
      });
      await writeAudit(tx, { entity: 'Quotation', entityId: id, action: 'unapprove', remark, changes: { approvedDate: current.approvedDate, poNumber: current.poNumber } });
      return updated;
    });
    if (oldKey) await this.storage.delete(oldKey).catch(() => undefined);
    return this.map(q);
  }

  async reject(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ลูกค้าไม่อนุมัติ');
    const q = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.status !== 'ISSUED') throw conflict('บันทึกไม่อนุมัติได้เฉพาะใบที่ยังรอคำตอบ');
      const updated = await tx.quotation.update({ where: { id }, data: { status: 'REJECTED', rejectReason: remark }, include: Q_INCLUDE });
      await writeAudit(tx, { entity: 'Quotation', entityId: id, action: 'reject', remark, changes: {} });
      return updated;
    });
    return this.map(q);
  }

  // ยกเลิกใบที่ออกเลขแล้ว - เลขเก็บไว้ ไม่ลบแถว · ใบที่ออกบิลแล้วต้องยกเลิกบิลก่อน
  async cancel(id: string, dto: { remark?: unknown }) {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่ยกเลิกใบเสนอราคา');
    const q = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (!['ISSUED', 'APPROVED', 'REJECTED'].includes(current.status)) throw conflict(current.status === 'DRAFT' ? 'ร่างยังไม่มีเลข - ใช้ลบร่างแทน' : 'ใบเสนอราคานี้ยกเลิกหรือถูกแทนที่ไปแล้ว');
      if (current.invoices.length) throw conflict(`ออกใบวางบิล ${current.invoices[0].invoiceNo} ไปแล้ว - ยกเลิกบิลก่อน`);
      const updated = await tx.quotation.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null, contentHash: null },
        include: Q_INCLUDE,
      });
      await writeAudit(tx, { entity: 'Quotation', entityId: id, action: 'cancel', remark, changes: { status: current.status, poNumber: current.poNumber } });
      return updated;
    });
    return this.map(q);
  }

  // ทำฉบับแก้ไข: คัดลอกเป็นร่างใหม่ที่ผูกกับฉบับเดิม (ฉบับเดิมยังใช้อยู่จนกว่าร่างนี้จะออกเลข) - มีร่างฉบับแก้ไขค้างได้ทีละใบ
  async revise(id: string) {
    const current = await this.load(id);
    if (!['ISSUED', 'APPROVED', 'REJECTED'].includes(current.status)) throw conflict('ทำฉบับแก้ไขได้เฉพาะใบที่ออกเลขแล้วและยังไม่ถูกยกเลิก/แทนที่');
    if (current.invoices.length) throw conflict(`ออกใบวางบิล ${current.invoices[0].invoiceNo} ไปแล้ว - ยกเลิกบิลก่อนจึงจะแก้ใบเสนอราคาได้`);
    if (current.ratesAppliedAt) throw conflict('ตั้งเป็นราคาลูกค้าไปแล้ว - ออกใบเสนอราคาใบใหม่แทน');
    if (current.replacedBy) throw conflict('มีร่างฉบับแก้ไขของใบนี้อยู่แล้ว - เปิดร่างนั้นแก้ต่อ');
    const issueDate = utc(bangkokToday());
    try {
      const q = await this.prisma.quotation.create({
        data: {
          kind: current.kind,
          status: 'DRAFT',
          replacesId: current.id,
          customerId: current.customerId,
          customerSnapshot: current.customerSnapshot as Prisma.InputJsonValue,
          issueDate,
          validDays: current.validDays,
          validUntil: addDays(issueDate, current.validDays),
          title: current.title,
          conditions: current.conditions,
          account: current.account,
          vatRate: current.vatRate,
          whtRate: current.whtRate,
          feeTotal: current.feeTotal,
          serviceTotal: current.serviceTotal,
          goodsTotal: current.goodsTotal,
          vatAmount: current.vatAmount,
          whtAmount: current.whtAmount,
          netTotal: current.netTotal,
          yamahaMonth: current.yamahaMonth,
          yamahaCounts: (current.yamahaCounts ?? undefined) as Prisma.InputJsonValue | undefined,
          createdById: currentUser()?.id ?? null,
          items: {
            createMany: {
              data: current.items.map(({ id: _id, quotationId: _q, ...it }) => it),
            },
          },
        },
        include: Q_INCLUDE,
      });
      return this.map(q);
    } catch (err) {
      if ((err as { code?: unknown })?.code === 'P2002') throw conflict('มีร่างฉบับแก้ไขของใบนี้อยู่แล้ว - เปิดร่างนั้นแก้ต่อ');
      throw err;
    }
  }

  // ผูกใบเสนอราคาของลูกค้าใหม่กับลูกค้าที่เพิ่มเข้าระบบแล้ว (ADMIN เพิ่มลูกค้าในหน้าลูกค้าก่อน) - ชื่อ/ที่อยู่บนใบที่ออกแล้วไม่เปลี่ยน
  async linkCustomer(id: string, dto: { customerId?: unknown }) {
    if (typeof dto?.customerId !== 'string' || !dto.customerId) throw bad('ต้องเลือกลูกค้า');
    const customer = await this.prisma.customer.findUnique({ where: { id: dto.customerId }, select: { id: true, name: true, company: true } });
    if (!customer) throw new NotFoundException({ error: 'ไม่พบข้อมูลลูกค้า' });
    const q = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.customerId) throw conflict('ใบเสนอราคานี้ผูกกับลูกค้าในระบบอยู่แล้ว');
      if (['CANCELLED', 'SUPERSEDED'].includes(current.status)) throw conflict('ใบเสนอราคานี้ยกเลิกหรือถูกแทนที่ไปแล้ว');
      const updated = await tx.quotation.update({ where: { id }, data: { customerId: customer.id }, include: Q_INCLUDE });
      await writeAudit(tx, { entity: 'Quotation', entityId: id, action: 'link-customer', remark: `ผูกกับลูกค้า ${customer.company || customer.name}`, changes: { customerId: { from: null, to: customer.id } } });
      return updated;
    });
    return this.map(q);
  }

  // ---------- หลังอนุมัติ ----------
  // ออกใบวางบิลจากใบเสนอราคา (ยอดงาน): รายการคัดลอกทั้งใบ แก้ตัวเลขไม่ได้ บิลอ้างเลข QT + PO · ใบเสนอราคา 1 ใบ = บิลที่ยังใช้อยู่ 1 ใบ
  async createInvoice(id: string, dto: { invoiceNo?: unknown; issueDate?: unknown; whtRate?: unknown }) {
    const q = await this.load(id);
    if (q.kind !== 'JOB') throw bad('ใบเสนอราคาแบบราคาต่อคันออกใบวางบิลไม่ได้ - ใช้ตั้งเป็นราคาลูกค้า');
    if (q.status !== 'APPROVED') throw conflict('ออกใบวางบิลได้เฉพาะใบเสนอราคาที่ลูกค้าอนุมัติแล้ว');
    if (!q.customerId) throw bad('ใบเสนอราคานี้ยังไม่ได้ผูกกับลูกค้าในระบบ - ผูกลูกค้าก่อนออกใบวางบิล');
    if (q.invoices.length) throw conflict(`ใบเสนอราคานี้ออกใบวางบิล ${q.invoices[0].invoiceNo} ไปแล้ว`);
    const issueDate = parseIsoDate(dto?.issueDate, 'วันที่ออกบิล');
    if (q.approvedDate && issueDate < q.approvedDate) throw bad('วันที่ออกบิลต้องไม่ก่อนวันที่ลูกค้าอนุมัติ');

    const items = [...q.items]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((it) => ({ kind: it.kind, description: it.description, quantity: it.quantity, unitPrice: Number(it.unitPrice), cost: num(it.cost) }));
    const invoice = await this.billing.createCustomInvoice(
      { customerId: q.customerId, invoiceNo: dto.invoiceNo, issueDate: dto.issueDate, jobLabel: q.title, items, whtRate: dto.whtRate ?? Number(q.whtRate) },
      {
        quotationId: q.id,
        quotationNo: q.quotationNo!,
        poNumber: q.poNumber,
        link: async (tx) => {
          const locked = await this.lock(tx, id);
          if (locked.status !== 'APPROVED' || locked.updatedAt.getTime() !== q.updatedAt.getTime()) throw conflict(STALE);
          if (locked.invoices.length) throw conflict(`ใบเสนอราคานี้ออกใบวางบิล ${locked.invoices[0].invoiceNo} ไปแล้ว`);
          await writeAudit(tx, { entity: 'Quotation', entityId: id, action: 'invoice', remark: `ออกใบวางบิล ${typeof dto.invoiceNo === 'string' ? dto.invoiceNo.trim() : ''}`, changes: {} });
        },
      },
    );
    return { invoice, quotation: await this.get(id) };
  }

  // ตั้งเป็นราคาลูกค้า (ราคาต่อคัน): แทนที่ตารางราคาของลูกค้าทั้งชุดด้วยแถวในใบเสนอราคา - ตารางเดิมเก็บลงประวัติของลูกค้า
  async applyRates(id: string) {
    const q = await this.prisma.$transaction(async (tx) => {
      const current = await this.lock(tx, id);
      if (current.kind !== 'RATE') throw bad('ใช้ได้กับใบเสนอราคาแบบราคาต่อคันเท่านั้น');
      if (current.status !== 'APPROVED') throw conflict('ตั้งราคาได้เฉพาะใบเสนอราคาที่ลูกค้าอนุมัติแล้ว');
      if (current.ratesAppliedAt) throw conflict('ใบเสนอราคานี้ตั้งเป็นราคาลูกค้าไปแล้ว');
      if (!current.customerId) throw bad('ใบเสนอราคานี้ยังไม่ได้ผูกกับลูกค้าในระบบ - ผูกลูกค้าก่อนตั้งราคา');
      const customerId = current.customerId;
      await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${customerId} FOR UPDATE`;
      const old = await tx.serviceFeeRate.findMany({ where: { customerId }, orderBy: { sortOrder: 'asc' } });
      const rows = [...current.items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((it, i) => ({
          customerId,
          label: it.description,
          vehicleKind: it.vehicleKind ?? 'ANY',
          ccMin: it.ccMin,
          ccMax: it.ccMax,
          chassisPrefix: it.chassisPrefix,
          amount: it.unitPrice,
          vatInclusive: it.vatInclusive,
          includesReceipt: it.includesReceipt,
          kind: it.rateKind ?? 'BASE',
          sortOrder: i,
        }));
      await tx.serviceFeeRate.deleteMany({ where: { customerId } });
      await tx.serviceFeeRate.createMany({ data: rows });
      const remark = `ตั้งราคาจากใบเสนอราคา ${current.quotationNo}`;
      const brief = (r: { label: string; kind: string; amount: unknown }) => `${r.label} [${r.kind}] ${Number(r.amount)}`;
      await writeAudit(tx, { entity: 'Customer', entityId: customerId, action: 'apply-quotation-rates', remark, changes: { rates: { from: old.map(brief), to: rows.map(brief) } } });
      await writeAudit(tx, { entity: 'Quotation', entityId: id, action: 'apply-rates', remark, changes: { replacedRows: old.length, newRows: rows.length } });
      return tx.quotation.update({ where: { id }, data: { ratesAppliedAt: new Date() }, include: Q_INCLUDE });
    });
    return this.map(q);
  }

  async poFile(id: string): Promise<{ data: Buffer; mimeType: string; fileName: string }> {
    const q = await this.prisma.quotation.findUnique({ where: { id }, select: { storageKey: true, mimeType: true, quotationNo: true, originalName: true } });
    if (!q?.storageKey) throw new NotFoundException({ error: 'ไม่มีไฟล์แนบ' });
    const ext = q.storageKey.slice(q.storageKey.lastIndexOf('.') + 1);
    return { data: await this.storage.get(q.storageKey), mimeType: q.mimeType ?? 'application/octet-stream', fileName: q.originalName || `PO-${q.quotationNo ?? id}.${ext}` };
  }
}
