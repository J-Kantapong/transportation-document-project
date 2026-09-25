import { BadRequestException, Injectable } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { currentVehicleScope, vehicleKindOf, vehicleTypeWhere, type VehicleKind } from '../auth/vehicle-scope.js';
import { bangkokToday, daysBetween } from '../overview/overview-calculator.js';
import { STAGES, waitsFor, type Flag, type StageKey } from '../overview/overview-process.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { vehicleListWhere } from '../vehicles/vehicle-list-filter.js';

// หน้าค้นหารถ (ผู้ใช้ 2026-09-25): ค้นรถจดใหม่ทั้งฐานข้อมูล พร้อมสถานะว่าตอนนี้ค้างอยู่ขั้นไหน ค้างมากี่วัน และมีปัญหาอะไร
// สถานะคำนวณด้วย waitsFor() ตัวเดียวกับภาพรวมผู้บริหาร จึงตรงกับคิวจริงของแต่ละหน้า - อ่านอย่างเดียว
// ขอบเขต: STAFF_ENTRY / ADMIN / ACCOUNTANT เห็นทุกคัน, STAFF_CAR / STAFF_MOTO เห็นเฉพาะประเภทรถของตัวเอง

const PAGE_SIZE = 100;
const NOT_VOID = { invoice: { status: { not: 'VOID' } } } as const;

// ขั้นที่รถจดใหม่ค้างได้ (ไม่รวมสลับเลข/ต่อภาษี ซึ่งเป็นงานแยก) ตามลำดับงานจริง
export const SEARCH_STAGES = [
  'transfer',
  'inspectSend',
  'inspectResult',
  'submit',
  'receipt',
  'plate',
  'book',
  'delivery',
  'plateDelivery',
  'billing',
] as const satisfies readonly StageKey[];

// ตัวกรองสถานะ: ขั้นที่ค้าง | done = จบงานแล้ว (ส่งงาน + ป้าย + วางบิลครบ) | problem = มีปัญหาหรือเกินกำหนด
export type StatusFilter = (typeof SEARCH_STAGES)[number] | 'done' | 'problem';
const STATUS_FILTERS: readonly string[] = [...SEARCH_STAGES, 'done', 'problem'];

export interface VehicleStatus {
  stage: StageKey;
  label: string;
  href: string;
  since: string;
  days: number;
  sla: number;
  late: boolean;
  flags: Flag[];
  reason: string | null;
}

export interface VehicleSearchRow {
  id: string;
  date: string;
  kind: VehicleKind;
  customerName: string;
  brandName: string;
  chassis: string;
  engine: string | null;
  plate: string | null;
  statuses: VehicleStatus[]; // ว่าง = จบงานแล้ว
  problem: boolean;
}

export interface VehicleSearchParams {
  q?: string;
  from?: string;
  to?: string;
  status?: string;
  kind?: string;
  offset?: string;
}

const isoOf = (d: Date) => d.toISOString().slice(0, 10);

@Injectable()
export class VehicleSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(params: VehicleSearchParams, today: string = bangkokToday()) {
    const status = params.status?.trim() || null;
    if (status && !STATUS_FILTERS.includes(status)) throw new BadRequestException({ error: 'สถานะที่เลือกไม่ถูกต้อง' });
    const kind = params.kind?.trim() || null;
    if (kind && kind !== 'car' && kind !== 'moto') throw new BadRequestException({ error: 'ประเภทรถต้องเป็น car หรือ moto' });
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);

    const vehicles = await this.prisma.vehicle.findMany({
      where: { ...vehicleListWhere(params), ...this.scopeWhere() },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        date: true,
        chassis: true,
        engine: true,
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
    });

    const rows: VehicleSearchRow[] = vehicles.map((v) => {
      const statuses = waitsFor(
        {
          ...v,
          latestSubmission: v.documentSubmissions[0] ?? null,
          hasPendingPlateSwap: v.plateSwapsAsNew.length > 0,
          billed: v.invoiceLines.length > 0,
        },
        today,
      ).map((w): VehicleStatus => {
        const stage = STAGES[w.stage];
        const days = Math.max(0, daysBetween(w.since, today));
        return { stage: w.stage, label: stage.label, href: stage.href, since: w.since, days, sla: stage.sla, late: days > stage.sla, flags: w.flags, reason: w.reason };
      });
      return {
        id: v.id,
        date: isoOf(v.date),
        kind: vehicleKindOf(v.body),
        customerName: v.customer.name,
        brandName: v.brand.name,
        chassis: v.chassis,
        engine: v.engine,
        plate: v.plateCategory && v.plateNumber ? `${v.plateCategory} ${v.plateNumber}` : null,
        statuses,
        problem: statuses.some((s) => s.late || s.flags.length > 0),
      };
    });

    // จำนวนต่อสถานะ (ตามคำค้น/วันที่/ประเภทรถ แต่ก่อนกรองสถานะ) ไว้แสดงบนปุ่มกรอง - รถคันเดียวค้างได้หลายขั้นพร้อมกัน (ป้าย + เล่ม)
    const kindRows = kind ? rows.filter((r) => r.kind === kind) : rows;
    const counts = Object.fromEntries(STATUS_FILTERS.map((s) => [s, 0])) as Record<StatusFilter, number>;
    for (const r of kindRows) {
      if (!r.statuses.length) counts.done += 1;
      if (r.problem) counts.problem += 1;
      for (const s of new Set(r.statuses.map((x) => x.stage))) counts[s as StatusFilter] += 1;
    }

    const matched = status ? kindRows.filter((r) => matchesStatus(r, status as StatusFilter)) : kindRows;
    return {
      vehicles: matched.slice(offset, offset + PAGE_SIZE),
      total: matched.length,
      all: kindRows.length,
      hasMore: matched.length > offset + PAGE_SIZE,
      counts,
    };
  }

  // STAFF_ENTRY ทำขั้น 1-3 ของรถทุกประเภท จึงค้นได้ทุกคัน - นอกนั้นใช้ขอบเขตขั้น 4-8 ตามปกติ (vehicle-scope.ts)
  private scopeWhere() {
    const roles = currentUser()?.roles ?? [];
    return roles.includes('STAFF_ENTRY') ? {} : vehicleTypeWhere(currentVehicleScope());
  }
}

function matchesStatus(row: VehicleSearchRow, status: StatusFilter): boolean {
  if (status === 'done') return row.statuses.length === 0;
  if (status === 'problem') return row.problem;
  return row.statuses.some((s) => s.stage === status);
}
