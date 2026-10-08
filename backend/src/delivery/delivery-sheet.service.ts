import { BadRequestException, Injectable } from '@nestjs/common';
import { currentUser } from '../auth/request-context.js';
import { currentVehicleScope, vehicleKindOf } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DeliveryService } from './delivery.service.js';

// ใบส่งงานรวมทุกประเภท (ผู้ใช้ 2026-10-05): เลือกเจ้าของงาน + ช่วงวันที่ แล้วดึงงานทุกประเภทที่ "ส่งแล้ว/เสร็จ" ในช่วงนั้นมารวมกัน
// อ่านอย่างเดียว ไม่มีราคา - ไม่แตะใบ DL (DeliverySlip) เดิม ไม่เพิ่มขั้นส่งงานให้งานประเภทอื่น
// วันที่ของแต่ละประเภท (งานที่ยังไม่มีขั้นส่งงานใช้วันที่ที่ถือว่างานนั้นเสร็จ):
// - รถจดใหม่ / สลับเลข   = วันที่บนใบ DL (รายการที่ยังไม่ยกเลิก)
// - ต่อภาษี              = วันที่คืนเอกสารให้ลูกค้า (deliveredDate)
// - ยกเลิกการใช้รถ / คัดป้าย / งานโอน / ย้ายออก = ตั้งแต่ 2026-10-08 ส่งงานผ่านใบ DL (แถวมาจากใบ DL ข้างบน) - งานที่ส่งก่อนมีใบ DL
//   (deliveredDate ที่ migration เติมให้งานที่วางบิลแล้ว / ต่อภาษีที่กรอกมือ) ยังขึ้นด้วยวันที่ส่งนั้น แต่แก้วันที่ไม่ได้จากหน้านี้
// - แจ้งย้ายยามาฮ่า       = วันที่แจ้งย้าย (ไม่มีเจ้าของงานในข้อมูล จึงขึ้นเป็นเจ้าของ "ยามาฮ่า" และไม่ออกเมื่อเลือกเจ้าของงานเฉพาะราย)
export type SheetSource = 'VEHICLE' | 'PLATE_SWAP' | 'TAX_RENEWAL' | 'USE_CANCEL' | 'PLATE_COPY' | 'TRANSFER' | 'MOVE_OUT' | 'YAMAHA';

export interface SheetCustomer {
  id: string;
  name: string;
  company: string | null;
  branch: string | null;
}

export interface SheetRow {
  key: string;
  source: SheetSource;
  jobId: string; // id ของงานต้นทาง (ใบ DL = id ใบ ใช้แก้วันที่ผ่านใบ)
  date: string; // YYYY-MM-DD
  dateLabel: string; // วันที่นี้คือวันอะไรของงานประเภทนี้
  customer: SheetCustomer | null; // null = ไม่ระบุเจ้าของงาน (งานเก่าก่อนบังคับกรอก) / ยามาฮ่าใช้ pseudo-customer
  kind: 'car' | 'moto' | null;
  chassis: string;
  plateText: string;
  brand: string;
  ownerName: string | null;
  detail: string; // ข้อความสั้นสรุปว่างานอะไร เช่น "เล่ม + ป้าย", "โอนตรวจรถ", "รถเล็ก 12 คัน"
  // ส่งเล่ม / ป้ายรอบนี้ - เฉพาะแถวจากใบ DL (null = งานประเภทอื่นที่ไม่มีขั้นส่งเล่ม/ป้าย)
  book: boolean | null;
  plate: boolean | null;
  slipId: string | null;
  slipNo: number | null;
  updatedAt: string | null; // ใช้ส่งกลับตอนแก้ (expectedUpdatedAt) กันแก้ทับกัน
}

export const YAMAHA_CUSTOMER: SheetCustomer = { id: 'YAMAHA', name: 'ยามาฮ่า (แจ้งย้าย)', company: null, branch: null };

