import { BadRequestException, Injectable } from '@nestjs/common';
import { addDays, bangkokToday, billValueOf, dutyOfItems, round2, toDate } from '../overview/overview-calculator.js';
import { vehicleKindOf, type VehicleKind } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ภาพรวมการทำงาน (ผู้ใช้ 2026-10-08: "วันนี้มีการเคลื่อนไหวอะไรบ้าง ผมจะได้เข้าไปตรวจเช็คได้ พร้อมราคาด้วย" และขอเป็นหน้าแยกจากภาพรวมผู้บริหาร):
// รายการเหตุการณ์ของวันที่เลือก เรียงตามเวลา อ่านอย่างเดียว ADMIN เท่านั้น (มีราคา)
// เหตุการณ์ = สิ่งที่เกิดขึ้นในวันนั้นจริง ดูจากเวลาที่บันทึก (createdAt) หรือวันที่ของขั้นตอน (วันได้รับใบเสร็จ / ป้าย / เล่ม / วันรับเงิน)
// Bill / No bill / อากร ใช้ยอดที่เก็บไว้ตอนทำงาน อากรแยกจากยอดรวมเหมือนหน้าอื่น

const DAY_MS = 24 * 60 * 60 * 1000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;
const num = (d: unknown) => (d === null || d === undefined ? 0 : Number(d));
const plate = (c: string | null | undefined, n: string | null | undefined) => (c && n ? `${c} ${n}` : null);

export interface ActivityEvent {
  id: string;
  at: string; // ISO - งานที่รู้แค่วันที่ (ไม่มีเวลา) ใช้ 00:00 ของวันนั้น และ timed = false
  timed: boolean;
  type: string;
  group: 'new' | 'other' | 'billing' | 'edit';
  title: string;
  kind: VehicleKind | null; // รถยนต์ / จักรยานยนต์ - null = ไม่แยกประเภท (เอกสารการเงิน ยามาฮ่า แก้ไขทั่วไป)
  ref: string | null; // เลขตัวถัง / เลขเอกสาร
  customer: string | null;
  detail: string | null;
  bill: number | null;
  noBill: number | null;
  duty: number | null;
  amount: number | null; // ยอดเอกสารการเงิน (บิล / ใบกำกับ / ใบเสร็จ) ที่ไม่ใช่ Bill/No bill
  cancelled: boolean; // เอกสารที่ยกเลิกแล้ว: แสดงแถวไว้ แต่ไม่นับในยอดรวม
  actor: string | null;
  href: string;
}

const AUDIT_ENTITY_LABELS: Record<string, string> = {
  Customer: 'ลูกค้า',
  Invoice: 'ใบวางบิล',
  TaxInvoice: 'ใบกำกับภาษี',
  TaxRenewal: 'ต่อภาษี',
  YamahaRelocation: 'แจ้งย้ายยามาฮ่า',
  PlateSwap: 'สลับเลข',
  PlateCopy: 'คัดแผ่นป้าย',
  VehicleTransfer: 'งานโอน',
  VehicleUseCancellation: 'ยกเลิกการใช้รถ',
  VehicleMoveOut: 'ย้ายออก',
  Quotation: 'ใบเสนอราคา',
  User: 'ผู้ใช้',
  PayrollRun: 'เงินเดือน',
  Employee: 'พนักงาน',
};
const AUDIT_ACTION_LABELS: Record<string, string> = {
  update: 'แก้ไข',
  cancel: 'ยกเลิก',
  void: 'ยกเลิกบิล',
  unpay: 'ยกเลิกการรับเงิน',
  'undo-return': 'ยกเลิกการรับคืนเอกสาร',
  'set-password': 'ตั้งรหัสผ่านใหม่',
  'job-rates': 'ตั้งราคางาน',
  'set-account': 'เปลี่ยนบัญชีรับเงิน',
  issue: 'ออกเอกสาร',
};
const classKind = (vehicleClass: string): VehicleKind => (vehicleClass === 'MOTO' ? 'moto' : 'car');
// ใบส่งงานหนึ่งใบมีรถชนิดเดียว (ใบเก่าที่ผสมกัน ใช้ชนิดของรายการแรก)
const slipKind = (items: Array<{ vehicleKind: string | null; body: string | null }>): VehicleKind | null => {
  const first = items[0];
  if (!first) return null;
  return first.vehicleKind === 'moto' || first.vehicleKind === 'car' ? first.vehicleKind : vehicleKindOf(first.body);
};
const auditTitle = (entity: string, action: string) => `${AUDIT_ENTITY_LABELS[entity] ?? entity}: ${AUDIT_ACTION_LABELS[action] ?? action}`;

