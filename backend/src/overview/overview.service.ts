import { BadRequestException, Injectable } from '@nestjs/common';
import { ACTIVE_SUBMISSION_STATUSES } from '../document-submission/submission-eligibility.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, agingBuckets, bangkokToday, buildForecast, daysBetween, isoOf, paymentBehaviour, pctChange, round2, toDate } from './overview-calculator.js';
import {
  INSPECTION_WARN_DAYS,
  STAGES,
  sortStuck,
  stuckItemFor,
  summarizeBacklog,
  vehicleKindOf,
  waitsFor,
  type BacklogItem,
  type Flag,
  type KindCount,
  type StageKey,
  type StuckItem,
  type VehicleKind,
} from './overview-process.js';

// ภาพรวมผู้บริหาร (ADMIN เท่านั้น - ดู access-policy.ts): สรุปการใช้เงินรายวัน งานแต่ละขั้นตอน (แยกรถยนต์/จักรยานยนต์)
// คันที่ติดขัด กระแสเงินสด และประมาณการ - อ่านอย่างเดียว ไม่เขียนข้อมูล
// "ใช้เงิน" = เงินที่ร้านจ่ายออกไปจริงในแต่ละงาน (Bill + No bill ที่บันทึกไว้ตอนทำงาน) ส่วน "รับเงิน" = บิลที่บัญชีบันทึกรับเงินแล้ว
// (Invoice PAID) ระบบยังไม่มียอดเงินในบัญชีธนาคาร จึงแสดงได้แค่กระแสสุทธิ ไม่ใช่ยอดคงเหลือ
// ค่าที่ผู้ใช้ยังไม่ได้กำหนด (กำหนดเวลาแต่ละขั้น, เกณฑ์เตือน, ค่าตั้งต้นประมาณการ) อยู่ใน overview-process.ts / overview-calculator.ts

const FORECAST_WEEKS = 4;
const SERIES_DAYS = 30;
const STUCK_LIMIT = 100;
const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;
const MOTO_TYPE_PREFIX = 'รย.12'; // ต่อภาษี: vehicleType ขึ้นต้น รย.12 = จักรยานยนต์ (เหมือน Vehicle.body)

const num = (d: unknown) => (d === null || d === undefined ? 0 : Number(d));
const renewalKind = (vehicleType: string): VehicleKind => (vehicleType.startsWith(MOTO_TYPE_PREFIX) ? 'moto' : 'car');
const plateText = (category: string | null, number: string | null) => (category && number ? `${category} ${number}` : null);

export const SPEND_CATEGORIES = [
  { key: 'submit', label: 'ยื่นจดทะเบียนรถใหม่' },
  { key: 'inspection', label: 'ตรวจสภาพรถ' },
  { key: 'transfer', label: 'แจ้งย้าย/ตัดบัญชี' },
  { key: 'plateSwap', label: 'สลับเลข' },
  { key: 'taxRenewal', label: 'ต่อภาษี' },
  { key: 'yamaha', label: 'แจ้งย้ายยามาฮ่า' },
] as const;
type CategoryKey = (typeof SPEND_CATEGORIES)[number]['key'];

interface SpendEvent {
  date: string;
  category: CategoryKey;
  kind: VehicleKind | null; // null = ไม่แยกประเภทรถ (ยามาฮ่า บันทึกเป็นจำนวนคันต่อวัน)
  bill: number; // มีใบเสร็จ
  noBill: number; // ลงขัน ไม่มีใบเสร็จ
  other: number; // ไม่ได้แยกว่า Bill/No bill (ค่าแจ้งย้าย/ตัดบัญชี)
}

const eventTotal = (e: SpendEvent) => e.bill + e.noBill + e.other;

// แถวของตาราง "งานแต่ละขั้นตอน" - ค่า null ในช่อง car/moto = ขั้นนี้ไม่มีรถประเภทนั้น (เช่น สลับเลขมีแต่รถยนต์)
export interface SplitValue {
  car: number | null;
  moto: number | null;
  unsplit?: number; // ข้อมูลที่ไม่ได้แยกประเภทรถ (ยามาฮ่า)
}

export interface ProcessRow {
  key: string;
  group: 'new' | 'other';
  label: string;
  href: string;
  done: SplitValue; // ทำไปในวันที่เลือก
  doneNote: string | null;
  spend: SplitValue | null; // ค่าใช้จ่ายในวันที่เลือก (บาท) - null = ขั้นนี้ไม่มีค่าใช้จ่าย
  pending: SplitValue | null; // ค้างอยู่ตอนนี้ - null = ไม่มีคิว
  oldestDays: number | null;
  lateCount: number;
  sla: number | null;
}

