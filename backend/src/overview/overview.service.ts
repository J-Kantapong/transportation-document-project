import { BadRequestException, Injectable } from '@nestjs/common';
import { WHT_OVERDUE_DAYS } from '../billing/tax-invoice.service.js';
import { ACTIVE_SUBMISSION_STATUSES } from '../document-submission/submission-eligibility.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  addDays,
  agingBuckets,
  bangkokToday,
  billValueOf,
  buildForecast,
  daysBetween,
  dutyOfItems,
  FORECAST_SPEND_DAYS,
  inProcessMoney,
  isoOf,
  overdueByCustomer,
  paymentBehaviour,
  pctChange,
  round2,
  toDate,
} from './overview-calculator.js';
import {
  INSPECTION_WARN_DAYS,
  limitStuckPerKind,
  STAGES,
  sortStuck,
  plateCopyWaits,
  jobDeliveryWait,
  mostUrgent,
  problemItemsFor,
  receiptWait,
  summarizeBacklog,
  transferWaits,
  vehicleKindOf,
  waitsFor,
  type BacklogItem,
  type Flag,
  type KindCount,
  type StageKey,
  type StuckItem,
  type StuckSubject,
  type VehicleKind,
  type Wait,
} from './overview-process.js';

// ภาพรวมผู้บริหาร (ADMIN เท่านั้น - ดู access-policy.ts): สรุปการใช้เงินรายวัน งานแต่ละขั้นตอน (แยกรถยนต์/จักรยานยนต์)
// คันที่ติดขัด กระแสเงินสด และประมาณการ - อ่านอย่างเดียว ไม่เขียนข้อมูล
// "ใช้เงิน" = เงินที่ร้านจ่ายออกไปจริงในแต่ละงาน (Bill + No bill ที่บันทึกไว้ตอนทำงาน - งานยื่นเอกสารที่ได้ใบเสร็จแล้วใช้ยอดบนใบเสร็จ
// แทน Bill ที่ระบบคำนวณ ดู billValueOf) ส่วน "รับเงิน" = บิลที่บัญชีบันทึกรับเงินแล้ว
// (Invoice PAID) ระบบยังไม่มียอดเงินในบัญชีธนาคาร จึงแสดงได้แค่กระแสสุทธิ ไม่ใช่ยอดคงเหลือ
// ค่าที่ผู้ใช้ยังไม่ได้กำหนด (กำหนดเวลาแต่ละขั้น, เกณฑ์เตือน, ค่าตั้งต้นประมาณการ) อยู่ใน overview-process.ts / overview-calculator.ts

const FORECAST_WEEKS = 4;
const SERIES_DAYS = 30;
const INSPECTION_REQUEST_FEE = 25; // ค่าใบคำขอตรวจสภาพ ต่อวันที่มีการตรวจ
const STUCK_LIMIT = 100;
const ALERT_ITEM_LIMIT = 50; // รายคันที่ส่งไปกับ "สิ่งที่ควรจัดการ" แต่ละเรื่อง (คันที่ด่วนที่สุดก่อน) - จำนวนจริงอยู่ใน itemTotal
const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;
// รถของรายการยื่น - ให้ "สิ่งที่ควรจัดการ" บอกได้ว่าคันไหนและลิงก์ไปถึงคันนั้น
const vehicleRef = { chassis: true, body: true, customer: { select: { name: true } } } as const;
const snapshotName = (snapshot: unknown) => (snapshot as { name?: string } | null)?.name ?? '-';

// รายใบของ "สิ่งที่ควรจัดการ" ที่ไม่ใช่รายคันติดขัด (บิล ใบกำกับ ใบเสนอราคา ใบเสร็จ) - ผู้ใช้ 2026-10-09 รอบสอง
// href พาไปถึงใบนั้น: หน้ารายการใช้ ?focus=<เลขที่> (FocusVehicleRow ไฮไลต์แถวที่มีเลขนั้น) ใบเสนอราคาเปิดหน้าของใบเลย
export interface AlertDoc {
  id: string;
  title: string; // เลขที่ใบ / เลขตัวถัง
  customerName: string;
  amount: number | null;
  dateLabel: string;
  date: string | null; // ค.ศ. YYYY-MM-DD
  note: string;
  href: string;
}
const focusUrl = (page: string, value: string, extra: Record<string, string> = {}) => `${page}?${new URLSearchParams({ ...extra, focus: value }).toString()}`;
// แท็บของหน้ารายการที่ยื่นแล้ว (classify ใน frontend SubmittedRecordsView.tsx): ประเภทรถที่ไม่ใช่ รย.1/2/3 หรือจักรยานยนต์ อยู่แท็บ unknown
const recordsTab = (body: string | null) => (vehicleKindOf(body) === 'moto' ? 'moto' : body && /^รย.[123]-/.test(body) ? 'car' : 'unknown');
const MOTO_TYPE_PREFIX = 'รย.12'; // ต่อภาษี: vehicleType ขึ้นต้น รย.12 = จักรยานยนต์ (เหมือน Vehicle.body)

const num = (d: unknown) => (d === null || d === undefined ? 0 : Number(d));
const renewalKind = (vehicleType: string): VehicleKind => (vehicleType.startsWith(MOTO_TYPE_PREFIX) ? 'moto' : 'car');
const classKind = (vehicleClass: string): VehicleKind => (vehicleClass === 'MOTO' ? 'moto' : 'car'); // งานที่มีช่อง vehicleClass CAR | MOTO
const plateText = (category: string | null, number: string | null) => (category && number ? `${category} ${number}` : null);

export const SPEND_CATEGORIES = [
  { key: 'submit', label: 'ยื่นจดทะเบียนรถใหม่' },
  { key: 'inspection', label: 'ตรวจสภาพรถ' },
  { key: 'transfer', label: 'แจ้งย้าย/ตัดบัญชี' },
  { key: 'plateSwap', label: 'สลับเลข' },
  { key: 'taxRenewal', label: 'ต่อภาษี' },
  { key: 'yamaha', label: 'แจ้งย้ายยามาฮ่า' },
  // งานอื่นๆ (ผู้ใช้ 2026-10-02 / 2026-10-06): ค่าใช้จ่ายตาม snapshot ตอนยื่น (billTotal / noBillTotal / dutyAmount) นับที่วันที่ยื่น
  { key: 'vehicleTransfer', label: 'งานโอน' },
  { key: 'useCancel', label: 'ยกเลิกการใช้รถ' },
  { key: 'plateCopy', label: 'คัดแผ่นป้ายทะเบียน' },
  { key: 'moveOut', label: 'ย้ายออก' },
  // รายจ่ายของบริษัทเอง (ผู้ใช้ 2026-10-06): เงินเดือนตามรอบที่จ่ายแล้ว + ค่าจ้างบุคคลภายนอกตาม 50 ทวิ ที่ออกในระบบ
  { key: 'payroll', label: 'เงินเดือนพนักงาน' },
  { key: 'subcontract', label: 'ค่าจ้างบุคคลภายนอก (ตาม 50 ทวิ)' },
] as const;
type CategoryKey = (typeof SPEND_CATEGORIES)[number]['key'];

interface SpendEvent {
  date: string;
  category: CategoryKey;
  kind: VehicleKind | null; // null = ไม่แยกประเภทรถ (ยามาฮ่า บันทึกเป็นจำนวนคันต่อวัน)
  bill: number; // มีใบเสร็จ
  noBill: number; // ลงขัน ไม่มีใบเสร็จ
  other: number; // ไม่ได้แยกว่า Bill/No bill (ค่าแจ้งย้าย/ตัดบัญชี)
  duty?: number; // ค่าอากร - แยกจากค่าใช้จ่าย ไม่อยู่ใน noBill และไม่นับในยอดรวม (ผู้ใช้ 2026-10-05)
  overhead?: number; // รายจ่ายของบริษัทเอง ไม่ใช่เงินทดรองจ่ายรายงาน (เงินเดือน, ค่าจ้างบุคคลภายนอก) - รวมในยอดใช้เงินแต่แสดงแยก (ผู้ใช้ 2026-10-06 "เอารายจ่ายทั้งหมดเข้าไป")
}

