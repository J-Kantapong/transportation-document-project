import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import {
  assertVehicleInScope,
  currentDeliveryScope,
  currentVehicleScope,
  currentWriteScope,
  isVehicleInScope,
  vehicleKindOf,
  vehicleTypeWhere,
} from '../auth/vehicle-scope.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

// ส่งงานลูกค้า (พนักงาน): ติ๊กคันที่ส่งแล้ว + วันที่ส่ง + ผู้รับ แล้วกดบันทึกครั้งเดียวทั้งชุด - พนักงานไม่เห็นราคา เรื่องบิลอยู่ที่ backend/src/billing
// กติกา (ผู้ใช้ 2026-09-21): ปกติส่งเล่ม + ป้ายพร้อมกัน แต่บางคันป้ายยังไม่ออก -> ส่งเล่มไปก่อนได้ แล้วป้ายตามทีหลัง
// ดังนั้นรถเข้าคิวส่งเมื่อ "ได้รับใบเสร็จแล้ว + รับเล่มแล้ว" (ไม่ต้องรอป้าย) และรถที่ส่งแล้วแต่ป้ายค้างจะกลับมาในคิวเป็นงานส่งป้ายอย่างเดียว
// ใบเสร็จไม่ได้ไปกับงานแล้ว ไปพร้อมใบวางบิล (ผู้ใช้ 2026-09-26) - ต้องได้ใบเสร็จกลับมาก่อนจึงเข้าคิวเหมือนเดิม
export type DeliveryKind =
  | 'FULL' // ส่งเล่ม + ป้าย
  | 'NO_PLATE' // ส่งเล่ม (ป้ายยังไม่ออก ส่งตามทีหลัง)
  | 'PLATE_ONLY' // ส่งเล่มไปแล้ว ป้ายเพิ่งมา -> ส่งป้ายอย่างเดียว
  | 'WAITING_PLATE' // ส่งเล่มไปแล้ว ป้ายยังไม่ออก -> ยังติ๊กไม่ได้
  | 'DONE'; // ส่งเล่มและป้ายครบแล้ว - บันทึกส่งซ้ำไม่ได้ (พบ 2026-09-27: หน้าที่เปิดค้างไว้บันทึกซ้ำแล้วได้ใบส่งป้ายซ้อน)

// ชนิดงานที่หน้า Delivery ส่งมาได้ (คันที่ติ๊กได้)
const DELIVERABLE_KINDS: DeliveryKind[] = ['FULL', 'NO_PLATE', 'PLATE_ONLY'];
const SLIP_LIMIT = 500; // รายงานส่งงานแสดงได้ครั้งละกี่ใบ (ใบล่าสุดก่อน)

const NOT_VOID = { invoice: { status: { not: 'VOID' } } };
// เงื่อนไขของ updateMany: รถยังไม่อยู่ในบิลที่ใช้อยู่ - กันแก้/ยกเลิกใบส่งเล่มพร้อมกับที่บัญชีออกบิล (พบ 2026-09-27)
// และยังไม่ปิดงาน - วางบิลนอกระบบ (billingClosedAt) - ปิดแล้วรถไม่กลับเข้าคิววางบิลอีก ต้องให้ ADMIN เปิดงานกลับก่อน (2026-09-27)
const NOT_BILLED = { invoiceLines: { none: NOT_VOID }, billingClosedAt: null };
const CLOSED_OUTSIDE = (chassis: string, what: string) => `รถ ${chassis} ปิดงาน - วางบิลนอกระบบแล้ว ให้ ADMIN เปิดงานกลับก่อนจึงจะ${what}ได้`;
// บิลรอรับเงินแก้ในที่ได้แล้ว (ผู้ใช้ 2026-09-27 F53a) - เอารถออกจากบิลแทนการยกเลิกทั้งบิล (บิลต้องเหลืออย่างน้อย 1 คัน)
const BILLED_FIX =
  '(ให้ฝ่ายบัญชีเอารถออกจากบิลก่อน: "แก้ไขบิล" ติ๊ก "เอาออกจากบิล" - รับเงินแล้วให้ "ยกเลิกการรับเงิน" ก่อน, เป็นคันเดียวในบิลให้ยกเลิกบิล)';

type Tx = Prisma.TransactionClient;

const VEHICLE_INCLUDE = {
  // branch: ลูกค้าชื่อซ้ำกัน (เช่นคนละสาขา) หน้า Delivery / รายงานส่งงานต่อสาขาให้แยกออก (F47 ผู้ใช้ 2026-09-27)
  customer: { select: { id: true, name: true, company: true, branch: true } },
  brand: { select: { name: true } },
  // submitDate + urgent + createdAt = ใบยื่น (lot) ที่รถคันนี้อยู่ - หน้า Delivery จัดการ์ดตามใบยื่นแบบหน้ารับป้าย (ผู้ใช้ 2026-09-26)
  documentSubmissions: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { status: true, receiptNo: true, submitDate: true, urgent: true, createdAt: true },
  },
  invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } },
  // ใบส่งเล่มที่ยังไม่ยกเลิก - รายงานส่งงานใช้กับปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ของรถที่ป้ายค้างส่ง (ผู้ใช้ 2026-09-27)
  deliverySlipItems: {
    where: { book: true, cancelledAt: null },
    orderBy: { slip: { slipNo: 'desc' as const } },
    take: 1,
    select: { slip: { select: { id: true, slipNo: true, date: true } } },
  },
} as const;

const USER_NAME = { select: { name: true, displayName: true } } as const;

const SLIP_INCLUDE = {
  customer: { select: { id: true, name: true, company: true, branch: true, address: true, phone: true } },
  createdBy: USER_NAME,
  cancelledBy: USER_NAME,
  items: {
    include: {
      cancelledBy: USER_NAME,
      // วางบิลแล้ว = ห้ามยกเลิก / เปลี่ยนวันที่ส่ง (บิลเก็บวันที่ส่งไว้แล้ว)
      vehicle: {
        select: {
          invoiceLines: { where: NOT_VOID, select: { invoice: { select: { invoiceNo: true } } } },
          billingClosedAt: true,
          // ชื่อเจ้าของบนใบส่งงาน (ผู้ใช้ 2026-09-26) - อ่านสดจาก VehicleOwner
          owner: { select: { name: true, hirerName: true } },
        },
      },
    },
  },
} as const;

// ชื่อเจ้าของบนใบส่งงาน: ติดไฟแนนซ์ = ชื่อผู้ครอบครอง (ไม่ใส่ชื่อไฟแนนซ์ - ผู้ใช้ 2026-09-26) ไม่ติด = ผู้ถือกรรมสิทธิ์
const ownerNameOf = (o: { name: string | null; hirerName: string | null } | null) => o?.hirerName || o?.name || null;

// ขอบเขตของแถวในใบส่งงาน - แถวสลับเลขไม่มี body จึงดู vehicleKind ที่บันทึกไว้ก่อน (ผู้ใช้ 2026-09-28)
// แถวเก่าก่อนมีคอลัมน์นี้ vehicleKind เป็น null ให้ตกไปใช้ body เหมือนเดิม
const itemInScope = (i: { body: string | null; vehicleKind?: string | null }, scope = currentVehicleScope()) =>
  i.vehicleKind ? scope === 'ALL' || scope.toLowerCase() === i.vehicleKind : isVehicleInScope(i.body, scope);

// เงื่อนไขกรองใบตามประเภทรถฝั่งฐานข้อมูล - ใบที่มีแถวในขอบเขตอย่างน้อย 1 แถว
const slipItemScopeWhere = (scope: ReturnType<typeof currentVehicleScope>) => {
  if (scope === 'ALL') return {};
  const kind = scope === 'MOTO' ? 'moto' : 'car';
  return { items: { some: { OR: [{ vehicleKind: kind }, { vehicleKind: null, ...vehicleTypeWhere(scope) }] } } };
};

const userName = (u: { name: string; displayName: string | null } | null) => (u ? u.displayName || u.name : null);

const bad = (error: string) => new BadRequestException({ error });
const conflict = (error: string) => new ConflictException({ error });
const slipNoLabel = (slipNo: number) => `DL-${String(slipNo).padStart(5, '0')}`;

const plateTextOf = (v: { plateCategory: string | null; plateNumber: string | null }) =>
  v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : '';

