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
import { PLATE_COPY_REQUEST_FEE } from '../plate-copy/plate-copy-fee.js';
import { calculateTransferFees, calculateTransferMoveInFees } from '../vehicle-transfer/vehicle-transfer-fee.js';
import { clearlyDifferentChassis, isNearChassis, type ReceiptReading } from './receipt-extraction.js';

export type RecheckStatus = 'MATCH' | 'DIFF' | 'MISSING';

export interface ReceiptRecheck {
  amount: { status: RecheckStatus; bill: number | null; receipt: number | null; diff: number | null };
  chassis: { status: RecheckStatus; read: string | null };
  plate: { status: RecheckStatus; read: string | null };
  itemsSumMismatch: boolean;
  // ข้อ 6 (ผู้ใช้ 2026-11-19): เทียบรายการบนใบเสร็จกับรายการ Bill ที่ระบบคิด - ทีละยอดเงิน (ชื่อรายการแต่ละสำนักงานเขียนไม่เหมือนกัน)
  items: { extra: Array<{ label: string; amount: number }>; missing: Array<{ label: string; amount: number }> } | null;
  duplicates: string[]; // ข้อ 4: งานอื่นที่ใช้เลขที่ใบเสร็จเดียวกัน
  problems: string[]; // ข้อความภาษาไทยที่หน้าจอแสดง / ว่าง = ผ่านทุกข้อ (ยอดเงินว่างนับเป็นปัญหา) - ไม่ผ่าน = ยืนยันต้องมีเหตุผล
  warnings: string[]; // ข้อ 1-2: ควรดูรูปซ้ำ แต่ไม่ขวางการยืนยัน (AI ไม่แน่ใจ / เลขที่ใบเสร็จผิดรูปแบบ / รายการต่างแต่ยอดตรง)
}

export interface RecheckJob {
  billTotal: unknown; // Decimal | number | null
  receiptAmount: unknown;
  chassis: string;
  plates: Array<{ category: string | null | undefined; number: string | null | undefined }>; // ทะเบียนเดิม + ทะเบียนใหม่ (ถ้ามี)
  receiptNo?: string | null; // เลขที่ใบเสร็จที่งานเก็บไว้ (AI เติม / พนักงานกรอก)
  expectedItems?: Array<{ label: string; amount: number }> | null; // รายการ Bill ที่ระบบคิด - null = งานนี้ไม่มีรายการให้เทียบ
  useRequest?: boolean | null; // งานโอน: ยื่นเป็นโอนขอใช้ไหม (ใบเสร็จมีรายการขอใช้ = บอกว่าเลือกประเภทผิด)
}

// ชื่อช่องที่ AI บอกว่าไม่แน่ใจ (ReceiptReading.uncertainFields) เป็นภาษาไทย
const FIELD_LABEL: Record<string, string> = {
  receiptNo: 'เลขที่ใบเสร็จ',
  date: 'วันที่',
  plate: 'ทะเบียน',
  chassis: 'เลขตัวถัง',
  cc: 'CC',
  weightKg: 'น้ำหนัก',
  items: 'รายการ',
  total: 'ยอดรวม',
};
// เลขที่ใบเสร็จกรมการขนส่ง เช่น 69/0001234 (รูปแบบเดียวกับ checkReading ของ Step 5)
export const RECEIPT_NO_PATTERN = /^\d+\/\d+$/;
const USE_REQUEST_LINE = /ขอใช้|ต่างภูมิลำเนา/;

