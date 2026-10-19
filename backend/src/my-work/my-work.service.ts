import { Injectable } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { vehicleKindOf, type VehicleKind } from '../auth/vehicle-scope.js';
import { currentBillEstimate, loadDocumentFeeRules } from '../billing/billing.service.js';
import { WHT_OVERDUE_DAYS, WHT_PENDING_WHERE } from '../billing/tax-invoice.service.js';
import type { UserRole } from '../generated/prisma/enums.js';
import { addDays, bangkokToday, daysBetween, isoOf, round2, toDate } from '../overview/overview-calculator.js';
import {
  jobDeliveryWait,
  plateCopyWaits,
  problemItemsFor,
  receiptWait,
  sortStuck,
  STAGES,
  summarizeBacklog,
  transferWaits,
  waitsFor,
  type BacklogItem,
  type StageKey,
  type StuckItem,
  type StuckSubject,
  type Wait,
} from '../overview/overview-process.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { motorcycleCcMismatch } from '../vehicles/vehicle-validation.js';
import { bangkokDateOf, canOpenDeliveryPage, focusUrl, hasCheckOwner, isMine, kindsFor, stagesFor, workHrefFor, type CheckOwner } from './my-work-roles.js';

// งานของฉัน (ผู้ใช้ 2026-10-13): หน้าภาพรวมของพนักงานแต่ละบทบาท - อ่านอย่างเดียว ไม่มีราคาของออฟฟิศ
// 1. "ต้องจัดการก่อน" = รายการที่ค้างเกินกำหนดหรือมีปัญหา เฉพาะขั้นที่บทบาทนี้ทำได้และรถประเภทที่ดูแล (กติกา "รออะไร" ชุดเดียวกับ
//    ภาพรวมผู้บริหาร: overview-process.ts - คำสั่ง select ของรถ/งานที่ยังไม่จบด้านล่างเป็นสำเนาของ overview.service.ts ต้องแก้ให้ตรงกัน)
// 2. "ตรวจก่อนผิด" = ตัวช่วยที่สร้างจากข้อผิดพลาดที่เกิดซ้ำใน VehicleEditLog / AuditLog / ใบยื่นที่ไม่สำเร็จ (นับจากฐานข้อมูล dev 2026-10-13):
//    วันที่ใบส่งงานผิด 61 · วันที่ยื่นผิด 30 · ยกเลิกใบส่งงาน "ป้ายไม่มา" 61 · CC/ประเภทรถผิด 10 · ยี่ห้อผิด 13 · จังหวัดเจ้าของผิด 20 ·
//    ยื่นไม่สำเร็จเพราะเลขทะเบียนยังไม่ถึง / เอกสารหมดอายุ / จังหวัดผิด - แต่ละเรื่องบอก "บทเรียน" ไว้ในช่อง lesson
// 3. "คิวของฉัน" = งานค้างรายขั้นของบทบาทนี้ (รวมที่ยังไม่เกินกำหนด)

const PROBLEM_LIMIT = 200;
const CHECK_LIMIT = 50;
const DRIFT_DAYS = 14; // ตรวจวันที่ของรายการที่บันทึกภายในกี่วัน (เก่ากว่านี้แก้ไปแล้วหรือเลยเวลาแก้)
const FUTURE_DAYS = 7; // วันที่ล่วงหน้าเกินนี้ถือว่าน่าจะพิมพ์ผิด (คีย์งานล่วงหน้าไม่กี่วันเป็นเรื่องปกติ)
const PAST_SLIP_DAYS = 2; // ใบส่งงานที่ลงวันที่ย้อนหลังไม่เกินนี้ไม่เตือน (ส่งแล้วค่อยมาบันทึก)
const VARIANCE_DAYS = 30;
const TRANSFER_RECEIPT_DAYS = 60; // แจ้งย้ายเสร็จภายในกี่วันที่ยังตามแนบใบเสร็จแจ้งย้ายได้ (ใบเสร็จต้องมีก่อนวางบิล ผู้ใช้ 2026-10-08)
const AR_OVERDUE_DAYS = 60;
const AR_DUE_SOON_DAYS = 7;
const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;

export type Severity = 'high' | 'medium' | 'info';

