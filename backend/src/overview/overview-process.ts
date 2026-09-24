// งานแต่ละขั้นตอนของหน้าภาพรวมผู้บริหาร (ผู้ใช้ขอ 2026-09-24): แยกรถยนต์/จักรยานยนต์ ว่าวันนี้แต่ละขั้นทำไปกี่คัน
// ค้างกี่คัน และ "คันไหนติดขัด" พร้อมสาเหตุ - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล (OverviewService ดึงข้อมูลมาให้)
//
// รถหนึ่งคันอยู่ได้หลายคิวพร้อมกันหลังได้ใบเสร็จ (รอป้าย + รอเล่ม, ส่งงานแล้วแต่ยังไม่วางบิล) จึงคืนเป็นรายการ "รอ" หลายรายการ
// เงื่อนไขของแต่ละคิวตรงกับหน้างานจริง: vehicles.service.ts (ขั้น 2-3), submission-eligibility.ts (ขั้น 4),
// receiving.service.ts / delivery.service.ts (ขั้น 5-8), billing.service.ts (วางบิล)

import { vehicleKindOf, type VehicleKind } from '../auth/vehicle-scope.js';
import { INSPECTION_VALID_DAYS } from '../document-submission/submission-eligibility.js';
import { addDays, daysBetween, isoOf } from './overview-calculator.js';

export type { VehicleKind };
export { vehicleKindOf };

// กำหนดเวลาของแต่ละขั้น (วัน) ค้างเกินนี้ = ติดขัด - ค่าตั้งต้นของ Claude รอผู้ใช้กำหนด
export const STAGES = {
  transfer: { label: 'แจ้งย้าย/ตัดบัญชี', href: '/registration/new-vehicle/transfer-notice', sla: 3 },
  inspectSend: { label: 'ส่งตรวจรถ', href: '/registration/new-vehicle/inspection', sla: 3 },
  inspectResult: { label: 'ผลตรวจรถ', href: '/registration/new-vehicle/inspection', sla: 7 },
  submit: { label: 'ยื่นเอกสารจดทะเบียน', href: '/registration/new-vehicle/submit-documents', sla: 3 },
  receipt: { label: 'รับใบเสร็จ', href: '/registration/new-vehicle/receive-receipt', sla: 7 },
  plate: { label: 'รับป้ายทะเบียน', href: '/registration/new-vehicle/receive-plate', sla: 7 },
  book: { label: 'รับเล่มทะเบียน', href: '/registration/new-vehicle/receive-book', sla: 7 },
  delivery: { label: 'ส่งงานลูกค้า (Delivery)', href: '/registration/new-vehicle/delivery', sla: 3 },
  plateDelivery: { label: 'ส่งป้ายตามหลัง', href: '/registration/new-vehicle/delivery', sla: 3 },
  billing: { label: 'วางบิล', href: '/accounting/billing', sla: 7 },
  plateSwap: { label: 'สลับเลข (รอรับเอกสารกลับ)', href: '/registration/plate-swap/old-new', sla: 14 },
  taxRenewal: { label: 'ต่อภาษี (รอชำระ)', href: '/registration/tax-renewal', sla: 7 },
} as const;
export type StageKey = keyof typeof STAGES;

export const INSPECTION_WARN_DAYS = 14; // เตือนผลตรวจที่จะหมดอายุภายในกี่วัน

// ปัญหาที่ต้องมีคนดู แม้ยังไม่เกินกำหนดเวลาของขั้นนั้น
export type Flag =
  | 'INSPECTION_FAILED' // ตรวจไม่ผ่าน รอส่งตรวจใหม่
  | 'INSPECTION_EXPIRED' // ผลตรวจครบ 90 วันแล้วยังไม่ยื่น ต้องตรวจรอบ 2
  | 'INSPECTION_EXPIRING' // ผลตรวจจะหมดอายุใน INSPECTION_WARN_DAYS วัน
  | 'SUBMISSION_FAILED' // ยื่นไม่สำเร็จ ยังไม่ได้ยื่นใหม่
  | 'RECEIPT_UNKNOWN' // ตรวจใบยื่นแล้วยังไม่ได้ใบเสร็จ ไม่ทราบสาเหตุ (ค้างจากใบก่อน)
  | 'PLATE_SWAP_PENDING'; // รอเอกสารงานสลับเลขกลับก่อนจึงยื่นได้