interface EventInput {
  id: string;
  type: string;
  group: ActivityEvent['group'];
  title: string;
  href: string;
  kind?: VehicleKind | null;
  at?: Date;
  ref?: string | null;
  customer?: string | null;
  detail?: string | null;
  bill?: number | null;
  noBill?: number | null;
  duty?: number | null;
  amount?: number | null;
  cancelled?: boolean;
  actor?: string | null;
}

interface JobRow {
  id: string;
  createdAt: Date;
  customerId: string | null;
  chassis: string;
  plateCategory: string;
  plateNumber: string;
  billTotal: unknown;
  noBillTotal: unknown;
  dutyAmount: unknown;
  vehicleClass: string;
}

@Injectable()
export class ActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async day(dateInput?: string) {
    const today = bangkokToday();
    const iso = dateInput ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso) || Number.isNaN(toDate(iso).getTime())) throw new BadRequestException('วันที่ไม่ถูกต้อง');
    const dayStart = new Date(toDate(iso).getTime() - BANGKOK_OFFSET_MS); // 00:00 เวลาไทย
    const dayEnd = new Date(dayStart.getTime() + DAY_MS);
    const range = { gte: dayStart, lt: dayEnd }; // คอลัมน์ timestamp
    const exact = toDate(iso); // คอลัมน์วันที่ล้วน (เก็บเป็น 00:00 UTC)
    const p = this.prisma;
    const userSel = { select: { name: true, displayName: true } };
    const vehicleSel = { id: true, chassis: true, customerId: true, plateCategory: true, plateNumber: true, body: true };

    const [
      newVehicles, submissions, receipts, plates, books, slips, invoices, paidInvoices, taxInvoices,
      plateSwaps, taxRenewals, yamaha, transfers, useCancels, plateCopies, moveOuts, vehicleLogs, auditLogs,
    ] = await Promise.all([
      p.vehicle.findMany({ where: { createdAt: range, deletedAt: null }, select: { ...vehicleSel, createdAt: true } }),
      p.documentSubmission.findMany({ where: { createdAt: range } }),
      p.documentSubmission.findMany({ where: { receiptReceivedDate: exact, status: 'RECEIPT_RECEIVED' } }),
      p.vehicle.findMany({ where: { plateReceivedDate: exact, deletedAt: null }, select: vehicleSel }),
      p.vehicle.findMany({ where: { bookReceivedDate: exact, deletedAt: null }, select: vehicleSel }),
      p.deliverySlip.findMany({ where: { createdAt: range, cancelledAt: null }, include: { items: { where: { cancelledAt: null }, select: { id: true, vehicleKind: true, body: true } }, createdBy: userSel } }),
      p.invoice.findMany({ where: { createdAt: range } }),
      p.invoice.findMany({ where: { paidDate: exact, status: 'PAID' } }),
      p.taxInvoice.findMany({ where: { createdAt: range } }),
      p.plateSwap.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.taxRenewal.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.yamahaRelocationEntry.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.vehicleTransfer.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.vehicleUseCancellation.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.plateCopy.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.vehicleMoveOut.findMany({ where: { createdAt: range, cancelledAt: null } }),
      p.vehicleEditLog.findMany({ where: { editedAt: range }, include: { editedBy: userSel } }),
      p.auditLog.findMany({ where: { createdAt: range }, include: { editedBy: userSel } }),
    ]);

    // รถที่เหตุการณ์อ้างถึง + ชื่อลูกค้า (ดึงครั้งเดียว)
    const refVehicleIds = new Set<string>([...submissions, ...receipts].map((s) => s.vehicleId));
    for (const l of vehicleLogs) refVehicleIds.add(l.vehicleId);
    const vehicleRows = await p.vehicle.findMany({ where: { id: { in: [...refVehicleIds] } }, select: vehicleSel });
    const vehicles = new Map(vehicleRows.map((v) => [v.id, v]));
    const customerIds = new Set<string>();
    for (const v of [...vehicleRows, ...newVehicles, ...plates, ...books]) customerIds.add(v.customerId);
    for (const x of [...slips, ...invoices, ...paidInvoices, ...taxInvoices]) customerIds.add(x.customerId);
    for (const x of [...plateSwaps, ...taxRenewals, ...transfers, ...useCancels, ...plateCopies, ...moveOuts]) if (x.customerId) customerIds.add(x.customerId);
    const customerRows = await p.customer.findMany({ where: { id: { in: [...customerIds] } }, select: { id: true, name: true } });
    const customers = new Map(customerRows.map((c) => [c.id, c.name]));
    const cname = (id: string | null | undefined) => (id ? (customers.get(id) ?? null) : null);
    const person = (u: { name: string; displayName: string | null } | null | undefined) => (u ? u.displayName || u.name : null);

    const events: ActivityEvent[] = [];
    const add = (e: EventInput) => {
      events.push({
        kind: null, ref: null, customer: null, detail: null, bill: null, noBill: null, duty: null, amount: null, cancelled: false, actor: null,
        ...e,
        at: (e.at ?? dayStart).toISOString(),
        timed: !!e.at,
      });
    };
    const money = (bill: unknown, noBill: unknown, duty: unknown) => ({ bill: round2(num(bill)), noBill: round2(num(noBill)), duty: round2(num(duty)) });
    const vehicleHref = (chassis: string) => `/vehicles?q=${encodeURIComponent(chassis)}`;

    // --- จดทะเบียนรถใหม่ ---
    for (const v of newVehicles) {
      add({ id: `veh-${v.id}`, at: v.createdAt, type: 'vehicle-entry', group: 'new', kind: vehicleKindOf(v.body), title: 'บันทึกรถใหม่เข้าระบบ', ref: v.chassis, customer: cname(v.customerId), href: vehicleHref(v.chassis) });
    }
    for (const s of submissions) {
      const v = vehicles.get(s.vehicleId);
      const duty = dutyOfItems(s.noBillItems);
      add({
        id: `sub-${s.id}`, at: s.createdAt, type: 'submit', group: 'new', kind: v ? vehicleKindOf(v.body) : null, title: 'ยื่นเอกสาร', ref: v?.chassis ?? null, customer: cname(v?.customerId),
        detail: [s.urgent ? 'งานด่วน' : null, s.status === 'FAILED' ? 'ยื่นไม่สำเร็จ' : null].filter(Boolean).join(' · ') || null,
        ...money(billValueOf(s), num(s.noBillTotal) - duty, duty),
        href: '/registration/new-vehicle/submit-documents/records',
      });
    }
    for (const s of receipts) {
      const v = vehicles.get(s.vehicleId);
      add({
        id: `rec-${s.id}`, type: 'receipt', group: 'new', kind: v ? vehicleKindOf(v.body) : null, title: 'ได้รับใบเสร็จ', ref: v?.chassis ?? null, customer: cname(v?.customerId),
        detail: s.receiptNo ? `เลขที่ ${s.receiptNo}` : null, amount: s.receiptAmount === null ? null : round2(num(s.receiptAmount)),
        href: '/registration/new-vehicle/receive-receipt',
      });
    }
    for (const v of plates) add({ id: `plate-${v.id}`, type: 'plate', group: 'new', kind: vehicleKindOf(v.body), title: 'รับป้ายทะเบียน', ref: v.chassis, customer: cname(v.customerId), detail: plate(v.plateCategory, v.plateNumber), href: '/registration/new-vehicle/receive-plate' });
    for (const v of books) add({ id: `book-${v.id}`, type: 'book', group: 'new', kind: vehicleKindOf(v.body), title: 'รับเล่มทะเบียน', ref: v.chassis, customer: cname(v.customerId), href: '/registration/new-vehicle/receive-book' });
    for (const s of slips) {
      add({
        id: `slip-${s.id}`, at: s.createdAt, type: 'delivery', group: 'new', kind: slipKind(s.items), title: 'ส่งงานให้ลูกค้า', ref: `DL-${String(s.slipNo).padStart(5, '0')}`, customer: cname(s.customerId),
        detail: `${s.items.length} คัน · ผู้รับ ${s.recipient}`, actor: person(s.createdBy), href: '/registration/new-vehicle/delivery/report',
      });
    }

    // --- งานอื่นๆ: ยอดที่เก็บไว้ตอนยื่น (อากรแยก) ---
    const jobs = (rows: JobRow[], type: string, title: string, href: string) => {
      for (const r of rows) {
        add({ id: `${type}-${r.id}`, at: r.createdAt, type, group: 'other', kind: classKind(r.vehicleClass), title, ref: r.chassis, customer: cname(r.customerId), detail: plate(r.plateCategory, r.plateNumber), ...money(r.billTotal, r.noBillTotal, r.dutyAmount), href });
      }
    };
    jobs(transfers, 'transfer', 'งานโอน', '/registration/transfer');
    jobs(useCancels, 'use-cancel', 'ยกเลิกการใช้รถ', '/registration/other/cancel-use');
    jobs(plateCopies, 'plate-copy', 'คัดแผ่นป้ายทะเบียน', '/registration/other/plate-copy');
    jobs(moveOuts, 'move-out', 'ย้ายออก', '/registration/other/move-out');
    for (const r of plateSwaps) {
      const duty = dutyOfItems(r.noBillItems);
      add({ id: `swap-${r.id}`, at: r.createdAt, type: 'plate-swap', group: 'other', kind: classKind(r.vehicleClass), title: 'สลับเลข', ref: r.oldChassis, customer: cname(r.customerId), detail: plate(r.oldPlateCategory, r.oldPlateNumber), ...money(r.billTotal, num(r.noBillTotal) - duty, duty), href: '/registration/plate-swap/old-new' });
    }
    for (const r of taxRenewals) {
      const duty = dutyOfItems(r.noBillItems);
      add({ id: `tax-${r.id}`, at: r.createdAt, type: 'tax-renewal', group: 'other', kind: r.vehicleType.startsWith('รย.12') ? 'moto' : 'car', title: 'ต่อภาษี', ref: r.chassis, customer: cname(r.customerId), detail: plate(r.plateCategory, r.plateNumber), ...money(r.billTotal, num(r.noBillTotal) - duty, duty), href: '/registration/tax-renewal' });
    }
    for (const y of yamaha) {
      add({ id: `ymh-${y.id}`, at: y.createdAt, type: 'yamaha', group: 'other', title: `แจ้งย้ายยามาฮ่า (${y.size === 'SMALL' ? 'เล็ก' : 'ใหญ่'})`, customer: 'ยามาฮ่า', detail: `${y.count} คัน`, ...money(y.billFee, y.noBillFee, 0), href: '/registration/yamaha-relocation' });
    }

    // --- การเงิน ---
    // บิล / ใบกำกับที่ยกเลิกแล้วยังแสดงเป็นแถว (ให้เห็นว่าเคยออก) แต่ไม่นับในยอดรวม: cancelled = true
    for (const i of invoices) add({ id: `inv-${i.id}`, at: i.createdAt, type: 'invoice', group: 'billing', title: i.status === 'VOID' ? 'ออกใบวางบิล (ยกเลิกแล้ว)' : 'ออกใบวางบิล', ref: i.invoiceNo, customer: cname(i.customerId), amount: round2(num(i.netTotal)), cancelled: i.status === 'VOID', href: '/accounting/billing' });
    for (const i of paidInvoices) add({ id: `paid-${i.id}`, type: 'paid', group: 'billing', title: 'รับเงินตามบิล', ref: i.invoiceNo, customer: cname(i.customerId), amount: round2(num(i.netTotal)), href: '/accounting/billing' });
    for (const t of taxInvoices) add({ id: `tv-${t.id}`, at: t.createdAt, type: 'tax-invoice', group: 'billing', title: t.status === 'CANCELLED' ? 'ใบกำกับภาษี (ยกเลิกแล้ว)' : 'ออกใบกำกับภาษี/ใบเสร็จ', ref: t.taxInvoiceNo, customer: cname(t.customerId), amount: round2(num(t.grandTotal)), cancelled: t.status === 'CANCELLED', href: '/accounting/tax-invoices' });

    // --- การแก้ไข / ยกเลิก (มีผู้ทำและเหตุผล) ---
    for (const l of vehicleLogs) {
      const v = vehicles.get(l.vehicleId);
      add({ id: `vlog-${l.id}`, at: l.editedAt, type: 'vehicle-edit', group: 'edit', kind: v ? vehicleKindOf(v.body) : null, title: 'แก้ไข/ยกเลิกข้อมูลรถ', ref: v?.chassis ?? null, customer: cname(v?.customerId), detail: l.remark, actor: person(l.editedBy), href: v ? vehicleHref(v.chassis) : '/vehicles' });
    }
    for (const l of auditLogs) {
      add({ id: `alog-${l.id}`, at: l.createdAt, type: 'audit', group: 'edit', title: auditTitle(l.entity, l.action), detail: l.remark, actor: person(l.editedBy), href: '/' });
    }

    events.sort((a, b) => (a.timed === b.timed ? a.at.localeCompare(b.at) : a.timed ? -1 : 1));

    const sum = (key: 'bill' | 'noBill' | 'duty' | 'amount', type?: string) =>
      round2(events.filter((e) => !e.cancelled && (!type || e.type === type)).reduce((a, e) => a + (e[key] ?? 0), 0));
    const counts: Record<string, number> = {};
    for (const e of events) counts[e.type] = (counts[e.type] ?? 0) + 1;

    const kinds = { car: events.filter((e) => e.kind === 'car').length, moto: events.filter((e) => e.kind === 'moto').length };

    return {
      date: iso,
      today,
      prev: addDays(iso, -1),
      next: iso >= today ? null : addDays(iso, 1),
      events,
      counts,
      kinds,
      totals: {
        bill: sum('bill'),
        noBill: sum('noBill'),
        duty: sum('duty'),
        spend: round2(sum('bill') + sum('noBill')),
        invoiced: sum('amount', 'invoice'),
        collected: sum('amount', 'paid'),
      },
    };
  }
}