// หนึ่งแถวของหน้า (รถ / งาน / ใบ) - หน้าเว็บแสดงตารางเดียวกันทุกเรื่อง
export interface WorkRow {
  key: string;
  kind: VehicleKind | null; // null = ไม่ผูกกับประเภทรถ (บิล ใบกำกับ ใบเสนอราคา)
  title: string; // ยี่ห้อ · ทะเบียน / เลขที่ใบ
  chassis: string | null;
  customerName: string;
  stageLabel: string;
  since: string | null; // ค.ศ. YYYY-MM-DD
  days: number | null;
  overdueDays: number;
  severity: Severity;
  reason: string;
  amount: number | null; // เฉพาะเรื่องของบัญชี (ยอดบิล / ส่วนต่างใบเสร็จ) - ไม่มีราคาค่าบริการของออฟฟิศ
  href: string;
}

export interface WorkCheck {
  key: string;
  owner: CheckOwner;
  severity: Severity;
  title: string;
  lesson: string; // บทเรียนจากข้อผิดพลาดที่ผ่านมา - ทำไมถึงต้องตรวจ
  items: WorkRow[];
  total: number;
}

export interface StageSummary {
  key: StageKey;
  label: string;
  href: string;
  sla: number;
  kinds: VehicleKind[];
  pending: { car: number; moto: number };
  oldestDays: number | null;
  lateCount: number;
}