export interface Wait {
  stage: StageKey;
  since: string; // วันที่เข้าคิวนี้ (ค.ศ. YYYY-MM-DD)
  flags: Flag[];
  reason: string | null; // ข้อความสาเหตุที่แสดงให้ผู้บริหาร
}

export interface OpenVehicle {
  id: string;
  date: Date;
  body: string | null;
  transferDone: boolean;
  transferCompletedDate: Date | null;
  inspectionSentDate: Date | null;
  inspectionResult: string | null;
  inspectionResultDate: Date | null;
  inspectionFailRemark: string | null;
  plateReceivedDate: Date | null;
  bookReceivedDate: Date | null;
  deliveredDate: Date | null;
  plateDeliveredDate: Date | null;
  latestSubmission: {
    status: string;
    submitDate: Date;
    receiptReceivedDate: Date | null;
    failRemark: string | null;
    receiptCarriedAt: Date | null;
  } | null;
  hasPendingPlateSwap: boolean;
  billed: boolean; // อยู่ในบิลที่ยังไม่ถูกยกเลิกแล้ว
}

const iso = (d: Date) => isoOf(d);
const later = (a: Date, b: Date) => (a > b ? a : b);

function wait(stage: StageKey, since: string, flags: Flag[] = [], reasons: Array<string | null> = []): Wait {
  const text = reasons.filter(Boolean).join(' · ');
  return { stage, since, flags, reason: text || null };
}

export function waitsFor(v: OpenVehicle, today: string): Wait[] {
  const sub = v.latestSubmission;
  const waits: Wait[] = [];

  if (sub?.status === 'PENDING') {
    const unknown = sub.receiptCarriedAt !== null;
    waits.push(wait('receipt', iso(sub.submitDate), unknown ? ['RECEIPT_UNKNOWN'] : [], [unknown ? 'ตรวจใบยื่นแล้วยังไม่ได้ใบเสร็จ ยังไม่ทราบสาเหตุ' : null]));
  } else if (sub?.status === 'RECEIPT_RECEIVED') {
    const receiptDate = iso(sub.receiptReceivedDate ?? sub.submitDate);
    if (!v.plateReceivedDate) waits.push(wait('plate', receiptDate));
    if (!v.bookReceivedDate) waits.push(wait('book', receiptDate));
    // ส่งงานได้เมื่อได้ใบเสร็จ + รับเล่มแล้ว (ป้ายส่งตามทีหลังได้) - ดู delivery.service.ts
    if (!v.deliveredDate && v.bookReceivedDate) waits.push(wait('delivery', iso(v.bookReceivedDate)));
    if (v.deliveredDate && v.plateReceivedDate && !v.plateDeliveredDate) {
      waits.push(wait('plateDelivery', iso(later(v.plateReceivedDate, v.deliveredDate))));
    }
  } else if (!v.deliveredDate) {
    waits.push(...beforeSubmission(v, today));
  }

  if (v.deliveredDate && !v.billed) waits.push(wait('billing', iso(v.deliveredDate)));
  return waits;
}

// ยังไม่ได้ยื่น หรือยื่นไม่สำเร็จ (FAILED) - ขั้น 2 -> 4 ตามลำดับ
function beforeSubmission(v: OpenVehicle, today: string): Wait[] {
  const failed = v.latestSubmission?.status === 'FAILED';
  const failFlags: Flag[] = failed ? ['SUBMISSION_FAILED'] : [];
  const failReason = failed ? `ยื่นไม่สำเร็จ${v.latestSubmission?.failRemark ? `: ${v.latestSubmission.failRemark}` : ''}` : null;

  if (!v.transferDone) return [wait('transfer', iso(v.date))];
  if (!v.inspectionSentDate) return [wait('inspectSend', iso(v.transferCompletedDate ?? v.date), failFlags, [failReason])];
  if (!v.inspectionResultDate) return [wait('inspectResult', iso(v.inspectionSentDate), failFlags, [failReason])];

  const resultDate = iso(v.inspectionResultDate);
  if (v.inspectionResult === 'ไม่ผ่าน') {
    const remark = v.inspectionFailRemark ? `: ${v.inspectionFailRemark}` : '';
    return [wait('inspectSend', resultDate, ['INSPECTION_FAILED', ...failFlags], [`ตรวจไม่ผ่าน${remark} - รอส่งตรวจใหม่`, failReason])];
  }
  const age = daysBetween(resultDate, today);
  if (age >= INSPECTION_VALID_DAYS) {
    return [
      wait('inspectSend', addDays(resultDate, INSPECTION_VALID_DAYS), ['INSPECTION_EXPIRED', ...failFlags], [
        `ผลตรวจหมดอายุ (ครบ ${INSPECTION_VALID_DAYS} วัน) ต้องตรวจรอบ 2`,
        failReason,
      ]),
    ];
  }

  const left = INSPECTION_VALID_DAYS - age;
  const flags: Flag[] = [...failFlags];
  const reasons: Array<string | null> = [failReason];
  if (v.hasPendingPlateSwap) {
    flags.push('PLATE_SWAP_PENDING');
    reasons.push('รอรับเอกสารงานสลับเลขกลับก่อนจึงยื่นได้');
  }
  if (left <= INSPECTION_WARN_DAYS) {
    flags.push('INSPECTION_EXPIRING');
    reasons.push(`ผลตรวจจะหมดอายุใน ${left} วัน`);
  }
  return [wait('submit', resultDate, flags, reasons)];
}

