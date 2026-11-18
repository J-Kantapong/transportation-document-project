import { Injectable } from '@nestjs/common';
import { vehicleKindOf } from '../auth/vehicle-scope.js';
import { INSPECTION_SEPARATE_FROM } from '../billing/billing.service.js';
import { JOB_LABEL, JOB_TYPES, isJobType } from '../billing/other-jobs.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import { OverviewService } from '../overview/overview.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isMotorcycleType } from '../vehicles/vehicle-reference-data.js';
import { loadFinancePending } from './finance-pending.js';
import { costIndexMessage, costSheetText, findCostSheet, registrationCostText } from './job-cost-sheet.js';
import type { LineMessage } from './line-client.js';
import {
  ambiguousText,
  costText,
  customerLabel,
  customerSummaryText,
  matchCustomers,
  MAX_LOOKUP_DOCS,
  menuMessage,
  pendingText,
  quotationMessages,
  rateCustomersMessage,
  ratesText,
  summarizeCosts,
  supplierRateText,
  buildJobSummaries,
  jobSummaryTexts,
  type CustomerName,
  type JobKey,
  type JobPrice,
  type JobSample,
  type LookupCommand,
  type QuotationRow,
} from './lookup.js';
import { StatementService } from './statement.service.js';

// ช่วงที่ใช้คิดต้นทุนเฉลี่ย (Claude เลือก: 90 วัน พอให้มีงานทุกประเภทและยังเป็นราคาปัจจุบัน)
export const COST_DAYS = 90;

const textOf = (text: string): LineMessage => ({ type: 'text', text });
const num = (v: unknown) => Number(v ?? 0);
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round(n * 100) / 100;
const TRANSFER_LABEL: Record<string, string> = { OWNER: 'โอน', INSPECTION: 'โอนตรวจรถ', MOVE_IN: 'โอนย้ายเข้า' };
const classLabel = (vehicleClass: string) => (vehicleClass === 'MOTO' ? 'จักรยานยนต์' : 'รถยนต์');