function parseOptionalIsoDate(raw: unknown, label: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

const dmy = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
const isoDay = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

function parseRemark(raw: unknown): string {
  const remark = typeof raw === 'string' ? raw.trim() : '';
  if (!remark) throw bad('ต้องใส่เหตุผล');
  return remark;
}

// หมายเหตุของการส่งป้ายตามทีหลังถูกต่อท้าย deliveryNote เป็น "... · ส่งป้าย วว/ดด/ปปปป ผู้รับ ..." - ยกเลิกใบส่งป้ายแล้วตัดส่วนนั้นออก
export function stripPlateNote(note: string | null): string | null {
  if (!note) return null;
  const kept = note.split(' · ').filter((part) => !part.startsWith('ส่งป้าย '));
  return kept.length ? kept.join(' · ') : null;
}

const plateNoteOf = (date: Date, recipient: string, note: string | null) =>
  `ส่งป้าย ${dmy(date)} ผู้รับ ${recipient}${note ? ` (${note})` : ''}`;

// งานสลับเลขส่งคืนลูกค้าได้ในใบเดียวกับรถจดใหม่ (ผู้ใช้ 2026-09-28) - แถวในคิว/ใบส่งงานจึงมาจาก 2 ที่
export type DeliverySource = 'VEHICLE' | 'PLATE_SWAP';

// คีย์ของแถวที่ติ๊ก - id ซ้ำข้ามตารางได้ในทางทฤษฎี จึงคีย์ด้วย source ด้วย
const itemKey = (source: DeliverySource, id: string) => `${source}:${id}`;

// คันที่ติ๊ก + ชนิดงานที่ผู้ใช้เห็นในป๊อปอัปยืนยัน (items) - vehicleIds อย่างเดียว = แบบเดิม ไม่ตรวจชนิดงาน
// หน้าเว็บส่งทั้งสองแบบคู่กัน backend รุ่นก่อนหน้าจึงยังรับได้ระหว่างอัปเดต
// items รับได้ทั้ง { source, id, kind } (แบบใหม่) และ { vehicleId, kind } (แบบเดิม = รถจดใหม่)
function parseDeliveryItems(dto: { items?: unknown; vehicleIds?: unknown }): Map<string, DeliveryKind | null> {
  const expected = new Map<string, DeliveryKind | null>();
  if (Array.isArray(dto.items)) {
    for (const raw of dto.items as Array<{ source?: unknown; id?: unknown; vehicleId?: unknown; kind?: unknown } | null>) {
      if (!raw || !DELIVERABLE_KINDS.includes(raw.kind as DeliveryKind)) throw bad('รายการที่ส่งไม่ถูกต้อง');
      const source: DeliverySource = raw.source === 'PLATE_SWAP' ? 'PLATE_SWAP' : 'VEHICLE';
      const id = typeof raw.id === 'string' ? raw.id : typeof raw.vehicleId === 'string' ? raw.vehicleId : '';
      if (!id) throw bad('รายการที่ส่งไม่ถูกต้อง');
      expected.set(itemKey(source, id), raw.kind as DeliveryKind);
    }
  } else if (Array.isArray(dto.vehicleIds) && dto.vehicleIds.every((id) => typeof id === 'string')) {
    for (const id of dto.vehicleIds as string[]) expected.set(itemKey('VEHICLE', id), null);
  }
  if (expected.size === 0) throw bad('ต้องติ๊กรายการที่ส่งแล้วอย่างน้อย 1 รายการ');
  return expected;
}

// ทำไมชนิดงานตอนบันทึกไม่ตรงกับที่ผู้ใช้เห็น (ข้อความสั้นใน error 409)
function kindChangeText(expected: DeliveryKind | null, now: DeliveryKind): string {
  if (now === 'DONE') return 'ส่งครบแล้ว';
  if ((expected === 'FULL' || expected === 'NO_PLATE') && (now === 'PLATE_ONLY' || now === 'WAITING_PLATE')) return 'ส่งเล่มไปแล้ว';
  if (expected === 'NO_PLATE' && now === 'FULL') return 'เพิ่งรับป้ายเข้ามา';
  return 'สถานะการส่งเปลี่ยนไป';
}

function parseIsoDate(raw: unknown): Date {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad('วันที่ส่งต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง');
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

export function deliveryKind(v: { deliveredDate: Date | null; plateReceivedDate: Date | null; plateDeliveredDate: Date | null }): DeliveryKind {
  if (v.deliveredDate && v.plateDeliveredDate) return 'DONE';
  if (v.deliveredDate) return v.plateReceivedDate ? 'PLATE_ONLY' : 'WAITING_PLATE';
  return v.plateReceivedDate ? 'FULL' : 'NO_PLATE';
}

// รูปร่างกลางของ "ของที่ส่งได้" - รถจดใหม่กับงานสลับเลขต่างที่มา แต่ขั้นส่งงานใช้กฎเดียวกันทั้งหมด
// (ชนิดงาน FULL/NO_PLATE/PLATE_ONLY, 1 ใบ = 1 ลูกค้า + 1 ประเภทรถ, ส่งเล่มก่อนป้ายตามทีหลัง)
interface Deliverable {
  source: DeliverySource;
  id: string;
  customerId: string;
  chassis: string;
  brandName: string;
  body: string | null;
  vehicleKind: 'car' | 'moto';
  plateText: string;
  receiptNo: string | null;
  ownerName: string | null; // เก็บ snapshot เฉพาะงานสลับเลข (รถจดใหม่อ่านสดจาก VehicleOwner ตอนปริ้น)
  deliveredDate: Date | null;
  plateReceivedDate: Date | null;
  plateDeliveredDate: Date | null;
  deliveryNote: string | null;
  // พร้อมส่งครั้งแรกไหม - รถจดใหม่: การยื่นล่าสุดได้ใบเสร็จ + รับเล่มแล้ว / สลับเลข: รับใบเสร็จ (returnedDate) + รับเล่มแล้ว
  readyForFirstDelivery: boolean;
}

// ขอบเขตประเภทรถของงานสลับเลข - ไม่มี body ให้ดูเหมือนรถจดใหม่ จึงเทียบ vehicleClass ตรงๆ ด้วยกฎเดียวกัน
const plateSwapClassWhere = (scope: ReturnType<typeof currentDeliveryScope>) =>
  scope === 'ALL' ? {} : scope === 'MOTO' ? { vehicleClass: 'MOTO' } : scope === 'CAR' ? { vehicleClass: 'CAR' } : { id: { in: [] as string[] } };

// งานสลับเลขที่พร้อมส่ง: ได้ใบเสร็จ (returnedDate) + รับเล่มแล้ว (ผู้ใช้ 2026-09-28) หรือส่งเล่มแล้วแต่ป้ายค้างส่ง
const plateSwapQueueWhere = (scope: ReturnType<typeof currentDeliveryScope>) => ({
  cancelledAt: null,
  OR: [
    { deliveredDate: null, returnedDate: { not: null }, bookReceivedDate: { not: null } },
    { deliveredDate: { not: null }, plateDeliveredDate: null },
  ],
  ...plateSwapClassWhere(scope),
});

const PLATE_SWAP_SELECT = {
  id: true,
  customerId: true,
  vehicleClass: true,
  oldChassis: true,
  oldBrand: true,
  oldOwnerName: true,
  newPlateCategory: true,
  newPlateNumber: true,
  receiptNo: true,
  submitDate: true,
  returnedDate: true,
  bookReceivedDate: true,
  plateReceivedDate: true,
  deliveredDate: true,
  plateDeliveredDate: true,
  deliveryNote: true,
  deliveryRecipient: true,
  customer: { select: { id: true, name: true, company: true, branch: true } },
  // ใบส่งเล่มที่ยังไม่ยกเลิก - ปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ของงานสลับเลขที่ป้ายค้างส่ง (เหมือนรถจดใหม่)
  deliverySlipItems: {
    where: { book: true, cancelledAt: null },
    orderBy: { slip: { slipNo: 'desc' as const } },
    take: 1,
    select: { slip: { select: { id: true, slipNo: true, date: true } } },
  },
} as const;

type PlateSwapRow = {
  id: string;
  customerId: string | null;
  vehicleClass: string;
  oldChassis: string;
  oldBrand: string;
  oldOwnerName: string;
  newPlateCategory: string | null;
  newPlateNumber: string | null;
  receiptNo: string | null;
  returnedDate: Date | null;
  bookReceivedDate: Date | null;
  plateReceivedDate: Date | null;
  deliveredDate: Date | null;
  plateDeliveredDate: Date | null;
  deliveryNote: string | null;
};

function plateSwapDeliverable(s: PlateSwapRow): Deliverable {
  return {
    source: 'PLATE_SWAP',
    id: s.id,
    customerId: s.customerId ?? '',
    chassis: s.oldChassis,
    brandName: s.oldBrand,
    body: null,
    vehicleKind: s.vehicleClass === 'MOTO' ? 'moto' : 'car',
    // ทะเบียนบนใบส่งงาน = เลขใหม่ที่รถเก่าได้รับ (ของที่ส่งคืนคือป้ายใหม่กับเล่มที่แก้แล้ว)
    plateText: s.newPlateCategory && s.newPlateNumber ? `${s.newPlateCategory} ${s.newPlateNumber}` : '',
    receiptNo: s.receiptNo,
    ownerName: s.oldOwnerName,
    deliveredDate: s.deliveredDate,
    plateReceivedDate: s.plateReceivedDate,
    plateDeliveredDate: s.plateDeliveredDate,
    deliveryNote: s.deliveryNote,
    readyForFirstDelivery: !!s.returnedDate && !!s.bookReceivedDate,
  };
}

@Injectable()
export class DeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  // คิวงานส่ง: ขอบเขตเดียวกับที่บันทึกส่งได้ (DELIVERY ทุกคัน, STAFF_CAR / STAFF_MOTO เฉพาะประเภทรถของตัวเอง
  // แม้ถือ ACCOUNTANT ด้วย - ไม่โชว์คันที่ติ๊กแล้วบันทึกไม่ได้)
  async queue() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        OR: [
          { deliveredDate: null, bookReceivedDate: { not: null }, documentSubmissions: { some: { status: 'RECEIPT_RECEIVED' } } },
          { deliveredDate: { not: null }, plateDeliveredDate: null },
        ],
        deletedAt: null,
        ...vehicleTypeWhere(currentDeliveryScope()),
      },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    // some(RECEIPT_RECEIVED) ยังนับรถที่เคยได้ใบเสร็จแล้วยื่นใหม่ค้าง PENDING - เอาเฉพาะที่การยื่นล่าสุดได้ใบเสร็จจริง
    const vehicleRows = vehicles
      .filter((v) => v.deliveredDate || v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED')
      .map((v) => this.mapRow(v));
    // งานสลับเลขส่งคืนลูกค้าในใบเดียวกันได้ (ผู้ใช้ 2026-09-28) - อยู่คิวเดียวกันเลย
    return [...vehicleRows, ...(await this.plateSwapQueue())];
  }

  // งานสลับเลขที่รอส่งคืนลูกค้า - แปลงเป็นแถวหน้าตาเดียวกับรถจดใหม่ให้หน้า Delivery ใช้ซ้ำได้ทั้งหน้า
  private async plateSwapQueue() {
    const swaps = await this.prisma.plateSwap.findMany({
      where: plateSwapQueueWhere(currentDeliveryScope()),
      orderBy: [{ submitDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: PLATE_SWAP_SELECT,
    });
    return swaps.map((s) => this.mapPlateSwapRow(s));
  }

  // รถคันอื่นในใบยื่น (lot) เดียวกับคันที่อยู่ในคิว: ยังไม่พร้อมส่ง (รอใบเสร็จ/รอเล่ม) หรือส่งครบแล้ว
  // งานเสร็จเป็น lot แต่บางทีเสร็จไม่หมด (ผู้ใช้ 2026-09-26) - หน้า Delivery แสดงทั้ง lot ให้เห็นว่าเหลือคันไหน ติ๊กได้เฉพาะคันในคิว
  async lotVehicles(rows: Array<{ id: string; customerId: string; submitDate: string | null }>) {
    const dates = [...new Set(rows.map((r) => r.submitDate).filter((d): d is string => !!d))];
    if (dates.length === 0) return [];
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        id: { notIn: rows.map((r) => r.id) },
        customerId: { in: [...new Set(rows.map((r) => r.customerId))] },
        deletedAt: null,
        documentSubmissions: { some: { submitDate: { in: dates.map((d) => new Date(`${d}T00:00:00.000Z`)) } } },
        ...vehicleTypeWhere(currentDeliveryScope()),
      },
      include: VEHICLE_INCLUDE,
    });
    const lotKeys = new Set(rows.map((r) => `${r.submitDate}|${r.customerId}`));
    // ใบยื่นล่าสุดของคันนั้นต้องอยู่ใน lot เดียวกัน (ยื่นใหม่ไปใบอื่นแล้ว = ไม่นับ) และไม่ใช่ยื่นไม่สำเร็จ
    return vehicles
      .map((v) => this.mapRow(v))
      .filter((r) => r.submissionStatus !== 'FAILED' && lotKeys.has(`${r.submitDate}|${r.customerId}`));
  }

  async recent() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deliveredDate: { not: null }, deletedAt: null, ...vehicleTypeWhere(currentDeliveryScope()) },
      orderBy: [{ deliveredDate: 'desc' }, { updatedAt: 'desc' }],
      take: 200,
      include: VEHICLE_INCLUDE,
    });
    return vehicles.map((v) => this.mapRow(v));
  }

  // รายงานส่งงาน: รถที่ส่งเล่มแล้วแต่ป้ายยังค้างส่ง - ขอบเขตการอ่านเดียวกับ slips() ไม่ใช่ขอบเขตการส่งของ queue()
  // (พบ 2026-09-27: STAFF_CAR + ACCOUNTANT เห็นใบส่งงานจักรยานยนต์ แต่จักรยานยนต์หายจากรายการป้ายค้างส่งของรายงานเดียวกัน)
  async platePending() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deliveredDate: { not: null }, plateDeliveredDate: null, deletedAt: null, ...vehicleTypeWhere(currentVehicleScope()) },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      include: VEHICLE_INCLUDE,
    });
    // งานสลับเลขก็ส่งเล่มก่อนแล้วส่งป้ายตามทีหลังได้ (ผู้ใช้ 2026-09-28) - ต้องอยู่ในรายการป้ายค้างส่งเดียวกัน
    const swaps = await this.prisma.plateSwap.findMany({
      where: { cancelledAt: null, deliveredDate: { not: null }, plateDeliveredDate: null, ...plateSwapClassWhere(currentVehicleScope()) },
      orderBy: [{ submitDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      select: PLATE_SWAP_SELECT,
    });
    return [...vehicles.map((v) => this.mapRow(v)), ...swaps.map((s) => this.mapPlateSwapRow(s))];
  }

  // items = [{ vehicleId, kind }] ชนิดงานที่ผู้ใช้เห็นในป๊อปอัปยืนยัน (vehicleIds อย่างเดียว = แบบเดิม)
  async submit(dto: { items?: unknown; vehicleIds?: unknown; date?: unknown; recipient?: unknown; note?: unknown }) {
    const date = parseIsoDate(dto?.date);
    if (typeof dto.recipient !== 'string' || !dto.recipient.trim()) throw bad('ต้องใส่ชื่อผู้รับงาน');
    const recipient = dto.recipient.trim();
    if (dto.note !== undefined && dto.note !== null && typeof dto.note !== 'string') throw bad('หมายเหตุต้องเป็นข้อความ');
    const note = (dto.note as string | null | undefined)?.trim() || null;
    const expected = parseDeliveryItems(dto);
    const vehicleIds = [...expected.keys()].filter((k) => k.startsWith('VEHICLE:')).map((k) => k.slice('VEHICLE:'.length));
    const swapIds = [...expected.keys()].filter((k) => k.startsWith('PLATE_SWAP:')).map((k) => k.slice('PLATE_SWAP:'.length));

    const vehicles = await this.prisma.vehicle.findMany({ where: { id: { in: vehicleIds }, deletedAt: null }, include: VEHICLE_INCLUDE });
    const swaps = swapIds.length
      ? await this.prisma.plateSwap.findMany({ where: { id: { in: swapIds }, cancelledAt: null }, select: PLATE_SWAP_SELECT })
      : [];
    // ข้อความไม่บอกให้โหลดหน้าใหม่ - หน้า Delivery โหลดรายการให้เองโดยเก็บคันที่ติ๊ก/ผู้รับ/หมายเหตุไว้ กด F5 แล้วหาย (พบ 2026-09-27)
    if (vehicles.length !== vehicleIds.length || swaps.length !== swapIds.length) {
      throw bad('ไม่พบข้อมูลบางรายการ กรุณาตรวจรายการแล้วบันทึกใหม่');
    }

    // รวมสองที่มาเป็นรูปร่างเดียว - กฎส่งงานทุกข้อจากนี้ไปใช้ร่วมกันทั้งรถจดใหม่และงานสลับเลข
    const vehicleItems: Deliverable[] = vehicles.map((v) => ({
      source: 'VEHICLE',
      id: v.id,
      customerId: v.customer.id,
      chassis: v.chassis,
      brandName: v.brand.name,
      body: v.body,
      vehicleKind: vehicleKindOf(v.body),
      plateText: plateTextOf(v),
      receiptNo: v.documentSubmissions[0]?.receiptNo ?? null,
      ownerName: null,
      deliveredDate: v.deliveredDate,
      plateReceivedDate: v.plateReceivedDate,
      plateDeliveredDate: v.plateDeliveredDate,
      deliveryNote: v.deliveryNote,
      readyForFirstDelivery: !!v.bookReceivedDate && v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED',
    }));
    const items: Deliverable[] = [...vehicleItems, ...swaps.map((s) => plateSwapDeliverable(s))];

    const scope = currentDeliveryScope(); // DELIVERY ส่งได้ทุกคัน, STAFF_CAR / STAFF_MOTO เฉพาะประเภทรถของตัวเอง
    for (const v of vehicles) assertVehicleInScope(v.body, scope);
    // งานสลับเลขไม่มี body ให้ดู - เช็คจาก vehicleClass ตรงๆ ด้วยกฎเดียวกัน
    for (const s of swaps) {
      const kind = s.vehicleClass === 'MOTO' ? 'moto' : 'car';
      if (scope !== 'ALL' && scope.toLowerCase() !== kind) {
        throw new ForbiddenException({ error: scope === 'CAR' ? 'บัญชีของคุณดูแลเฉพาะรถยนต์' : 'บัญชีของคุณดูแลเฉพาะจักรยานยนต์' });
      }
    }
    // บันทึก 1 ครั้ง = ใบส่งงาน 1 ใบของลูกค้ารายเดียว (ผู้รับคนเดียว)
    if (new Set(items.map((i) => i.customerId)).size > 1) throw bad('ส่งงานได้ครั้งละ 1 ลูกค้า');
    // ใบส่งงาน 1 ใบ = รถประเภทเดียว (ผู้ใช้ 2026-09-27): ใบรวมรถยนต์ + จักรยานยนต์ พนักงานประเภทเดียวพิมพ์ซ้ำได้ไม่ครบ
    // (เห็นเฉพาะคันในขอบเขต) และแก้ใบไม่ได้ - แต่รถจดใหม่กับงานสลับเลขของประเภทเดียวกันอยู่ใบเดียวกันได้ (ผู้ใช้ 2026-09-28)
    if (new Set(items.map((i) => i.vehicleKind)).size > 1) throw bad('ส่งรถยนต์กับจักรยานยนต์คนละใบ');

    // สถานะตอนนี้ต้องตรงกับที่ผู้ใช้ยืนยันในป๊อปอัป ไม่ตรงรายการเดียว = ไม่บันทึกทั้งชุด (พบ 2026-09-27: หน้าเปิดค้างไว้
    // แล้วระบบคิดใหม่เงียบๆ - ป้ายเพิ่งแนบ "เล่ม (ป้ายตามทีหลัง)" กลายเป็นส่งป้ายด้วย, คันที่ส่งครบแล้วได้ใบส่งป้ายซ้ำ)
    const kinds = new Map(items.map((i) => [itemKey(i.source, i.id), deliveryKind(i)]));
    const kindOfItem = (i: Deliverable) => kinds.get(itemKey(i.source, i.id))!;
    const changed = items.filter((i) => {
      const now = kindOfItem(i);
      const want = expected.get(itemKey(i.source, i.id)) ?? null;
      return now === 'DONE' || (want !== null && want !== now);
    });
    if (changed.length) {
      const list = changed
        .map((i) => `รถ ${i.chassis} ${kindChangeText(expected.get(itemKey(i.source, i.id)) ?? null, kindOfItem(i))}`)
        .join(', ');
      throw conflict(`${list} (ข้อมูลเปลี่ยนไปจากตอนที่เปิดหน้า) กรุณาตรวจรายการแล้วบันทึกใหม่`);
    }
    for (const i of items) {
      const kind = kindOfItem(i);
      if (kind === 'WAITING_PLATE') throw bad(`รถ ${i.chassis} ส่งเล่มไปแล้ว และป้ายยังไม่ออก`);
      if (kind === 'PLATE_ONLY') {
        // กติกาเดียวกับตอนแก้ใบ (พบ 2026-09-27: บันทึกได้ แต่เปิดแก้ใบเดิมทีหลังไม่ผ่าน)
        if (i.deliveredDate && date < i.deliveredDate) {
          throw bad(`รถ ${i.chassis} ส่งเล่มเมื่อ ${dmy(i.deliveredDate)} วันที่ส่งป้ายต้องไม่ก่อนวันนั้น`);
        }
      } else if (!i.readyForFirstDelivery) {
        throw bad(`รถ ${i.chassis} ต้องได้รับใบเสร็จและเล่มทะเบียนก่อนจึงจะส่งงานได้`);
      }
    }
    const ofKind = (kind: DeliveryKind) => items.filter((i) => kindOfItem(i) === kind);

    // เขียนแบบมีเงื่อนไขใน transaction เดียวกับการสร้างใบ: 2 คำขอพร้อมกันผ่านการตรวจด้านบนได้ทั้งคู่ แต่แถวรถถูกเปลี่ยนได้ครั้งเดียว
    // คำขอหลังนับได้ไม่ครบ -> throw -> ย้อนทั้งชุด ไม่มีใบส่งงานซ้ำ (พบ 2026-09-27) - timeout เผื่อชุดส่งป้ายหลายคัน (เขียนทีละคัน)
    const created = await this.prisma.$transaction(
      async (tx) => {
        for (const kind of ['FULL', 'NO_PLATE'] as const) {
          const group = ofKind(kind);
          const data = { deliveredDate: date, deliveryRecipient: recipient, deliveryNote: note, plateDeliveredDate: kind === 'FULL' ? date : null };
          const vIds = group.filter((i) => i.source === 'VEHICLE').map((i) => i.id);
          if (vIds.length) {
            const { count } = await tx.vehicle.updateMany({ where: { id: { in: vIds }, deletedAt: null, deliveredDate: null }, data });
            if (count !== vIds.length) throw conflict('มีการบันทึกส่งรถบางคันในชุดนี้ไปก่อนแล้ว กรุณาตรวจรายการแล้วบันทึกใหม่');
          }
          const sIds = group.filter((i) => i.source === 'PLATE_SWAP').map((i) => i.id);
          if (sIds.length) {
            const { count } = await tx.plateSwap.updateMany({ where: { id: { in: sIds }, cancelledAt: null, deliveredDate: null }, data });
            if (count !== sIds.length) throw conflict('มีการบันทึกส่งงานสลับเลขบางรายการในชุดนี้ไปก่อนแล้ว กรุณาตรวจรายการแล้วบันทึกใหม่');
          }
        }
        for (const i of ofKind('PLATE_ONLY')) {
          // ผู้รับ/หมายเหตุของการส่งเล่มเก็บไว้ตามเดิม - บันทึกการส่งป้ายต่อท้ายหมายเหตุ
          const plateNote = plateNoteOf(date, recipient, note);
          const data = { plateDeliveredDate: date, deliveryNote: i.deliveryNote ? `${i.deliveryNote} · ${plateNote}` : plateNote };
          const where = { id: i.id, deliveredDate: { not: null }, plateReceivedDate: { not: null }, plateDeliveredDate: null };
          const { count } =
            i.source === 'VEHICLE'
              ? await tx.vehicle.updateMany({ where: { ...where, deletedAt: null }, data })
              : await tx.plateSwap.updateMany({ where: { ...where, cancelledAt: null }, data });
          if (count !== 1) throw conflict(`รถ ${i.chassis} บันทึกส่งป้ายไปแล้ว กรุณาตรวจรายการแล้วบันทึกใหม่`);
        }
        // ใบส่งงาน: บอกแยกรายคันว่ารอบนี้ส่งอะไร (ผู้ใช้ 2026-09-25)
        return tx.deliverySlip.create({
          data: {
            customerId: items[0].customerId,
            date,
            recipient,
            note,
            createdById: currentUser()?.id ?? null,
            items: {
              create: items.map((i) => {
                const kind = kindOfItem(i);
                return {
                  // แถวหนึ่งผูกกับที่มาเดียว - อีกช่องเป็น null (บังคับ XOR ที่นี่ Prisma เช็คให้ไม่ได้)
                  vehicleId: i.source === 'VEHICLE' ? i.id : null,
                  plateSwapId: i.source === 'PLATE_SWAP' ? i.id : null,
                  // ใบเสร็จส่งไปพร้อมใบวางบิล ไม่ได้ไปกับใบส่งงาน (ผู้ใช้ 2026-09-26) - ใบเก่าก่อนนี้ยังเป็น true
                  receipt: false,
                  book: kind !== 'PLATE_ONLY',
                  plate: kind !== 'NO_PLATE',
                  chassis: i.chassis,
                  brandName: i.brandName,
                  body: i.body,
                  vehicleKind: i.vehicleKind,
                  ownerName: i.ownerName,
                  plateText: i.plateText,
                  receiptNo: i.receiptNo,
                };
              }),
            },
          },
          select: { id: true, slipNo: true },
        });
      },
      { timeout: 30_000 },
    );

    return {
      slipId: created.id,
      slipNo: created.slipNo,
      delivered: ofKind('FULL').length + ofKind('NO_PLATE').length,
      plateOnly: ofKind('PLATE_ONLY').length,
      platePending: ofKind('NO_PLATE').length,
    };
  }

  // รายงานส่งงานย้อนหลัง: ใบส่งงานตามช่วงวันที่ส่ง (และลูกค้า) - STAFF_CAR / STAFF_MOTO เห็นเฉพาะคันในขอบเขตของตัวเอง
  // ครั้งละไม่เกิน SLIP_LIMIT ใบ (ใบล่าสุดก่อน) - เกินแล้ว truncated = true ให้หน้าเว็บเตือน (พบ 2026-09-27: เดิมตัดเงียบๆ)
  async slips(query: { from?: unknown; to?: unknown; customerId?: unknown }) {
    const from = parseOptionalIsoDate(query?.from, 'วันที่เริ่ม');
    const to = parseOptionalIsoDate(query?.to, 'วันที่สิ้นสุด');
    if (from && to && from > to) throw bad('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
    const customerId = typeof query?.customerId === 'string' && query.customerId ? query.customerId : undefined;
    const scope = currentVehicleScope();
    const found = await this.prisma.deliverySlip.findMany({
      where: {
        ...(from || to ? { date: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
        ...(customerId ? { customerId } : {}),
        // นับเพดานเฉพาะใบที่มีรถในขอบเขต - ใบของรถอีกประเภทไม่กินโควตาจนใบของตัวเองหาย (DeliverySlipItem มี body/id เหมือน Vehicle)
        ...slipItemScopeWhere(scope),
      },
      orderBy: [{ date: 'desc' }, { slipNo: 'desc' }],
      take: SLIP_LIMIT + 1,
      include: SLIP_INCLUDE,
    });
    const slips = found.slice(0, SLIP_LIMIT);
    const later = await this.platesSentLater(slips);
    return {
      slips: slips.map((s) => this.mapSlip(s, later)).filter((s) => s.items.length > 0),
      truncated: found.length > SLIP_LIMIT,
    };
  }

  async slip(id: string) {
    const found = await this.prisma.deliverySlip.findUnique({ where: { id }, include: SLIP_INCLUDE });
    const slip = found && this.mapSlip(found, await this.platesSentLater([found]));
    if (!slip || slip.items.length === 0) throw new NotFoundException({ error: 'ไม่พบใบส่งงาน' });
    return slip;
  }

  // ใบส่งเล่มที่ป้ายส่งตามไปทีหลังในใบอื่น: เลขที่/วันที่ของใบส่งป้าย (อ่านสดทุกครั้ง) ให้รายงานบอกว่าทำไมช่องป้ายของใบนี้ว่าง
  // (ผู้ใช้ 2026-09-27) - ใบส่งงานเองยังเป็น snapshot ตอนส่งเหมือนเดิม
  // คีย์ด้วย source:id เพราะแถวสลับเลขไม่มี vehicleId - ถ้าคีย์ด้วย vehicleId เฉยๆ แถวสลับเลขจะ null ชนกันหมด
  private async platesSentLater(
    slips: Array<{ items: Array<{ vehicleId: string | null; plateSwapId: string | null; book: boolean; plate: boolean; cancelledAt: Date | null }> }>,
  ) {
    const pending = slips.flatMap((s) => s.items.filter((i) => i.book && !i.plate && !i.cancelledAt));
    const vehicleIds = [...new Set(pending.map((i) => i.vehicleId).filter((id): id is string => !!id))];
    const swapIds = [...new Set(pending.map((i) => i.plateSwapId).filter((id): id is string => !!id))];
    const later = new Map<string, { slipNo: number; date: string }>();
    if (vehicleIds.length === 0 && swapIds.length === 0) return later;
    const items = await this.prisma.deliverySlipItem.findMany({
      where: {
        OR: [
          ...(vehicleIds.length ? [{ vehicleId: { in: vehicleIds } }] : []),
          ...(swapIds.length ? [{ plateSwapId: { in: swapIds } }] : []),
        ],
        book: false,
        plate: true,
        cancelledAt: null,
      },
      select: { vehicleId: true, plateSwapId: true, slip: { select: { slipNo: true, date: true } } },
    });
    for (const i of items) {
      const key = i.plateSwapId ? itemKey('PLATE_SWAP', i.plateSwapId) : i.vehicleId ? itemKey('VEHICLE', i.vehicleId) : null;
      if (key) later.set(key, { slipNo: i.slip.slipNo, date: isoDay(i.slip.date) ?? '' });
    }
    return later;
  }

  // ป้ายไปพร้อมเล่มแล้ว (ผู้ใช้ 2026-09-27): ใบส่งเล่มที่บันทึกไว้ว่าป้ายตามทีหลัง แต่จริงๆ ป้ายไปพร้อมเล่มแล้ว (แนบรูปป้ายช้า)
  // -> ติ๊กป้ายในใบเดิม + วันที่ส่งป้าย = วันที่ในใบ + บันทึกประวัติ - สิทธิ์เดียวกับแก้/ยกเลิกใบ
  // ทำกับคันที่วางบิลแล้วได้ (บิลเก็บแค่วันที่ส่งเล่ม)
  async addPlate(id: string, dto: { itemId?: unknown; source?: unknown; id?: unknown; vehicleId?: unknown; remark?: unknown }) {
    const itemId = typeof dto?.itemId === 'string' ? dto.itemId : '';
    const legacyVehicleId = typeof dto?.vehicleId === 'string' ? dto.vehicleId : '';
    // หน้ารายงานรู้แค่แถวในคิว (source + id) ไม่ได้ถือรายการในใบมาด้วย - ให้ระบุแบบนี้ได้ด้วย
    const bySource = typeof dto?.id === 'string' && dto.id ? { source: dto.source === 'PLATE_SWAP' ? 'PLATE_SWAP' : 'VEHICLE', id: dto.id } : null;
    if (!itemId && !legacyVehicleId && !bySource) throw bad('ต้องเลือกรายการ');
    if (dto.remark !== undefined && dto.remark !== null && typeof dto.remark !== 'string') throw bad('หมายเหตุต้องเป็นข้อความ');
    const slip = await this.findActiveSlip(id);
    const label = slipNoLabel(slip.slipNo);
    // ระบุด้วย id ของแถว - แถวงานสลับเลขไม่มี vehicleId ให้ใช้ (ผู้ใช้ 2026-09-28) / vehicleId เดิมยังรับได้
    const item = itemId
      ? slip.items.find((i) => i.id === itemId)
      : bySource
        ? slip.items.find((i) => (bySource.source === 'PLATE_SWAP' ? i.plateSwapId === bySource.id : i.vehicleId === bySource.id))
        : slip.items.find((i) => i.vehicleId === legacyVehicleId);
    if (!item) throw bad(`รายการนี้ไม่อยู่ในใบ ${label}`);
    const source: DeliverySource = item.plateSwapId ? 'PLATE_SWAP' : 'VEHICLE';
    const targetId = item.plateSwapId ?? item.vehicleId ?? '';
    this.assertItemInScope(item.body, `รถ ${item.chassis} `);
    if (item.cancelledAt) throw bad(`รถ ${item.chassis} ถูกยกเลิกจากใบ ${label} แล้ว`);
    if (!item.book) throw bad(`ใบ ${label} เป็นใบส่งป้ายของรถ ${item.chassis} อยู่แล้ว`);
    if (item.plate) throw bad(`ใบ ${label} ส่งป้ายของรถ ${item.chassis} ไปแล้ว`);

    const stateSelect = { id: true, deliveredDate: true, plateReceivedDate: true, plateDeliveredDate: true } as const;
    const v =
      source === 'PLATE_SWAP'
        ? await this.prisma.plateSwap.findFirst({ where: { id: targetId, cancelledAt: null }, select: stateSelect })
        : await this.prisma.vehicle.findFirst({ where: { id: targetId, deletedAt: null }, select: stateSelect });
    if (!v) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    if (!v.plateReceivedDate) throw bad(`รถ ${item.chassis} ยังไม่ได้รับป้าย - แนบรูปป้ายที่หน้ารับป้ายทะเบียนก่อน`);
    if (v.plateDeliveredDate) throw bad(`รถ ${item.chassis} บันทึกส่งป้ายไปแล้วเมื่อ ${dmy(v.plateDeliveredDate)}`);
    // รายงานส่งงานโหลดรายการใหม่ให้เองเมื่อถูกปฏิเสธ - ข้อความจึงไม่บอกให้โหลดหน้าใหม่ (พบ 2026-09-27)
    if (isoDay(v.deliveredDate) !== isoDay(slip.date)) throw bad(`รถ ${item.chassis} วันที่ส่งเล่มไม่ตรงกับใบ ${label} กรุณาตรวจรายการอีกครั้ง`);

    const note = typeof dto.remark === 'string' ? dto.remark.trim() : '';
    // ป้ายไปพร้อมเล่ม = ร้านได้ป้ายมาก่อนวันส่งเล่มแน่นอน - รูปที่แนบทีหลังมักลงวันที่วันแนบ จึงปรับวันที่รับป้ายเป็นวันส่งเล่ม
    // (พบ 2026-09-27: ไม่งั้นป้ายถูกบันทึกว่าส่งก่อนรับ และแก้วันที่รับป้ายไม่ได้อีกเพราะส่งไปแล้ว)
    const receivedLater = v.plateReceivedDate > slip.date;
    await this.prisma.$transaction(async (tx) => {
      // มีเงื่อนไขทั้งสองแถว - ยกเลิกใบ/ส่งป้ายในใบอื่นพร้อมกัน จะนับไม่ครบแล้วย้อนทั้งหมด
      const itemUpdate = await tx.deliverySlipItem.updateMany({
        where: { id: item.id, cancelledAt: null, book: true, plate: false },
        data: { plate: true },
      });
      const where = { id: targetId, deliveredDate: slip.date, plateReceivedDate: v.plateReceivedDate, plateDeliveredDate: null };
      const data = { plateDeliveredDate: slip.date, ...(receivedLater ? { plateReceivedDate: slip.date } : {}) };
      const rowUpdate =
        source === 'PLATE_SWAP'
          ? await tx.plateSwap.updateMany({ where: { ...where, cancelledAt: null }, data })
          : await tx.vehicle.updateMany({ where: { ...where, deletedAt: null }, data });
      if (itemUpdate.count !== 1 || rowUpdate.count !== 1) throw conflict(`ข้อมูลรถ ${item.chassis} เปลี่ยนไปแล้ว กรุณาตรวจรายการอีกครั้ง`);
      const remarkText = note ? `ป้ายไปพร้อมเล่มในใบ ${label}: ${note}` : `ป้ายไปพร้อมเล่มในใบ ${label}`;
      const changes = {
        plateDeliveredDate: { from: null, to: isoDay(slip.date) },
        ...(receivedLater ? { plateReceivedDate: { from: isoDay(v.plateReceivedDate), to: isoDay(slip.date) } } : {}),
        'deliverySlip.plate': { from: `${label} ส่งเล่ม (ป้ายตามทีหลัง)`, to: `${label} ส่งเล่ม + ป้าย` },
      };
      if (source === 'PLATE_SWAP') {
        await writeAudit(tx, { entity: 'PlateSwap', entityId: targetId, action: 'delivery-add-plate', remark: remarkText, changes });
      } else {
        await tx.vehicleEditLog.create({
          data: { vehicleId: targetId, remark: remarkText, changes: JSON.stringify(changes), editedById: currentUser()?.id ?? null },
        });
      }
    });
    return this.slip(id);
  }

  // แก้ใบส่งงานที่คีย์ผิด (ผู้ใช้ 2026-09-26): ผู้รับ / วันที่ส่ง + เหตุผล (บันทึกลง VehicleEditLog ทุกคัน)
  // ADMIN ทุกใบ, STAFF_CAR เฉพาะใบรถยนต์, STAFF_MOTO เฉพาะใบจักรยานยนต์ (ผู้รับ/วันที่ใช้ร่วมกันทั้งใบ - ทุกคันที่ยังไม่ยกเลิกต้องอยู่ในขอบเขต)
  // วันที่ส่งของคันที่วางบิลแล้วเปลี่ยนไม่ได้ (บิลเก็บวันที่ส่งไว้แล้ว) แต่แก้ชื่อผู้รับได้
  async updateSlip(id: string, dto: { recipient?: unknown; date?: unknown; remark?: unknown }) {
    const remark = parseRemark(dto?.remark);
    if (typeof dto.recipient !== 'string' || !dto.recipient.trim()) throw bad('ต้องใส่ชื่อผู้รับงาน');
    const recipient = dto.recipient.trim();
    const date = parseIsoDate(dto.date);
    const slip = await this.findActiveSlip(id);
    const items = slip.items.filter((i) => !i.cancelledAt);
    for (const i of items) this.assertItemInScope(i.body, 'ใบนี้');
    const dateChanged = slip.date.getTime() !== date.getTime();
    if (slip.recipient === recipient && !dateChanged) throw bad('ไม่มีอะไรเปลี่ยน');

    const deliveryStateSelect = { id: true, deliveredDate: true, plateDeliveredDate: true, deliveryRecipient: true, deliveryNote: true } as const;
    const vehicles = await this.prisma.vehicle.findMany({
      where: { id: { in: items.map((i) => i.vehicleId).filter((x): x is string => !!x) } },
      select: deliveryStateSelect,
    });
    const swapRows = await this.prisma.plateSwap.findMany({
      where: { id: { in: items.map((i) => i.plateSwapId).filter((x): x is string => !!x) } },
      select: deliveryStateSelect,
    });
    // คีย์ด้วย source:id - งานสลับเลขกับรถจดใหม่อยู่ใบเดียวกันได้ (ผู้ใช้ 2026-09-28)
    const byId = new Map([
      ...vehicles.map((v) => [itemKey('VEHICLE', v.id), v] as const),
      ...swapRows.map((v) => [itemKey('PLATE_SWAP', v.id), v] as const),
    ]);
    const writes: Array<(tx: Tx) => Promise<void>> = [];
    for (const i of items) {
      const source: DeliverySource = i.plateSwapId ? 'PLATE_SWAP' : 'VEHICLE';
      const v = byId.get(itemKey(source, i.plateSwapId ?? i.vehicleId ?? ''));
      if (!v) continue;
      // บิลเก็บเฉพาะวันส่งเล่ม - ใบส่งป้ายตามทีหลังของรถที่วางบิลแล้วเปลี่ยนวันที่ได้ (ผู้ใช้ 2026-09-27)
      // งานสลับเลขยังไม่เข้าระบบวางบิล (i.vehicle เป็น null) จึงไม่มีล็อกฝั่งบิล
      const invoiceNo = i.vehicle?.invoiceLines[0]?.invoice.invoiceNo;
      const lockedByInvoice = dateChanged && i.book;
      if (lockedByInvoice && invoiceNo) throw bad(`รถ ${i.chassis} วางบิลแล้ว (${invoiceNo}) เปลี่ยนวันที่ส่งไม่ได้ - แก้ได้เฉพาะชื่อผู้รับ ${BILLED_FIX}`);
      if (lockedByInvoice && i.vehicle?.billingClosedAt) throw bad(CLOSED_OUTSIDE(i.chassis, 'เปลี่ยนวันที่ส่ง'));
      const data: { deliveredDate?: Date; deliveryRecipient?: string; plateDeliveredDate?: Date; deliveryNote?: string } = {};
      if (i.book) {
        // ใบนี้ส่งเล่ม - ถ้าส่งป้ายตามไปทีหลังแล้ว วันที่ใหม่ต้องไม่หลังวันส่งป้าย
        if (!i.plate && v.plateDeliveredDate && date > v.plateDeliveredDate) {
          throw bad(`รถ ${i.chassis} ส่งป้ายไปแล้วเมื่อ ${dmy(v.plateDeliveredDate)} วันที่ส่งเล่มต้องไม่หลังวันนั้น`);
        }
        data.deliveredDate = date;
        data.deliveryRecipient = recipient;
        if (i.plate) data.plateDeliveredDate = date;
      } else {
        // ใบส่งป้ายตามทีหลัง - ต้องไม่ก่อนวันส่งเล่ม
        if (v.deliveredDate && date < v.deliveredDate) {
          throw bad(`รถ ${i.chassis} ส่งเล่มเมื่อ ${dmy(v.deliveredDate)} วันที่ส่งป้ายต้องไม่ก่อนวันนั้น`);
        }
        data.plateDeliveredDate = date;
        // ผู้รับป้ายเก็บอยู่ในหมายเหตุ "ส่งป้าย วว/ดด/ปปปป ผู้รับ ..." - เขียนส่วนนั้นใหม่ตามใบที่แก้ (พบ 2026-09-27: เดิมค้างข้อความเก่า)
        data.deliveryNote = [stripPlateNote(v.deliveryNote), plateNoteOf(date, recipient, slip.note)].filter(Boolean).join(' · ');
      }
      const changes: Record<string, { from: string | null; to: string | null }> = {};
      if (data.deliveredDate && isoDay(v.deliveredDate) !== isoDay(data.deliveredDate)) {
        changes.deliveredDate = { from: isoDay(v.deliveredDate), to: isoDay(data.deliveredDate) };
      }
      if (data.deliveryRecipient && v.deliveryRecipient !== data.deliveryRecipient) {
        changes.deliveryRecipient = { from: v.deliveryRecipient, to: data.deliveryRecipient };
      }
      if (data.plateDeliveredDate && isoDay(v.plateDeliveredDate) !== isoDay(data.plateDeliveredDate)) {
        changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: isoDay(data.plateDeliveredDate) };
      }
      if (!i.book && slip.recipient !== recipient) changes['deliverySlip.recipient'] = { from: slip.recipient, to: recipient };
      writes.push(async (tx) => {
        const note = `แก้ใบส่งงาน ${slipNoLabel(slip.slipNo)}: ${remark}`;
        if (source === 'PLATE_SWAP') {
          // งานสลับเลขไม่มีบิลให้ล็อก และประวัติเขียนลง AuditLog (VehicleEditLog บังคับผูกกับ Vehicle)
          const { count } = await tx.plateSwap.updateMany({ where: { id: v.id, cancelledAt: null }, data });
          if (count !== 1) throw conflict(`รถ ${i.chassis} เพิ่งถูกแก้หรือยกเลิก - โหลดรายการใหม่`);
          await writeAudit(tx, { entity: 'PlateSwap', entityId: v.id, action: 'delivery-update', remark: note, changes });
          return;
        }
        const { count } = await tx.vehicle.updateMany({ where: { id: v.id, ...(lockedByInvoice ? NOT_BILLED : {}) }, data });
        if (count !== 1) throw conflict(`รถ ${i.chassis} เพิ่งวางบิลหรือปิดงาน เปลี่ยนวันที่ส่งไม่ได้ - แก้ได้เฉพาะชื่อผู้รับ`);
        await this.editLog(v.id, note, changes, tx);
      });
    }
    await this.prisma.$transaction(async (tx) => {
      for (const write of writes) await write(tx);
      await tx.deliverySlip.update({ where: { id }, data: { recipient, date } });
    });
    return this.slip(id);
  }

  // ยกเลิกใบส่งงาน (ทั้งใบหรือรายคัน) ที่คีย์ผิด (ผู้ใช้ 2026-09-26): รถกลับเข้าคิว Delivery แล้วบันทึกใหม่ได้
  // ไม่ลบ - รายการ/ใบถูกทำเครื่องหมายยกเลิกพร้อมเหตุผล (ครบทุกคัน = ทั้งใบขึ้นว่ายกเลิกแล้ว) เลข DL ไม่ขาดช่วง
  // ห้ามยกเลิก: คันที่วางบิลแล้ว (แก้บิลก่อน) และใบส่งเล่มของคันที่ส่งป้ายตามไปแล้ว (ยกเลิกใบส่งป้ายก่อน)
  // ระบุแถวด้วย itemIds (แถวงานสลับเลขไม่มี vehicleId ให้ใช้ - ผู้ใช้ 2026-09-28) / vehicleIds เดิมยังรับได้
  async cancelSlip(id: string, dto: { itemIds?: unknown; vehicleIds?: unknown; remark?: unknown }) {
    const remark = parseRemark(dto?.remark);
    const rawItemIds = Array.isArray(dto.itemIds) && dto.itemIds.every((v) => typeof v === 'string') ? (dto.itemIds as string[]) : null;
    const rawVehicleIds =
      Array.isArray(dto.vehicleIds) && dto.vehicleIds.every((v) => typeof v === 'string') ? (dto.vehicleIds as string[]) : null;
    if (!rawItemIds?.length && !rawVehicleIds?.length) throw bad('ต้องเลือกรายการที่จะยกเลิกอย่างน้อย 1 รายการ');
    const slip = await this.findActiveSlip(id);
    const chosen = rawItemIds?.length
      ? slip.items.filter((i) => rawItemIds.includes(i.id))
      : slip.items.filter((i) => i.vehicleId && rawVehicleIds!.includes(i.vehicleId));
    const wanted = rawItemIds?.length ? new Set(rawItemIds).size : new Set(rawVehicleIds).size;
    if (chosen.length !== wanted || chosen.some((i) => i.cancelledAt)) throw bad('บางรายการไม่อยู่ในใบนี้ หรือยกเลิกไปแล้ว');
    const cancelledItemIds = new Set(chosen.map((i) => i.id));
    const chosenVehicleIds = chosen.map((i) => i.vehicleId).filter((x): x is string => !!x);
    const chosenSwapIds = chosen.map((i) => i.plateSwapId).filter((x): x is string => !!x);

    const laterPlate = await this.prisma.deliverySlipItem.findMany({
      where: {
        OR: [
          ...(chosenVehicleIds.length ? [{ vehicleId: { in: chosenVehicleIds } }] : []),
          ...(chosenSwapIds.length ? [{ plateSwapId: { in: chosenSwapIds } }] : []),
        ],
        slipId: { not: id },
        cancelledAt: null,
        book: false,
        plate: true,
      },
      select: { vehicleId: true, plateSwapId: true, slip: { select: { slipNo: true } } },
    });
    const stateSelect = { id: true, deliveredDate: true, plateDeliveredDate: true, deliveryNote: true } as const;
    const vehicles = await this.prisma.vehicle.findMany({ where: { id: { in: chosenVehicleIds } }, select: stateSelect });
    const swapRows = await this.prisma.plateSwap.findMany({ where: { id: { in: chosenSwapIds } }, select: stateSelect });
    const byId = new Map([
      ...vehicles.map((v) => [itemKey('VEHICLE', v.id), v] as const),
      ...swapRows.map((v) => [itemKey('PLATE_SWAP', v.id), v] as const),
    ]);
    const now = new Date();
    const cancelledById = currentUser()?.id ?? null;
    const writes: Array<(tx: Tx) => Promise<void>> = [];
    for (const i of chosen) {
      this.assertItemInScope(i.body, `รถ ${i.chassis} `);
      // ล็อกเฉพาะรายการส่งเล่ม (บิลเก็บวันส่งเล่ม) - ใบส่งป้ายตามทีหลังยกเลิกได้แม้วางบิลแล้ว (ผู้ใช้ 2026-09-27)
      // งานสลับเลขยังไม่เข้าระบบวางบิล (i.vehicle เป็น null) จึงไม่มีล็อกฝั่งบิล
      const invoiceNo = i.vehicle?.invoiceLines[0]?.invoice.invoiceNo;
      if (i.book && invoiceNo) throw bad(`รถ ${i.chassis} วางบิลแล้ว (${invoiceNo}) ยกเลิกการส่งไม่ได้ ${BILLED_FIX}`);
      if (i.book && i.vehicle?.billingClosedAt) throw bad(CLOSED_OUTSIDE(i.chassis, 'ยกเลิกการส่ง'));
      const source: DeliverySource = i.plateSwapId ? 'PLATE_SWAP' : 'VEHICLE';
      const targetId = i.plateSwapId ?? i.vehicleId ?? '';
      const v = byId.get(itemKey(source, targetId));
      if (!v) continue;
      const changes: Record<string, { from: string | null; to: string | null }> = {
        'deliverySlip.cancelled': { from: `${slipNoLabel(slip.slipNo)} ${dmy(slip.date)} ผู้รับ ${slip.recipient}`, to: 'ยกเลิกการส่ง' },
      };
      if (i.book) {
        const plate = laterPlate.find((p) => (i.plateSwapId ? p.plateSwapId === i.plateSwapId : p.vehicleId === i.vehicleId));
        if (plate) throw bad(`รถ ${i.chassis} ส่งป้ายตามไปแล้วในใบ ${slipNoLabel(plate.slip.slipNo)} ต้องยกเลิกใบนั้นก่อน`);
        if (v.deliveredDate) changes.deliveredDate = { from: isoDay(v.deliveredDate), to: null };
        if (v.plateDeliveredDate) changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: null };
        writes.push(async (tx) => {
          if (source === 'PLATE_SWAP') {
            // งานสลับเลขไม่มี deliveryConfirmedAt (ยังไม่เข้าพอร์ทัลลูกค้า) และไม่มีบิลให้ล็อก
            const { count } = await tx.plateSwap.updateMany({
              where: { id: v.id, cancelledAt: null },
              data: { deliveredDate: null, deliveryRecipient: null, deliveryNote: null, plateDeliveredDate: null },
            });
            if (count !== 1) throw conflict(`รถ ${i.chassis} เพิ่งถูกแก้หรือยกเลิก - โหลดรายการใหม่`);
            return;
          }
          const { count } = await tx.vehicle.updateMany({
            where: { id: v.id, ...NOT_BILLED },
            data: { deliveredDate: null, deliveryRecipient: null, deliveryNote: null, plateDeliveredDate: null, deliveryConfirmedAt: null },
          });
          if (count !== 1) throw conflict(`รถ ${i.chassis} เพิ่งวางบิลหรือปิดงาน ยกเลิกการส่งไม่ได้`);
        });
      } else {
        if (v.plateDeliveredDate) changes.plateDeliveredDate = { from: isoDay(v.plateDeliveredDate), to: null };
        writes.push(async (tx) => {
          const data = { plateDeliveredDate: null, deliveryNote: stripPlateNote(v.deliveryNote) };
          if (source === 'PLATE_SWAP') await tx.plateSwap.update({ where: { id: v.id }, data });
          else await tx.vehicle.update({ where: { id: v.id }, data });
        });
      }
      writes.push(async (tx) => {
        // ยกเลิกรายการเดียวกันพร้อมกันสองเครื่อง - เครื่องหลังต้องไม่ทับ
        const { count } = await tx.deliverySlipItem.updateMany({
          where: { id: i.id, cancelledAt: null },
          data: { cancelledAt: now, cancelReason: remark, cancelledById },
        });
        if (count !== 1) throw conflict(`รถ ${i.chassis} ถูกยกเลิกจากใบนี้ไปแล้ว`);
        if (source === 'PLATE_SWAP') {
          await writeAudit(tx, { entity: 'PlateSwap', entityId: v.id, action: 'delivery-cancel', remark, changes });
        } else {
          await this.editLog(v.id, remark, changes, tx);
        }
      });
    }
    await this.prisma.$transaction(async (tx) => {
      for (const write of writes) await write(tx);
      // ครบทุกคัน = ยกเลิกทั้งใบ
      if (slip.items.every((i) => i.cancelledAt || cancelledItemIds.has(i.id))) {
        await tx.deliverySlip.update({ where: { id }, data: { cancelledAt: now, cancelReason: remark, cancelledById } });
      }
    });
    return this.slip(id);
  }

  private async findActiveSlip(id: string) {
    const slip = await this.prisma.deliverySlip.findUnique({ where: { id }, include: SLIP_INCLUDE });
    if (!slip) throw new NotFoundException({ error: 'ไม่พบใบส่งงาน' });
    if (slip.cancelledAt) throw bad('ใบส่งงานนี้ถูกยกเลิกไปแล้ว');
    return slip;
  }

  private assertItemInScope(body: string | null, what: string) {
    if (!isVehicleInScope(body, currentWriteScope())) throw new ForbiddenException({ error: `${what}มีรถประเภทที่บัญชีของคุณไม่ได้ดูแล` });
  }

  private editLog(vehicleId: string, remark: string, changes: Record<string, unknown>, db: Pick<Tx, 'vehicleEditLog'> = this.prisma) {
    return db.vehicleEditLog.create({
      data: { vehicleId, remark, changes: JSON.stringify(changes), editedById: currentUser()?.id ?? null },
    });
  }

  private mapSlip(s: {
    id: string;
    slipNo: number;
    date: Date;
    recipient: string;
    note: string | null;
    createdAt: Date;
    cancelledAt: Date | null;
    cancelReason: string | null;
    customer: { id: string; name: string; company: string | null; branch: string | null; address: string | null; phone: string | null };
    createdBy: { name: string; displayName: string | null } | null;
    cancelledBy: { name: string; displayName: string | null } | null;
    items: Array<{
      id: string;
      vehicleId: string | null;
      plateSwapId: string | null;
      vehicleKind: string | null;
      ownerName: string | null;
      receipt: boolean;
      book: boolean;
      plate: boolean;
      chassis: string;
      brandName: string;
      body: string | null;
      plateText: string;
      receiptNo: string | null;
      cancelledAt: Date | null;
      cancelReason: string | null;
      cancelledBy: { name: string; displayName: string | null } | null;
      vehicle: {
        invoiceLines: Array<{ invoice: { invoiceNo: string } }>;
        billingClosedAt: Date | null;
        owner: { name: string | null; hirerName: string | null } | null;
      } | null;
    }>;
  }, later = new Map<string, { slipNo: number; date: string }>()) {
    return {
      id: s.id,
      slipNo: s.slipNo,
      date: s.date.toISOString().slice(0, 10),
      recipient: s.recipient,
      note: s.note,
      createdAt: s.createdAt.toISOString(),
      createdBy: userName(s.createdBy),
      cancelledAt: s.cancelledAt?.toISOString() ?? null,
      cancelReason: s.cancelReason,
      cancelledBy: userName(s.cancelledBy),
      customer: { ...s.customer, displayName: s.customer.company || s.customer.name },
      // ใบเก่าที่รวมรถยนต์ + จักรยานยนต์ (ก่อนห้ามรวม ผู้ใช้ 2026-09-27): คันอีกประเภทที่ยังไม่ยกเลิกซึ่งผู้ใช้นี้ไม่เห็น
      // หน้ารายงานซ่อนปุ่มแก้ (updateSlip ต้องการทุกคันในขอบเขต) และพิมพ์ซ้ำบอกว่าใบเต็มมีกี่คัน - ADMIN เห็นครบทุกคัน = 0
      hiddenItems: s.items.filter((i) => !i.cancelledAt && !itemInScope(i)).length,
      items: s.items
        .filter((i) => itemInScope(i))
        .sort((a, b) => a.plateText.localeCompare(b.plateText, 'th') || a.chassis.localeCompare(b.chassis))
        .map((i) => ({
          id: i.id,
          vehicleId: i.vehicleId,
          plateSwapId: i.plateSwapId,
          source: (i.plateSwapId ? 'PLATE_SWAP' : 'VEHICLE') as DeliverySource,
          chassis: i.chassis,
          brandName: i.brandName,
          body: i.body,
          // แถวงานสลับเลขไม่มี body ให้หน้าเว็บดูประเภทรถ - ปล่อยว่างแล้วจะถูกตีเป็นรถยนต์ (ผู้ใช้ 2026-09-28)
          vehicleKind: i.vehicleKind ?? (vehicleKindOf(i.body) as 'car' | 'moto'),
          plateText: i.plateText,
          receiptNo: i.receiptNo,
          receipt: i.receipt,
          book: i.book,
          plate: i.plate,
          cancelledAt: i.cancelledAt?.toISOString() ?? null,
          cancelReason: i.cancelReason,
          cancelledBy: userName(i.cancelledBy),
          // งานสลับเลขยังไม่เข้าระบบวางบิล จึงไม่มีบิล/ปิดงานให้ล็อก (ผู้ใช้ 2026-09-28)
          invoiceNo: i.vehicle?.invoiceLines[0]?.invoice.invoiceNo ?? null,
          // ปิดงาน - วางบิลนอกระบบ = ล็อกใบส่งเล่มเหมือนวางบิลแล้ว (2026-09-27)
          billingClosed: i.vehicle?.billingClosedAt != null,
          // แถวสลับเลขใช้ชื่อเจ้าของที่ snapshot ไว้ (ไม่มี VehicleOwner ให้อ่านสด)
          ownerName: i.ownerName ?? ownerNameOf(i.vehicle?.owner ?? null),
          // ส่งเล่มในใบนี้ ป้ายส่งตามไปในใบอื่น (อ่านสด) - null = ป้ายไปในใบนี้แล้ว / ยังค้างส่ง
          plateSentLater:
            i.book && !i.plate && !i.cancelledAt
              ? (later.get(i.plateSwapId ? itemKey('PLATE_SWAP', i.plateSwapId) : itemKey('VEHICLE', i.vehicleId ?? '')) ?? null)
              : null,
        })),
    };
  }

  private mapRow(v: {
    id: string;
    chassis: string;
    body: string | null;
    plateCategory: string | null;
    plateNumber: string | null;
    plateReceivedDate: Date | null;
    deliveredDate: Date | null;
    plateDeliveredDate: Date | null;
    deliveryRecipient: string | null;
    deliveryNote: string | null;
    bookReceivedDate: Date | null;
    customer: { id: string; name: string; company: string | null; branch?: string | null };
    brand: { name: string };
    documentSubmissions: Array<{ status: string; receiptNo: string | null; submitDate: Date; urgent: boolean; createdAt: Date }>;
    invoiceLines: Array<{ invoice: { invoiceNo: string } }>;
    deliverySlipItems: Array<{ slip: { id: string; slipNo: number; date: Date } }>;
  }) {
    const bookSlip = v.deliveredDate ? v.deliverySlipItems[0]?.slip : undefined;
    return {
      id: v.id,
      customerId: v.customer.id,
      customerName: v.customer.company || v.customer.name,
      // ใบยื่นแบ่งด้วย customerId - หน้าเว็บใช้ชื่อ/บริษัท/สาขาแยกลูกค้าชื่อซ้ำกันตอนแสดง (F47 ผู้ใช้ 2026-09-27)
      customer: { id: v.customer.id, name: v.customer.name, company: v.customer.company, branch: v.customer.branch ?? null },
      chassis: v.chassis,
      brandName: v.brand.name,
      body: v.body,
      plateCategory: v.plateCategory,
      plateNumber: v.plateNumber,
      receiptNo: v.documentSubmissions[0]?.receiptNo ?? null,
      kind: deliveryKind(v),
      plateReceived: v.plateReceivedDate !== null,
      deliveredDate: v.deliveredDate?.toISOString().slice(0, 10) ?? null,
      plateDeliveredDate: v.plateDeliveredDate?.toISOString().slice(0, 10) ?? null,
      recipient: v.deliveryRecipient,
      note: v.deliveryNote,
      invoiceNo: v.invoiceLines[0]?.invoice.invoiceNo ?? null,
      // ใบยื่นล่าสุด = lot ของรถคันนี้ (วันที่ยื่น + กลุ่ม รย./ด่วน + ลูกค้า)
      submitDate: v.documentSubmissions[0]?.submitDate.toISOString().slice(0, 10) ?? null,
      urgent: v.documentSubmissions[0]?.urgent ?? false,
      submittedAt: v.documentSubmissions[0]?.createdAt.toISOString() ?? null,
      submissionStatus: v.documentSubmissions[0]?.status ?? null,
      receiptReceived: v.documentSubmissions[0]?.status === 'RECEIPT_RECEIVED',
      bookReceived: v.bookReceivedDate !== null,
      // ใบที่ส่งเล่มไป (เฉพาะคันที่ส่งเล่มแล้ว) - ปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ในรายงานส่งงานอ้างถึงใบนี้
      bookSlip: bookSlip ? { id: bookSlip.id, slipNo: bookSlip.slipNo, date: bookSlip.date.toISOString().slice(0, 10) } : null,
      source: 'VEHICLE' as DeliverySource,
      // หน้าเว็บตัดสินขอบเขตจากช่องนี้ได้ทุกแถว ไม่ต้องแยกว่ามาจากที่ไหน (ผู้ใช้ 2026-09-28)
      vehicleKind: vehicleKindOf(v.body),
    };
  }

  // งานสลับเลขในคิวส่งงาน - รูปร่างเดียวกับ mapRow() เพื่อให้หน้า Delivery ใช้โค้ดชุดเดียวทั้งหน้า
  // ช่องที่เป็นของรถจดใหม่โดยเฉพาะ (invoiceNo, bookSlip, submissionStatus) ปล่อยว่าง - งานสลับเลขยังไม่เข้าระบบวางบิล
  private mapPlateSwapRow(
    s: PlateSwapRow & {
      submitDate: Date;
      deliveryRecipient: string | null;
      customer: { id: string; name: string; company: string | null; branch: string | null } | null;
      deliverySlipItems: Array<{ slip: { id: string; slipNo: number; date: Date } }>;
    },
  ) {
    const d = plateSwapDeliverable(s);
    const bookSlip = s.deliveredDate ? s.deliverySlipItems[0]?.slip : undefined;
    return {
      id: s.id,
      customerId: s.customer?.id ?? '',
      customerName: s.customer?.company || s.customer?.name || '',
      customer: s.customer
        ? { id: s.customer.id, name: s.customer.name, company: s.customer.company, branch: s.customer.branch }
        : { id: '', name: '', company: null, branch: null },
      chassis: d.chassis,
      brandName: d.brandName,
      body: null,
      plateCategory: s.newPlateCategory,
      plateNumber: s.newPlateNumber,
      receiptNo: s.receiptNo,
      kind: deliveryKind(d),
      plateReceived: s.plateReceivedDate !== null,
      deliveredDate: isoDay(s.deliveredDate),
      plateDeliveredDate: isoDay(s.plateDeliveredDate),
      recipient: s.deliveryRecipient,
      note: s.deliveryNote,
      invoiceNo: null,
      // lot ของงานสลับเลข = วันที่ยื่น + ลูกค้า (ไม่มีใบยื่นแบบรถจดใหม่) - หน้าเว็บจัดการ์ดด้วย source นี้
      submitDate: isoDay(s.submitDate),
      urgent: false,
      submittedAt: null,
      submissionStatus: null,
      receiptReceived: s.returnedDate !== null,
      bookReceived: s.bookReceivedDate !== null,
      // ใบที่ส่งเล่มไป - ปุ่ม "ป้ายไปพร้อมเล่มแล้ว" ใช้ได้กับงานสลับเลขเหมือนรถจดใหม่ (ผู้ใช้ 2026-09-28)
      bookSlip: bookSlip ? { id: bookSlip.id, slipNo: bookSlip.slipNo, date: bookSlip.date.toISOString().slice(0, 10) } : null,
      source: 'PLATE_SWAP' as DeliverySource,
      vehicleKind: d.vehicleKind,
    };
  }
}

