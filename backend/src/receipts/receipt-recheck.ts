// ตรวจใบเสร็จซ้ำก่อนยืนยันรับใบเสร็จของงานรถเก่า (ผู้ใช้ 2026-11-19: "ใช้ AI ตรวจสอบยอดใบเสร็จทุกงาน ... สำคัญมากๆ เวลาคิดเงิน
// เอาทำตั้งแต่หน้ารับใบเสร็จของทุกอัน") - ใช้กับ สลับเลข / เปลี่ยนเลข / งานโอน / ต่อภาษี / ยกเลิกการใช้รถ / ย้ายออก / คัดแผ่นป้าย
// เทียบ 3 อย่าง จากข้อมูลที่ AI อ่านจากรูปใบเสร็จ (ReceiptImage.extraction) + ช่องข้อมูลใบเสร็จของงาน:
//   1) ยอดเงินตามใบเสร็จ (receiptAmount - AI เติมให้ หรือพนักงานกรอก) ต้องเท่ากับ Bill ที่ระบบคิดไว้ (billTotal)
//   2) เลขตัวถังที่ AI อ่านได้ต้องเป็นรถคันเดียวกับงาน (กันแนบใบเสร็จผิดคัน) - อ่านไม่ได้ = ไม่ตัดสิน
//   3) ทะเบียนที่ AI อ่านได้ต้องเป็นทะเบียนเดิมหรือทะเบียนใหม่ของงาน - อ่านไม่ได้ = ไม่ตัดสิน
//   และบอกเพิ่มเมื่อรายการในใบเสร็จรวมกันไม่เท่ายอดรวม (AI อาจอ่านผิด ให้คนดูรูปซ้ำ)
// ไม่ตรงข้อใดข้อหนึ่ง = ยืนยันรับใบเสร็จได้เมื่อใส่เหตุผล (เก็บใน AuditLog) · ยังไม่มียอดเงินตามใบเสร็จ = ยืนยันไม่ได้
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { clearlyDifferentChassis, isNearChassis, type ReceiptReading } from './receipt-extraction.js';

export type RecheckStatus = 'MATCH' | 'DIFF' | 'MISSING';

export interface ReceiptRecheck {
  amount: { status: RecheckStatus; bill: number | null; receipt: number | null; diff: number | null };
  chassis: { status: RecheckStatus; read: string | null };
  plate: { status: RecheckStatus; read: string | null };
  itemsSumMismatch: boolean;
  problems: string[]; // ข้อความภาษาไทยที่หน้าจอแสดง / ว่าง = ผ่านทุกข้อ (ยอดเงินว่างนับเป็นปัญหา)
}