// คำสั่งค้นข้อมูลของเลขาไลน์ (ผู้ใช้ 2026-11-18) - อ่านอย่างเดียวทั้งหมด ทำงานนอก request ของผู้ใช้ (webhook)
// ผู้เรียกต้องตรวจแล้วว่าเป็นเจ้าของระบบ เพราะคำตอบมีราคาและต้นทุน
@Injectable()
export class LookupService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly overviewService: OverviewService,
    private readonly statements: StatementService,
  ) {}

  private baseUrl(): string | undefined {
    const origin = process.env.FRONTEND_ORIGIN?.trim();
    return origin && /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : undefined;
  }

  // null = ไม่ใช่เรื่องของคำสั่งนี้ (เช่น "บิลเกินกำหนด" ไม่ใช่ชื่อลูกค้า) ให้ตัวรับคำสั่งเดิมตอบต่อ
  async run(command: LookupCommand): Promise<LineMessage[] | null> {
    switch (command.kind) {
      case 'menu':
        return [menuMessage()];
      case 'pending':
        return [await this.pending()];
      case 'jobs':
        return this.jobSummary();
      case 'rates':
        return [await this.rates(command.term)];
      case 'cost':
        return this.cost(command.term);
      case 'quotations':
        return this.quotations(command);
      case 'docs': {
        const found = await this.findCustomers(command.term);
        if (found.length === 0) return null;
        if (found.length > 1) return [textOf(ambiguousText(command.term, found))];
        return this.statements.invoiceLinks({ doc: command.doc, kind: 'customer', customerId: found[0].id, count: MAX_LOOKUP_DOCS });
      }
      case 'customer': {
        const found = await this.findCustomers(command.term);
        if (found.length !== 1) return [textOf(ambiguousText(command.term, found))];
        return [await this.customerSummary(found[0])];
      }
    }
  }

  private async findCustomers(term: string): Promise<CustomerName[]> {
    const all = await this.prisma.customer.findMany({ select: { id: true, name: true, company: true }, orderBy: { name: 'asc' } });
    return matchCustomers(all, term);
  }

  // งานค้างทุกขั้นตอน = คอลัมน์ "ค้างอยู่ตอนนี้" ของตารางงานแต่ละขั้นตอนในหน้าภาพรวม + รอวางบิล/รอรับเงินของการ์ดการเงิน
  private async pending(): Promise<LineMessage> {
    const today = bangkokToday();
    const [overview, finance] = await Promise.all([this.overviewService.overview(), loadFinancePending(this.prisma, today)]);
    return textOf(
      pendingText(overview.process, {
        unbilledVehicles: finance.unbilled.vehicles,
        unbilledJobs: finance.unbilled.jobs,
        receivableCount: finance.receivables.count,
        receivableAmount: finance.receivables.amount,
      }),
    );
  }

  // ตารางราคาของลูกค้า (ServiceFeeRate + JobFeeRate) - ไม่ระบุชื่อ = รายชื่อลูกค้าที่ตั้งราคาไว้
  private async rates(term: string): Promise<LineMessage> {
    if (!term) {
      const rows = await this.prisma.customer.findMany({
        where: { OR: [{ serviceFeeRates: { some: {} } }, { jobFeeRates: { some: {} } }] },
        select: { name: true },
        orderBy: { name: 'asc' },
      });
      return rateCustomersMessage(rows.map((r) => r.name));
    }
    const found = await this.findCustomers(term);
    if (found.length !== 1) return textOf(ambiguousText(term, found));
    const c = await this.prisma.customer.findUnique({
      where: { id: found[0].id },
      select: {
        name: true,
        company: true,
        billingVat: true,
        billingWhtRate: true,
        billingWhtSpecialRate: true,
        billingWhtSpecialUntil: true,
        billingCreditDays: true,
        billingPayWeekday: true,
        billingRequiresQuotation: true,
        serviceFeeRates: { orderBy: [{ kind: 'asc' }, { sortOrder: 'asc' }] },
        jobFeeRates: { orderBy: [{ jobType: 'asc' }, { sortOrder: 'asc' }] },
      },
    });
    if (!c) return textOf(ambiguousText(term, []));
    const today = bangkokToday();
    // อัตราพิเศษชั่วคราว (เช่น 1% ถึงสิ้นปี) ใช้แทนอัตราปกติจนถึงวันสุดท้าย - เหมือนตอนออกบิล
    const special = c.billingWhtSpecialRate !== null && c.billingWhtSpecialUntil && iso(c.billingWhtSpecialUntil) >= today;
    return textOf(
      ratesText(
        c.name === customerLabel(c) ? c.name : `${c.name} (${customerLabel(c)})`,
        c.serviceFeeRates.map((r) => ({
          label: r.label,
          vehicleKind: r.vehicleKind,
          ccMin: numOrNull(r.ccMin),
          ccMax: numOrNull(r.ccMax),
          chassisPrefix: r.chassisPrefix,
          registrationProvince: r.registrationProvince,
          bodyPrefix: r.bodyPrefix,
          amount: num(r.amount),
          vatInclusive: r.vatInclusive,
          includesReceipt: r.includesReceipt,
          kind: r.kind,
        })),
        c.jobFeeRates.map((r) => ({
          jobLabel: `${isJobType(r.jobType) ? JOB_LABEL[r.jobType] : r.jobType}${r.variant ? ` (${TRANSFER_LABEL[r.variant] ?? r.variant})` : ''}`,
          vehicleClass: r.vehicleClass,
          label: r.label,
          amount: num(r.amount),
          includesReceipt: r.includesReceipt,
        })),
        {
          vat: c.billingVat,
          whtRate: num(special ? c.billingWhtSpecialRate : c.billingWhtRate),
          creditDays: c.billingCreditDays,
          payWeekday: c.billingPayWeekday,
          requiresQuotation: c.billingRequiresQuotation,
        },
      ),
    );
  }

  // ต้นทุนจริงเฉลี่ยต่องานจากงานที่ยื่นใน COST_DAYS วันล่าสุด: ต้นทุน = No Bill + ค่าอากร (ผู้ใช้ 2026-10-06 ตอนวิเคราะห์กำไร)
  // รถจดใหม่: No Bill ของรายการยื่นที่ได้ใบเสร็จแล้ว + No Bill แจ้งย้าย + ค่าตรวจรถนอกที่ต่ำกว่า INSPECTION_SEPARATE_FROM
  // (ตั้งแต่ยอดนั้นขึ้นไปลูกค้าจ่ายแยก ไม่ใช่ต้นทุนของเรา) · ค่าธรรมเนียมตามใบเสร็จไม่นับ เพราะเก็บลูกค้าเท่าจริง
  // "ต้นทุน" = รายการงานให้เลือก · "ต้นทุน <งาน>" = ใบต้นทุนต่อคัน Bill / No Bill ตามอัตราของงานนั้น (job-cost-sheet.ts)
  // "ต้นทุน จด…" = ตารางอัตราจดทะเบียนรถใหม่จากฐานข้อมูล · "ต้นทุน เฉลี่ย" = เฉลี่ยจากงานจริง · อย่างอื่น = ราคาซับของจังหวัดนั้น
  private async cost(term: string): Promise<LineMessage[]> {
    const key = term.replace(/\s+/g, '');
    if (!key) return [costIndexMessage()];
    if (key.includes('เฉลี่ย')) return [await this.costs()];
    const sheet = findCostSheet(key);
    if (sheet) return [textOf(costSheetText(sheet))];
    if (/จด|รถใหม่/.test(key)) {
      const moto = /จักรยานยนต์|มอเตอร์ไซค์|จยย/.test(key);
      const car = /รถยนต์|เก๋ง|กระบะ/.test(key);
      const param = { select: { key: true, amount: true }, orderBy: { key: 'asc' } } as const;
      const rows = (list: Array<{ key: string; amount: unknown }>) => list.map((r) => ({ key: r.key, amount: numOrNull(r.amount) }));
      const out: LineMessage[] = [];
      if (car || !moto) {
        const [bill, noBill] = await Promise.all([this.prisma.feeCarBillParam.findMany(param), this.prisma.feeCarNoBillParam.findMany(param)]);
        out.push(textOf(registrationCostText('car', rows(bill), rows(noBill))));
      }
      if (moto || !car) {
        const [bill, noBill] = await Promise.all([this.prisma.feeMotorcycleBillParam.findMany(param), this.prisma.feeMotorcycleNoBillParam.findMany(param)]);
        out.push(textOf(registrationCostText('moto', rows(bill), rows(noBill))));
      }
      return out;
    }
    return [await this.supplierRate(term)];
  }

  private async costs(): Promise<LineMessage> {
    return textOf(costText(summarizeCosts(await this.loadCostSamples(this.costSince())), COST_DAYS));
  }

  private costSince(): Date {
    const since = new Date(`${bangkokToday()}T00:00:00.000Z`);
    since.setUTCDate(since.getUTCDate() - COST_DAYS);
    return since;
  }

  // สรุปแยกตามประเภทงาน (ผู้ใช้ 2026-11-18 "มันมีหลายประเภทงาน ทำสรุปมาในแต่ละงาน"): ยื่นเดือนนี้ / ค้างตอนนี้ / ต้นทุนเฉลี่ย / ค่าบริการเฉลี่ยที่วางบิล
  // ต้นทุน = ชุดเดียวกับคำสั่ง "ต้นทุน" · ค่าบริการ = ค่าดำเนินการก่อน VAT ของบิลที่ไม่ยกเลิกซึ่งออกใน COST_DAYS วันล่าสุด
  // (รถจดใหม่ = InvoiceLine.serviceFee · งานอื่น = InvoiceItem ชนิด SERVICE ที่ผูกกับงาน) · สลับเลขวางบิลพ่วงกับรถใหม่ จึงไม่มีค่าบริการแยก
  private async jobSummary(): Promise<LineMessage[]> {
    const today = bangkokToday();
    const month = today.slice(0, 7);
    const since = this.costSince();
    const liveInvoice = { status: { not: 'VOID' }, issueDate: { gte: since } };
    const [overview, samples, monthSubs, lines, items] = await Promise.all([
      this.overviewService.overview(),
      this.loadCostSamples(since),
      this.prisma.documentSubmission.findMany({
        where: { status: { not: 'FAILED' }, submitDate: { gte: new Date(`${month}-01T00:00:00.000Z`) }, vehicle: { deletedAt: null } },
        select: { vehicle: { select: { body: true } } },
      }),
      this.prisma.invoiceLine.findMany({ where: { invoice: liveInvoice }, select: { serviceFee: true, body: true } }),
      this.prisma.invoiceItem.findMany({ where: { kind: 'SERVICE', sourceType: { in: [...JOB_TYPES] }, invoice: liveInvoice }, select: { amount: true, sourceType: true, sourceSnapshot: true } }),
    ]);
    const kindOfBody = (body: string | null) => (vehicleKindOf(body) === 'moto' ? ('moto' as const) : ('car' as const));
    const prices: JobPrice[] = [
      ...lines.map((l): JobPrice => ({ type: 'NEW', kind: kindOfBody(l.body), amount: num(l.serviceFee) })),
      ...items.map((i): JobPrice => ({ type: i.sourceType as JobKey, kind: (i.sourceSnapshot as { vehicleClass?: string } | null)?.vehicleClass === 'MOTO' ? 'moto' : 'car', amount: num(i.amount) })),
    ];
    const submitted = [
      ...monthSubs.map((s) => ({ type: 'NEW' as JobKey, kind: kindOfBody(s.vehicle.body) })),
      ...samples.filter((s) => s.type !== 'NEW' && s.date.slice(0, 7) === month).map((s) => ({ type: s.type, kind: s.kind })),
    ];
    return jobSummaryTexts(buildJobSummaries({ samples, prices, submitted, process: overview.process }), { month, days: COST_DAYS }).map(textOf);
  }

  private async loadCostSamples(since: Date): Promise<JobSample[]> {
    const job = { where: { cancelledAt: null, submitDate: { gte: since } } } as const;
    const [submissions, transfers, cancels, copies, moveOuts, swaps, renewals] = await Promise.all([
      this.prisma.documentSubmission.findMany({
        where: { status: 'RECEIPT_RECEIVED', submitDate: { gte: since }, vehicle: { deletedAt: null } },
        select: { submitDate: true, noBillTotal: true, viaSupplier: true, vehicle: { select: { body: true, transferCost: true, inspectionResultCost: true } } },
      }),
      this.prisma.vehicleTransfer.findMany({ ...job, select: { submitDate: true, transferType: true, vehicleClass: true, noBillTotal: true, dutyAmount: true } }),
      this.prisma.vehicleUseCancellation.findMany({ ...job, select: { submitDate: true, vehicleClass: true, noBillTotal: true, dutyAmount: true } }),
      this.prisma.plateCopy.findMany({ ...job, select: { submitDate: true, vehicleClass: true, noBillTotal: true, dutyAmount: true } }),
      this.prisma.vehicleMoveOut.findMany({ ...job, select: { submitDate: true, vehicleClass: true, noBillTotal: true, dutyAmount: true } }),
      this.prisma.plateSwap.findMany({ ...job, select: { submitDate: true, vehicleClass: true, noBillTotal: true } }),
      this.prisma.taxRenewal.findMany({ where: { cancelledAt: null, paymentDate: { not: null }, submitDate: { gte: since } }, select: { submitDate: true, vehicleType: true, noBillTotal: true } }),
    ]);

    const samples: JobSample[] = [];
    for (const s of submissions) {
      const inspection = num(s.vehicle.inspectionResultCost);
      const cost = num(s.noBillTotal) + num(s.vehicle.transferCost) + (inspection < INSPECTION_SEPARATE_FROM ? inspection : 0);
      const kind = vehicleKindOf(s.vehicle.body) === 'moto' ? 'moto' : 'car';
      samples.push({ type: 'NEW', kind, date: iso(s.submitDate), group: 'จดทะเบียนรถใหม่', label: `${kind === 'moto' ? 'จักรยานยนต์' : 'รถยนต์'} (${s.viaSupplier ? 'ส่งซับ' : 'จดเอง'})`, cost: round2(cost) });
    }
    const other = (type: JobKey, label: string, rows: Array<{ submitDate: Date; vehicleClass: string; noBillTotal: unknown; dutyAmount?: unknown }>) => {
      for (const r of rows) {
        samples.push({ type, kind: r.vehicleClass === 'MOTO' ? 'moto' : 'car', date: iso(r.submitDate), group: 'งานอื่นๆ', label: `${label} ${classLabel(r.vehicleClass)}`, cost: round2(num(r.noBillTotal) + num(r.dutyAmount)) });
      }
    };
    for (const type of Object.keys(TRANSFER_LABEL)) other('TRANSFER', TRANSFER_LABEL[type], transfers.filter((t) => t.transferType === type));
    other('USE_CANCEL', 'ยกเลิกการใช้รถ', cancels);
    other('PLATE_COPY', 'คัดแผ่นป้าย', copies);
    other('MOVE_OUT', 'ย้ายออก', moveOuts);
    other('PLATE_SWAP', 'สลับเลข', swaps);
    other('TAX_RENEWAL', 'ต่อภาษี', renewals.map((r) => ({ submitDate: r.submitDate, vehicleClass: isMotorcycleType(r.vehicleType) ? 'MOTO' : 'CAR', noBillTotal: r.noBillTotal })));
    return samples;
  }

  // ราคาซับจดต่างจังหวัด (SupplierProvinceRate) ของจังหวัดที่ชื่อมีคำนั้น
  private async supplierRate(term: string): Promise<LineMessage> {
    const key = term.replace(/\s+/g, '');
    const rows = await this.prisma.supplierProvinceRate.findMany({
      where: { province: { contains: key } },
      select: { province: true, accepts: true, serviceFee: true, channelFee: true, inspectionFee: true, plateSwapFee: true, plateSwapNote: true, note: true },
      orderBy: { province: 'asc' },
    });
    return textOf(
      supplierRateText(
        term,
        rows.map((r) => ({ ...r, serviceFee: numOrNull(r.serviceFee), channelFee: numOrNull(r.channelFee), inspectionFee: numOrNull(r.inspectionFee), plateSwapFee: numOrNull(r.plateSwapFee) })),
      ),
    );
  }

  // ใบเสนอราคา: ล่าสุด (ไม่นับร่าง / ยกเลิก / ฉบับที่ถูกแก้ไขแทน) · ตามเลข · ของลูกค้ารายเดียว - ยอดอ่านจากใบตรงๆ ไม่คำนวณใหม่
  private async quotations(command: Extract<LookupCommand, { kind: 'quotations' }>): Promise<LineMessage[]> {
    const today = bangkokToday();
    const live = { status: { in: ['ISSUED', 'APPROVED', 'REJECTED'] } };
    const select = {
      id: true,
      quotationNo: true,
      kind: true,
      status: true,
      title: true,
      issueDate: true,
      validUntil: true,
      customerSnapshot: true,
      feeTotal: true,
      serviceTotal: true,
      goodsTotal: true,
      vatRate: true,
      vatAmount: true,
      whtRate: true,
      whtAmount: true,
      netTotal: true,
      poNumber: true,
      customer: { select: { name: true, company: true } },
      invoices: { where: { status: { not: 'VOID' } }, select: { invoiceNo: true } },
    } as const;
    const order = [{ createdAt: 'desc' }, { quotationNo: 'desc' }] as const;
    let rows;
    let missing: string[] = [];
    if (command.mode === 'latest') rows = await this.prisma.quotation.findMany({ where: live, orderBy: [...order], take: command.count, select });
    else if (command.mode === 'numbers') {
      const found = await this.prisma.quotation.findMany({ where: { quotationNo: { in: command.numbers } }, select });
      rows = command.numbers.flatMap((no) => found.filter((q) => q.quotationNo === no));
      missing = command.numbers.filter((no) => !found.some((q) => q.quotationNo === no));
    } else {
      const found = await this.findCustomers(command.term);
      if (found.length !== 1) return [textOf(ambiguousText(command.term, found))];
      rows = await this.prisma.quotation.findMany({ where: { ...live, customerId: found[0].id }, orderBy: [...order], take: MAX_LOOKUP_DOCS, select });
      if (rows.length === 0) return [textOf(`${customerLabel(found[0])} ยังไม่มีใบเสนอราคา`)];
    }
    const base = this.baseUrl();
    return quotationMessages(
      rows.map((q): QuotationRow => {
        const snapshotName = (q.customerSnapshot as { name?: unknown } | null)?.name;
        return {
          quotationNo: q.quotationNo,
          customerName: typeof snapshotName === 'string' && snapshotName.trim() ? snapshotName.trim() : q.customer ? customerLabel(q.customer) : '-',
          kind: q.kind,
          status: q.status,
          title: q.title,
          issueDate: iso(q.issueDate),
          validUntil: iso(q.validUntil),
          feeTotal: num(q.feeTotal),
          serviceTotal: num(q.serviceTotal),
          goodsTotal: num(q.goodsTotal),
          vatRate: num(q.vatRate),
          vatAmount: num(q.vatAmount),
          whtRate: num(q.whtRate),
          whtAmount: num(q.whtAmount),
          netTotal: num(q.netTotal),
          poNumber: q.poNumber,
          invoiceNos: q.invoices.map((i) => i.invoiceNo),
          url: base ? `${base}/accounting/quotations/view?id=${encodeURIComponent(q.id)}` : undefined,
        };
      }),
      missing,
      today,
    );
  }

  // ยอดของลูกค้ารายเดียว: บิลรอรับเงิน, วางบิล/รับเงินเดือนนี้, รถที่ส่งงานแล้วรอวางบิล, ใบเสนอราคาที่ยังเปิดอยู่
  private async customerSummary(customer: CustomerName): Promise<LineMessage> {
    const today = bangkokToday();
    const month = today.slice(0, 7);
    const monthStart = new Date(`${month}-01T00:00:00.000Z`);
    const nextMonth = new Date(monthStart);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    const inMonth = { gte: monthStart, lt: nextMonth };
    const customerId = customer.id;
    const [open, billed, paid, unbilledVehicles, quotations] = await Promise.all([
      this.prisma.invoice.findMany({ where: { customerId, status: 'ISSUED' }, select: { invoiceNo: true, issueDate: true, dueDate: true, netTotal: true }, orderBy: { issueDate: 'asc' } }),
      this.prisma.invoice.aggregate({ where: { customerId, status: { not: 'VOID' }, issueDate: inMonth }, _count: { _all: true }, _sum: { netTotal: true } }),
      this.prisma.invoice.aggregate({ where: { customerId, status: 'PAID', paidDate: inMonth }, _count: { _all: true }, _sum: { netTotal: true } }),
      // เงื่อนไขเดียวกับคิวรอวางบิล (finance-pending.ts)
      this.prisma.vehicle.count({ where: { customerId, deletedAt: null, billingClosedAt: null, deliveredDate: { not: null }, invoiceLines: { none: { invoice: { status: { not: 'VOID' } } } } } }),
      this.prisma.quotation.findMany({
        where: { customerId, status: { in: ['DRAFT', 'ISSUED', 'APPROVED'] }, invoices: { none: { status: { not: 'VOID' } } }, ratesAppliedAt: null },
        select: { quotationNo: true, status: true, netTotal: true, kind: true },
        orderBy: { createdAt: 'desc' },
        take: 5,
      }),
    ]);
    return textOf(
      customerSummaryText(
        {
          customerName: customer.name,
          month,
          open: open.map((i) => ({ invoiceNo: i.invoiceNo, issueDate: iso(i.issueDate), dueDate: i.dueDate ? iso(i.dueDate) : null, netTotal: num(i.netTotal) })),
          billedMonth: { count: billed._count._all, amount: num(billed._sum.netTotal) },
          paidMonth: { count: paid._count._all, amount: num(paid._sum.netTotal) },
          unbilledVehicles,
          quotations: quotations.map((q) => ({ quotationNo: q.quotationNo, status: q.status, netTotal: num(q.netTotal), kind: q.kind })),
        },
        today,
      ),
    );
  }
}