const eventTotal = (e: SpendEvent) => e.bill + e.noBill + e.other + (e.overhead ?? 0);
const dutyOf = (e: SpendEvent) => e.duty ?? 0;

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
  spend: SplitValue | null; // ค่าใช้จ่ายในวันที่เลือก (บาท) - null = ขั้นนี้ไม่มีค่าใช้จ่าย (ไม่รวมค่าอากร)
  duty: SplitValue | null; // ค่าอากรของวันที่เลือก - แสดงแยกอีกบรรทัด, null = ขั้นนี้ไม่มีค่าอากร
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
    // ดูล่วงหน้าได้ (พนักงานคีย์งานไว้ก่อน, ผู้บริหารขอ 2026-10-07) แต่ไม่เกิน 90 วัน
    if (asOf > addDays(today, 90)) throw new BadRequestException({ error: 'ดูล่วงหน้าได้ไม่เกิน 90 วัน' });

    const day = toDate(asOf);
    const range = { gte: toDate(addDays(asOf, -(SERIES_DAYS * 2 - 1))), lte: day }; // 60 วัน: 30 วันล่าสุด + 30 วันก่อนหน้าไว้เทียบ
    // ประมาณการเริ่มจากวันนี้เสมอ จึงใช้ค่าเฉลี่ยใช้เงินถึงวันนี้ ไม่ใช่ถึงวันที่เลือก - ดูวันย้อนหลังต้องดึงช่วงนั้นมาด้วย (พบ 2026-09-27)
    const forecastFrom = addDays(today, -(FORECAST_SPEND_DAYS - 1));
    const spendWindows = asOf === today ? [range] : [range, { gte: toDate(forecastFrom), lte: toDate(today) }];
    const inSpendWindow = (d: Date) => spendWindows.some((w) => d >= w.gte && d <= w.lte);
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
      useCancels,
      plateCopies,
      moveOuts,
      vehicleTransfers,
      openUseCancels,
      openPlateCopies,
      openMoveOuts,
      openTransfers,
      whtPendingRows,
      quotations,
      payrollRuns,
      subcontractItems,
    ] = await Promise.all([
      // --- ค่าใช้จ่าย 60 วัน (กราฟรายวัน + เทียบช่วงก่อนหน้า) + 28 วันถึงวันนี้ (ประมาณการ) ---
      this.prisma.documentSubmission.findMany({
        where: { status: { not: 'FAILED' }, OR: spendWindows.map((w) => ({ submitDate: w })), vehicle: live },
        select: { submitDate: true, status: true, receiptAmount: true, billFeeTotal: true, noBillTotal: true, noBillItems: true, taxAmount: true, vehicle: bodyOf },
      }),
      // งานสลับเลข / ต่อภาษี / ยามาฮ่าที่ยกเลิกแล้ว (cancelledAt) ไม่นับทุกยอด (ผู้ใช้ 2026-09-27: ยกเลิกแบบไม่ลบแถว)
      this.prisma.plateSwap.findMany({
        where: { cancelledAt: null, OR: [...spendWindows.map((w) => ({ submitDate: w })), { returnedDate: day }] },
        select: { submitDate: true, returnedDate: true, vehicleClass: true, billTotal: true, noBillTotal: true, noBillItems: true },
      }),
      this.prisma.taxRenewal.findMany({
        where: { cancelledAt: null, OR: spendWindows.map((w) => ({ paymentDate: w })) },
        select: { paymentDate: true, vehicleType: true, billTotal: true, noBillTotal: true, noBillItems: true },
      }),
      this.prisma.yamahaRelocationEntry.findMany({
        // ลงขัน (noBillFee) จ่ายวันสุดท้ายของเดือน จึงดึงทั้งเดือนของช่วงที่ดู (ใบเสร็จจ่ายทุกวัน ใช้วันที่ของรายการ)
        where: {
          cancelledAt: null,
          OR: spendWindows.map((w) => ({
            date: {
              gte: new Date(Date.UTC(w.gte.getUTCFullYear(), w.gte.getUTCMonth(), 1)),
              lte: new Date(Date.UTC(w.lte.getUTCFullYear(), w.lte.getUTCMonth() + 1, 0)),
            },
          })),
        },
        select: { date: true, count: true, billFee: true, noBillFee: true },
      }),
      this.prisma.vehicle.findMany({
        where: { ...live, transferDone: true, OR: spendWindows.map((w) => ({ transferCompletedDate: w })) },
        select: { transferCompletedDate: true, transferCost: true, transferBillCost: true, body: true },
      }),
      this.prisma.vehicle.findMany({
        where: { ...live, OR: spendWindows.map((w) => ({ inspectionSentDate: w })) },
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
        select: { id: true, invoiceNo: true, issueDate: true, dueDate: true, customerId: true, netTotal: true, customerSnapshot: true },
      }),
      this.prisma.invoice.findMany({
        where: { status: 'PAID', paidDate: { gte: toDate(addDays(today, -180)) } },
        select: { customerId: true, issueDate: true, paidDate: true, lines: { select: { deliveredDate: true } } },
      }),
      // ส่งงานแล้วยังไม่วางบิล - ไม่รวมรถที่ปิดงาน - วางบิลนอกระบบ (billingClosedAt, ผู้ใช้ 2026-09-27)
      this.prisma.vehicle.findMany({
        where: { ...live, deliveredDate: { not: null }, invoiceLines: { none: NOT_VOID }, billingClosedAt: null },
        select: {
          customerId: true,
          deliveredDate: true,
          customer: { select: { name: true } },
          documentSubmissions: {
            orderBy: { createdAt: 'desc' },
            take: 1,
            select: { status: true, receiptAmount: true, billFeeTotal: true, taxAmount: true },
          },
        },
      }),
      // รวมงานที่คีย์ล่วงหน้า (วันที่ยื่นหลังวันนี้) ด้วย แล้วแยกออกใน inProcessMoney - ยังไม่ได้จ่ายจริง
      this.prisma.documentSubmission.findMany({
        where: { status: { in: ACTIVE_SUBMISSION_STATUSES }, vehicle: { ...live, deliveredDate: null } },
        select: { id: true, submitDate: true, status: true, receiptAmount: true, billFeeTotal: true, taxAmount: true, vehicle: { select: vehicleRef } },
      }),
      this.prisma.documentSubmission.findMany({
        where: {
          status: 'RECEIPT_RECEIVED',
          receiptAmount: { not: null },
          taxAmount: { not: null },
          receiptDate: { gte: toDate(addDays(asOf, -(SERIES_DAYS - 1))), lte: day }, // วันที่ในใบเสร็จ (ผู้ใช้ 2026-09-25)
          vehicle: live,
        },
        select: { id: true, receiptDate: true, receiptAmount: true, billFeeTotal: true, taxAmount: true, vehicle: { select: vehicleRef } },
      }),
      // --- รถที่ยังไม่จบงาน (ยังไม่ส่งงาน / ป้ายค้างส่ง / ยังไม่วางบิล) -> คิวค้าง + คันที่ติดขัด ---
      // ปิดงาน - วางบิลนอกระบบแล้ว = ไม่ค้างวางบิล (ผู้ใช้ 2026-09-27)
      this.prisma.vehicle.findMany({
        where: { ...live, OR: [{ deliveredDate: null }, { plateDeliveredDate: null }, { invoiceLines: { none: NOT_VOID }, billingClosedAt: null }] },
        select: {
          id: true,
          date: true,
          chassis: true,
          body: true,
          plateCategory: true,
          plateNumber: true,
          registrationProvince: true,
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
            select: {
              status: true,
              submitDate: true,
              receiptDate: true,
              receiptReceivedDate: true,
              failRemark: true,
              receiptCarriedAt: true,
              _count: { select: { receipts: true } },
            },
          },
          plateSwapsAsNew: { where: { returnedDate: null, cancelledAt: null }, take: 1, select: { id: true } },
          invoiceLines: { where: NOT_VOID, take: 1, select: { id: true } },
          billingClosedAt: true,
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
        where: { returnedDate: null, cancelledAt: null },
        select: { id: true, vehicleClass: true, submitDate: true, oldOwnerName: true, oldChassis: true, oldBrand: true, oldPlateCategory: true, oldPlateNumber: true },
      }),
      this.prisma.taxRenewal.findMany({
        // รอชำระ หรือรับป้ายภาษี/ใบเสร็จแล้วแต่ยังไม่ลงส่งงาน (ผู้ใช้ 2026-10-08)
        where: { cancelledAt: null, OR: [{ paymentDate: null }, { receivedDate: { not: null }, deliveredDate: null }] },
        select: {
          id: true,
          submitDate: true,
          paymentDate: true,
          receivedDate: true,
          deliveredDate: true,
          vehicleType: true,
          chassis: true,
          plateCategory: true,
          plateNumber: true,
          ownerName: true,
          customer: { select: { name: true } },
        },
      }),
      this.prisma.user.count({ where: { status: 'PENDING' } }),
      // --- งานอื่นๆ: ยื่น 60 วัน (ค่าใช้จ่าย) + วันที่เลือก (รับใบเสร็จ/รับป้าย/ส่งตรวจ/ผลตรวจที่ทำวันนั้น) - ยกเลิกแล้ว (cancelledAt) ไม่นับ ---
      this.prisma.vehicleUseCancellation.findMany({
        where: { cancelledAt: null, OR: [...spendWindows.map((w) => ({ submitDate: w })), { returnedDate: day }] },
        select: { submitDate: true, returnedDate: true, vehicleClass: true, billTotal: true, noBillTotal: true, dutyAmount: true },
      }),
      this.prisma.plateCopy.findMany({
        where: { cancelledAt: null, OR: [...spendWindows.map((w) => ({ submitDate: w })), { returnedDate: day }, { plateReceivedDate: day }] },
        select: { submitDate: true, returnedDate: true, plateReceivedDate: true, vehicleClass: true, billTotal: true, noBillTotal: true, dutyAmount: true },
      }),
      this.prisma.vehicleMoveOut.findMany({
        where: { cancelledAt: null, OR: [...spendWindows.map((w) => ({ submitDate: w })), { returnedDate: day }] },
        select: { submitDate: true, returnedDate: true, vehicleClass: true, billTotal: true, noBillTotal: true, dutyAmount: true },
      }),
      this.prisma.vehicleTransfer.findMany({
        where: {
          cancelledAt: null,
          OR: [...spendWindows.map((w) => ({ submitDate: w })), { returnedDate: day }, { inspectionSentDate: day }, { inspectionResultDate: day }],
        },
        select: {
          submitDate: true,
          returnedDate: true,
          inspectionSentDate: true,
          inspectionResult: true,
          inspectionResultDate: true,
          vehicleClass: true,
          billTotal: true,
          noBillTotal: true,
          dutyAmount: true,
        },
      }),
      // งานค้าง (ยังไม่รับใบเสร็จกลับ / ยังไม่รับป้าย / ของครบแล้วแต่ยังไม่ลงส่งงาน) + ข้อมูลที่ใช้ขึ้นรายการ "ติดขัด"
      this.prisma.vehicleUseCancellation.findMany({
        where: { cancelledAt: null, deliveredDate: null },
        select: { id: true, vehicleClass: true, submitDate: true, returnedDate: true, ownerName: true, chassis: true, brand: true, plateCategory: true, plateNumber: true, customer: { select: { name: true } } },
      }),
      this.prisma.plateCopy.findMany({
        where: { cancelledAt: null, deliveredDate: null },
        select: {
          id: true,
          vehicleClass: true,
          submitDate: true,
          returnedDate: true,
          plateReceivedDate: true,
          ownerName: true,
          chassis: true,
          brand: true,
          plateCategory: true,
          plateNumber: true,
          customer: { select: { name: true } },
        },
      }),
      this.prisma.vehicleMoveOut.findMany({
        where: { cancelledAt: null, deliveredDate: null },
        select: { id: true, vehicleClass: true, submitDate: true, returnedDate: true, ownerName: true, chassis: true, brand: true, plateCategory: true, plateNumber: true, customer: { select: { name: true } } },
      }),
      this.prisma.vehicleTransfer.findMany({
        where: { cancelledAt: null, deliveredDate: null },
        select: {
          id: true,
          vehicleClass: true,
          transferType: true,
          submitDate: true,
          returnedDate: true,
          inspectionSentDate: true,
          inspectionResult: true,
          inspectionResultDate: true,
          transfereeName: true,
          chassis: true,
          brand: true,
          plateCategory: true,
          plateNumber: true,
          customer: { select: { name: true } },
        },
      }),
      // 50 ทวิที่ลูกค้าหักไว้แต่ยังไม่ส่งหลักฐาน (หน้า /accounting/tax-invoices/wht)
      this.prisma.taxInvoice.findMany({
        where: { status: 'ISSUED', whtAmount: { gt: 0 }, whtCertificateId: null },
        select: { id: true, taxInvoiceNo: true, issueDate: true, whtAmount: true, customerSnapshot: true },
      }),
      // ใบเสนอราคาที่ยังมีเรื่องต้องตาม: ส่งแล้วรอลูกค้าตอบ / อนุมัติแล้วยังไม่ออกบิลหรือตั้งราคา
      this.prisma.quotation.findMany({
        where: { status: { in: ['ISSUED', 'APPROVED'] } },
        select: {
          id: true,
          quotationNo: true,
          customerSnapshot: true,
          netTotal: true,
          approvedDate: true,
          status: true,
          kind: true,
          validUntil: true,
          ratesAppliedAt: true,
          _count: { select: { invoices: { where: NOT_VOID.invoice } } },
        },
      }),
      // --- รายจ่ายบริษัท: เงินเดือนเฉพาะรอบที่บันทึกว่าจ่ายแล้ว (PAID) นับตามวันที่จ่ายจริง ---
      this.prisma.payrollRun.findMany({
        where: { status: 'PAID', cancelledAt: null, OR: spendWindows.map((w) => ({ payDate: w })) },
        select: { payDate: true, items: { select: { salary: true, otherIncome: true, ssoAmount: true } } },
      }),
      // ค่าจ้างบุคคลภายนอก (ซับ) = บรรทัดใน 50 ทวิ ที่บริษัทออกให้ผู้รับเงินที่ไม่ใช่พนักงาน (OTHER) - ใบของพนักงานรายปีเป็นยอดรวมของเงินเดือนที่นับข้างบนแล้ว จึงไม่นับซ้ำ
      this.prisma.issuedWhtItem.findMany({
        where: { paidDate: { gte: range.gte, lte: toDate(today) }, certificate: { status: 'ISSUED', payeeKind: 'OTHER' } },
        select: { paidDate: true, amountPaid: true },
      }),
    ]);

    // ---------- การใช้เงิน ----------
    const events: SpendEvent[] = [];
    // noBillTotal ที่เก็บไว้รวมค่าอากรอยู่ด้วย - ตัดออกมาแสดงแยก (ผู้ใช้ 2026-10-05: ยอด 05/10 ต้องเป็น 20,738 ไม่ใช่ 20,858)
    for (const s of subs) {
      const duty = dutyOfItems(s.noBillItems);
      events.push({
        date: isoOf(s.submitDate),
        category: 'submit',
        kind: vehicleKindOf(s.vehicle.body),
        bill: billValueOf(s),
        noBill: round2(num(s.noBillTotal) - duty),
        other: 0,
        duty,
      });
    }
    for (const s of swaps) {
      if (inSpendWindow(s.submitDate)) {
        const duty = dutyOfItems(s.noBillItems);
        events.push({ date: isoOf(s.submitDate), category: 'plateSwap', kind: classKind(s.vehicleClass), bill: num(s.billTotal), noBill: round2(num(s.noBillTotal) - duty), other: 0, duty });
      }
    }
    // งานอื่นๆ: noBillTotal ไม่รวมค่าอากรอยู่แล้ว (dutyAmount แยกคอลัมน์) - ต่างจากสลับเลข/ต่อภาษีที่ค่าอากรอยู่ในรายการ No Bill
    const jobEvents = (category: CategoryKey, rows: Array<{ submitDate: Date; vehicleClass: string; billTotal: unknown; noBillTotal: unknown; dutyAmount: unknown }>) => {
      for (const j of rows) {
        if (!inSpendWindow(j.submitDate)) continue; // แถวที่ดึงมาเพราะรับใบเสร็จ/รับป้ายในวันที่เลือก แต่ยื่นนานแล้ว
        events.push({ date: isoOf(j.submitDate), category, kind: classKind(j.vehicleClass), bill: num(j.billTotal), noBill: num(j.noBillTotal), other: 0, duty: num(j.dutyAmount) });
      }
    };
    jobEvents('vehicleTransfer', vehicleTransfers);
    jobEvents('useCancel', useCancels);
    jobEvents('plateCopy', plateCopies);
    jobEvents('moveOut', moveOuts);
    for (const r of renewals) {
      const duty = dutyOfItems(r.noBillItems);
      events.push({
        date: isoOf(r.paymentDate!),
        category: 'taxRenewal',
        kind: renewalKind(r.vehicleType),
        bill: num(r.billTotal),
        noBill: round2(num(r.noBillTotal) - duty),
        other: 0,
        duty,
      });
    }
    // แจ้งย้ายยามาฮ่า: ใบเสร็จ (Bill) จ่ายทุกวันตามวันที่ของรายการ · ลงขัน (No bill) จ่ายวันสุดท้ายของเดือนของรายการนั้น (ผู้ใช้ 2026-10-07)
    for (const y of yamaha) {
      const monthEnd = isoOf(new Date(Date.UTC(y.date.getUTCFullYear(), y.date.getUTCMonth() + 1, 0)));
      if (inSpendWindow(y.date)) events.push({ date: isoOf(y.date), category: 'yamaha', kind: null, bill: num(y.billFee), noBill: 0, other: 0 });
      if (inSpendWindow(toDate(monthEnd))) events.push({ date: monthEnd, category: 'yamaha', kind: null, bill: 0, noBill: num(y.noBillFee), other: 0 });
    }
    for (const t of transfers) {
      events.push({ date: isoOf(t.transferCompletedDate!), category: 'transfer', kind: vehicleKindOf(t.body), bill: num(t.transferBillCost), noBill: 0, other: num(t.transferCost) });
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
    // ทุกวันที่มีการส่งตรวจ มีค่าใบคำขอตรวจสภาพ 25 บาท วันละ 1 ใบ (ผู้ใช้ 2026-10-07) - นับรถยนต์ถ้าวันนั้นมีรถยนต์ ไม่มีก็จักรยานยนต์
    const inspectionDays = new Map<string, VehicleKind>();
    for (const v of inspections) {
      const d = isoOf(v.inspectionSentDate!);
      const k = vehicleKindOf(v.body);
      if (inspectionDays.get(d) !== 'car') inspectionDays.set(d, k);
    }
    for (const [d, k] of inspectionDays) events.push({ date: d, category: 'inspection', kind: k, bill: 0, noBill: 0, other: INSPECTION_REQUEST_FEE });

    // เงินเดือน = ต้นทุนบริษัท: เงินเดือน + รายได้อื่น + ประกันสังคมส่วนนายจ้าง (เท่ากับส่วนพนักงาน) · ไม่ใช่เงินสุทธิที่โอนให้พนักงาน เพราะภาษี/ประกันสังคมที่หักไว้บริษัทต้องนำส่งต่อ
    for (const r of payrollRuns) {
      const cost = r.items.reduce((a, i) => a + num(i.salary) + num(i.otherIncome) + num(i.ssoAmount), 0);
      if (cost > 0) events.push({ date: isoOf(r.payDate!), category: 'payroll', kind: null, bill: 0, noBill: 0, other: 0, overhead: round2(cost) });
    }
    for (const i of subcontractItems) {
      if (inSpendWindow(i.paidDate)) events.push({ date: isoOf(i.paidDate), category: 'subcontract', kind: null, bill: 0, noBill: 0, other: 0, overhead: num(i.amountPaid) });
    }

    const sumEvents = (from: string, to: string) => {
      let total = 0;
      let bill = 0;
      let noBill = 0;
      let duty = 0;
      let overhead = 0;
      for (const e of events) {
        if (e.date < from || e.date > to) continue;
        total += eventTotal(e);
        overhead += e.overhead ?? 0;
        bill += e.bill;
        noBill += e.noBill;
        duty += dutyOf(e);
      }
      return { total: round2(total), bill: round2(bill), noBill: round2(noBill), overhead: round2(overhead), other: round2(total - bill - noBill - overhead), duty: round2(duty) };
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
    const runningCost = (w: readonly [string, string]) => {
      const x = spendBy(w);
      return round2(x.total - x.overhead);
    };
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
        overhead: s.overhead,
        duty: s.duty,
        billed: sumMoney(billedRows, date, date),
        collected: sumMoney(collectedRows, date, date),
        submitted: submittedByDay.get(date) ?? 0,
      };
    });

    const categories = SPEND_CATEGORIES.map((c) => {
      const of = (w: readonly [string, string]) =>
        round2(events.filter((e) => e.category === c.key && e.date >= w[0] && e.date <= w[1]).reduce((a, e) => a + eventTotal(e), 0));
      const dutyOfWindow = (w: readonly [string, string]) =>
        round2(events.filter((e) => e.category === c.key && e.date >= w[0] && e.date <= w[1]).reduce((a, e) => a + dutyOf(e), 0));
      return { key: c.key, label: c.label, today: of(windows.today), last30: of(windows.last30), dutyToday: dutyOfWindow(windows.today), dutyLast30: dutyOfWindow(windows.last30) };
    });

    // ค่าใช้จ่ายของวันที่เลือก แยกประเภทรถ - ใช้ในตารางงานแต่ละขั้นตอน
    const daySpend = (category: CategoryKey): SplitValue => {
      const rows = events.filter((e) => e.category === category && e.date === asOf);
      if (category === 'yamaha') return { car: null, moto: null, unsplit: round2(rows.reduce((a, e) => a + eventTotal(e), 0)) };
      return tally(rows, (e) => e.kind!, eventTotal);
    };
    // ค่าอากรของวันที่เลือก (แยกรถยนต์/จักรยานยนต์) - null = หมวดนี้ไม่มีค่าอากร จะได้ไม่แสดงเลข 0 ปลอม
    const dayDuty = (category: CategoryKey): SplitValue | null => {
      const rows = events.filter((e) => e.category === category && e.date === asOf);
      if (!rows.some((e) => dutyOf(e) > 0)) return null;
      return tally(rows, (e) => e.kind!, dutyOf);
    };

    // ---------- ลูกหนี้ / เงินจม ----------
    const receivableItems = receivables.map((i) => ({
      id: i.id,
      invoiceNo: i.invoiceNo,
      customerId: i.customerId,
      customerName: (i.customerSnapshot as { name?: string } | null)?.name ?? '-',
      issueDate: isoOf(i.issueDate),
      dueDate: i.dueDate ? isoOf(i.dueDate) : null,
      amount: num(i.netTotal),
    }));
    const unbilledItems = unbilledVehicles.map((v) => {
      const sub = v.documentSubmissions[0];
      return { customerId: v.customerId, customerName: v.customer.name, deliveredDate: isoOf(v.deliveredDate!), amount: sub ? billValueOf(sub) : 0 };
    });
    const receivableTotal = round2(receivableItems.reduce((a, r) => a + r.amount, 0));
    const unbilledTotal = round2(unbilledItems.reduce((a, r) => a + r.amount, 0));
    // ระหว่างดำเนินการเป็นข้อมูล ณ ตอนนี้ จึงแยกงานคีย์ล่วงหน้าด้วยวันนี้ ไม่ใช่วันที่เลือก
    const { inProcess, advance } = inProcessMoney(inProcessSubs, today);
    const inProcessTotal = inProcess.amount;

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

    // ---------- ประมาณการ 4 สัปดาห์ (เริ่มวันนี้เสมอ ไม่ขึ้นกับวันที่เลือก) ----------
    const avgDailySpend = sumEvents(forecastFrom, today).total / FORECAST_SPEND_DAYS;
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
    // ทุกรายการรอที่เกินกำหนด/มีปัญหา (คันเดียวมีได้หลายรายการ) - "สิ่งที่ควรจัดการ" นับและแสดงรายคันจากชุดนี้
    const problems: StuckItem[] = [];
    const addStuck = (subject: StuckSubject, waits: Wait[]) => {
      const items = problemItemsFor(subject, waits, today);
      problems.push(...items);
      const item = mostUrgent(items); // รายการติดขัด: หนึ่งคันหนึ่งแถว
      if (item) stuck.push(item);
    };
    for (const v of openVehicles) {
      const kind = vehicleKindOf(v.body);
      const sub = v.documentSubmissions[0] ?? null;
      const waits = waitsFor(
        {
          ...v,
          latestSubmission: sub,
          hasPendingPlateSwap: v.plateSwapsAsNew.length > 0,
          billed: v.invoiceLines.length > 0,
          billingClosed: !!v.billingClosedAt,
        },
        today,
      );
      for (const w of waits) backlogItems.push({ stage: w.stage, kind, since: w.since });
      addStuck(
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
      );
    }
    for (const s of openSwaps) {
      const since = isoOf(s.submitDate);
      const swapKind = classKind(s.vehicleClass);
      backlogItems.push({ stage: 'plateSwap', kind: swapKind, since });
      addStuck(
        {
          id: s.id,
          source: 'plateSwap',
          kind: swapKind,
          customerName: s.oldOwnerName,
          brandName: s.oldBrand,
          chassis: s.oldChassis,
          plate: plateText(s.oldPlateCategory, s.oldPlateNumber),
        },
        [{ stage: 'plateSwap', since, flags: [], reason: null }],
      );
    }
    for (const r of openRenewals) {
      const kind = renewalKind(r.vehicleType);
      // ชำระแล้ว + รับป้ายภาษีแล้ว = รอลงส่งงาน (นับจากวันรับ) / ยังไม่ชำระ = รอชำระ (นับจากวันยื่น)
      const renewalWait = r.paymentDate && r.receivedDate ? jobDeliveryWait(r.receivedDate) : { stage: 'taxRenewal' as const, since: isoOf(r.submitDate), flags: [], reason: null };
      backlogItems.push({ stage: renewalWait.stage, kind, since: renewalWait.since });
      addStuck(
        {
          id: r.id,
          source: 'taxRenewal',
          kind,
          customerName: r.customer?.name ?? r.ownerName ?? '-',
          brandName: null,
          chassis: r.chassis,
          plate: plateText(r.plateCategory, r.plateNumber),
        },
        [renewalWait],
      );
    }
    // งานอื่นๆ: เข้าคิวค้างเหมือนงานข้างบน หนึ่งงานแสดงแถวเดียวในรายการติดขัด (ขั้นที่หนักที่สุด)
    // "ไปจัดการ" พาไปหน้ารับใบเสร็จ/รับป้ายของงานนั้นตรงๆ (หน้างานแยกรถยนต์/จักรยานยนต์ตามที่มี)
    interface OtherJob {
      id: string;
      vehicleClass: string;
      chassis: string;
      brand: string;
      plateCategory: string;
      plateNumber: string;
      customer: { name: string } | null;
    }
    const addJob = (job: OtherJob, name: string, waits: ReturnType<typeof transferWaits>, href: string) => {
      const kind = classKind(job.vehicleClass);
      for (const w of waits) backlogItems.push({ stage: w.stage, kind, since: w.since });
      addStuck(
        {
          id: job.id,
          source: 'otherJob',
          kind,
          customerName: job.customer?.name ?? name,
          brandName: job.brand,
          chassis: job.chassis,
          plate: plateText(job.plateCategory, job.plateNumber),
          href,
        },
        waits,
      );
    };
    // ใบเสร็จกลับแล้ว (ของครบ) แต่ยังไม่ลงส่งงาน = รอส่งงานลูกค้า ไปหน้า Delivery (ผู้ใช้ 2026-10-08)
    const deliveryHref = STAGES.jobDelivery.href;
    for (const j of openUseCancels) {
      if (j.returnedDate) addJob(j, j.ownerName, [jobDeliveryWait(j.returnedDate)], deliveryHref);
      else addJob(j, j.ownerName, [receiptWait('useCancel', j.submitDate)], `/registration/other/cancel-use/${classKind(j.vehicleClass)}/return`);
    }
    for (const j of openMoveOuts) {
      if (j.returnedDate) addJob(j, j.ownerName, [jobDeliveryWait(j.returnedDate)], deliveryHref);
      else addJob(j, j.ownerName, [receiptWait('moveOut', j.submitDate)], `/registration/other/move-out/${classKind(j.vehicleClass)}/return`);
    }
    for (const j of openPlateCopies) {
      const waits = plateCopyWaits(j);
      if (waits.length === 0 && j.returnedDate && j.plateReceivedDate) {
        addJob(j, j.ownerName, [jobDeliveryWait(j.returnedDate > j.plateReceivedDate ? j.returnedDate : j.plateReceivedDate)], deliveryHref);
        continue;
      }
      addJob(j, j.ownerName, waits, waits.some((w) => w.stage === 'plateCopy') ? '/registration/other/plate-copy/return' : '/registration/other/plate-copy/receive-plate');
    }
    for (const t of openTransfers) {
      if (t.returnedDate) {
        addJob(t, t.transfereeName, [jobDeliveryWait(t.returnedDate)], deliveryHref);
        continue;
      }
      const waits = transferWaits({ ...t, returnedDate: null });
      const href = waits[0]?.stage === 'transferJob' ? `/registration/transfer/${t.transferType === 'INSPECTION' ? 'inspection' : 'owner'}/return` : '/registration/transfer/inspection/inspect';
      addJob(t, t.transfereeName, waits, href);
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

    const stageRow = (key: StageKey, group: ProcessRow['group'], done: SplitValue, spend: SplitValue | null, doneNote: string | null = null, duty: SplitValue | null = null): ProcessRow => {
      const b = backlog[key];
      return {
        key,
        group,
        label: STAGES[key].label,
        href: STAGES[key].href,
        done,
        doneNote,
        spend,
        duty,
        pending: b.pending,
        oldestDays: b.oldestDays,
        lateCount: b.lateCount,
        sla: STAGES[key].sla,
      };
    };

    // งานอื่นๆ: แถวสรุปของงานที่ยื่นในวันที่เลือก (done = ยื่นกี่งาน, spend/duty = ค่าใช้จ่ายของงานที่ยื่นวันนั้น, pending = ค้างตามขั้น stage)
    // carOnly = งานนี้มีแต่รถยนต์ (คัดป้าย) ช่องจักรยานยนต์เป็น null เหมือนสลับเลขตอนก่อนมีรถจักรยานยนต์
    const returnedNote = (rows: Array<{ returnedDate: Date | null }>) => {
      const n = rows.filter((r) => on(r.returnedDate)).length;
      return n ? `รับใบเสร็จกลับ ${n}` : null;
    };
    const jobRow = (
      category: CategoryKey,
      stage: StageKey,
      label: string,
      rows: Array<{ submitDate: Date; vehicleClass: string }>,
      note: string | null,
      carOnly = false,
    ): ProcessRow => {
      const row = stageRow(stage, 'other', tally(rows.filter((r) => isoOf(r.submitDate) === asOf), (r) => classKind(r.vehicleClass)), daySpend(category), note, dayDuty(category));
      return carOnly ? { ...row, label, done: { ...row.done, moto: null }, spend: row.spend && { ...row.spend, moto: null }, duty: row.duty && { ...row.duty, moto: null }, pending: { car: backlog[stage].pending.car, moto: null } } : { ...row, label };
    };
    // ส่งตรวจ / ผลตรวจของงานโอนตรวจรถ - ไม่มีค่าใช้จ่ายของตัวเอง (ค่าใช้จ่ายรวมอยู่ที่แถว "งานโอน (ยื่น)")
    const transferStageRow = (stage: StageKey, label: string, rows: Array<{ vehicleClass: string }>, note: string | null): ProcessRow => ({
      ...stageRow(stage, 'other', tally(rows, (r) => classKind(r.vehicleClass)), null, note),
      label,
    });

    const process: ProcessRow[] = [
      {
        key: 'entry',
        group: 'new',
        label: 'รับรถเข้าระบบ',
        href: '/registration/new-vehicle/entry',
        done: doneOf((v) => on(v.date)),
        doneNote: null,
        spend: null,
        duty: null,
        pending: null,
        oldestDays: null,
        lateCount: 0,
        sla: null,
      },
      stageRow('transfer', 'new', doneOf((v) => v.transferDone && on(v.transferCompletedDate)), daySpend('transfer')),
      stageRow('inspectSend', 'new', doneOf((v) => on(v.inspectionSentDate)), daySpend('inspection')),
      stageRow('inspectResult', 'new', doneOf((v) => on(v.inspectionResultDate)), null, passed || failedInspect ? `ผ่าน ${passed} · ไม่ผ่าน ${failedInspect}` : null),
      stageRow('submit', 'new', tally(daySubs, (s) => vehicleKindOf(s.vehicle.body)), daySpend('submit'), null, dayDuty('submit')),
      stageRow('receipt', 'new', tally(dayReceipts, (s) => vehicleKindOf(s.vehicle.body)), null),
      stageRow('plate', 'new', doneOf((v) => on(v.plateReceivedDate)), null),
      stageRow('book', 'new', doneOf((v) => on(v.bookReceivedDate)), null),
      stageRow('delivery', 'new', doneOf((v) => on(v.deliveredDate)), null),
      // ส่งป้ายตามหลัง = ส่งป้ายในวันที่เลือก ของรถที่ส่งงาน (ใบเสร็จ + เล่ม) ไปก่อนหน้านั้นแล้ว
      stageRow('plateDelivery', 'new', doneOf((v) => on(v.plateDeliveredDate) && !on(v.deliveredDate)), null),
      stageRow('billing', 'new', tally(dayBilledLines, vKind), null),
      // สลับเลขมีทั้งรถยนต์และจักรยานยนต์ (vehicleClass) - แยกตามประเภทของแต่ละงาน
      {
        ...stageRow(
          'plateSwap',
          'other',
          tally(swaps.filter((s) => isoOf(s.submitDate) === asOf), (s) => classKind(s.vehicleClass)),
          daySpend('plateSwap'),
          swapsReturned ? `รับเอกสารกลับ ${swapsReturned}` : null,
          dayDuty('plateSwap'),
        ),
        label: 'สลับเลข (ยื่น)',
      },
      { ...stageRow('taxRenewal', 'other', tally(renewals.filter((r) => isoOf(r.paymentDate!) === asOf), (r) => renewalKind(r.vehicleType)), daySpend('taxRenewal'), null, dayDuty('taxRenewal')), label: 'ต่อภาษี' },
      {
        key: 'yamaha',
        group: 'other',
        label: 'แจ้งย้ายยามาฮ่า',
        href: '/registration/yamaha-relocation',
        done: { car: null, moto: null, unsplit: yamahaToday.reduce((a, y) => a + y.count, 0) },
        doneNote: null,
        spend: daySpend('yamaha'),
        duty: null,
        pending: null,
        oldestDays: null,
        lateCount: 0,
        sla: null,
      },
      // ---- งานอื่นๆ ที่เพิ่มภายหลัง: ยื่นวันนี้กี่งาน / ค่าใช้จ่าย / ค้างรับใบเสร็จ (งานโอนตรวจรถมีขั้นส่งตรวจ-ผลตรวจเพิ่ม, คัดป้ายมีขั้นรับป้าย) ----
      jobRow('vehicleTransfer', 'transferJob', 'งานโอน (ยื่น)', vehicleTransfers, returnedNote(vehicleTransfers)),
      transferStageRow('transferInspectSend', 'งานโอนตรวจรถ (ส่งตรวจ)', vehicleTransfers.filter((t) => on(t.inspectionSentDate)), null),
      transferStageRow(
        'transferInspectResult',
        'งานโอนตรวจรถ (ผลตรวจ)',
        vehicleTransfers.filter((t) => on(t.inspectionResultDate)),
        (() => {
          const ok = vehicleTransfers.filter((t) => on(t.inspectionResultDate) && t.inspectionResult === 'PASS').length;
          const bad = vehicleTransfers.filter((t) => on(t.inspectionResultDate) && t.inspectionResult === 'FAIL').length;
          return ok || bad ? `ผ่าน ${ok} · ไม่ผ่าน ${bad}` : null;
        })(),
      ),
      jobRow('useCancel', 'useCancel', 'ยกเลิกการใช้รถ (ยื่น)', useCancels, returnedNote(useCancels)),
      jobRow('plateCopy', 'plateCopy', 'คัดแผ่นป้ายทะเบียน (ยื่น)', plateCopies, returnedNote(plateCopies), true),
      {
        ...stageRow('plateCopyPlate', 'other', { car: plateCopies.filter((j) => on(j.plateReceivedDate)).length, moto: null }, null),
        label: 'คัดแผ่นป้ายทะเบียน (รับป้าย)',
        pending: { car: backlog.plateCopyPlate.pending.car, moto: null },
      },
      jobRow('moveOut', 'moveOut', 'ย้ายออก (ยื่น)', moveOuts, returnedNote(moveOuts)),
    ];

    // ---------- สิ่งที่ควรจัดการ (เรียงตามความเร่งด่วน) ----------
    const overdueAr = receivableItems.filter((r) => daysBetween(r.issueDate, today) > 60);
    // เลยกำหนดเครดิตของลูกค้า (Invoice.dueDate = วันที่ออกบิล + เครดิตวัน ณ วันออกบิล) แต่ยังไม่ถึง 60 วัน - 60 วันขึ้นไปอยู่ในการเตือนข้างบนแล้ว
    const pastDue = receivableItems.filter((r) => r.dueDate !== null && r.dueDate < today && daysBetween(r.issueDate, today) <= 60);
    const dueSoon = receivableItems.filter((r) => r.dueDate !== null && r.dueDate >= today && daysBetween(today, r.dueDate) <= 7);
    const whtOverdue = whtPendingRows.filter((r) => daysBetween(isoOf(r.issueDate), today) > WHT_OVERDUE_DAYS).sort((a, b) => a.issueDate.getTime() - b.issueDate.getTime());
    // ใบเสนอราคา: รอลูกค้าตอบ (หมดอายุแล้วนับแยก) · อนุมัติแล้วแต่ยังไม่ได้ออกบิล/ตั้งเป็นราคาลูกค้า (stageOf ใน quotation-calc.ts)
    const byValidUntil = (a: { validUntil: Date }, b: { validUntil: Date }) => a.validUntil.getTime() - b.validUntil.getTime();
    const quoteWaitingList = quotations.filter((q) => q.status === 'ISSUED' && isoOf(q.validUntil) >= today).sort(byValidUntil);
    const quoteExpiredList = quotations.filter((q) => q.status === 'ISSUED' && isoOf(q.validUntil) < today).sort(byValidUntil);
    const quoteApprovedList = quotations.filter((q) => q.status === 'APPROVED' && (q.kind === 'RATE' ? !q.ratesAppliedAt : q._count.invoices === 0));
    const quoteWaiting = quoteWaitingList.length;
    const quoteExpired = quoteExpiredList.length;
    const quoteApprovedOpen = quoteApprovedList.length;
    // ส่วนต่างมากสุดขึ้นก่อน (ไม่ปัดเศษตรงนี้ ยอดรวมในข้อความจึงเท่าเดิม)
    const varianceRows = receiptRows
      .map((r) => ({ ...r, diff: num(r.receiptAmount) - (num(r.billFeeTotal) + num(r.taxAmount)) }))
      .filter((r) => Math.abs(r.diff) >= 1)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const variance = varianceRows.map((r) => r.diff);
    // ยื่นแล้วแต่ระบบคำนวณภาษีไม่ได้ (taxAmount = null เช่น จักรยานยนต์ไฟฟ้า) ยอดระหว่างดำเนินการนับภาษีเป็น 0 - ต้องบอกให้รู้
    // ไม่ให้ดูเหมือนยอดครบ (พบ 2026-09-27) · ได้ใบเสร็จแล้วใช้ยอดบนใบเสร็จจริง จึงไม่นับ · งานคีย์ล่วงหน้าไม่อยู่ในยอดนั้น จึงไม่นับเช่นกัน
    const taxMissingRows = inProcessSubs
      .filter((s) => isoOf(s.submitDate) <= today && s.taxAmount === null && !(s.status === 'RECEIPT_RECEIVED' && s.receiptAmount !== null))
      .sort((a, b) => a.submitDate.getTime() - b.submitDate.getTime());
    const taxMissing = taxMissingRows.length;

    // รายใบของแต่ละเรื่อง (ใบที่ควรดูก่อนขึ้นก่อน) - ตัดที่ ALERT_ITEM_LIMIT เหมือนรายคัน จำนวนจริงอยู่ใน itemTotal
    const withDocs = <T>(rows: T[], toDoc: (row: T) => AlertDoc) => ({ docs: rows.slice(0, ALERT_ITEM_LIMIT).map(toDoc), itemTotal: rows.length });
    type Receivable = (typeof receivableItems)[number];
    const invoiceDoc = (note: (r: Receivable) => string, byDue: boolean) => (r: Receivable): AlertDoc => ({
      id: r.id,
      title: r.invoiceNo,
      customerName: r.customerName,
      amount: r.amount,
      dateLabel: byDue ? 'ครบกำหนด' : 'ออกบิล',
      date: byDue ? r.dueDate : r.issueDate,
      note: note(r),
      href: focusUrl('/accounting/billing', r.invoiceNo),
    });
    const oldestIssue = (a: Receivable, b: Receivable) => a.issueDate.localeCompare(b.issueDate);
    const earliestDue = (a: Receivable, b: Receivable) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '');
    type QuoteRow = (typeof quotations)[number];
    const quoteDoc = (note: (q: QuoteRow) => string, approved: boolean) => (q: QuoteRow): AlertDoc => ({
      id: q.id,
      title: q.quotationNo ?? '(ร่าง)',
      customerName: snapshotName(q.customerSnapshot),
      amount: num(q.netTotal),
      dateLabel: approved ? 'อนุมัติ' : 'ใช้ได้ถึง',
      date: approved ? (q.approvedDate ? isoOf(q.approvedDate) : null) : isoOf(q.validUntil),
      note: note(q),
      href: `/accounting/quotations/view?id=${encodeURIComponent(q.id)}`,
    });
    const receiptPage = (body: string | null) => `${STAGES.receipt.href}/${vehicleKindOf(body)}`;
    // รายคันของแต่ละเรื่อง (ผู้ใช้ 2026-10-09: กดแล้วไปถึงคันที่มีปัญหา) - จำนวนบนหัวข้อนับจากรายการชุดเดียวกับที่กางให้ดู
    // ธงปัญหานับเฉพาะรถจดใหม่ (งานโอนตรวจไม่ผ่านอยู่ในรายการติดขัด ไม่อยู่ในเรื่องเหล่านี้) · เกินกำหนด = ค้างขั้นนั้นเกิน SLA
    const sortedProblems = sortStuck(problems);
    const flagged = (...fs: Flag[]) => sortedProblems.filter((p) => p.source === 'vehicle' && p.flags.some((f) => fs.includes(f)));
    const lateAt = (...keys: StageKey[]) => sortedProblems.filter((p) => p.overdueDays > 0 && keys.includes(p.stage));
    const flags = (f: Flag) => flagged(f).length;
    const late = (key: StageKey) => lateAt(key).length;
    const withItems = (list: StuckItem[]) => ({ items: list.slice(0, ALERT_ITEM_LIMIT), itemTotal: list.length });

    const alerts = [
      overdueAr.length && {
        key: 'ar-overdue',
        severity: 'high',
        title: 'บิลค้างชำระเกิน 60 วัน',
        detail: `${overdueAr.length} ใบ รวม ${fmt(overdueAr.reduce((a, r) => a + r.amount, 0))} บาท - ควรติดตามทวงถาม`,
        href: '/accounting/billing',
        ...withDocs([...overdueAr].sort(oldestIssue), invoiceDoc((r) => `ค้าง ${daysBetween(r.issueDate, today)} วัน`, false)),
      },
      pastDue.length && {
        key: 'ar-past-due',
        severity: 'medium',
        title: 'บิลเลยกำหนดชำระตามเครดิตลูกค้า',
        detail: `${pastDue.length} ใบ รวม ${fmt(pastDue.reduce((a, r) => a + r.amount, 0))} บาท`,
        href: '/accounting/billing',
        ...withDocs([...pastDue].sort(earliestDue), invoiceDoc((r) => `เลยกำหนด ${daysBetween(r.dueDate!, today)} วัน`, true)),
      },
      whtOverdue.length && {
        key: 'wht-overdue',
        severity: 'medium',
        title: `ลูกค้าหัก ณ ที่จ่ายแล้วยังไม่ส่ง 50 ทวิ เกิน ${WHT_OVERDUE_DAYS} วัน`,
        detail: `${whtOverdue.length} ใบกำกับ ภาษีที่หักไว้ ${fmt(whtOverdue.reduce((a, r) => a + num(r.whtAmount), 0))} บาท - ควรทวงหลักฐาน`,
        href: '/accounting/tax-invoices/wht',
        ...withDocs(whtOverdue, (r) => ({
          id: r.id,
          title: r.taxInvoiceNo,
          customerName: snapshotName(r.customerSnapshot),
          amount: num(r.whtAmount),
          dateLabel: 'รับเงิน',
          date: isoOf(r.issueDate),
          note: `ค้าง ${daysBetween(isoOf(r.issueDate), today)} วัน`,
          href: focusUrl('/accounting/tax-invoices/wht', r.taxInvoiceNo),
        })),
      },
      quoteApprovedOpen && {
        key: 'quotation-approved-open',
        severity: 'medium',
        title: 'ใบเสนอราคาอนุมัติแล้ว ยังไม่ได้ออกบิล / ตั้งราคา',
        detail: `${quoteApprovedOpen} ใบ - ลูกค้าตอบรับแล้ว รอดำเนินการต่อ`,
        href: '/accounting/quotations',
        ...withDocs(quoteApprovedList, quoteDoc((q) => (q.kind === 'RATE' ? 'รอตั้งเป็นราคาลูกค้า' : 'รอออกใบวางบิล'), true)),
      },
      quoteExpired && {
        key: 'quotation-expired',
        severity: 'info',
        title: 'ใบเสนอราคาหมดอายุโดยลูกค้ายังไม่ตอบ',
        detail: `${quoteExpired} ใบ${quoteWaiting ? ` (ยังรอตอบอยู่อีก ${quoteWaiting} ใบ)` : ''} - ติดตามลูกค้าหรือยกเลิก`,
        href: '/accounting/quotations',
        ...withDocs(quoteExpiredList, quoteDoc((q) => `หมดอายุมา ${daysBetween(isoOf(q.validUntil), today)} วัน`, false)),
      },
      !quoteExpired && quoteWaiting && {
        key: 'quotation-waiting',
        severity: 'info',
        title: 'ใบเสนอราคารอลูกค้าตอบ',
        detail: `${quoteWaiting} ใบ`,
        href: '/accounting/quotations',
        ...withDocs(quoteWaitingList, quoteDoc((q) => `เหลือ ${daysBetween(today, isoOf(q.validUntil))} วัน`, false)),
      },
      dueSoon.length && {
        key: 'ar-due-soon',
        severity: 'info',
        title: 'บิลที่จะครบกำหนดชำระภายใน 7 วัน',
        detail: `${dueSoon.length} ใบ รวม ${fmt(dueSoon.reduce((a, r) => a + r.amount, 0))} บาท`,
        href: '/accounting/billing',
        ...withDocs([...dueSoon].sort(earliestDue), invoiceDoc((r) => (r.dueDate === today ? 'ครบกำหนดวันนี้' : `อีก ${daysBetween(today, r.dueDate!)} วัน`), true)),
      },
      flags('INSPECTION_EXPIRING') && {
        key: 'inspection-expiring',
        severity: 'high',
        title: `ผลตรวจรถใกล้หมดอายุ (ภายใน ${INSPECTION_WARN_DAYS} วัน)`,
        detail: `${flags('INSPECTION_EXPIRING')} คัน ยังไม่ยื่นเอกสาร - หมดอายุแล้วต้องตรวจใหม่และเสียค่าตรวจซ้ำ`,
        href: STAGES.submit.href,
        ...withItems(flagged('INSPECTION_EXPIRING')),
      },
      flags('SUBMISSION_FAILED') && {
        key: 'submission-failed',
        severity: 'high',
        title: 'ยื่นเอกสารไม่สำเร็จ ยังไม่ได้ยื่นใหม่',
        detail: `${flags('SUBMISSION_FAILED')} คัน`,
        href: STAGES.submit.href,
        ...withItems(flagged('SUBMISSION_FAILED')),
      },
      flags('INSPECTION_FAILED') + flags('INSPECTION_EXPIRED') && {
        key: 'inspection-redo',
        severity: 'high',
        title: 'ต้องส่งตรวจรถใหม่',
        detail: `ตรวจไม่ผ่าน ${flags('INSPECTION_FAILED')} คัน · ผลตรวจหมดอายุ ${flags('INSPECTION_EXPIRED')} คัน`,
        href: STAGES.inspectSend.href,
        ...withItems(flagged('INSPECTION_FAILED', 'INSPECTION_EXPIRED')),
      },
      flags('RECEIPT_UNKNOWN') && {
        key: 'receipt-unknown',
        severity: 'medium',
        title: 'ยื่นแล้วยังไม่ได้ใบเสร็จ ไม่ทราบสาเหตุ',
        detail: `${flags('RECEIPT_UNKNOWN')} คัน (ยังขาดใบเสร็จในใบยื่น) - ควรตามที่ขนส่ง`,
        href: STAGES.receipt.href,
        ...withItems(flagged('RECEIPT_UNKNOWN')),
      },
      late('receipt') && {
        key: 'receipt-late',
        severity: 'medium',
        title: `รอใบเสร็จนานเกิน ${STAGES.receipt.sla} วัน`,
        detail: `${late('receipt')} คัน (นานสุด ${backlog.receipt.oldestDays} วัน) - เงินทดรองจ่ายจมอยู่`,
        href: STAGES.receipt.href,
        ...withItems(lateAt('receipt')),
      },
      // ตัวช่วยกันลืมลงวันส่งงาน (ผู้ใช้ 2026-10-08): ของครบแล้ว (ใบเสร็จ+เล่ม / ใบเสร็จของงานอื่น) แต่ยังไม่มีใบ DL เกินกำหนด
      // ค้างนานกว่า 7 วัน = ด่วน (น่าจะส่งไปแล้วแต่ไม่ได้ลง จึงวางบิลไม่ได้) - ขึ้นทั้งหน้าภาพรวม สรุปเช้า และสรุปเย็นใน LINE
      late('delivery') + late('jobDelivery') && {
        key: 'delivery-pending',
        severity: Math.max(backlog.delivery.oldestDays ?? 0, backlog.jobDelivery.oldestDays ?? 0) > 7 ? 'high' : 'medium',
        title: 'ของพร้อมส่งแล้ว แต่ยังไม่ได้ลงส่งงาน (ใบ DL)',
        detail: `รถจดใหม่/สลับเลข ${late('delivery')} คัน · งานอื่น ${late('jobDelivery')} งาน เกิน ${STAGES.delivery.sla} วัน (นานสุด ${Math.max(backlog.delivery.oldestDays ?? 0, backlog.jobDelivery.oldestDays ?? 0)} วัน) - พนักงานอาจลืมลงวันส่ง วางบิลไม่ได้จนกว่าจะลง`,
        href: STAGES.delivery.href,
        ...withItems(lateAt('delivery', 'jobDelivery')),
      },
      late('billing') && {
        key: 'billing-late',
        severity: 'medium',
        title: `ส่งงานแล้วแต่ยังไม่วางบิลเกิน ${STAGES.billing.sla} วัน`,
        detail: `${late('billing')} คัน - เงินยังไม่ถูกเรียกเก็บ`,
        href: STAGES.billing.href,
        ...withItems(lateAt('billing')),
      },
      late('plateDelivery') && {
        key: 'plate-owed',
        severity: 'medium',
        title: 'รับป้ายแล้วแต่ยังไม่ได้ส่งป้ายตามให้ลูกค้า',
        detail: `${late('plateDelivery')} คัน (นานสุด ${backlog.plateDelivery.oldestDays} วัน)`,
        href: STAGES.plateDelivery.href,
        ...withItems(lateAt('plateDelivery')),
      },
      variance.length && {
        key: 'receipt-variance',
        severity: 'info',
        title: 'ใบเสร็จจริงไม่ตรงกับยอดที่ระบบคำนวณ (30 วันล่าสุด)',
        detail: `${variance.length} ใบ ส่วนต่างสุทธิ ${fmt(variance.reduce((a, b) => a + b, 0))} บาท - ตรวจว่าอัตราค่าธรรมเนียมยังถูกต้อง`,
        href: STAGES.receipt.href,
        ...withDocs(varianceRows, (r) => ({
          id: r.id,
          title: r.vehicle.chassis,
          customerName: r.vehicle.customer.name,
          amount: round2(r.diff),
          dateLabel: 'ใบเสร็จ',
          date: r.receiptDate ? isoOf(r.receiptDate) : null,
          note: `ใบเสร็จ ${fmt(num(r.receiptAmount))} · ระบบคำนวณ ${fmt(num(r.billFeeTotal) + num(r.taxAmount))}`,
          href: focusUrl(receiptPage(r.vehicle.body), r.vehicle.chassis),
        })),
      },
      taxMissing && {
        key: 'tax-missing',
        severity: 'info',
        title: 'ยื่นแล้วแต่ยังคำนวณภาษีไม่ได้',
        detail: `${taxMissing} คัน - ยอดจ่ายแล้วระหว่างดำเนินการยังไม่รวมภาษีของคันเหล่านี้`,
        href: '/registration/new-vehicle/submit-documents/records',
        ...withDocs(taxMissingRows, (r) => ({
          id: r.id,
          title: r.vehicle.chassis,
          customerName: r.vehicle.customer.name,
          amount: null,
          dateLabel: 'ยื่น',
          date: isoOf(r.submitDate),
          note: 'ระบบยังคำนวณภาษีไม่ได้',
          href: focusUrl('/registration/new-vehicle/submit-documents/records', r.vehicle.chassis, { date: isoOf(r.submitDate), tab: recordsTab(r.vehicle.body) }),
        })),
      },
      pendingUsers && {
        key: 'pending-users',
        severity: 'info',
        title: 'ผู้ใช้รออนุมัติ',
        detail: `${pendingUsers} บัญชี`,
        href: '/admin/users',
      },
    ].filter(Boolean) as Array<{ key: string; severity: 'high' | 'medium' | 'info'; title: string; detail: string; href: string; items?: StuckItem[]; docs?: AlertDoc[]; itemTotal?: number }>;
    const severityRank = { high: 0, medium: 1, info: 2 } as const;
    alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]); // เรียงตามความเร่งด่วน (sort เสถียร คงลำดับเดิมในระดับเดียวกัน)

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
        // เปลี่ยนแปลงเทียบช่วงก่อนหน้าไม่รวมเงินเดือน/ค่าจ้าง (ผู้ใช้ 2026-10-06): จ่ายเดือนละครั้งทำให้ % รายวันกระโดด ยอดรวมยังรวมไว้ตามเดิม
        changeVsYesterday: pctChange(runningCost(windows.today), runningCost(windows.yesterday)),
        changeVs7: pctChange(runningCost(windows.last7), runningCost(windows.prev7)),
        changeVs30: pctChange(runningCost(windows.last30), runningCost(windows.prev30)),
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
        inProcess, // จ่ายไปแล้ว ยังอยู่ระหว่างดำเนินการ ยังไม่ส่งงาน
        advance, // คีย์ล่วงหน้า (วันที่ยื่นหลังวันนี้) ยังไม่ได้จ่าย - ไม่นับรวมใน total
        unbilled: { amount: unbilledTotal, count: unbilledItems.length }, // ส่งงานแล้ว ยังไม่วางบิล (ยอดตามใบเสร็จ ไม่รวมค่าดำเนินการ)
        receivable: { amount: receivableTotal, count: receivableItems.length }, // วางบิลแล้ว รอรับเงิน
        overdue: overdueByCustomer(receivableItems, today), // เลยกำหนดเครดิตแล้ว (ใช้ในสรุปเช้า/เย็นของเลขา)
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
        limit: STUCK_LIMIT, // แสดงได้สูงสุดกี่คันต่อตัวกรอง (ทั้งหมด / รถยนต์ / จักรยานยนต์)
        items: limitStuckPerKind(sortedStuck, STUCK_LIMIT),
      },
      alerts,
    };
  }
}

function fmt(n: number): string {
  return round2(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