// รายการที่ต่างกันระหว่างใบเสร็จกับ Bill - จับคู่ทีละยอดเงิน (ยอดเท่ากันคือรายการเดียวกัน แม้ชื่อเขียนต่าง)
function diffItems(read: Array<{ label: string; amount: number }>, expected: Array<{ label: string; amount: number }>) {
  const left = expected.filter((e) => e.amount > 0).map((e) => ({ ...e }));
  const extra: Array<{ label: string; amount: number }> = [];
  for (const it of read.filter((r) => r.amount > 0)) {
    const i = left.findIndex((e) => Math.round(e.amount * 100) === Math.round(it.amount * 100));
    if (i >= 0) left.splice(i, 1);
    else extra.push({ label: it.label, amount: it.amount });
  }
  return { extra, missing: left };
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

  const warnings: string[] = [];
  // ข้อ 1: ช่องที่ AI บอกว่าไม่แน่ใจ
  // เฉพาะช่องที่มีผลกับเงิน / ตัวงาน: CC น้ำหนัก ไม่นับ · ตัวถัง / ทะเบียนที่ตรวจแล้วว่าตรงกับงาน ไม่นับ
  // (ทดสอบกับ production 2026-11-19: AI ติด "ไม่แน่ใจเลขตัวถัง" แทบทุกใบ ทั้งที่ตรงกับงาน - เตือนแบบนั้นไม่มีประโยชน์)
  const skipUncertain = new Set(['cc', 'weightKg', ...(chassisStatus === 'MATCH' ? ['chassis'] : []), ...(plateStatus === 'MATCH' ? ['plate'] : [])]);
  const uncertain = [...new Set(readings.flatMap((r) => r.uncertainFields ?? []))].filter((f) => !skipUncertain.has(f)).map((f) => FIELD_LABEL[f] ?? f);
  if (uncertain.length) warnings.push(`AI ไม่แน่ใจ: ${uncertain.join(', ')} - ดูรูปใบเสร็จเทียบช่องเหล่านี้อีกครั้ง`);
  // ข้อ 2: เลขที่ใบเสร็จผิดรูปแบบ (ทั้งที่งานเก็บไว้ และที่ AI อ่าน)
  const receiptNo = (job.receiptNo ?? '').trim();
  if (!receiptNo) warnings.push('ยังไม่มีเลขที่ใบเสร็จ');
  else if (!RECEIPT_NO_PATTERN.test(receiptNo)) warnings.push(`เลขที่ใบเสร็จ "${receiptNo}" ผิดรูปแบบ (ปกติเป็น ปี/เลข เช่น 69/0001234) - AI อาจอ่านเพี้ยน`);

  // ข้อ 6: เทียบรายการทีละบรรทัด - ใช้ใบที่มีรายการ (ใบแรกที่อ่านได้)
  const withItems = readings.find((r) => r.items.length);
  let items: ReceiptRecheck['items'] = null;
  if (withItems && job.expectedItems?.length) {
    items = diffItems(withItems.items, job.expectedItems);
    const parts = [
      items.extra.length ? `ใบเสร็จมี ${items.extra.map((i) => `${i.label} ${baht(i.amount)}`).join(', ')} แต่ Bill ไม่มี` : '',
      items.missing.length ? `Bill มี ${items.missing.map((i) => `${i.label} ${baht(i.amount)}`).join(', ')} แต่ใบเสร็จไม่มี` : '',
    ].filter(Boolean);
    if (parts.length) {
      const text = `รายการไม่ตรงกัน: ${parts.join(' · ')}`;
      // ยอดไม่ตรง = อธิบายสาเหตุในปัญหา / ยอดตรงแต่รายการต่าง (เช่น รวมกันพอดี) = เตือนเฉยๆ
      if (amountStatus === 'DIFF') problems.push(text);
      else warnings.push(text);
    }
  }
  // งานโอน: เลือกประเภทผิด (เคสจริง production 2026-11-19: ยื่นโอนปกติ 105 แต่ใบเสร็จเป็นโอนขอใช้ 130)
  if (job.useRequest !== undefined && job.useRequest !== null && withItems) {
    const hasUseRequestLine = withItems.items.some((it) => USE_REQUEST_LINE.test(it.label));
    if (hasUseRequestLine && !job.useRequest) problems.push('ใบเสร็จเป็นโอนขอใช้ แต่งานยื่นเป็นโอนปกติ - แก้ประเภทโอนในหน้างานโอน (Bill และค่าอากรจะคิดใหม่)');
    if (!hasUseRequestLine && job.useRequest && withItems.items.length > 1) warnings.push('งานยื่นเป็นโอนขอใช้ แต่ใบเสร็จไม่มีรายการขอใช้ - ตรวจประเภทโอนอีกครั้ง');
  }

  return {
    amount: { status: amountStatus, bill, receipt, diff },
    chassis: { status: chassisStatus, read: chassisReads[0] ?? null },
    plate: { status: plateStatus, read: plateReads[0] ? `${plateReads[0].c} ${plateReads[0].n}` : null },
    itemsSumMismatch,
    items,
    duplicates: [],
    problems,
    warnings,
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

type Db = Pick<Prisma.TransactionClient, 'plateSwap' | 'vehicleTransfer' | 'vehicleUseCancellation' | 'vehicleMoveOut' | 'plateCopy' | 'taxRenewal' | 'documentSubmission'>;
const money = { billTotal: true, receiptAmount: true, receiptNo: true } as const;
const ex = { select: { extraction: true } } as const;
type Item = { label: string; amount: number };
const itemsOf = (raw: unknown): Item[] | null =>
  Array.isArray(raw) ? (raw as Item[]).filter((i) => i && typeof i.amount === 'number').map((i) => ({ label: String(i.label), amount: i.amount })) : null;

const JOB_NAME: Record<RecheckJobType, string> = {
  PLATE_SWAP: 'สลับเลข / เปลี่ยนเลข',
  TRANSFER: 'งานโอน',
  USE_CANCEL: 'ยกเลิกการใช้รถ',
  MOVE_OUT: 'ย้ายออก',
  PLATE_COPY: 'คัดแผ่นป้าย',
  TAX_RENEWAL: 'ต่อภาษี',
};

// ข้อ 4 (ผู้ใช้ 2026-11-19): เลขที่ใบเสร็จเดียวกันถูกใช้กับงานอื่น (งานรถเก่าทุกตาราง + ใบยื่นงานจดทะเบียนรถใหม่) = อาจแนบผิดงาน / คิดเงินซ้ำ
async function duplicateReceiptNos(db: Db, own: Array<{ type: RecheckJobType; id: string; receiptNo: string }>): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const nos = [...new Set(own.map((o) => o.receiptNo).filter((n) => RECEIPT_NO_PATTERN.test(n)))];
  if (!nos.length) return out;
  const where = { receiptNo: { in: nos }, cancelledAt: null };
  const plateOf = (c: string | null, n: string | null) => [c, n].filter(Boolean).join(' ');
  const [swaps, transfers, cancels, moveOuts, copies, taxes, subs] = await Promise.all([
    db.plateSwap.findMany({ where, select: { id: true, receiptNo: true, oldPlateCategory: true, oldPlateNumber: true } }),
    db.vehicleTransfer.findMany({ where, select: { id: true, receiptNo: true, plateCategory: true, plateNumber: true, transferType: true } }),
    db.vehicleUseCancellation.findMany({ where, select: { id: true, receiptNo: true, plateCategory: true, plateNumber: true } }),
    db.vehicleMoveOut.findMany({ where, select: { id: true, receiptNo: true, plateCategory: true, plateNumber: true } }),
    db.plateCopy.findMany({ where, select: { id: true, receiptNo: true, plateCategory: true, plateNumber: true } }),
    db.taxRenewal.findMany({ where, select: { id: true, receiptNo: true, plateCategory: true, plateNumber: true } }),
    db.documentSubmission.findMany({ where: { receiptNo: { in: nos }, status: { in: ['PENDING', 'RECEIPT_RECEIVED'] } }, select: { id: true, receiptNo: true, vehicle: { select: { chassis: true } } } }),
  ]);
  const found: Array<{ type: string; id: string; receiptNo: string | null; label: string; office?: 'OUT' | 'IN' }> = [
    ...swaps.map((r) => ({ type: 'PLATE_SWAP', id: r.id, receiptNo: r.receiptNo, label: `${JOB_NAME.PLATE_SWAP} ${plateOf(r.oldPlateCategory, r.oldPlateNumber)}` })),
    ...transfers.map((r) => ({ type: 'TRANSFER', id: r.id, receiptNo: r.receiptNo, label: `${JOB_NAME.TRANSFER} ${plateOf(r.plateCategory, r.plateNumber)}` })),
    ...cancels.map((r) => ({ type: 'USE_CANCEL', id: r.id, receiptNo: r.receiptNo, label: `${JOB_NAME.USE_CANCEL} ${plateOf(r.plateCategory, r.plateNumber)}` })),
    ...moveOuts.map((r) => ({ type: 'MOVE_OUT', id: r.id, receiptNo: r.receiptNo, label: `${JOB_NAME.MOVE_OUT} ${plateOf(r.plateCategory, r.plateNumber)}` })),
    ...copies.map((r) => ({ type: 'PLATE_COPY', id: r.id, receiptNo: r.receiptNo, label: `${JOB_NAME.PLATE_COPY} ${plateOf(r.plateCategory, r.plateNumber)}` })),
    ...taxes.map((r) => ({ type: 'TAX_RENEWAL', id: r.id, receiptNo: r.receiptNo, label: `${JOB_NAME.TAX_RENEWAL} ${plateOf(r.plateCategory, r.plateNumber)}` })),
    ...subs.map((r) => ({ type: 'NEW', id: r.id, receiptNo: r.receiptNo, label: `จดทะเบียนรถใหม่ ตัวถัง ${r.vehicle.chassis}` })),
  ];
  // เลขที่ใบเสร็จรันแยกต่อสำนักงานขนส่ง: ย้ายออก (สำนักงานจังหวัดเดิม) กับโอนย้ายเข้า (สำนักงานจังหวัดใหม่) ซ้ำเลขกันได้โดยไม่ผิด
  // (production 2026-11-19: ย้ายออก 6 คันกับโอนย้ายเข้า 6 คันใช้เลข 70/0000296-301 ไขว้กัน - คนละสำนักงาน) จึงไม่นับคู่นี้
  const moveInIds = own.length && own[0].type === 'TRANSFER' ? await moveInTransferIds(db, own.map((o) => o.id)) : new Set<string>();
  const moveInFound = new Set(transfers.filter((t) => t.transferType === 'MOVE_IN').map((t) => t.id));
  for (const o of own) {
    const otherOffice = (f: { type: string; id: string }) =>
      (o.type === 'MOVE_OUT' && f.type === 'TRANSFER' && moveInFound.has(f.id)) || (o.type === 'TRANSFER' && moveInIds.has(o.id) && f.type === 'MOVE_OUT');
    const others = found.filter((f) => f.receiptNo === o.receiptNo && !(f.type === o.type && f.id === o.id) && !otherOffice(f)).map((f) => f.label);
    if (others.length) out.set(o.id, others);
  }
  return out;
}

async function moveInTransferIds(db: Db, ids: string[]): Promise<Set<string>> {
  const rows = await db.vehicleTransfer.findMany({ where: { id: { in: ids }, transferType: 'MOVE_IN' }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

export async function recheckJobs(db: Db, type: RecheckJobType, ids: string[]): Promise<Map<string, ReceiptRecheck>> {
  const out = new Map<string, ReceiptRecheck>();
  if (!ids.length) return out;
  const where = { id: { in: ids } };
  const receiptNos: Array<{ type: RecheckJobType; id: string; receiptNo: string }> = [];
  const put = (id: string, job: RecheckJob, receipts: { extraction: unknown }[]) => {
    out.set(id, recheckReceipt(job, readingsOf(receipts)));
    if (job.receiptNo) receiptNos.push({ type, id, receiptNo: job.receiptNo.trim() });
  };
  const plateSel = { id: true, chassis: true, plateCategory: true, plateNumber: true, ...money, receipts: ex } as const;
  const base = (r: { billTotal: unknown; receiptAmount: unknown; receiptNo: string | null; chassis: string; plateCategory: string; plateNumber: string }) => ({
    billTotal: r.billTotal,
    receiptAmount: r.receiptAmount,
    receiptNo: r.receiptNo,
    chassis: r.chassis,
    plates: [{ category: r.plateCategory, number: r.plateNumber }],
  });
  if (type === 'PLATE_SWAP') {
    const rows = await db.plateSwap.findMany({
      where,
      select: { id: true, ...money, billItems: true, oldChassis: true, oldPlateCategory: true, oldPlateNumber: true, newPlateCategory: true, newPlateNumber: true, receipts: ex },
    });
    for (const r of rows) {
      put(
        r.id,
        {
          billTotal: r.billTotal,
          receiptAmount: r.receiptAmount,
          receiptNo: r.receiptNo,
          chassis: r.oldChassis,
          plates: [{ category: r.oldPlateCategory, number: r.oldPlateNumber }, { category: r.newPlateCategory, number: r.newPlateNumber }],
          expectedItems: itemsOf(r.billItems),
        },
        r.receipts,
      );
    }
  } else if (type === 'TRANSFER') {
    const rows = await db.vehicleTransfer.findMany({
      where,
      select: { ...plateSel, newPlateCategory: true, newPlateNumber: true, vehicleClass: true, transferType: true, useRequest: true, urgent: true, fineAmount: true, stampDutyAmount: true },
    });
    for (const r of rows) {
      // งานโอนไม่เก็บรายการ Bill - สร้างใหม่จากตัวเลือกของงาน (สูตรเดียวกับตอนยื่น) ไว้เทียบทีละบรรทัด
      const cls = r.vehicleClass === 'MOTO' ? 'MOTO' : 'CAR';
      const opts = { urgent: r.urgent, fine: Number(r.fineAmount ?? 0), stampDuty: Number(r.stampDutyAmount ?? 0) };
      const fees =
        r.transferType === 'MOVE_IN'
          ? calculateTransferMoveInFees({ vehicleClass: cls, ...opts })
          : calculateTransferFees(cls, { ...opts, useRequest: r.useRequest });
      put(
        r.id,
        {
          ...base(r),
          plates: [{ category: r.plateCategory, number: r.plateNumber }, { category: r.newPlateCategory, number: r.newPlateNumber }],
          expectedItems: fees.billItems,
          useRequest: r.transferType === 'MOVE_IN' ? null : r.useRequest,
        },
        r.receipts,
      );
    }
  } else if (type === 'PLATE_COPY') {
    // คัดแผ่นป้าย: Bill = ค่าคำขอ 5 + ค่าแผ่นป้าย (ส่วนที่เหลือของ Bill)
    for (const r of await db.plateCopy.findMany({ where, select: plateSel })) {
      const bill = Number(r.billTotal);
      put(r.id, { ...base(r), expectedItems: bill > PLATE_COPY_REQUEST_FEE ? [{ label: 'คำขอ', amount: PLATE_COPY_REQUEST_FEE }, { label: 'ค่าแผ่นป้าย', amount: bill - PLATE_COPY_REQUEST_FEE }] : null }, r.receipts);
    }
  } else if (type === 'TAX_RENEWAL') {
    for (const r of await db.taxRenewal.findMany({ where, select: { ...plateSel, billItems: true } })) {
      const items = itemsOf(r.billItems);
      // รถ ขส. ที่ใช้ยอดตามใบเสร็จ: บรรทัดเดียวที่มาจากใบเสร็จเอง - ไม่มีอะไรให้เทียบ
      put(r.id, { ...base(r), expectedItems: items && items.length > 1 ? items : null }, r.receipts);
    }
  } else {
    // ยกเลิกการใช้รถ / ย้ายออก: ระบบเก็บแค่ยอดรวม ไม่มีรายการให้เทียบ (ยอดรวมยังตรวจตามปกติ)
    const rows = type === 'USE_CANCEL' ? await db.vehicleUseCancellation.findMany({ where, select: plateSel }) : await db.vehicleMoveOut.findMany({ where, select: plateSel });
    for (const r of rows) put(r.id, base(r), r.receipts);
  }
  // ข้อ 4: เลขที่ใบเสร็จซ้ำกับงานอื่น = ปัญหา (ต้องมีเหตุผลถึงยืนยันได้)
  const dup = await duplicateReceiptNos(db, receiptNos);
  for (const [id, others] of dup) {
    const check = out.get(id);
    if (!check) continue;
    check.duplicates = others;
    // เตือน ไม่ขวาง: เลขรันแยกต่อสำนักงาน งานคนละจังหวัดอาจได้เลขเดียวกันจริง (ระบบไม่รู้ว่าใบเสร็จออกจากสำนักงานไหน)
    check.warnings.push(`เลขที่ใบเสร็จซ้ำกับงานอื่น: ${others.join(', ')} - ถ้าเป็นสำนักงานเดียวกัน อาจแนบใบเสร็จผิดงานหรือคิดเงินซ้ำ`);
  }
  return out;
}

// ใช้ในทุก markReturned: ตรวจ + ด่านเหตุผล - คืนข้อมูลสำหรับลง AuditLog (null = ผ่านหมด ไม่ต้องลง)
export async function recheckBeforeReturn(db: Db, type: RecheckJobType, id: string, reasonRaw: unknown): Promise<{ reason: string; problems: string[] } | null> {
  const check = (await recheckJobs(db, type, [id])).get(id);
  if (!check) return null;
  const reason = acceptRecheck(check, reasonRaw);
  return reason ? { reason, problems: check.problems } : null;
}