function parseAsOf(raw: unknown): string {
  if (raw === undefined || raw === '') return bangkokToday();
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
  }
  return raw;
}

function tally<T>(rows: T[], kindOf: (row: T) => VehicleKind, valueOf: (row: T) => number = () => 1): KindCount {
  const out = { car: 0, moto: 0 };
  for (const r of rows) out[kindOf(r)] += valueOf(r);
  return { car: round2(out.car), moto: round2(out.moto) };
}

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(dateRaw?: unknown) {
    const today = bangkokToday();
    const asOf = parseAsOf(dateRaw);
    if (asOf > today) throw new BadRequestException({ error: 'เลือกวันที่หลังวันนี้ไม่ได้' });

    const day = toDate(asOf);
    const range = { gte: toDate(addDays(asOf, -(SERIES_DAYS * 2 - 1))), lte: day }; // 60 วัน: 30 วันล่าสุด + 30 วันก่อนหน้าไว้เทียบ
    const live = { deletedAt: null };
    const bodyOf = { select: { body: true } };

    const [
      subs,
      swaps,
      renewals,
      yamaha,
      transfers,
      inspections,
      billedInvoices,
      paidInvoices,
      receivables,
      paidHistory,
      unbilledVehicles,
      inProcessSubs,
      receiptRows,
      openVehicles,
      dayVehicles,
      dayReceipts,
      dayBilledLines,
      openSwaps,
      openRenewals,
      pendingUsers,
    ] = await Promise.all([
      // --- ค่าใช้จ่าย 60 วัน (กราฟรายวัน + เทียบช่วงก่อนหน้า) ---
      this.prisma.documentSubmission.findMany({
        where: { status: { not: 'FAILED' }, submitDate: range, vehicle: live },
        select: { submitDate: true, billFeeTotal: true, noBillTotal: true, taxAmount: true, vehicle: bodyOf },
      }),
      this.prisma.plateSwap.findMany({
        where: { OR: [{ submitDate: range }, { returnedDate: day }] },
        select: { submitDate: true, returnedDate: true, billTotal: true, noBillTotal: true },
      }),
      this.prisma.taxRenewal.findMany({ where: { paymentDate: range }, select: { paymentDate: true, vehicleType: true, billTotal: true, noBillTotal: true } }),
      this.prisma.yamahaRelocationEntry.findMany({ where: { date: range }, select: { date: true, count: true, billFee: true, noBillFee: true } }),
      this.prisma.vehicle.findMany({
        where: { ...live, transferDone: true, transferCompletedDate: range },
        select: { transferCompletedDate: true, transferCost: true, body: true },
      }),
      this.prisma.vehicle.findMany({
        where: { ...live, inspectionSentDate: range },
        select: {
          body: true,
          inspectionSentDate: true,
          inspectionSentCost: true,
          inspectionSentBillCost: true,
          inspectionResultDate: true,
          inspectionResultCost: true,
          inspectionResultBillCost: true,
        },
      }),
      // --- เงินเข้า / ลูกหนี้ ---
      this.prisma.invoice.findMany({ where: { status: { not: 'VOID' }, issueDate: range }, select: { issueDate: true, netTotal: true } }),
      this.prisma.invoice.findMany({ where: { status: 'PAID', paidDate: range }, select: { paidDate: true, netTotal: true } }),
      this.prisma.invoice.findMany({
        where: { status: 'ISSUED' },
        select: { id: true, invoiceNo: true, issueDate: true, customerId: true, netTotal: true, customerSnapshot: true },
      }),
      this.prisma.invoice.findMany({
        where: { status: 'PAID', paidDate: { gte: toDate(addDays(today, -180)) } },
        select: { customerId: true, issueDate: true, paidDate: true, lines: { select: { deliveredDate: true } } },
      }),
      this.prisma.vehicle.findMany({
        where: { ...live, deliveredDate: { not: null }, invoiceLines: { none: NOT_VOID } },
        select: {
          customerId: true,
          deliveredDate: true,
          customer: { select: { name: true } },
          documentSubmissions: { orderBy: { createdAt: 'desc' }, take: 1, select: { receiptAmount: true, billFeeTotal: true, taxAmount: true } },
        },
      }),
      this.prisma.documentSubmission.findMany({
        where: { status: { in: ACTIVE_SUBMISSION_STATUSES }, vehicle: { ...live, deliveredDate: null } },
        select: { billFeeTotal: true, taxAmount: true },
      }),
      this.prisma.documentSubmission.findMany({
        where: {
          status: 'RECEIPT_RECEIVED',
          receiptAmount: { not: null },
          taxAmount: { not: null },
          receiptDate: { gte: toDate(addDays(asOf, -(SERIES_DAYS - 1))), lte: day }, // วันที่ในใบเสร็จ (ผู้ใช้ 2026-09-25)
          vehicle: live,
        },
        select: { receiptAmount: true, billFeeTotal: true, taxAmount: true },
      }),
      // --- รถที่ยังไม่จบงาน (ยังไม่ส่งงาน / ป้ายค้างส่ง / ยังไม่วางบิล) -> คิวค้าง + คันที่ติดขัด ---
      this.prisma.vehicle.findMany({
        where: { ...live, OR: [{ deliveredDate: null }, { plateDeliveredDate: null }, { invoiceLines: { none: NOT_VOID } }] },
        select: {
          id: true,
          date: true,
          chassis: true,
          body: true,
          plateCategory: true,
          plateNumber: true,
          transferDone: true,
          transferCompletedDate: true,
          inspectionSentDate: true,
          inspectionResult: true,
          inspectionResultDate: true,
          inspectionFailRemark: true,
          plateReceivedDate: true,
          bookReceivedDate: true,
          deliveredDate: true,
          plateDeliveredDate: true,
          customer: { select: { name: true } },
          brand: { select: { name: true } },
          documentSubmissions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, submitDate: true, receiptDate: true, receiptReceivedDate: true, failRemark: true, receiptCarriedAt: true },
          },
          plateSwapsAsNew: { where: { returnedDate: null }, take: 1, select: { id: true } },
          invoiceLines: { where: NOT_VOID, take: 1, select: { id: true } },
        },
      }),
      // --- งานที่ทำในวันที่เลือก ---
      this.prisma.vehicle.findMany({
        where: {
          ...live,
          OR: [
            { date: day },
            { transferCompletedDate: day },
            { inspectionSentDate: day },
            { inspectionResultDate: day },
            { plateReceivedDate: day },
            { bookReceivedDate: day },
            { deliveredDate: day },
            { plateDeliveredDate: day },
          ],
        },
        select: {
          body: true,
          date: true,
          transferDone: true,
          transferCompletedDate: true,
          inspectionSentDate: true,
          inspectionResult: true,
          inspectionResultDate: true,
          plateReceivedDate: true,
          bookReceivedDate: true,
          deliveredDate: true,
          plateDeliveredDate: true,
        },
      }),
      this.prisma.documentSubmission.findMany({ where: { status: 'RECEIPT_RECEIVED', receiptDate: day, vehicle: live }, select: { vehicle: bodyOf } }),
      this.prisma.invoiceLine.findMany({ where: { invoice: { status: { not: 'VOID' }, issueDate: day } }, select: { body: true } }),
      // --- งานอื่นที่ค้าง ---
      this.prisma.plateSwap.findMany({
        where: { returnedDate: null },
        select: { id: true, submitDate: true, oldOwnerName: true, oldChassis: true, oldBrand: true, oldPlateCategory: true, oldPlateNumber: true },
      }),
      this.prisma.taxRenewal.findMany({
        where: { paymentDate: null },
        select: {
          id: true,
          submitDate: true,
          vehicleType: true,
          chassis: true,
          plateCategory: true,
          plateNumber: true,
          ownerName: true,
          customer: { select: { name: true } },
        },
      }),
      this.prisma.user.count({ where: { status: 'PENDING' } }),
    ]);

    // ---------- การใช้เงิน ----------
    const events: SpendEvent[] = [];
    for (const s of subs) {
      events.push({
        date: isoOf(s.submitDate),
        category: 'submit',
        kind: vehicleKindOf(s.vehicle.body),
        bill: num(s.billFeeTotal) + num(s.taxAmount),
        noBill: num(s.noBillTotal),
        other: 0,
      });
    }
    for (const s of swaps) {
      if (s.submitDate >= range.gte) {
        events.push({ date: isoOf(s.submitDate), category: 'plateSwap', kind: 'car', bill: num(s.billTotal), noBill: num(s.noBillTotal), other: 0 });
      }
    }
    for (const r of renewals) {
      events.push({
        date: isoOf(r.paymentDate!),
        category: 'taxRenewal',
        kind: renewalKind(r.vehicleType),
        bill: num(r.billTotal),
        noBill: num(r.noBillTotal),
        other: 0,
      });
    }
    for (const y of yamaha) events.push({ date: isoOf(y.date), category: 'yamaha', kind: null, bill: num(y.billFee), noBill: num(y.noBillFee), other: 0 });
    for (const t of transfers) {
      events.push({ date: isoOf(t.transferCompletedDate!), category: 'transfer', kind: vehicleKindOf(t.body), bill: 0, noBill: 0, other: num(t.transferCost) });
    }
    for (const v of inspections) {
      // ทราบผลแล้ว ใช้ราคา ณ วันทราบผล (ตรวจไม่ผ่านเป็น 0 = ได้เงินคืน) ยังไม่ทราบผลใช้ราคาตอนส่งตรวจ
      const known = v.inspectionResultDate !== null;
      events.push({
        date: isoOf(v.inspectionSentDate!),
        category: 'inspection',
        kind: vehicleKindOf(v.body),
        bill: known ? num(v.inspectionResultBillCost) : num(v.inspectionSentBillCost),
        noBill: known ? num(v.inspectionResultCost) : num(v.inspectionSentCost),
        other: 0,
      });
    }

    const sumEvents = (from: string, to: string) => {
      let total = 0;
      let bill = 0;
      let noBill = 0;
      for (const e of events) {
        if (e.date < from || e.date > to) continue;
        total += eventTotal(e);
        bill += e.bill;
        noBill += e.noBill;
      }
      return { total: round2(total), bill: round2(bill), noBill: round2(noBill), other: round2(total - bill - noBill) };
    };
    const sumMoney = (rows: Array<{ date: string; amount: number }>, from: string, to: string) =>
      round2(rows.filter((r) => r.date >= from && r.date <= to).reduce((a, r) => a + r.amount, 0));

    const billedRows = billedInvoices.map((i) => ({ date: isoOf(i.issueDate), amount: num(i.netTotal) }));
    const collectedRows = paidInvoices.map((i) => ({ date: isoOf(i.paidDate!), amount: num(i.netTotal) }));
    const submittedByDay = new Map<string, number>();
    for (const s of subs) submittedByDay.set(isoOf(s.submitDate), (submittedByDay.get(isoOf(s.submitDate)) ?? 0) + 1);

    const windows = {
      today: [asOf, asOf],
      yesterday: [addDays(asOf, -1), addDays(asOf, -1)],
      last7: [addDays(asOf, -6), asOf],
      prev7: [addDays(asOf, -13), addDays(asOf, -7)],
      last30: [addDays(asOf, -29), asOf],
      prev30: [addDays(asOf, -59), addDays(asOf, -30)],
      month: [`${asOf.slice(0, 8)}01`, asOf],
    } as const;
    const spendBy = (w: readonly [string, string]) => sumEvents(w[0], w[1]);
    const moneyBy = (rows: Array<{ date: string; amount: number }>, w: readonly [string, string]) => sumMoney(rows, w[0], w[1]);

    const daily = Array.from({ length: SERIES_DAYS }, (_, i) => {
      const date = addDays(asOf, -(SERIES_DAYS - 1 - i));
      const s = sumEvents(date, date);
      return {
        date,
        spend: s.total,
        bill: s.bill,
        noBill: s.noBill,
        other: s.other,
        billed: sumMoney(billedRows, date, date),
        collected: sumMoney(collectedRows, date, date),
        submitted: submittedByDay.get(date) ?? 0,
      };
    });

    const categories = SPEND_CATEGORIES.map((c) => {
      const of = (w: readonly [string, string]) =>
        round2(events.filter((e) => e.category === c.key && e.date >= w[0] && e.date <= w[1]).reduce((a, e) => a + eventTotal(e), 0));
      return { key: c.key, label: c.label, today: of(windows.today), last30: of(windows.last30) };
    });

    // ค่าใช้จ่ายของวันที่เลือก แยกประเภทรถ - ใช้ในตารางงานแต่ละขั้นตอน
    const daySpend = (category: CategoryKey): SplitValue => {
      const rows = events.filter((e) => e.category === category && e.date === asOf);
      if (category === 'yamaha') return { car: null, moto: null, unsplit: round2(rows.reduce((a, e) => a + eventTotal(e), 0)) };
      return tally(rows, (e) => e.kind!, eventTotal);
    };

    // ---------- ลูกหนี้ / เงินจม ----------
    const receivableItems = receivables.map((i) => ({
      customerId: i.customerId,
      customerName: (i.customerSnapshot as { name?: string } | null)?.name ?? '-',
      issueDate: isoOf(i.issueDate),
      amount: num(i.netTotal),
    }));
    const unbilledItems = unbilledVehicles.map((v) => {
      const sub = v.documentSubmissions[0];
      const receipt = sub?.receiptAmount != null ? num(sub.receiptAmount) : sub ? num(sub.billFeeTotal) + num(sub.taxAmount) : 0;
      return { customerId: v.customerId, customerName: v.customer.name, deliveredDate: isoOf(v.deliveredDate!), amount: receipt };
    });
    const receivableTotal = round2(receivableItems.reduce((a, r) => a + r.amount, 0));
    const unbilledTotal = round2(unbilledItems.reduce((a, r) => a + r.amount, 0));
    const inProcessTotal = round2(inProcessSubs.reduce((a, s) => a + num(s.billFeeTotal) + num(s.taxAmount), 0));

    const behaviour = paymentBehaviour(
      paidHistory.map((i) => ({
        customerId: i.customerId,
        issueDate: isoOf(i.issueDate),
        paidDate: isoOf(i.paidDate!),
        firstDeliveredDate: i.lines.length ? i.lines.map((l) => isoOf(l.deliveredDate)).sort()[0] : null,
      })),
    );

    const byCustomer = new Map<string, { customerId: string; name: string; receivable: number; unbilled: number }>();
    const bucket = (id: string, name: string) => {
      const existing = byCustomer.get(id);
      if (existing) return existing;
      const created = { customerId: id, name, receivable: 0, unbilled: 0 };
      byCustomer.set(id, created);
      return created;
    };
    for (const r of receivableItems) bucket(r.customerId, r.customerName).receivable += r.amount;
    for (const u of unbilledItems) bucket(u.customerId, u.customerName).unbilled += u.amount;
    const topCustomers = [...byCustomer.values()]
      .map((c) => ({ ...c, receivable: round2(c.receivable), unbilled: round2(c.unbilled), total: round2(c.receivable + c.unbilled) }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 5);

    // ---------- ประมาณการ 4 สัปดาห์ ----------
    const avgDailySpend = sumEvents(addDays(asOf, -27), asOf).total / 28;
    const forecast = buildForecast({
      today,
      weeks: FORECAST_WEEKS,
      receivable: receivableItems.map((r) => ({ customerId: r.customerId, issueDate: r.issueDate, amount: r.amount })),
      unbilled: unbilledItems.map((u) => ({ customerId: u.customerId, deliveredDate: u.deliveredDate, amount: u.amount })),
      payDaysFor: behaviour.payDaysFor,
      billingLagDays: behaviour.billingLagDays,
      avgDailySpend,
    });

    // ---------- งานค้าง + คันที่ติดขัด ----------
    const backlogItems: BacklogItem[] = [];
    const stuck: StuckItem[] = [];
    const flagCount = new Map<Flag, number>();
    for (const v of openVehicles) {
      const kind = vehicleKindOf(v.body);
      const sub = v.documentSubmissions[0] ?? null;
      const waits = waitsFor(
        {
          ...v,
          latestSubmission: sub,
          hasPendingPlateSwap: v.plateSwapsAsNew.length > 0,
          billed: v.invoiceLines.length > 0,
        },
        today,
      );
      for (const w of waits) {
        backlogItems.push({ stage: w.stage, kind, since: w.since });
        for (const f of w.flags) flagCount.set(f, (flagCount.get(f) ?? 0) + 1);
      }
      const item = stuckItemFor(
        {
          id: v.id,
          source: 'vehicle',
          kind,
          customerName: v.customer.name,
          brandName: v.brand.name,
          chassis: v.chassis,
          plate: plateText(v.plateCategory, v.plateNumber),
        },
        waits,
        today,
      );
      if (item) stuck.push(item);
    }
    for (const s of openSwaps) {
      const since = isoOf(s.submitDate);
      backlogItems.push({ stage: 'plateSwap', kind: 'car', since });
      const item = stuckItemFor(
        {
          id: s.id,
          source: 'plateSwap',
          kind: 'car',
          customerName: s.oldOwnerName,
          brandName: s.oldBrand,
          chassis: s.oldChassis,
          plate: plateText(s.oldPlateCategory, s.oldPlateNumber),
        },
        [{ stage: 'plateSwap', since, flags: [], reason: null }],
        today,
      );
      if (item) stuck.push(item);
    }
    for (const r of openRenewals) {
      const since = isoOf(r.submitDate);
      const kind = renewalKind(r.vehicleType);
      backlogItems.push({ stage: 'taxRenewal', kind, since });
      const item = stuckItemFor(
        {
          id: r.id,
          source: 'taxRenewal',
          kind,
          customerName: r.customer?.name ?? r.ownerName ?? '-',
          brandName: null,
          chassis: r.chassis,
          plate: plateText(r.plateCategory, r.plateNumber),
        },
        [{ stage: 'taxRenewal', since, flags: [], reason: null }],
        today,
      );
      if (item) stuck.push(item);
    }
    const backlog = summarizeBacklog(backlogItems, today);
    const sortedStuck = sortStuck(stuck);

    // ---------- งานแต่ละขั้นตอนในวันที่เลือก ----------
    const on = (d: Date | null) => d !== null && isoOf(d) === asOf;
    const vKind = (v: { body: string | null }) => vehicleKindOf(v.body);
    const doneOf = (pred: (v: (typeof dayVehicles)[number]) => boolean) => tally(dayVehicles.filter(pred), vKind);
    const passed = dayVehicles.filter((v) => on(v.inspectionResultDate) && v.inspectionResult === 'ผ่าน').length;
    const failedInspect = dayVehicles.filter((v) => on(v.inspectionResultDate) && v.inspectionResult === 'ไม่ผ่าน').length;
    const daySubs = subs.filter((s) => isoOf(s.submitDate) === asOf);
    const swapsReturned = swaps.filter((s) => s.returnedDate && isoOf(s.returnedDate) === asOf).length;
    const yamahaToday = yamaha.filter((y) => isoOf(y.date) === asOf);

    const stageRow = (key: StageKey, group: ProcessRow['group'], done: SplitValue, spend: SplitValue | null, doneNote: string | null = null): ProcessRow => {
      const b = backlog[key];
      return {
        key,
        group,
        label: STAGES[key].label,
        href: STAGES[key].href,
        done,
        doneNote,
        spend,
        pending: b.pending,
        oldestDays: b.oldestDays,
        lateCount: b.lateCount,
        sla: STAGES[key].sla,
      };
    };

    const process: ProcessRow[] = [
      {
        key: 'entry',
        group: 'new',
        label: 'รับรถเข้าระบบ',
        href: '/registration/new-vehicle/entry',
        done: doneOf((v) => on(v.date)),
        doneNote: null,
        spend: null,
        pending: null,
        oldestDays: null,
        lateCount: 0,
        sla: null,
      },
      stageRow('transfer', 'new', doneOf((v) => v.transferDone && on(v.transferCompletedDate)), daySpend('transfer')),
      stageRow('inspectSend', 'new', doneOf((v) => on(v.inspectionSentDate)), daySpend('inspection')),
      stageRow('inspectResult', 'new', doneOf((v) => on(v.inspectionResultDate)), null, passed || failedInspect ? `ผ่าน ${passed} · ไม่ผ่าน ${failedInspect}` : null),
      stageRow('submit', 'new', tally(daySubs, (s) => vehicleKindOf(s.vehicle.body)), daySpend('submit')),
      stageRow('receipt', 'new', tally(dayReceipts, (s) => vehicleKindOf(s.vehicle.body)), null),
      stageRow('plate', 'new', doneOf((v) => on(v.plateReceivedDate)), null),
      stageRow('book', 'new', doneOf((v) => on(v.bookReceivedDate)), null),
      stageRow('delivery', 'new', doneOf((v) => on(v.deliveredDate)), null),
      // ส่งป้ายตามหลัง = ส่งป้ายในวันที่เลือก ของรถที่ส่งงาน (ใบเสร็จ + เล่ม) ไปก่อนหน้านั้นแล้ว
      stageRow('plateDelivery', 'new', doneOf((v) => on(v.plateDeliveredDate) && !on(v.deliveredDate)), null),
      stageRow('billing', 'new', tally(dayBilledLines, vKind), null),
      // สลับเลขตอนนี้มีแต่รถยนต์ (ผู้ใช้ 2026-09-22) - ช่องจักรยานยนต์เป็น null
      {
        ...stageRow(
          'plateSwap',
          'other',
          { car: swaps.filter((s) => isoOf(s.submitDate) === asOf).length, moto: null },
          { car: daySpend('plateSwap').car, moto: null },
          swapsReturned ? `รับเอกสารกลับ ${swapsReturned}` : null,
        ),
        label: 'สลับเลข (ยื่น)',
        pending: { car: backlog.plateSwap.pending.car, moto: null },
      },
      { ...stageRow('taxRenewal', 'other', tally(renewals.filter((r) => isoOf(r.paymentDate!) === asOf), (r) => renewalKind(r.vehicleType)), daySpend('taxRenewal')), label: 'ต่อภาษี' },
      {
        key: 'yamaha',
        group: 'other',
        label: 'แจ้งย้ายยามาฮ่า',
        href: '/registration/yamaha-relocation',
        done: { car: null, moto: null, unsplit: yamahaToday.reduce((a, y) => a + y.count, 0) },
        doneNote: null,
        spend: daySpend('yamaha'),
        pending: null,
        oldestDays: null,
        lateCount: 0,
        sla: null,
      },
    ];

    // ---------- สิ่งที่ควรจัดการ (เรียงตามความเร่งด่วน) ----------
    const overdueAr = receivableItems.filter((r) => daysBetween(r.issueDate, today) > 60);
    const variance = receiptRows
      .map((r) => num(r.receiptAmount) - (num(r.billFeeTotal) + num(r.taxAmount)))
      .filter((d) => Math.abs(d) >= 1);
    const flags = (f: Flag) => flagCount.get(f) ?? 0;
    const late = (key: StageKey) => backlog[key].lateCount;

    const alerts = [
      overdueAr.length && {
        key: 'ar-overdue',
        severity: 'high',
        title: 'บิลค้างชำระเกิน 60 วัน',
        detail: `${overdueAr.length} ใบ รวม ${fmt(overdueAr.reduce((a, r) => a + r.amount, 0))} บาท - ควรติดตามทวงถาม`,
        href: '/accounting/billing',
      },
      flags('INSPECTION_EXPIRING') && {
        key: 'inspection-expiring',
        severity: 'high',
        title: `ผลตรวจรถใกล้หมดอายุ (ภายใน ${INSPECTION_WARN_DAYS} วัน)`,
        detail: `${flags('INSPECTION_EXPIRING')} คัน ยังไม่ยื่นเอกสาร - หมดอายุแล้วต้องตรวจใหม่และเสียค่าตรวจซ้ำ`,
        href: STAGES.submit.href,
      },
      flags('SUBMISSION_FAILED') && {
        key: 'submission-failed',
        severity: 'high',
        title: 'ยื่นเอกสารไม่สำเร็จ ยังไม่ได้ยื่นใหม่',
        detail: `${flags('SUBMISSION_FAILED')} คัน`,
        href: STAGES.submit.href,
      },
      flags('INSPECTION_FAILED') + flags('INSPECTION_EXPIRED') && {
        key: 'inspection-redo',
        severity: 'high',
        title: 'ต้องส่งตรวจรถใหม่',
        detail: `ตรวจไม่ผ่าน ${flags('INSPECTION_FAILED')} คัน · ผลตรวจหมดอายุ ${flags('INSPECTION_EXPIRED')} คัน`,
        href: STAGES.inspectSend.href,
      },
      flags('RECEIPT_UNKNOWN') && {
        key: 'receipt-unknown',
        severity: 'medium',
        title: 'ยื่นแล้วยังไม่ได้ใบเสร็จ ไม่ทราบสาเหตุ',
        detail: `${flags('RECEIPT_UNKNOWN')} คัน (ค้างจากใบก่อน) - ควรตามที่ขนส่ง`,
        href: STAGES.receipt.href,
      },
      late('receipt') && {
        key: 'receipt-late',
        severity: 'medium',
        title: `รอใบเสร็จนานเกิน ${STAGES.receipt.sla} วัน`,
        detail: `${late('receipt')} คัน (นานสุด ${backlog.receipt.oldestDays} วัน) - เงินทดรองจ่ายจมอยู่`,
        href: STAGES.receipt.href,
      },
      late('billing') && {
        key: 'billing-late',
        severity: 'medium',
        title: `ส่งงานแล้วแต่ยังไม่วางบิลเกิน ${STAGES.billing.sla} วัน`,
        detail: `${late('billing')} คัน - เงินยังไม่ถูกเรียกเก็บ`,
        href: STAGES.billing.href,
      },
      late('plateDelivery') && {
        key: 'plate-owed',
        severity: 'medium',
        title: 'รับป้ายแล้วแต่ยังไม่ได้ส่งป้ายตามให้ลูกค้า',
        detail: `${late('plateDelivery')} คัน (นานสุด ${backlog.plateDelivery.oldestDays} วัน)`,
        href: STAGES.plateDelivery.href,
      },
      variance.length && {
        key: 'receipt-variance',
        severity: 'info',
        title: 'ใบเสร็จจริงไม่ตรงกับยอดที่ระบบคำนวณ (30 วันล่าสุด)',
        detail: `${variance.length} ใบ ส่วนต่างสุทธิ ${fmt(variance.reduce((a, b) => a + b, 0))} บาท - ตรวจว่าอัตราค่าธรรมเนียมยังถูกต้อง`,
        href: STAGES.receipt.href,
      },
      pendingUsers && {
        key: 'pending-users',
        severity: 'info',
        title: 'ผู้ใช้รออนุมัติ',
        detail: `${pendingUsers} บัญชี`,
        href: '/admin/users',
      },
    ].filter(Boolean) as Array<{ key: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string; href: string }>;

    return {
      asOf,
      today,
      generatedAt: new Date().toISOString(),
      spend: {
        today: spendBy(windows.today),
        yesterday: spendBy(windows.yesterday),
        last7: spendBy(windows.last7),
        prev7: spendBy(windows.prev7),
        last30: spendBy(windows.last30),
        prev30: spendBy(windows.prev30),
        month: spendBy(windows.month),
        changeVsYesterday: pctChange(spendBy(windows.today).total, spendBy(windows.yesterday).total),
        changeVs7: pctChange(spendBy(windows.last7).total, spendBy(windows.prev7).total),
        changeVs30: pctChange(spendBy(windows.last30).total, spendBy(windows.prev30).total),
        categories,
      },
      cash: {
        collectedToday: moneyBy(collectedRows, windows.today),
        collected7: moneyBy(collectedRows, windows.last7),
        collected30: moneyBy(collectedRows, windows.last30),
        collectedMonth: moneyBy(collectedRows, windows.month),
        billedToday: moneyBy(billedRows, windows.today),
        billed30: moneyBy(billedRows, windows.last30),
        billedMonth: moneyBy(billedRows, windows.month),
        net30: round2(moneyBy(collectedRows, windows.last30) - spendBy(windows.last30).total),
        netMonth: round2(moneyBy(collectedRows, windows.month) - spendBy(windows.month).total),
        daily,
      },
      workingCapital: {
        inProcess: { amount: inProcessTotal, count: inProcessSubs.length }, // จ่ายไปแล้ว ยังอยู่ระหว่างดำเนินการ ยังไม่ส่งงาน
        unbilled: { amount: unbilledTotal, count: unbilledItems.length }, // ส่งงานแล้ว ยังไม่วางบิล (ยอดตามใบเสร็จ ไม่รวมค่าดำเนินการ)
        receivable: { amount: receivableTotal, count: receivableItems.length }, // วางบิลแล้ว รอรับเงิน
        total: round2(inProcessTotal + unbilledTotal + receivableTotal),
        aging: agingBuckets(receivableItems.map((r) => ({ date: r.issueDate, amount: r.amount })), today),
        unbilledAging: agingBuckets(unbilledItems.map((u) => ({ date: u.deliveredDate, amount: u.amount })), today),
        topCustomers,
        avgDaysToPay: behaviour.avgDaysToPay,
        avgBillingLagDays: behaviour.avgBillingLagDays,
        paySamples: behaviour.samples,
      },
      forecast: {
        ...forecast,
        avgDailySpend: round2(avgDailySpend),
        assumptions: {
          payDays: behaviour.avgDaysToPay ?? 30,
          payDaysFromHistory: behaviour.samples > 0,
          billingLagDays: behaviour.billingLagDays,
          paySamples: behaviour.samples,
        },
      },
      process,
      stuck: {
        total: sortedStuck.length,
        byKind: tally(sortedStuck, (s) => s.kind),
        high: sortedStuck.filter((s) => s.severity === 'high').length,
        items: sortedStuck.slice(0, STUCK_LIMIT),
      },
      alerts,
    };
  }
}

function fmt(n: number): string {
  return round2(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