const num = (d: unknown) => (d === null || d === undefined ? 0 : Number(d));
const classKind = (vehicleClass: string): VehicleKind => (vehicleClass === 'MOTO' ? 'moto' : 'car');
const renewalKind = (vehicleType: string): VehicleKind => (vehicleType.startsWith('รย.12') ? 'moto' : 'car');
const plateText = (category: string | null, number: string | null) => (category && number ? `${category} ${number}` : null);
const titleOf = (brand: string | null, plate: string | null, chassis: string) => [brand, plate].filter(Boolean).join(' · ') || chassis;
const snapshotName = (snapshot: unknown) => (snapshot as { name?: string } | null)?.name ?? '-';
const thaiDate = (iso: string) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}/${iso.slice(0, 4)}`;
const fmt = (n: number) => round2(n).toLocaleString('th-TH', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const recordsTab = (body: string | null) => (vehicleKindOf(body) === 'moto' ? 'moto' : body && /^รย.[123]-/.test(body) ? 'car' : 'unknown');
const entryEditUrl = (chassis: string) => focusUrl('/registration/new-vehicle/entry', chassis, { edit: '1' });

interface VehicleRef {
  chassis: string;
  body: string | null;
  plateCategory: string | null;
  plateNumber: string | null;
  customer: { name: string };
  brand: { name: string };
}
const vehicleRef = { chassis: true, body: true, plateCategory: true, plateNumber: true, customer: { select: { name: true } }, brand: { select: { name: true } } } as const;

function rowOfVehicle(v: VehicleRef, rest: Omit<WorkRow, 'kind' | 'title' | 'chassis' | 'customerName'>): WorkRow {
  return {
    kind: vehicleKindOf(v.body),
    title: titleOf(v.brand.name, plateText(v.plateCategory, v.plateNumber), v.chassis),
    chassis: v.chassis,
    customerName: v.customer.name,
    ...rest,
  };
}

function stuckRow(s: StuckItem, roles: UserRole[]): WorkRow {
  return {
    key: `${s.source}-${s.id}-${s.stage}`,
    kind: s.kind,
    title: titleOf(s.brandName, s.plate, s.chassis),
    chassis: s.chassis,
    customerName: s.customerName,
    stageLabel: s.stageLabel,
    since: s.since,
    days: s.days,
    overdueDays: s.overdueDays,
    severity: s.severity,
    reason: s.reason,
    amount: null,
    href: workHrefFor(s, roles),
  };
}

@Injectable()
export class MyWorkService {
  constructor(private readonly prisma: PrismaService) {}

  async myWork() {
    const roles: UserRole[] = currentUser()?.roles ?? ['ADMIN']; // นอกคำขอ HTTP (unit test) = เห็นทุกอย่าง
    const today = bangkokToday();
    const stages = stagesFor(roles);

    const [open, checks] = await Promise.all([this.openWork(roles, today), this.checks(roles, today)]);
    const backlog = summarizeBacklog(open.backlog, today);
    const deliveryPage = canOpenDeliveryPage(roles) ? '/delivery' : '/accounting/billing';
    const stageRows: StageSummary[] = stages.map((key) => {
      const b = backlog[key];
      const href = key === 'delivery' || key === 'plateDelivery' || key === 'jobDelivery' ? deliveryPage : STAGES[key].href;
      return { key, label: STAGES[key].label, href, sla: STAGES[key].sla, kinds: kindsFor(roles, key) ?? [], pending: b.pending, oldestDays: b.oldestDays, lateCount: b.lateCount };
    });
    const problems = sortStuck(open.problems);

    return {
      today,
      roles,
      summary: {
        problems: problems.length,
        high: problems.filter((p) => p.severity === 'high').length,
        checks: checks.reduce((a, c) => a + c.total, 0),
        pending: open.backlog.length,
      },
      problems: problems.slice(0, PROBLEM_LIMIT).map((s) => stuckRow(s, roles)),
      problemTotal: problems.length,
      checks,
      stages: stageRows,
    };
  }

  // ---------- รถ/งานที่ยังไม่จบ -> รายการรอของขั้นที่ฉันทำ ----------
  private async openWork(roles: UserRole[], today: string) {
    const live = { deletedAt: null };
    const [openVehicles, openSwaps, openRenewals, openUseCancels, openPlateCopies, openMoveOuts, openTransfers] = await Promise.all([
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
            select: { status: true, submitDate: true, receiptDate: true, receiptReceivedDate: true, failRemark: true, receiptCarriedAt: true, _count: { select: { receipts: true } } },
          },
          plateSwapsAsNew: { where: { returnedDate: null, cancelledAt: null, vehicleClass: { not: 'MOTO' } }, take: 1, select: { id: true } },
          invoiceLines: { where: NOT_VOID, take: 1, select: { id: true } },
          billingClosedAt: true,
        },
      }),
      this.prisma.plateSwap.findMany({
        where: { returnedDate: null, cancelledAt: null },
        select: { id: true, vehicleClass: true, submitDate: true, oldOwnerName: true, oldChassis: true, oldBrand: true, oldPlateCategory: true, oldPlateNumber: true },
      }),
      this.prisma.taxRenewal.findMany({
        where: { cancelledAt: null, OR: [{ paymentDate: null }, { receivedDate: { not: null }, deliveredDate: null }] },
        select: { id: true, submitDate: true, paymentDate: true, receivedDate: true, vehicleType: true, chassis: true, plateCategory: true, plateNumber: true, ownerName: true, customer: { select: { name: true } } },
      }),
      this.prisma.vehicleUseCancellation.findMany({
        where: { cancelledAt: null, deliveredDate: null },
        select: { id: true, vehicleClass: true, submitDate: true, returnedDate: true, ownerName: true, chassis: true, brand: true, plateCategory: true, plateNumber: true, customer: { select: { name: true } } },
      }),
      this.prisma.plateCopy.findMany({
        where: { cancelledAt: null, deliveredDate: null },
        select: { id: true, vehicleClass: true, submitDate: true, returnedDate: true, plateReceivedDate: true, ownerName: true, chassis: true, brand: true, plateCategory: true, plateNumber: true, customer: { select: { name: true } } },
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
    ]);

    const backlog: BacklogItem[] = [];
    const problems: StuckItem[] = [];
    // เก็บเฉพาะรายการรอที่อยู่ในความรับผิดชอบของบทบาทนี้ (ขั้น + ประเภทรถ)
    const add = (subject: StuckSubject, waits: Wait[]) => {
      const mine = waits.filter((w) => isMine(roles, w.stage, subject.kind));
      for (const w of mine) backlog.push({ stage: w.stage, kind: subject.kind, since: w.since });
      problems.push(...problemItemsFor(subject, mine, today));
    };

    for (const v of openVehicles) {
      const waits = waitsFor(
        { ...v, latestSubmission: v.documentSubmissions[0] ?? null, hasPendingPlateSwap: v.plateSwapsAsNew.length > 0, billed: v.invoiceLines.length > 0, billingClosed: !!v.billingClosedAt },
        today,
      );
      add({ id: v.id, source: 'vehicle', kind: vehicleKindOf(v.body), customerName: v.customer.name, brandName: v.brand.name, chassis: v.chassis, plate: plateText(v.plateCategory, v.plateNumber) }, waits);
    }
    for (const s of openSwaps) {
      add(
        { id: s.id, source: 'plateSwap', kind: classKind(s.vehicleClass), customerName: s.oldOwnerName, brandName: s.oldBrand, chassis: s.oldChassis, plate: plateText(s.oldPlateCategory, s.oldPlateNumber) },
        [{ stage: 'plateSwap', since: isoOf(s.submitDate), flags: [], reason: null }],
      );
    }
    for (const r of openRenewals) {
      const wait: Wait = r.paymentDate && r.receivedDate ? jobDeliveryWait(r.receivedDate) : { stage: 'taxRenewal', since: isoOf(r.submitDate), flags: [], reason: null };
      add({ id: r.id, source: 'taxRenewal', kind: renewalKind(r.vehicleType), customerName: r.customer?.name ?? r.ownerName ?? '-', brandName: null, chassis: r.chassis, plate: plateText(r.plateCategory, r.plateNumber) }, [wait]);
    }
    interface OtherJob {
      id: string;
      vehicleClass: string;
      chassis: string;
      brand: string;
      plateCategory: string;
      plateNumber: string;
      customer: { name: string } | null;
    }
    const addJob = (job: OtherJob, name: string, waits: Wait[], href: string) =>
      add({ id: job.id, source: 'otherJob', kind: classKind(job.vehicleClass), customerName: job.customer?.name ?? name, brandName: job.brand, chassis: job.chassis, plate: plateText(job.plateCategory, job.plateNumber), href }, waits);
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
    return { backlog, problems };
  }

  // ---------- ตรวจก่อนผิด ----------
  private async checks(roles: UserRole[], today: string): Promise<WorkCheck[]> {
    const out: WorkCheck[] = [];
    const run = <T>(owner: CheckOwner, task: () => Promise<T>): Promise<T | null> => (hasCheckOwner(roles, owner) ? task() : Promise.resolve(null));
    const [entry, submit, delivery, accounting] = await Promise.all([
      run('entry', () => this.entryChecks(roles, today)),
      run('submit', () => this.submitChecks(roles, today)),
      run('delivery', () => this.deliveryChecks(roles, today)),
      run('accounting', () => this.accountingChecks(today)),
    ]);
    for (const list of [entry, submit, delivery, accounting]) if (list) out.push(...list);
    const rank = { high: 0, medium: 1, info: 2 } as const;
    return out.filter((c) => c.total > 0).sort((a, b) => rank[a.severity] - rank[b.severity]); // ด่วนก่อน (sort เสถียร คงลำดับฝ่ายในระดับเดียวกัน)
  }

  private check(key: string, owner: CheckOwner, severity: Severity, title: string, lesson: string, rows: WorkRow[]): WorkCheck {
    return { key, owner, severity, title, lesson, items: rows.slice(0, CHECK_LIMIT), total: rows.length };
  }

  // ข้อมูลรถที่ยังแก้ได้ (ยังไม่ยื่น / ยื่นไม่สำเร็จ): ขอบเขตประเภทรถตามบทบาท (STAFF_ENTRY ทุกคัน)
  private async entryChecks(roles: UserRole[], today: string): Promise<WorkCheck[]> {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, deliveredDate: null, documentSubmissions: { none: { status: { in: ['PENDING', 'RECEIPT_RECEIVED'] } } } },
      orderBy: { date: 'asc' },
      select: { ...vehicleRef, id: true, date: true, cc: true, ownerId: true, registrationProvince: true, ownerProvince: true },
    });
    const visible = vehicles.filter((v) => isMine(roles, 'transfer', vehicleKindOf(v.body)) || isMine(roles, 'inspectSend', vehicleKindOf(v.body)));
    const base = (v: (typeof vehicles)[number], severity: Severity, reason: string, stageLabel: string): WorkRow =>
      rowOfVehicle(v, { key: `${stageLabel}-${v.id}`, stageLabel, since: isoOf(v.date), days: daysBetween(isoOf(v.date), today), overdueDays: 0, severity, reason, amount: null, href: entryEditUrl(v.chassis) });

    const ccRows = visible
      .map((v) => ({ v, msg: v.body && v.cc !== null ? motorcycleCcMismatch(v.body, String(Number(v.cc))) : null }))
      .filter((x): x is { v: (typeof vehicles)[number]; msg: string } => x.msg !== null)
      .map(({ v, msg }) => base(v, 'high', msg, 'ข้อมูลรถ'));
    const provinceRows = visible
      .filter((v) => v.registrationProvince && v.ownerProvince && v.registrationProvince !== v.ownerProvince)
      .map((v) => base(v, 'info', `จด${v.registrationProvince} แต่เจ้าของอยู่${v.ownerProvince} = ขอใช้จังหวัดอื่น (ค่าธรรมเนียมอื่นๆ +20) - ถ้าไม่ใช่ขอใช้ แก้จังหวัดก่อนยื่น`, 'จังหวัด'));
    const ownerRows = visible.filter((v) => v.ownerId === null).map((v) => base(v, 'info', 'ยังไม่มีข้อมูลเจ้าของรถ (ชื่อผู้ถือกรรมสิทธิ์ / ผู้ครอบครอง) - ขั้นยื่นเอกสารต้องใช้', 'เจ้าของรถ'));

    // ใบเสร็จแจ้งย้าย (ผู้ใช้ 2026-10-08): รถที่แจ้งย้ายเสร็จก่อนมีระบบใบเสร็จ ยังแนบย้อนหลังได้ และต้องมีก่อนวางบิล
    const transferRows = (
      await this.prisma.vehicle.findMany({
        where: {
          deletedAt: null,
          transferDone: true,
          transferReceiptId: null,
          transferReceiptWaivedReason: null,
          billingClosedAt: null,
          invoiceLines: { none: NOT_VOID },
          registrationProvince: { not: 'กรุงเทพมหานคร' },
          transferCompletedDate: { gte: toDate(addDays(today, -TRANSFER_RECEIPT_DAYS)) },
        },
        orderBy: { transferCompletedDate: 'asc' },
        select: { ...vehicleRef, id: true, transferCompletedDate: true },
      })
    )
      .filter((v) => isMine(roles, 'transfer', vehicleKindOf(v.body)))
      .map((v) => {
        const since = isoOf(v.transferCompletedDate!);
        return rowOfVehicle(v, {
          key: `transfer-receipt-${v.id}`,
          stageLabel: 'แจ้งย้าย',
          since,
          days: daysBetween(since, today),
          overdueDays: 0,
          severity: 'medium',
          reason: `แจ้งย้ายเสร็จ ${thaiDate(since)} แต่ยังไม่แนบใบเสร็จแจ้งย้าย - ต้องมีก่อนวางบิล`,
          amount: null,
          href: focusUrl('/registration/new-vehicle/transfer-notice', v.chassis),
        });
      });

    return [
      this.check('moto-cc-mismatch', 'entry', 'high', 'CC ไม่ตรงกับประเภทรถ', 'เคยคีย์รถ 149.5cc เป็น รย.12-300-799cc - ภาษีและค่าธรรมเนียมคิดผิดทั้งคัน แก้ที่ข้อมูลรถก่อนยื่น', ccRows),
      this.check('transfer-receipt-missing', 'entry', 'medium', 'แจ้งย้ายเสร็จแล้วแต่ไม่มีใบเสร็จแจ้งย้าย', 'ใบเสร็จแจ้งย้ายรวมเข้าบิลลูกค้า - ไม่มีใบ บัญชีวางบิลไม่ครบ', transferRows),
      this.check('other-province', 'entry', 'info', 'จังหวัดที่จดกับจังหวัดเจ้าของไม่ตรงกัน (ขอใช้)', 'จังหวัดเจ้าของรถคีย์ผิดเป็นสาเหตุที่พบบ่อยที่สุดที่ใบเสร็จไม่ตรงกับ Bill และต้องแก้หลังยื่น (ที่ผ่านมา 20 ครั้ง)', provinceRows),
      this.check('missing-owner', 'entry', 'info', 'ยังไม่มีข้อมูลเจ้าของรถ', 'ขั้นยื่นเอกสารต้องรู้ประเภทเจ้าของและชื่อ - ใส่ตั้งแต่รับรถจะไม่ติดตอนยื่น', ownerRows),
    ];
  }

  private async submitChecks(roles: UserRole[], today: string): Promise<WorkCheck[]> {
    const [pendingSubs, receiptRows, feeRules] = await Promise.all([
      this.prisma.documentSubmission.findMany({
        where: { status: 'PENDING', createdAt: { gte: toDate(addDays(today, -DRIFT_DAYS)) }, vehicle: { deletedAt: null } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, submitDate: true, createdAt: true, vehicle: { select: vehicleRef } },
      }),
      this.prisma.documentSubmission.findMany({
        where: { status: 'RECEIPT_RECEIVED', receiptAmount: { not: null }, taxAmount: { not: null }, receiptDate: { gte: toDate(addDays(today, -(VARIANCE_DAYS - 1))) }, vehicle: { deletedAt: null } },
        select: {
          id: true,
          receiptDate: true,
          receiptAmount: true,
          billFeeTotal: true,
          taxAmount: true,
          plateNumberOption: true,
          includePlateFee: true,
          newPlateOption: true,
          relocateAddon: true,
          stopUseRelocateOut: true,
          urgent: true,
          vehicle: { select: { ...vehicleRef, registrationProvince: true, ownerProvince: true } },
        },
      }),
      loadDocumentFeeRules(this.prisma),
    ]);

    // วันที่ยื่นที่ลงไว้ ต่างจากวันที่กดบันทึกจริง - คีย์ล่วงหน้าเป็นเรื่องปกติ (ผู้ใช้: งานคีย์ไว้ก่อน) จึงเตือนเฉพาะย้อนหลัง (ลืมเปลี่ยนวันที่)
    // และล่วงหน้าเกิน FUTURE_DAYS วัน (ปี/เดือนพิมพ์ผิด)
    const driftRows = pendingSubs
      .filter((s) => isMine(roles, 'submit', vehicleKindOf(s.vehicle.body)))
      .map((s) => ({ s, submit: isoOf(s.submitDate), keyed: bangkokDateOf(s.createdAt) }))
      .map((x) => ({ ...x, drift: daysBetween(x.keyed, x.submit) })) // บวก = ล่วงหน้า, ลบ = ย้อนหลัง
      .filter(({ drift }) => drift < 0 || drift > FUTURE_DAYS)
      .map(({ s, submit, keyed, drift }) =>
        rowOfVehicle(s.vehicle, {
          key: `submit-drift-${s.id}`,
          stageLabel: 'ยื่นเอกสาร',
          since: submit,
          days: daysBetween(submit, today),
          overdueDays: 0,
          severity: drift === -1 ? 'info' : 'medium',
          reason:
            drift > 0
              ? `ลงวันที่ยื่น ${thaiDate(submit)} ล่วงหน้า ${drift} วันจากวันที่บันทึก (${thaiDate(keyed)}) - ปีหรือเดือนพิมพ์ผิดหรือเปล่า`
              : `ลงวันที่ยื่น ${thaiDate(submit)} แต่บันทึกเมื่อ ${thaiDate(keyed)} - ถ้าผิด ยกเลิกแล้วยื่นใหม่ก่อนได้ใบเสร็จ`,
          amount: null,
          href: focusUrl('/registration/new-vehicle/submit-documents/records', s.vehicle.chassis, { date: submit, tab: recordsTab(s.vehicle.body) }),
        }),
      );

    const varianceRows = receiptRows
      .filter((r) => isMine(roles, 'receipt', vehicleKindOf(r.vehicle.body)))
      .map((r) => {
        const expected = currentBillEstimate(r.vehicle, r, feeRules) ?? num(r.billFeeTotal) + num(r.taxAmount);
        return { r, expected, diff: round2(num(r.receiptAmount) - expected) };
      })
      .filter(({ diff }) => Math.abs(diff) >= 1)
      .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
      .map(({ r, expected, diff }) => {
        const since = r.receiptDate ? isoOf(r.receiptDate) : null;
        return rowOfVehicle(r.vehicle, {
          key: `variance-${r.id}`,
          stageLabel: 'รับใบเสร็จ',
          since,
          days: since ? daysBetween(since, today) : null,
          overdueDays: 0,
          severity: 'medium',
          reason: `ใบเสร็จ ${fmt(num(r.receiptAmount))} แต่ระบบคำนวณ ${fmt(expected)} (${diff > 0 ? '+' : ''}${fmt(diff)}) - ${diff > 0 ? 'อาจเป็นขอใช้จังหวัดอื่นทั้งที่ข้อมูลบอกว่าไม่ใช่' : 'อาจไม่ใช่ขอใช้ หรือ CC / น้ำหนักคีย์ผิด'}`,
          amount: diff,
          href: focusUrl(`${STAGES.receipt.href}/${vehicleKindOf(r.vehicle.body)}`, r.vehicle.chassis),
        });
      });

    return [
      this.check('submission-date-drift', 'submit', 'medium', 'วันที่ยื่นย้อนหลังหรือล่วงหน้าผิดปกติ', 'ยกเลิกใบยื่นเพราะ "วันที่ยื่นผิด" เป็นเหตุผลที่พบบ่อยที่สุด (30 ครั้ง) - ตรวจวันที่ในขั้นตั้งค่าก่อนกดยืนยันยื่น', driftRows),
      this.check('receipt-variance', 'submit', 'medium', 'ใบเสร็จไม่ตรงกับยอดที่ระบบคำนวณ (30 วันล่าสุด)', 'ใบเสร็จถูกเสมอ - ส่วนต่างมักมาจากจังหวัดเจ้าของ (ขอใช้) หรือ CC / น้ำหนักที่คีย์ผิด ตรวจแล้วแก้ข้อมูลรถหรือยืนยันในหน้ารับใบเสร็จ', varianceRows),
    ];
  }

  private async deliveryChecks(roles: UserRole[], today: string): Promise<WorkCheck[]> {
    const slips = await this.prisma.deliverySlip.findMany({
      where: { cancelledAt: null, OR: [{ createdAt: { gte: toDate(addDays(today, -DRIFT_DAYS)) } }, { date: { gt: toDate(today) } }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true, slipNo: true, date: true, recipient: true, createdAt: true, customer: { select: { name: true } }, items: { where: { cancelledAt: null }, select: { vehicle: { select: { body: true } } } } },
    });
    // ลงวันส่งย้อนหลังวันสองวันเป็นเรื่องปกติ (ส่งแล้วค่อยมาบันทึก) และวันที่ล่วงหน้าทำได้ (ผู้ใช้) - เตือนเฉพาะย้อนหลังเกิน PAST_SLIP_DAYS
    // หรือล่วงหน้าเกิน FUTURE_DAYS วัน ซึ่งมักเป็นเดือน/ปีพิมพ์ผิด
    const rows = slips
      .map((s) => {
        const withVehicle = s.items.find((i) => i.vehicle);
        const kind: VehicleKind | null = withVehicle ? vehicleKindOf(withVehicle.vehicle!.body) : null;
        const date = isoOf(s.date);
        const keyed = bangkokDateOf(s.createdAt);
        return { s, kind, date, keyed, drift: daysBetween(keyed, date) };
      })
      .filter(({ s, kind, drift }) => s.items.length > 0 && (drift < -PAST_SLIP_DAYS || drift > FUTURE_DAYS) && isMine(roles, 'delivery', kind))
      .map(({ s, kind, date, keyed, drift }) => {
        const slipNo = `DL-${String(s.slipNo).padStart(5, '0')}`;
        const future = drift > 0;
        return {
          key: `slip-drift-${s.id}`,
          kind,
          title: slipNo,
          chassis: null,
          customerName: s.customer.name,
          stageLabel: 'ใบส่งงาน',
          since: date,
          days: future ? null : daysBetween(date, today),
          overdueDays: 0,
          severity: 'medium' as const,
          reason: future
            ? `วันที่ส่ง ${thaiDate(date)} ล่วงหน้า ${drift} วันจากวันที่บันทึก (${thaiDate(keyed)}) - เดือนหรือปีพิมพ์ผิดหรือเปล่า · ผู้รับ ${s.recipient}`
            : `ลงวันที่ส่ง ${thaiDate(date)} แต่บันทึกเมื่อ ${thaiDate(keyed)} (ย้อนหลัง ${-drift} วัน) · ผู้รับ ${s.recipient} - ถ้าผิด กด ✎ แก้ ในรายงานส่งงาน`,
          amount: null,
          href: focusUrl('/delivery/report', slipNo),
        } satisfies WorkRow;
      });
    return [this.check('slip-date-drift', 'delivery', 'medium', 'วันที่ใบส่งงานย้อนหลังหรือล่วงหน้าผิดปกติ', 'แก้ใบส่งงานเพราะวันที่ผิดเป็นการแก้ที่พบมากที่สุดในระบบ (61 ครั้ง) - ดูวันที่ในป๊อปอัปยืนยันก่อนบันทึก', rows)];
  }

  private async accountingChecks(today: string): Promise<WorkCheck[]> {
    const [invoices, whtRows, quotations] = await Promise.all([
      this.prisma.invoice.findMany({ where: { status: 'ISSUED' }, select: { id: true, invoiceNo: true, issueDate: true, dueDate: true, netTotal: true, customerSnapshot: true } }),
      this.prisma.taxInvoice.findMany({ where: WHT_PENDING_WHERE, select: { id: true, taxInvoiceNo: true, issueDate: true, whtAmount: true, customerSnapshot: true } }),
      this.prisma.quotation.findMany({
        where: { status: { in: ['ISSUED', 'APPROVED'] } },
        select: { id: true, quotationNo: true, customerSnapshot: true, netTotal: true, status: true, kind: true, validUntil: true, ratesAppliedAt: true, _count: { select: { invoices: { where: NOT_VOID.invoice } } } },
      }),
    ]);

    const arRows: WorkRow[] = [];
    for (const inv of invoices) {
      const issue = isoOf(inv.issueDate);
      const due = inv.dueDate ? isoOf(inv.dueDate) : null;
      const age = daysBetween(issue, today);
      let severity: Severity;
      let reason: string;
      if (age > AR_OVERDUE_DAYS) {
        severity = 'high';
        reason = `ออกบิลมา ${age} วัน ยังไม่ได้รับเงิน - ตามลูกค้า`;
      } else if (due && due < today) {
        severity = 'medium';
        reason = `เลยกำหนดชำระ ${thaiDate(due)} มา ${daysBetween(due, today)} วัน`;
      } else if (due && daysBetween(today, due) <= AR_DUE_SOON_DAYS) {
        severity = 'info';
        reason = `ครบกำหนดชำระ ${thaiDate(due)} (อีก ${daysBetween(today, due)} วัน)`;
      } else continue;
      arRows.push({
        key: `ar-${inv.id}`,
        kind: null,
        title: inv.invoiceNo,
        chassis: null,
        customerName: snapshotName(inv.customerSnapshot),
        stageLabel: 'รอรับเงิน',
        since: issue,
        days: age,
        overdueDays: due && due < today ? daysBetween(due, today) : 0,
        severity,
        reason,
        amount: num(inv.netTotal),
        href: focusUrl('/accounting/billing', inv.invoiceNo),
      });
    }
    const rank = { high: 0, medium: 1, info: 2 } as const;
    arRows.sort((a, b) => rank[a.severity] - rank[b.severity] || (b.days ?? 0) - (a.days ?? 0));

    const whtOverdue = whtRows
      .map((r) => ({ r, issue: isoOf(r.issueDate) }))
      .filter(({ issue }) => daysBetween(issue, today) > WHT_OVERDUE_DAYS)
      .sort((a, b) => a.issue.localeCompare(b.issue))
      .map(({ r, issue }) => ({
        key: `wht-${r.id}`,
        kind: null,
        title: r.taxInvoiceNo,
        chassis: null,
        customerName: snapshotName(r.customerSnapshot),
        stageLabel: 'รอ 50 ทวิ',
        since: issue,
        days: daysBetween(issue, today),
        overdueDays: daysBetween(issue, today) - WHT_OVERDUE_DAYS,
        severity: 'medium' as const,
        reason: `ลูกค้าหัก ณ ที่จ่าย ${fmt(num(r.whtAmount))} บาท แต่ยังไม่ส่งหนังสือรับรอง 50 ทวิ (เกิน ${WHT_OVERDUE_DAYS} วัน)`,
        amount: num(r.whtAmount),
        href: focusUrl('/accounting/tax-invoices/wht', r.taxInvoiceNo),
      }));

    const quoteRows: WorkRow[] = [];
    for (const q of quotations) {
      const valid = isoOf(q.validUntil);
      let severity: Severity;
      let reason: string;
      let stageLabel: string;
      if (q.status === 'APPROVED') {
        if (q.kind === 'RATE' ? q.ratesAppliedAt : q._count.invoices > 0) continue;
        severity = 'medium';
        stageLabel = 'อนุมัติแล้ว';
        reason = q.kind === 'RATE' ? 'ลูกค้าอนุมัติแล้ว ยังไม่ได้ตั้งเป็นราคาลูกค้า' : 'ลูกค้าอนุมัติแล้ว ยังไม่ได้ออกใบวางบิล';
      } else if (valid < today) {
        severity = 'medium';
        stageLabel = 'หมดอายุ';
        reason = `หมดอายุ ${thaiDate(valid)} ลูกค้ายังไม่ตอบ - ทำฉบับแก้ไขหรือยกเลิก`;
      } else {
        severity = 'info';
        stageLabel = 'รอลูกค้าตอบ';
        reason = `ใช้ได้ถึง ${thaiDate(valid)} (อีก ${daysBetween(today, valid)} วัน)`;
      }
      quoteRows.push({
        key: `quote-${q.id}`,
        kind: null,
        title: q.quotationNo ?? '(ร่าง)',
        chassis: null,
        customerName: snapshotName(q.customerSnapshot),
        stageLabel,
        since: valid,
        days: null,
        overdueDays: valid < today ? daysBetween(valid, today) : 0,
        severity,
        reason,
        amount: num(q.netTotal),
        href: `/accounting/quotations/view?id=${encodeURIComponent(q.id)}`,
      });
    }
    quoteRows.sort((a, b) => rank[a.severity] - rank[b.severity]);

    return [
      this.check('ar', 'accounting', 'high', 'บิลที่ต้องตามเงิน', `บิลค้างเกิน ${AR_OVERDUE_DAYS} วัน / เลยกำหนดเครดิต / ครบกำหนดใน ${AR_DUE_SOON_DAYS} วัน - ตามก่อนที่ลูกค้าจะลืม`, arRows),
      this.check('wht-overdue', 'accounting', 'medium', 'ใบกำกับที่ยังไม่ได้ 50 ทวิ', 'ไม่มีหนังสือรับรองยื่นเครดิตภาษีไม่ได้ - ทวงลูกค้าทุกใบที่เกิน 30 วัน', whtOverdue),
      this.check('quotations', 'accounting', 'medium', 'ใบเสนอราคาที่ต้องตาม', 'อนุมัติแล้วแต่ยังไม่ออกบิล = งานทำไปแล้วแต่ยังไม่ได้เงิน · หมดอายุแล้วต้องทำฉบับแก้ไขก่อนลูกค้าส่ง PO', quoteRows),
    ];
  }
}