import { motorcycleTypeWhere } from '../vehicles/vehicle-reference-data.js';
const PER_SOURCE_LIMIT = 1000;
// บทบาทที่อ่านงานนอกใบ DL ได้ (ตรงกับกฎ GET ของ plate-swaps / tax-renewals / plate-copies ... ใน access-policy.ts) - DELIVERY เห็นเฉพาะใบ DL
const JOB_READERS = ['ADMIN', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT'];

const bad = (error: string) => new BadRequestException({ error });

function parseOptionalIsoDate(raw: unknown, label: string): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) || !Number.isFinite(Date.parse(raw))) {
    throw bad(`${label}ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง`);
  }
  return new Date(`${raw}T00:00:00.000Z`);
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const plateOf = (category: string | null, number: string | null) => (category && number ? `${category} ${number}` : '');
const CUSTOMER_SELECT = { select: { id: true, name: true, company: true, branch: true } } as const;

const TRANSFER_LABEL: Record<string, string> = { OWNER: 'โอนตามผู้ถือกรรมสิทธิ์', INSPECTION: 'โอนตรวจรถ' };
const YAMAHA_SIZE_LABEL: Record<string, string> = { SMALL: 'รถเล็ก', LARGE: 'รถใหญ่' };

@Injectable()
export class DeliverySheetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveryService: DeliveryService,
  ) {}

  async sheet(query: { from?: unknown; to?: unknown; customerId?: unknown }): Promise<{ rows: SheetRow[]; truncated: boolean }> {
    const from = parseOptionalIsoDate(query?.from, 'วันที่เริ่ม');
    const to = parseOptionalIsoDate(query?.to, 'วันที่สิ้นสุด');
    if (from && to && from > to) throw bad('วันที่เริ่มต้องไม่เกินวันที่สิ้นสุด');
    const customerId = typeof query?.customerId === 'string' && query.customerId ? query.customerId : undefined;
    const dateWhere = from || to ? { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } : undefined;
    const scope = currentVehicleScope();
    const user = currentUser();
    const readsJobs = !user || user.roles.some((r) => JOB_READERS.includes(r));

    const rows: SheetRow[] = [];
    let truncated = false;

    // ใบ DL: ใช้ตัวอ่านเดิมของรายงานส่งงาน (ขอบเขตประเภทรถ / รายการที่ยกเลิก / เพดาน 500 ใบ ตรงกับหน้ารายงาน)
    const slips = await this.deliveryService.slips({ from: query?.from, to: query?.to, customerId });
    if (slips.truncated) truncated = true;
    for (const slip of slips.slips) {
      if (slip.cancelledAt) continue;
      const customer: SheetCustomer = { id: slip.customer.id, name: slip.customer.name, company: slip.customer.company, branch: slip.customer.branch };
      for (const item of slip.items) {
        if (item.cancelledAt) continue;
        rows.push({
          key: `${item.source}:${item.id}`,
          source: item.source,
          jobId: slip.id,
          date: slip.date,
          dateLabel: 'วันที่ส่งงาน',
          customer,
          kind: item.vehicleKind as 'car' | 'moto',
          chassis: item.chassis,
          plateText: item.plateText,
          brand: item.brandName,
          ownerName: item.ownerName,
          // งานอื่นในใบ DL (ผู้ใช้ 2026-10-08): รายการ = ชื่องานตอนส่ง (ใบเสร็จ + ป้ายถ้าเป็นคัดป้าย)
          detail: item.jobDetail ?? ([item.book ? 'เล่ม' : '', item.plate ? 'ป้าย' : ''].filter(Boolean).join(' + ') || '-'),
          book: item.book,
          plate: item.plate,
          slipId: slip.id,
          slipNo: slip.slipNo,
          updatedAt: null,
        });
      }
    }
    if (!readsJobs || scope === 'NONE') return { rows: sortRows(rows), truncated };

    const classWhere = scope === 'ALL' ? {} : { vehicleClass: scope === 'MOTO' ? 'MOTO' : 'CAR' };
    const customerWhere = customerId ? { customerId } : {};
    const take = PER_SOURCE_LIMIT + 1;

    const [renewals, cancellations, plateCopies, transfers, moveOuts, yamaha] = await Promise.all([
      this.prisma.taxRenewal.findMany({
        where: {
          cancelledAt: null,
          deliveredDate: dateWhere ?? { not: null },
          ...customerWhere,
          ...(scope === 'MOTO'
            ? motorcycleTypeWhere('vehicleType')
            : scope === 'CAR'
              ? { NOT: motorcycleTypeWhere('vehicleType') }
              : {}),
        },
        include: { customer: CUSTOMER_SELECT },
        orderBy: { deliveredDate: 'desc' },
        take,
      }),
      this.prisma.vehicleUseCancellation.findMany({
        where: { cancelledAt: null, deliveredDate: dateWhere ?? { not: null }, ...customerWhere, ...classWhere },
        include: { customer: CUSTOMER_SELECT },
        orderBy: { deliveredDate: 'desc' },
        take,
      }),
      // คัดป้ายมีทั้งรถยนต์และมอเตอร์ไซค์ (ผู้ใช้ 2026-10-09) - กรองตามประเภทรถของงานเหมือนงานอื่น
      this.prisma.plateCopy.findMany({
        where: { cancelledAt: null, deliveredDate: dateWhere ?? { not: null }, ...customerWhere, ...classWhere },
        include: { customer: CUSTOMER_SELECT },
        orderBy: { deliveredDate: 'desc' },
        take,
      }),
      this.prisma.vehicleTransfer.findMany({
        where: { cancelledAt: null, deliveredDate: dateWhere ?? { not: null }, ...customerWhere, ...classWhere },
        include: { customer: CUSTOMER_SELECT },
        orderBy: { deliveredDate: 'desc' },
        take,
      }),
      this.prisma.vehicleMoveOut.findMany({
        where: { cancelledAt: null, deliveredDate: dateWhere ?? { not: null }, ...customerWhere, ...classWhere },
        include: { customer: CUSTOMER_SELECT },
        orderBy: { deliveredDate: 'desc' },
        take,
      }),
      // ยามาฮ่าไม่มีเจ้าของงานในข้อมูล - ไม่ออกเมื่อเลือกเจ้าของงานเฉพาะราย
      customerId
        ? Promise.resolve([])
        : this.prisma.yamahaRelocationEntry.findMany({
            where: { cancelledAt: null, ...(dateWhere ? { date: dateWhere } : {}) },
            orderBy: { date: 'desc' },
            take,
          }),
    ]);
    for (const list of [renewals, cancellations, plateCopies, transfers, moveOuts, yamaha]) if (list.length > PER_SOURCE_LIMIT) truncated = true;

    // งานที่ส่งผ่านใบ DL แล้วขึ้นจากใบ DL ข้างบน - ตัดออกจากส่วนรายประเภท ไม่ให้ซ้ำ (เหลือเฉพาะงานที่ส่งก่อนมีใบ DL)
    const inSlip = new Set(
      (
        await this.prisma.deliverySlipItem.findMany({
          where: { cancelledAt: null, jobType: { not: null }, jobId: { in: [...renewals, ...cancellations, ...plateCopies, ...transfers, ...moveOuts].map((r) => r.id) } },
          select: { jobType: true, jobId: true },
        })
      ).map((i) => `${i.jobType}:${i.jobId}`),
    );
    const LEGACY_LABEL = 'วันที่ส่งงาน (ลงไว้ก่อนมีใบ DL - แก้ไม่ได้จากหน้านี้)';

    for (const r of renewals.slice(0, PER_SOURCE_LIMIT)) {
      if (inSlip.has(`TAX_RENEWAL:${r.id}`)) continue;
      rows.push({
        key: `TAX_RENEWAL:${r.id}`,
        source: 'TAX_RENEWAL',
        jobId: r.id,
        date: isoDay(r.deliveredDate!),
        dateLabel: 'วันที่คืนเอกสารให้ลูกค้า (กรอกมือ)',
        customer: r.customer,
        kind: vehicleKindOf(r.vehicleType),
        chassis: r.chassis,
        plateText: plateOf(r.plateCategory, r.plateNumber),
        brand: '',
        ownerName: r.ownerName,
        detail: 'ต่อภาษี',
        book: null,
        plate: null,
        slipId: null,
        slipNo: null,
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    for (const r of cancellations.slice(0, PER_SOURCE_LIMIT)) {
      if (inSlip.has(`USE_CANCEL:${r.id}`)) continue;
      rows.push({
        key: `USE_CANCEL:${r.id}`,
        source: 'USE_CANCEL',
        jobId: r.id,
        date: isoDay(r.deliveredDate!),
        dateLabel: LEGACY_LABEL,
        customer: r.customer,
        kind: r.vehicleClass === 'MOTO' ? 'moto' : 'car',
        chassis: r.chassis,
        plateText: plateOf(r.plateCategory, r.plateNumber),
        brand: r.brand,
        ownerName: r.ownerName,
        detail: 'ยกเลิกการใช้รถ',
        book: null,
        plate: null,
        slipId: null,
        slipNo: null,
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    for (const r of plateCopies.slice(0, PER_SOURCE_LIMIT)) {
      if (inSlip.has(`PLATE_COPY:${r.id}`)) continue;
      rows.push({
        key: `PLATE_COPY:${r.id}`,
        source: 'PLATE_COPY',
        jobId: r.id,
        date: isoDay(r.deliveredDate!),
        dateLabel: LEGACY_LABEL,
        customer: r.customer,
        kind: r.vehicleClass === 'MOTO' ? 'moto' : 'car',
        chassis: r.chassis,
        plateText: plateOf(r.plateCategory, r.plateNumber),
        brand: r.brand,
        ownerName: r.ownerName,
        detail: 'คัดแผ่นป้ายทะเบียน',
        book: null,
        plate: null,
        slipId: null,
        slipNo: null,
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    for (const r of transfers.slice(0, PER_SOURCE_LIMIT)) {
      if (inSlip.has(`TRANSFER:${r.id}`)) continue;
      rows.push({
        key: `TRANSFER:${r.id}`,
        source: 'TRANSFER',
        jobId: r.id,
        date: isoDay(r.deliveredDate!),
        dateLabel: LEGACY_LABEL,
        customer: r.customer,
        kind: r.vehicleClass === 'MOTO' ? 'moto' : 'car',
        chassis: r.chassis,
        plateText: plateOf(r.plateCategory, r.plateNumber),
        brand: r.brand,
        // งานโอนมี 2 ฝ่าย - แสดงผู้รับโอน (ชื่อเต็มของทั้งคู่อยู่ในหน้างานโอน)
        ownerName: r.transfereeName,
        detail: TRANSFER_LABEL[r.transferType] ?? 'งานโอน',
        book: null,
        plate: null,
        slipId: null,
        slipNo: null,
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    for (const r of moveOuts.slice(0, PER_SOURCE_LIMIT)) {
      if (inSlip.has(`MOVE_OUT:${r.id}`)) continue;
      rows.push({
        key: `MOVE_OUT:${r.id}`,
        source: 'MOVE_OUT',
        jobId: r.id,
        date: isoDay(r.deliveredDate!),
        dateLabel: LEGACY_LABEL,
        customer: r.customer,
        kind: r.vehicleClass === 'MOTO' ? 'moto' : 'car',
        chassis: r.chassis,
        plateText: plateOf(r.plateCategory, r.plateNumber),
        brand: r.brand,
        ownerName: r.ownerName,
        detail: 'ย้ายออก',
        book: null,
        plate: null,
        slipId: null,
        slipNo: null,
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    for (const r of yamaha.slice(0, PER_SOURCE_LIMIT)) {
      rows.push({
        key: `YAMAHA:${r.id}`,
        source: 'YAMAHA',
        jobId: r.id,
        date: isoDay(r.date),
        dateLabel: 'วันที่แจ้งย้าย',
        customer: YAMAHA_CUSTOMER,
        kind: null,
        chassis: '',
        plateText: '',
        brand: '',
        ownerName: null,
        detail: `${YAMAHA_SIZE_LABEL[r.size] ?? r.size} ${r.count} คัน`,
        book: null,
        plate: null,
        slipId: null,
        slipNo: null,
        updatedAt: null,
      });
    }
    return { rows: sortRows(rows), truncated };
  }
}

// วันที่ล่าสุดก่อน แล้วลำดับประเภทงาน ทะเบียน เลขตัวถัง - หน้าเว็บจัดกลุ่มตามเจ้าของงาน + วันที่ต่อเอง
const SOURCE_ORDER: SheetSource[] = ['VEHICLE', 'PLATE_SWAP', 'TAX_RENEWAL', 'USE_CANCEL', 'PLATE_COPY', 'TRANSFER', 'MOVE_OUT', 'YAMAHA'];
function sortRows(rows: SheetRow[]): SheetRow[] {
  return rows.sort(
    (a, b) =>
      b.date.localeCompare(a.date) ||
      SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) ||
      (a.slipNo ?? 0) - (b.slipNo ?? 0) ||
      a.plateText.localeCompare(b.plateText, 'th') ||
      a.chassis.localeCompare(b.chassis),
  );
}