// --- สรุปงานค้าง -------------------------------------------------------------------

export interface KindCount {
  car: number;
  moto: number;
}

export interface Backlog {
  pending: KindCount;
  oldestDays: number | null;
  lateCount: number;
}

export interface BacklogItem {
  stage: StageKey;
  kind: VehicleKind;
  since: string;
}

export function summarizeBacklog(items: BacklogItem[], today: string): Record<StageKey, Backlog> {
  const out = Object.fromEntries(
    (Object.keys(STAGES) as StageKey[]).map((k) => [k, { pending: { car: 0, moto: 0 }, oldestDays: null, lateCount: 0 } as Backlog]),
  ) as Record<StageKey, Backlog>;
  for (const item of items) {
    const b = out[item.stage];
    const days = Math.max(0, daysBetween(item.since, today));
    b.pending[item.kind] += 1;
    b.oldestDays = Math.max(b.oldestDays ?? 0, days);
    if (days > STAGES[item.stage].sla) b.lateCount += 1;
  }
  return out;
}

// --- คันที่ติดขัด ------------------------------------------------------------------

export interface StuckSubject {
  id: string;
  source: 'vehicle' | 'plateSwap' | 'taxRenewal';
  kind: VehicleKind;
  customerName: string;
  brandName: string | null;
  chassis: string;
  plate: string | null;
}

export interface StuckItem extends StuckSubject {
  stage: StageKey;
  stageLabel: string;
  href: string;
  since: string;
  days: number;
  overdueDays: number; // เกินกำหนดกี่วัน (0 = ยังไม่เกิน แต่มีปัญหาที่ต้องดู)
  severity: 'high' | 'medium';
  reason: string;
  flags: Flag[];
}

// ปัญหาเหล่านี้เสียเงิน/เสียเวลาถ้าปล่อยไว้ จึงเป็น "ด่วน" แม้ยังไม่เกินกำหนด
const HIGH_FLAGS: Flag[] = ['INSPECTION_EXPIRING', 'INSPECTION_EXPIRED', 'SUBMISSION_FAILED', 'INSPECTION_FAILED'];

// หนึ่งคันแสดงแถวเดียว: เลือกรายการรอที่หนักที่สุด (มีปัญหาด่วน > เกินกำหนดนานสุด)
export function stuckItemFor(subject: StuckSubject, waits: Wait[], today: string): StuckItem | null {
  let best: StuckItem | null = null;
  for (const w of waits) {
    const stage = STAGES[w.stage];
    const days = Math.max(0, daysBetween(w.since, today));
    const overdueDays = Math.max(0, days - stage.sla);
    if (overdueDays === 0 && w.flags.length === 0) continue;
    const severity = w.flags.some((f) => HIGH_FLAGS.includes(f)) ? 'high' : 'medium';
    const reason = w.reason ?? `ค้างที่ขั้น${stage.label}เกินกำหนด ${stage.sla} วัน`;
    const item: StuckItem = { ...subject, stage: w.stage, stageLabel: stage.label, href: stage.href, since: w.since, days, overdueDays, severity, reason, flags: w.flags };
    if (!best || rank(item) > rank(best)) best = item;
  }
  return best;
}

const rank = (i: StuckItem) => (i.severity === 'high' ? 100_000 : 0) + i.overdueDays * 100 + i.days;

export function sortStuck(items: StuckItem[]): StuckItem[] {
  return [...items].sort((a, b) => rank(b) - rank(a));
}