export interface RecheckJob {
  billTotal: unknown; // Decimal | number | null
  receiptAmount: unknown;
  chassis: string;
  plates: Array<{ category: string | null | undefined; number: string | null | undefined }>; // ทะเบียนเดิม + ทะเบียนใหม่ (ถ้ามี)
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
const plateKey = (c: string | null | undefined, n: string | null | undefined) => `${c ?? ''}${n ?? ''}`.replace(/\s/g, '');
const baht = (n: number) => n.toLocaleString('th-TH', { maximumFractionDigits: 2 });

// แก้/เพิ่ม/ลบได้ไม่เกิน 1 ตัวอักษร
function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

// ผลที่ AI อ่านได้จากรูปใบเสร็จที่แนบ - ข้ามรูปที่อ่านไม่สำเร็จ (extraction.error) หรือยังไม่ได้อ่าน
export function readingsOf(receipts: Array<{ extraction?: unknown }>): ReceiptReading[] {
  return receipts
    .map((r) => r.extraction as { reading?: ReceiptReading } | null | undefined)
    .filter((e): e is { reading: ReceiptReading } => !!e && typeof e === 'object' && !!e.reading)
    .map((e) => e.reading);
}

export function recheckReceipt(job: RecheckJob, readings: ReceiptReading[]): ReceiptRecheck {
  const problems: string[] = [];
  const bill = num(job.billTotal);
  const receipt = num(job.receiptAmount);
  let amountStatus: RecheckStatus = 'MISSING';
  let diff: number | null = null;
  if (receipt === null) {
    problems.push('ยังไม่มียอดเงินตามใบเสร็จ - แนบรูปให้ AI อ่าน หรือกรอกยอดเองในข้อมูลใบเสร็จ');
  } else if (bill !== null) {
    diff = Math.round((receipt - bill) * 100) / 100;
    amountStatus = diff === 0 ? 'MATCH' : 'DIFF';
    if (diff !== 0) problems.push(`ยอดใบเสร็จ ${baht(receipt)} ไม่ตรงกับ Bill ที่ระบบคิด ${baht(bill)} (ต่าง ${diff > 0 ? '+' : ''}${baht(diff)} บาท)`);
  } else {
    amountStatus = 'MATCH'; // งานที่ยังไม่มี Bill (ต่อภาษีที่ยังไม่ชำระ) - ไม่มีอะไรให้เทียบ
  }

  // เลขตัวถัง: ใบไหนก็ได้ที่ตรง/ใกล้เคียง = ตรง · ทุกใบที่อ่านได้ครบต่างชัดเจน = ไม่ตรง
  const chassisReads = readings.map((r) => (r.chassis ?? '').trim()).filter(Boolean);
  const target = job.chassis.replace(/[\s-]/g, '').toUpperCase();
  let chassisStatus: RecheckStatus = 'MISSING';
  if (chassisReads.length) {
    const same = chassisReads.some((c) => c.toUpperCase() === target || isNearChassis(c, target) || !clearlyDifferentChassis(c, target));
    chassisStatus = same ? 'MATCH' : 'DIFF';
    if (!same) problems.push(`เลขตัวถังบนใบเสร็จ (${chassisReads[0]}) ไม่ตรงกับรถของงาน (${job.chassis}) - อาจแนบใบเสร็จผิดคัน`);
  }

  // ทะเบียน: ตรงกับทะเบียนเดิมหรือทะเบียนใหม่ของงาน - เลขต้องตรงเป๊ะ หมวดต่างได้ 1 ตัวอักษร
  // (ทดสอบกับใบเสร็จจริง 35 งานบน production 2026-11-19: AI อ่านหมวดไทยเพี้ยนบ่อย ฆ/พ ผ/ฝ ฎ/ญ ช/ข 4/7 - 7 จาก 8 กรณีที่ "ไม่ตรง" เป็นแบบนี้)
  const plateReads = readings.filter((r) => r.plateCategory && r.plateNumber).map((r) => ({ c: (r.plateCategory ?? '').replace(/\s/g, ''), n: (r.plateNumber ?? '').replace(/\s/g, '') }));
  const knownPlates = job.plates.filter((p) => p.category && p.number).map((p) => ({ c: (p.category ?? '').replace(/\s/g, ''), n: (p.number ?? '').replace(/\s/g, '') }));
  const known = knownPlates.map((p) => plateKey(p.c, p.n));
  let plateStatus: RecheckStatus = 'MISSING';
  if (plateReads.length && known.length) {
    const same = plateReads.some((r) => knownPlates.some((k) => k.n === r.n && editDistanceAtMostOne(k.c, r.c)));
    plateStatus = same ? 'MATCH' : 'DIFF';
    if (!same) problems.push(`ทะเบียนบนใบเสร็จ (${plateReads[0].c} ${plateReads[0].n}) ไม่ตรงกับทะเบียนของงาน (${known.join(' / ')})`);
  }

  // รายการในใบเสร็จรวมกันไม่เท่ายอดรวม = AI อาจอ่านตัวเลขผิด
  const itemsSumMismatch = readings.some((r) => {
    if (r.total === null || !r.items.length) return false;
    const sum = Math.round(r.items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
    return sum !== r.total;
  });
  if (itemsSumMismatch) problems.push('รายการในใบเสร็จรวมกันไม่เท่ายอดรวม - AI อาจอ่านตัวเลขผิด ดูรูปใบเสร็จอีกครั้ง');

  return {
    amount: { status: amountStatus, bill, receipt, diff },
    chassis: { status: chassisStatus, read: chassisReads[0] ?? null },
    plate: { status: plateStatus, read: plateReads[0] ? `${plateReads[0].c} ${plateReads[0].n}` : null },
    itemsSumMismatch,
    problems,
  };
}

// ด่านตอนยืนยันรับใบเสร็จ: ไม่มียอดเงิน = 400 เสมอ · มีจุดไม่ตรง = ต้องส่ง recheckReason (คืนเหตุผลไว้ลง AuditLog) · ผ่านหมด = null
export const RECHECK_REASON_REQUIRED = 'RECEIPT_RECHECK_REASON_REQUIRED';
export function acceptRecheck(check: ReceiptRecheck, reasonRaw: unknown): string | null {
  if (check.amount.status === 'MISSING') {
    throw new BadRequestException({ error: 'ยังไม่มียอดเงินตามใบเสร็จ - กรอกยอดในข้อมูลใบเสร็จก่อนยืนยันรับใบเสร็จ' });
  }
  if (!check.problems.length) return null;
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  if (!reason) {
    throw new BadRequestException({ error: `ตรวจใบเสร็จไม่ผ่าน: ${check.problems.join(' · ')} - ตรวจแล้วถ้าถูกต้องให้ใส่เหตุผลเพื่อยืนยัน`, code: RECHECK_REASON_REQUIRED, problems: check.problems });
  }
  if (reason.length > 500) throw new BadRequestException({ error: 'เหตุผลยาวเกิน 500 ตัวอักษร' });
  return reason;
}

// ---- โหลดงานจริง + ผลอ่านใบเสร็จ แล้วตรวจ (ใช้ทั้งตอนยืนยันรับใบเสร็จ และ GET /api/receipts/recheck ที่หน้ารับใบเสร็จเรียก) ----
export const RECHECK_JOB_TYPES = ['PLATE_SWAP', 'TRANSFER', 'USE_CANCEL', 'MOVE_OUT', 'PLATE_COPY', 'TAX_RENEWAL'] as const;
export type RecheckJobType = (typeof RECHECK_JOB_TYPES)[number];
export const isRecheckJobType = (v: unknown): v is RecheckJobType => (RECHECK_JOB_TYPES as readonly unknown[]).includes(v);

type Db = Pick<Prisma.TransactionClient, 'plateSwap' | 'vehicleTransfer' | 'vehicleUseCancellation' | 'vehicleMoveOut' | 'plateCopy' | 'taxRenewal'>;
const money = { billTotal: true, receiptAmount: true } as const;
const ex = { select: { extraction: true } } as const;

export async function recheckJobs(db: Db, type: RecheckJobType, ids: string[]): Promise<Map<string, ReceiptRecheck>> {
  const out = new Map<string, ReceiptRecheck>();
  if (!ids.length) return out;
  const where = { id: { in: ids } };
  const plain = (r: { id: string; billTotal: unknown; receiptAmount: unknown; chassis: string; plateCategory: string; plateNumber: string; receipts: { extraction: unknown }[] }) =>
    out.set(r.id, recheckReceipt({ ...r, plates: [{ category: r.plateCategory, number: r.plateNumber }] }, readingsOf(r.receipts)));
  const plateSel = { id: true, chassis: true, plateCategory: true, plateNumber: true, ...money, receipts: ex } as const;
  if (type === 'PLATE_SWAP') {
    const rows = await db.plateSwap.findMany({
      where,
      select: { id: true, ...money, oldChassis: true, oldPlateCategory: true, oldPlateNumber: true, newPlateCategory: true, newPlateNumber: true, receipts: ex },
    });
    for (const r of rows) {
      out.set(
        r.id,
        recheckReceipt(
          { billTotal: r.billTotal, receiptAmount: r.receiptAmount, chassis: r.oldChassis, plates: [{ category: r.oldPlateCategory, number: r.oldPlateNumber }, { category: r.newPlateCategory, number: r.newPlateNumber }] },
          readingsOf(r.receipts),
        ),
      );
    }
  } else if (type === 'TRANSFER') {
    const rows = await db.vehicleTransfer.findMany({ where, select: { ...plateSel, newPlateCategory: true, newPlateNumber: true } });
    for (const r of rows) {
      out.set(
        r.id,
        recheckReceipt(
          { ...r, plates: [{ category: r.plateCategory, number: r.plateNumber }, { category: r.newPlateCategory, number: r.newPlateNumber }] },
          readingsOf(r.receipts),
        ),
      );
    }
  } else if (type === 'USE_CANCEL') (await db.vehicleUseCancellation.findMany({ where, select: plateSel })).forEach(plain);
  else if (type === 'MOVE_OUT') (await db.vehicleMoveOut.findMany({ where, select: plateSel })).forEach(plain);
  else if (type === 'PLATE_COPY') (await db.plateCopy.findMany({ where, select: plateSel })).forEach(plain);
  else (await db.taxRenewal.findMany({ where, select: plateSel })).forEach(plain);
  return out;
}

// ใช้ในทุก markReturned: ตรวจ + ด่านเหตุผล - คืนข้อมูลสำหรับลง AuditLog (null = ผ่านหมด ไม่ต้องลง)
export async function recheckBeforeReturn(db: Db, type: RecheckJobType, id: string, reasonRaw: unknown): Promise<{ reason: string; problems: string[] } | null> {
  const check = (await recheckJobs(db, type, [id])).get(id);
  if (!check) return null;
  const reason = acceptRecheck(check, reasonRaw);
  return reason ? { reason, problems: check.problems } : null;
}
