import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { dutyAmountOf, type FeeItem } from '../plate-swap/plate-swap-fee.js';
import { type AuditChanges, diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { assertKindInScope, currentVehicleScope } from '../auth/vehicle-scope.js';
import { Prisma } from '../generated/prisma/client.js';
import { bangkokToday } from '../overview/overview-calculator.js';
import {
  isoDate,
  optionalText,
  parseExpectedUpdatedAt,
  parseIsoDate,
  requiredText,
  sameTime,
  toUtcDate,
} from '../plate-swap/plate-swap.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { transferHasInspection } from '../vehicle-transfer/transfer-type.js';
import { isMotorcycleType, isTransportType } from '../vehicles/vehicle-reference-data.js';
import {
  BLOCK_REASON_LABEL,
  type OldJobStatus,
  type OldJobType,
  OLD_JOB_TYPE_LABEL,
  chassisKeyOf,
  chassisWarnings,
  cleanChassis,
  inspectionRequiredFor,
  intakeStatus,
  isBlockReason,
  isClosedStatus,
  isOldJobType,
  isOldVehicleType,
  linkedStatus,
  vehicleClassOfType,
  workingDaysBetween,
} from './old-vehicle-job-rules.js';

// หน้ารวม "งานรถเก่า" (ผู้ใช้ 2026-11-18): รับงาน -> เลือกประเภทงาน -> ตรวจรถ (เฉพาะที่ต้องตรวจ) -> ยื่น -> รับเอกสาร -> ส่งงาน
// รอบที่ 1: รับงาน + หน้ารวม + ตรวจรถก่อนยื่น + ติดขัด - ขั้นยื่นและหลังจากนั้นยังทำในหน้าเดิมของแต่ละงาน
// งานที่ยื่นจากหน้าเดิมถูกผูกกลับมาอัตโนมัติด้วย sync() (เทียบเลขตัวถัง + ประเภทงาน) และงานที่คีย์ไว้ก่อนมีหน้านี้
// ได้แถวรับงานย้อนหลัง (receivedIsBackfill, วันที่รับ = วันที่สร้างงาน) - ไม่แตะ service ของงานเดิม
// สิทธิ์: กลุ่มยื่นเอกสาร (รถยนต์ = STAFF_CAR, มอเตอร์ไซค์ = STAFF_MOTO), ACCOUNTANT อ่าน - ดู access-policy.ts

export type OldVehicleClass = 'CAR' | 'MOTO';

export interface HubCustomer {
  id: string;
  name: string;
  company: string | null;
}

export interface HubJobFees {
  bill: number | null; // ค่าธรรมเนียมตามใบเสร็จที่ระบบคิดไว้ (ต่อภาษีที่ยังไม่ชำระ = null)
  noBill: number | null; // ลงขัน ฯลฯ ไม่รวมค่าอากร
  duty: number; // ค่าอากร แยกต่างหาก
  inspectionCost: number; // ค่าตรวจรถ (งานโอนที่มีขั้นตรวจ) - ไม่อยู่ใน noBill
  receiptAmount: number | null; // ยอดบนใบเสร็จจริง (ถ้าแนบ / อ่านแล้ว)
}

export interface HubNewVehicle {
  id: string;
  chassis: string;
  brandName: string;
  plate: string | null;
}

export interface HubJob {
  id: string;
  jobType: OldJobType | null;
  jobTypeLabel: string | null;
  jobId: string | null; // id ของงานจริง (ยื่นแล้ว)
  // แบบย่อยของงาน - หน้าเว็บใช้สร้างลิงก์ไปหน้าของงานนั้น: งานโอน = OWNER | INSPECTION | MOVE_IN / สลับเลข = OLD_NEW | OLD_OLD (รู้เมื่อยื่นแล้ว)
  variant: string | null;
  // คู่สลับเลข (รถเก่า กับ รถเก่า) - อีกคันของคู่ / null = ไม่มีคู่
  pair: { vehicleId: string; plate: string } | null;
  // สลับเลข รถเก่า กับ รถใหม่: รถใหม่ที่จะรับเลข (เลือกตอนรับงาน หรือที่ผูกจริงตอนยื่น) / null = ยังไม่ได้เลือก
  newVehicle: HubNewVehicle | null;
  status: OldJobStatus;
  customer: HubCustomer | null;
  receivedDate: string; // YYYY-MM-DD
  receivedIsBackfill: boolean;
  note: string | null;
  firstRegistrationDate: string | null;
  taxExpiryDate: string | null;
  inspectionRequired: boolean;
  inspectionSentType: string | null;
  inspectionSentDate: string | null;
  inspectionCost: string;
  inspectionResult: string | null;
  inspectionResultDate: string | null;
  blockedAt: string | null; // ISO
  blockedDays: number | null; // จำนวนวันทำการ (จันทร์-ศุกร์) ที่ติดขัดมาแล้ว (ผู้ใช้ 2026-11-18)
  blockedReason: string | null;
  blockedReasonLabel: string | null;
  blockedNote: string | null;
  // ยอดเงินของงานที่ยื่นแล้ว (snapshot ของงานจริง - ผู้ใช้ 2026-11-19 อยากเห็นในหน้ารวม) / null = ยังไม่ยื่น หรือบัญชีนี้ไม่เห็นราคา
  fees: HubJobFees | null;
  updatedAt: string;
}

export interface HubVehicle {
  id: string;
  vehicleType: string | null;
  vehicleClass: OldVehicleClass;
  plateCategory: string;
  plateNumber: string;
  chassis: string;
  engine: string | null;
  brand: string | null;
  ownerName: string | null;
  updatedAt: string;
  jobs: HubJob[]; // ใหม่สุดก่อน
}

export interface IntakeVehicleDto {
  vehicleId?: unknown; // รถที่มีอยู่แล้ว (รับงานเพิ่มให้คันเดิม) - ส่งมาแล้วไม่ต้องส่งข้อมูลรถ
  vehicleType?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  chassis?: unknown;
  engine?: unknown;
  brand?: unknown;
  ownerName?: unknown;
  jobType?: unknown; // เว้นว่างได้ = รอทำ
  swapKind?: unknown; // สลับเลข: OLD_NEW | OLD_OLD (บังคับเมื่อ jobType = PLATE_SWAP)
  pairKey?: unknown; // สลับเลข OLD_OLD: ข้อความเดียวกันในสองคันที่เป็นคู่กัน (ต้องมาครบ 2 คันในคำขอเดียว)
  newVehicleId?: unknown; // สลับเลข OLD_NEW: รถใหม่ที่จะรับเลข (ไม่บังคับ)
  firstRegistrationDate?: unknown; // ต่อภาษี
  taxExpiryDate?: unknown; // ต่อภาษี
  note?: unknown;
  duplicateReason?: unknown; // บังคับเมื่อคันนี้มีงานประเภทเดิมที่ยังไม่เสร็จ
}

export interface IntakeDto {
  customerId?: unknown;
  receivedDate?: unknown;
  vehicles?: unknown;
}

export interface ChooseTypeDto {
  jobType?: unknown;
  swapKind?: unknown; // สลับเลข: เลือกได้เฉพาะ OLD_NEW (OLD_OLD ต้องรับ 2 คันพร้อมกันจากฟอร์มรับงาน)
  newVehicleId?: unknown; // สลับเลข OLD_NEW: รถใหม่ที่จะรับเลข (ไม่บังคับ, ส่งค่าว่าง = ล้าง)
  firstRegistrationDate?: unknown;
  taxExpiryDate?: unknown;
  duplicateReason?: unknown;
}

export interface UpdateOldVehicleDto {
  vehicleType?: unknown;
  plateCategory?: unknown;
  plateNumber?: unknown;
  chassis?: unknown;
  engine?: unknown;
  brand?: unknown;
  ownerName?: unknown;
  remark?: unknown;
  expectedUpdatedAt?: unknown;
}

const customerSelect = { id: true, name: true, company: true } as const;
const vehicleInclude = {
  jobs: { where: { cancelledAt: null }, include: { customer: { select: customerSelect } } },
} satisfies Prisma.OldVehicleInclude;
type VehicleRecord = Prisma.OldVehicleGetPayload<{ include: typeof vehicleInclude }>;
type JobRecord = VehicleRecord['jobs'][number];

// แถวของงานจริงที่ยังไม่มีแถวรับงาน (sync) - รูปเดียวกันทุกตาราง
interface UnlinkedJob {
  jobType: OldJobType;
  id: string;
  vehicleClass: string;
  vehicleType: string | null;
  customerId: string | null;
  ownerName: string | null;
  engine: string | null;
  chassis: string;
  brand: string | null;
  plateCategory: string;
  plateNumber: string;
  createdAt: Date;
  createdById: string | null;
  variant?: string | null; // สลับเลข: OLD_NEW | OLD_OLD
  pairId?: string | null; // สลับเลข รถเก่า กับ รถเก่า: pairId ของ PlateSwap (สองแถวของคู่ใช้ค่าเดียวกัน)
}

interface LinkedInfo {
  status: OldJobStatus;
  variant: string | null;
  fees?: HubJobFees;
  newVehicleId?: string | null; // สลับเลขที่ยื่นแล้ว: รถใหม่ที่ผูกจริง
}

const STALE_ERROR = 'ข้อมูลนี้ถูกแก้ไปก่อนแล้ว - โหลดรายการใหม่';
const DAY_MS = 86_400_000;
const LOAD_CAP = 5000; // จำนวนรถสูงสุดที่อ่านมาคิดสถานะต่อครั้ง
const PAGE_CAP = 500; // จำนวนรถสูงสุดที่ส่งให้หน้าเว็บ
// รถใหม่ของงานสลับเลข: ยื่นแล้วใช้คันที่ผูกจริงในงานสลับเลข / ยังไม่ยื่นใช้คันที่เลือกตอนรับงาน
const newVehicleIdOf = (job: { jobId: string | null; newVehicleId: string | null }, linked: Map<string, LinkedInfo>): string | null =>
  job.jobId ? (linked.get(job.jobId)?.newVehicleId ?? null) : job.newVehicleId;
const todayDate = () => toUtcDate(bangkokToday());
// เห็นยอดเงินของงาน: ADMIN / ฝ่ายยื่นเอกสาร / บัญชี (นอกคำขอ HTTP = เห็น)
const canSeePrices = () => {
  const user = currentUser();
  return !user || user.roles.some((r) => r === 'ADMIN' || r === 'STAFF_CAR' || r === 'STAFF_MOTO' || r === 'ACCOUNTANT');
};
// วันที่ตามเวลาไทยของเวลาที่บันทึก (createdAt เป็น UTC)
const bangkokDateOf = (at: Date) => toUtcDate(bangkokToday(at));
const isUniqueConflict = (err: unknown) => (err as { code?: string } | null)?.code === 'P2002';

function staleIfMissing(err: unknown): never {
  if ((err as { code?: string } | null)?.code === 'P2025') throw new ConflictException({ error: STALE_ERROR });
  throw err;
}

function parseClass(value: unknown): OldVehicleClass | null {
  if (value === undefined || value === null || value === '') return null;
  if (value === 'CAR' || value === 'MOTO') return value;
  throw new BadRequestException({ error: 'พารามิเตอร์ vehicleClass ต้องเป็น CAR หรือ MOTO' });
}

function parseCost(value: unknown): number {
  if (value === undefined || value === null || value === '') throw new BadRequestException({ error: 'กรุณากรอกค่าตรวจรถ (ไม่มีค่าตรวจให้ใส่ 0)' });
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num) || num < 0) throw new BadRequestException({ error: 'ค่าตรวจรถไม่ถูกต้อง' });
  return Math.round(num * 100) / 100;
}

function assertNotFuture(label: string, date: Date) {
  if (isoDate(date)! > bangkokToday()) throw new BadRequestException({ error: `${label}ต้องไม่เกินวันนี้` });
}

@Injectable()
export class OldVehicleJobsService {
  private readonly logger = new Logger(OldVehicleJobsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // สิทธิ์ในหน้างานรถเก่า (ผู้ใช้ 2026-11-18: "admin staff entry delivery" คือคนคีย์รับงาน)
  // - กลุ่มรับงาน (ADMIN / STAFF_ENTRY / DELIVERY): รับงานใหม่ได้ทุกประเภทรถ - STAFF_ENTRY / DELIVERY "เพิ่มได้อย่างเดียว อันอื่นกดไม่ได้"
  //   (ผู้ใช้ 2026-11-19): แก้ข้อมูลรถ / เปลี่ยนประเภทงาน / ติดขัด / ยกเลิก / ตรวจรถ ไม่ได้ ยกเว้นถือ STAFF_CAR / STAFF_MOTO ด้วย
  // - กลุ่มยื่นเอกสาร (STAFF_CAR / STAFF_MOTO): ทำทุกอย่างของประเภทรถตัวเอง "ยกเว้นรับงานใหม่" และเป็นกลุ่มเดียว (กับ ADMIN) ที่บันทึกตรวจรถได้
  // นอกคำขอ HTTP (unit test / script) ไม่จำกัด
  private isIntakeRole(): boolean {
    const user = currentUser();
    return !user || user.roles.some((r) => r === 'ADMIN' || r === 'STAFF_ENTRY' || r === 'DELIVERY');
  }

  private assertCanIntake() {
    if (!this.isIntakeRole()) throw new ForbiddenException({ error: 'รับงานใหม่ได้เฉพาะ ADMIN / พนักงานคีย์ข้อมูล / พนักงานส่งของ' });
  }

  // แก้ / จัดการงานที่รับแล้ว: ADMIN ทุกคัน / STAFF_CAR / STAFF_MOTO ตามประเภทรถ / คนรับงานอย่างเดียว (STAFF_ENTRY / DELIVERY) ไม่ได้
  private assertWritable(vehicleClass: string) {
    const user = currentUser();
    if (!user || user.roles.includes('ADMIN')) return;
    if (!user.roles.some((r) => r === 'STAFF_CAR' || r === 'STAFF_MOTO')) {
      throw new ForbiddenException({ error: 'บัญชีนี้รับงานได้อย่างเดียว - แก้หรือจัดการงานที่รับแล้วให้พนักงานยื่นเอกสาร' });
    }
    assertKindInScope(vehicleClass === 'MOTO' ? 'moto' : 'car');
  }

  // ตรวจรถก่อนยื่นเป็นงานของกลุ่มยื่นเอกสาร - กลุ่มรับงานที่ไม่ได้ถือ STAFF_CAR / STAFF_MOTO บันทึกไม่ได้
  private assertCanInspect(vehicleClass: string) {
    const user = currentUser();
    if (user && !user.roles.some((r) => r === 'ADMIN' || r === 'STAFF_CAR' || r === 'STAFF_MOTO')) {
      throw new ForbiddenException({ error: 'บันทึกตรวจรถได้เฉพาะพนักงานยื่นเอกสาร' });
    }
    if (user && !user.roles.includes('ADMIN')) assertKindInScope(vehicleClass === 'MOTO' ? 'moto' : 'car');
  }

  // ขอบเขตการอ่าน: กลุ่มรับงานเห็นทุกประเภทรถ (ต้องค้นรถเดิมก่อนรับงาน) กลุ่มอื่นตามขอบเขตปกติ
  private readScope() {
    const user = currentUser();
    if (user && user.roles.some((r) => r === 'STAFF_ENTRY' || r === 'DELIVERY')) return 'ALL' as const;
    return currentVehicleScope();
  }

  // ---------------------------------------------------------------------------------------------
  // สถานะของงานที่ยื่นแล้ว - อ่านจากตารางงานจริงทีละตาราง (เฉพาะช่องที่ใช้ตัดสินสถานะ)
  private async loadLinked(jobs: { jobType: string | null; jobId: string | null }[]): Promise<Map<string, LinkedInfo>> {
    const ids = new Map<string, string[]>();
    for (const job of jobs) {
      if (!job.jobType || !job.jobId) continue;
      const table = job.jobType.startsWith('TRANSFER_') ? 'TRANSFER' : job.jobType;
      ids.set(table, [...(ids.get(table) ?? []), job.jobId]);
    }
    const out = new Map<string, LinkedInfo>();
    const put = (id: string, status: OldJobStatus, variant: string | null = null, newVehicleId: string | null = null, fees?: HubJobFees) =>
      out.set(id, { status, variant, newVehicleId, fees });
    const base = { id: true, cancelledAt: true, returnedDate: true, deliveredDate: true } as const;
    // ยอดเงินของงานจริง - ตารางส่วนใหญ่เก็บค่าอากรแยกที่ dutyAmount
    const money = { billTotal: true, noBillTotal: true, dutyAmount: true, receiptAmount: true } as const;
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const feesOf = (r: { billTotal: unknown; noBillTotal: unknown; dutyAmount?: unknown; receiptAmount?: unknown; inspectionCost?: unknown }): HubJobFees => ({
      bill: n(r.billTotal),
      noBill: n(r.noBillTotal),
      duty: n(r.dutyAmount) ?? 0,
      inspectionCost: n(r.inspectionCost) ?? 0,
      receiptAmount: n(r.receiptAmount),
    });
    const idsOf = (table: string) => ids.get(table) ?? [];

    await Promise.all([
      idsOf('PLATE_SWAP').length
        ? this.prisma.plateSwap
            .findMany({
              where: { id: { in: idsOf('PLATE_SWAP') } },
              select: {
                ...base,
                kind: true,
                newVehicleId: true,
                buyNormalPlate: true,
                buyAuctionPlate: true,
                plateReceivedDate: true,
                plateDeliveredDate: true,
                bookReceivedDate: true,
                billTotal: true,
                noBillTotal: true,
                noBillItems: true,
                receiptAmount: true,
              },
            })
            .then((rows) =>
              rows.forEach((r) =>
                put(
                  r.id,
                  linkedStatus({
                    ...r,
                    needsPlate: r.buyNormalPlate || r.buyAuctionPlate,
                    needsBook: true,
                  }),
                  r.kind,
                  r.newVehicleId,
                  // สลับเลขเก็บค่าอากรรวมอยู่ใน noBillTotal - แยกออกให้ตรงกับงานอื่น
                  (() => {
                    const duty = dutyAmountOf(Array.isArray(r.noBillItems) ? (r.noBillItems as unknown as FeeItem[]) : []);
                    return { ...feesOf({ ...r, dutyAmount: duty }), noBill: Number(r.noBillTotal) - duty };
                  })(),
                ),
              ),
            )
        : null,
      idsOf('TRANSFER').length
        ? this.prisma.vehicleTransfer
            .findMany({
              where: { id: { in: idsOf('TRANSFER') } },
              select: { ...base, ...money, inspectionCost: true, transferType: true, inspectionSentDate: true, inspectionResult: true },
            })
            .then((rows) => rows.forEach((r) => put(r.id, linkedStatus({ ...r, hasInspection: transferHasInspection(r.transferType) }), r.transferType, null, feesOf(r))))
        : null,
      idsOf('TAX_RENEWAL').length
        ? this.prisma.taxRenewal
            .findMany({
              where: { id: { in: idsOf('TAX_RENEWAL') } },
              select: { id: true, cancelledAt: true, paymentDate: true, receivedDate: true, deliveredDate: true, billTotal: true, noBillTotal: true, receiptAmount: true },
            })
            .then((rows) => rows.forEach((r) => put(r.id, linkedStatus({ ...r, returnedDate: r.receivedDate }), null, null, feesOf(r))))
        : null,
      idsOf('USE_CANCEL').length
        ? this.prisma.vehicleUseCancellation
            .findMany({ where: { id: { in: idsOf('USE_CANCEL') } }, select: { ...base, ...money } })
            .then((rows) => rows.forEach((r) => put(r.id, linkedStatus(r), null, null, feesOf(r))))
        : null,
      idsOf('MOVE_OUT').length
        ? this.prisma.vehicleMoveOut
            .findMany({ where: { id: { in: idsOf('MOVE_OUT') } }, select: { ...base, ...money } })
            .then((rows) => rows.forEach((r) => put(r.id, linkedStatus(r), null, null, feesOf(r))))
        : null,
      idsOf('PLATE_COPY').length
        ? this.prisma.plateCopy
            .findMany({ where: { id: { in: idsOf('PLATE_COPY') } }, select: { ...base, ...money, plateReceivedDate: true } })
            .then((rows) => rows.forEach((r) => put(r.id, linkedStatus({ ...r, needsPlate: true }), null, null, feesOf(r))))
        : null,
    ]);
    return out;
  }

  private statusOf(job: { jobType: string | null; jobId: string | null; inspectionRequired: boolean; inspectionSentDate: Date | null; inspectionResult: string | null }, linked: Map<string, LinkedInfo>): OldJobStatus {
    if (!job.jobId) return intakeStatus(job);
    // งานจริงหาไม่เจอ (ไม่ควรเกิด - งานไม่ถูกลบ) ถือว่าถูกยกเลิก
    return linked.get(job.jobId)?.status ?? 'CANCELLED';
  }

  private serializeJob(
    job: JobRecord,
    linked: Map<string, LinkedInfo>,
    pairs: Map<string, { vehicleId: string; plate: string }> = new Map(),
    newVehicles: Map<string, HubNewVehicle> = new Map(),
  ): HubJob {
    const jobType = isOldJobType(job.jobType) ? job.jobType : null;
    const blockedDays = job.blockedAt ? workingDaysBetween(isoDate(bangkokDateOf(job.blockedAt))!, bangkokToday()) : null;
    return {
      id: job.id,
      jobType,
      jobTypeLabel: jobType ? OLD_JOB_TYPE_LABEL[jobType] : null,
      jobId: job.jobId,
      variant: (job.jobId && linked.get(job.jobId)?.variant) || job.jobVariant || (jobType?.startsWith('TRANSFER_') ? jobType.slice('TRANSFER_'.length) : null),
      pair: pairs.get(job.id) ?? null,
      newVehicle: newVehicles.get(newVehicleIdOf(job, linked) ?? '') ?? null,
      status: this.statusOf(job, linked),
      customer: job.customer ?? null,
      receivedDate: isoDate(job.receivedDate)!,
      receivedIsBackfill: job.receivedIsBackfill,
      note: job.note,
      firstRegistrationDate: isoDate(job.firstRegistrationDate),
      taxExpiryDate: isoDate(job.taxExpiryDate),
      inspectionRequired: job.inspectionRequired,
      inspectionSentType: job.inspectionSentType,
      inspectionSentDate: isoDate(job.inspectionSentDate),
      inspectionCost: String(job.inspectionCost),
      inspectionResult: job.inspectionResult,
      inspectionResultDate: isoDate(job.inspectionResultDate),
      blockedAt: job.blockedAt ? job.blockedAt.toISOString() : null,
      blockedDays,
      blockedReason: job.blockedReason,
      blockedReasonLabel: isBlockReason(job.blockedReason) ? BLOCK_REASON_LABEL[job.blockedReason] : job.blockedReason,
      blockedNote: job.blockedNote,
      // ราคาไม่แสดงกับบัญชีที่ไม่ได้อยู่ฝ่ายยื่นเอกสาร / บัญชี (STAFF_ENTRY / DELIVERY ที่คีย์รับงาน)
      fees: (job.jobId && canSeePrices() ? linked.get(job.jobId)?.fees : null) ?? null,
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private serializeVehicle(
    vehicle: VehicleRecord,
    linked: Map<string, LinkedInfo>,
    pairs: Map<string, { vehicleId: string; plate: string }>,
    newVehicles: Map<string, HubNewVehicle>,
  ): HubVehicle {
    const jobs = vehicle.jobs
      .map((job) => this.serializeJob(job, linked, pairs, newVehicles))
      .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate) || b.updatedAt.localeCompare(a.updatedAt));
    return {
      id: vehicle.id,
      vehicleType: vehicle.vehicleType,
      vehicleClass: vehicle.vehicleClass === 'MOTO' ? 'MOTO' : 'CAR',
      plateCategory: vehicle.plateCategory,
      plateNumber: vehicle.plateNumber,
      chassis: vehicle.chassis,
      engine: vehicle.engine,
      brand: vehicle.brand,
      ownerName: vehicle.ownerName,
      updatedAt: vehicle.updatedAt.toISOString(),
      jobs,
    };
  }

  private async hubVehicles(vehicles: VehicleRecord[]): Promise<HubVehicle[]> {
    const jobs = vehicles.flatMap((v) => v.jobs);
    const [linked, pairs] = await Promise.all([this.loadLinked(jobs), this.loadPairs(jobs)]);
    const newVehicles = await this.loadNewVehicles(jobs.map((j) => newVehicleIdOf(j, linked)));
    return vehicles.map((v) => this.serializeVehicle(v, linked, pairs, newVehicles));
  }

  // อีกคันของคู่สลับเลข ของแต่ละแถวรับงานที่มี pairId (คู่ที่ถูกยกเลิกการรับงานไปแล้วไม่นับ)
  private async loadPairs(jobs: { id: string; pairId: string | null }[]): Promise<Map<string, { vehicleId: string; plate: string }>> {
    const pairIds = [...new Set(jobs.map((j) => j.pairId).filter((x): x is string => !!x))];
    const out = new Map<string, { vehicleId: string; plate: string }>();
    if (!pairIds.length) return out;
    const members = await this.prisma.oldVehicleJob.findMany({
      where: { pairId: { in: pairIds }, cancelledAt: null },
      select: { id: true, pairId: true, vehicleId: true, vehicle: { select: { plateCategory: true, plateNumber: true } } },
    });
    for (const job of jobs) {
      if (!job.pairId) continue;
      const other = members.find((m) => m.pairId === job.pairId && m.id !== job.id);
      if (other) out.set(job.id, { vehicleId: other.vehicleId, plate: `${other.vehicle.plateCategory} ${other.vehicle.plateNumber}` });
    }
    return out;
  }

  // รถใหม่ (ฐานข้อมูลรถจดใหม่) ที่งานสลับเลขอ้างถึง - รถที่ถูกลบไปแล้วไม่แสดง
  private async loadNewVehicles(ids: (string | null)[]): Promise<Map<string, HubNewVehicle>> {
    const wanted = [...new Set(ids.filter((x): x is string => !!x))];
    if (!wanted.length) return new Map();
    const rows = await this.prisma.vehicle.findMany({
      where: { id: { in: wanted }, deletedAt: null },
      select: { id: true, chassis: true, plateCategory: true, plateNumber: true, brand: { select: { name: true } } },
    });
    return new Map(
      rows.map((r) => [
        r.id,
        { id: r.id, chassis: r.chassis, brandName: r.brand.name, plate: r.plateCategory && r.plateNumber ? `${r.plateCategory} ${r.plateNumber}` : null },
      ]),
    );
  }

  // รถใหม่ที่จะรับเลขของงานสลับเลข รถเก่า กับ รถใหม่ (ไม่บังคับ): ต้องเป็นรถในฐานข้อมูลรถจดใหม่ที่ยังไม่ถูกลบ ประเภทเดียวกับรถเก่า
  // เงื่อนไขการผูกจริง (รถยื่นเอกสารไปแล้ว / ผูกกับงานสลับเลขอื่น) ตรวจตอนยื่นงานสลับเลข ไม่ตรวจซ้ำที่นี่
  private async resolveNewVehicleId(raw: unknown, typed: { jobType: OldJobType; jobVariant: string | null }, vehicleClass: string): Promise<string | null> {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) return null;
    if (typed.jobType !== 'PLATE_SWAP' || typed.jobVariant !== 'OLD_NEW') {
      throw new BadRequestException({ error: 'เลือกรถใหม่ได้เฉพาะงานสลับเลข รถเก่า กับ รถใหม่' });
    }
    const row = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, select: { id: true, body: true } });
    if (!row) throw new BadRequestException({ error: 'ไม่พบรถใหม่ที่เลือกในฐานข้อมูลรถจดใหม่' });
    if ((isMotorcycleType(row.body) ? 'MOTO' : 'CAR') !== vehicleClass) {
      throw new BadRequestException({ error: 'รถใหม่ที่เลือกต้องเป็นประเภทเดียวกับรถเก่า (รถยนต์กับรถยนต์ / มอเตอร์ไซค์กับมอเตอร์ไซค์)' });
    }
    return row.id;
  }

  private async reloadVehicle(id: string): Promise<{ vehicle: HubVehicle }> {
    const row = await this.prisma.oldVehicle.findUniqueOrThrow({ where: { id }, include: vehicleInclude });
    return { vehicle: (await this.hubVehicles([row]))[0] };
  }

  // บังคับรับงานก่อนยื่น (ผู้ใช้ 2026-11-18 เลือกแบบ ก: ทุกงานรถเก่าต้องเริ่มจากรับงาน) - เรียกจาก OldVehicleJobLinkInterceptor ก่อนสร้างงานจริง
  // เงื่อนไข: ต้องมีแถวรับงานที่ยังไม่ยื่น ไม่ถูกยกเลิก ของรถคันนี้ (เทียบเลขตัวถัง) ในประเภทงานเดียวกัน
  // และถ้างานนั้นต้องตรวจรถ ต้องตรวจผ่านแล้ว (ลำดับจริง: รับงาน -> ตรวจรถ -> ยื่น)
  // path ที่ไม่ใช่การสร้างงานรถเก่า หรืออ่านเลขตัวถังจากคำขอไม่ได้ = ไม่ตรวจ ปล่อยให้ service ของงานนั้นตอบ error ของตัวเอง
  async assertIntakeBeforeSubmit(path: string, body: unknown): Promise<void> {
    const b = (body ?? {}) as Record<string, unknown>;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const p = path.replace(/\/+$/, '').toLowerCase();
    let types: OldJobType[];
    let variant: string | null = null;
    let chassisList: string[];
    if (p === '/api/plate-swaps') {
      types = ['PLATE_SWAP'];
      variant = 'OLD_NEW';
      chassisList = [text(b.oldChassis)];
    } else if (p === '/api/plate-swaps/change') {
      types = ['PLATE_SWAP'];
      variant = 'CHANGE';
      chassisList = [text(b.oldChassis)];
    } else if (p === '/api/plate-swaps/pair') {
      types = ['PLATE_SWAP'];
      variant = 'OLD_OLD';
      chassisList = [text((b.carA as Record<string, unknown> | undefined)?.oldChassis), text((b.carB as Record<string, unknown> | undefined)?.oldChassis)];
    } else if (p === '/api/vehicle-transfers') {
      types = [b.transferType === 'MOVE_IN' ? 'TRANSFER_MOVE_IN' : b.transferType === 'INSPECTION' ? 'TRANSFER_INSPECTION' : 'TRANSFER_OWNER'];
      chassisList = [text(b.chassis)];
    } else if (p === '/api/tax-renewals') {
      types = ['TAX_RENEWAL'];
      let chassis = text(b.chassis);
      // รถจากฐานข้อมูลรถจดใหม่: คำขอส่ง vehicleId มา - อ่านเลขตัวถังจากรถคันนั้น
      if (!chassis && text(b.vehicleId)) {
        chassis = (await this.prisma.vehicle.findFirst({ where: { id: text(b.vehicleId), deletedAt: null }, select: { chassis: true } }))?.chassis ?? '';
      }
      chassisList = [chassis];
    } else if (p === '/api/vehicle-use-cancellations') {
      types = ['USE_CANCEL'];
      chassisList = [text(b.chassis)];
    } else if (p === '/api/vehicle-move-outs') {
      types = ['MOVE_OUT'];
      chassisList = [text(b.chassis)];
    } else if (p === '/api/plate-copies') {
      types = ['PLATE_COPY'];
      chassisList = [text(b.chassis)];
    } else {
      return;
    }
    for (const chassis of chassisList) {
      if (!chassis) continue; // ไม่มีเลขตัวถัง = service ของงานนั้นตอบ "กรุณากรอกเลขตัวถัง" เอง
      const label = OLD_JOB_TYPE_LABEL[types[0]];
      const rows = await this.prisma.oldVehicleJob.findMany({
        where: { cancelledAt: null, jobId: null, jobType: { in: types }, vehicle: { chassisKey: chassisKeyOf(chassis) }, ...(variant ? { jobVariant: variant } : {}) },
        select: { inspectionRequired: true, inspectionResult: true },
      });
      if (!rows.length) {
        throw new BadRequestException({
          error: `รถเลขตัวถัง ${chassis} ยังไม่ได้รับงาน "${label}" - รับงานที่เมนูงานรถเก่าก่อน แล้วกดยื่นจากหน้านั้น`,
        });
      }
      if (!rows.some((r) => !r.inspectionRequired || r.inspectionResult === 'PASS')) {
        throw new BadRequestException({ error: `รถเลขตัวถัง ${chassis} ต้องตรวจรถผ่านก่อนจึงยื่นได้ - บันทึกผลตรวจที่หน้าตรวจรถของงานรถเก่า` });
      }
    }
  }

  // แถวรับงาน 1 งาน + ข้อมูลรถ สำหรับเติมฟอร์มยื่นของหน้างานเดิม (รอบ 2 ผู้ใช้ 2026-11-18: กดยื่นจากหน้ารวมแล้วไม่ต้องกรอกข้อมูลรถซ้ำ)
  // pairVehicle = อีกคันของคู่สลับเลข รถเก่า กับ รถเก่า (ฟอร์มยื่นกรอก 2 คัน)
  async getJob(id: string): Promise<{ vehicle: HubVehicle; job: HubJob; pairVehicle: HubVehicle | null }> {
    const row = await this.prisma.oldVehicleJob.findFirst({ where: { id, cancelledAt: null }, select: { vehicleId: true, vehicle: { select: { vehicleClass: true } } } });
    if (!row) throw new NotFoundException({ error: 'ไม่พบการรับงานนี้ (อาจถูกยกเลิกไปแล้ว)' });
    const scope = this.readScope();
    if (scope !== 'ALL' && scope !== row.vehicle.vehicleClass) throw new ForbiddenException({ error: 'บัญชีของคุณไม่ได้ดูแลรถประเภทนี้' });
    const { vehicle } = await this.reloadVehicle(row.vehicleId);
    const job = vehicle.jobs.find((j) => j.id === id);
    if (!job) throw new NotFoundException({ error: 'ไม่พบการรับงานนี้ (อาจถูกยกเลิกไปแล้ว)' });
    const pairVehicle = job.pair ? (await this.reloadVehicle(job.pair.vehicleId)).vehicle : null;
    return { vehicle, job, pairVehicle };
  }

  // ---------------------------------------------------------------------------------------------
  // หน้ารวม: scope = open (ยังมีงานไม่เสร็จ - ค่าเริ่มต้น) | done (ทุกงานเสร็จ) | all · q = ทะเบียน / เลขตัวถัง / ชื่อเจ้าของรถ / ลูกค้า
  // ตัวกรองประเภทงานและสถานะทำที่หน้าเว็บ (ข้อมูลชุดเดียวกัน) - คืนไม่เกิน 500 คัน เรียงตามวันที่รับงานล่าสุด
  // scope = inspection: เฉพาะรถที่มีงานต้องตรวจรถและยังไม่ยื่น (หน้าตรวจรถ) - กรองใน SQL จึงไม่ขึ้นกับเพดานของหน้ารวม
  // counts = จำนวนรถที่ยังมีงานค้าง / งานเสร็จหมดแล้ว ตามคำค้นเดียวกัน (ผู้ใช้ 2026-11-19: หน้าแรกบอกว่ามีงานเสร็จแล้วกี่คัน กดดูได้)
  async list(
    scopeParam = 'open',
    qParam?: string,
    classParam?: unknown,
  ): Promise<{ vehicles: HubVehicle[]; truncated: boolean; counts: { open: number; done: number } }> {
    if (!['open', 'done', 'all', 'inspection'].includes(scopeParam)) {
      throw new BadRequestException({ error: 'พารามิเตอร์ scope ต้องเป็น open, done, all หรือ inspection' });
    }
    const wantClass = parseClass(classParam);
    const readScope = this.readScope();
    if (readScope === 'NONE') return { vehicles: [], truncated: false, counts: { open: 0, done: 0 } };
    const classes: OldVehicleClass[] = readScope === 'ALL' ? (wantClass ? [wantClass] : ['CAR', 'MOTO']) : [readScope];
    if (wantClass && !classes.includes(wantClass)) return { vehicles: [], truncated: false, counts: { open: 0, done: 0 } };

    // ผูกงานที่ยื่นจากหน้าเดิม + สร้างแถวย้อนหลัง - ล้มก็ยังแสดงรายการได้
    await this.sync().catch((err: unknown) => this.logger.error(`sync งานรถเก่าไม่สำเร็จ: ${String(err)}`));

    const q = typeof qParam === 'string' ? qParam.trim() : '';
    const key = q ? chassisKeyOf(q) : '';
    const where: Prisma.OldVehicleWhereInput = {
      vehicleClass: { in: classes },
      jobs: { some: scopeParam === 'inspection' ? { cancelledAt: null, jobId: null, inspectionRequired: true } : { cancelledAt: null } },
      ...(q
        ? {
            OR: [
              ...(key ? [{ chassisKey: { contains: key } }] : []),
              { plateNumber: { contains: q } },
              { plateCategory: { contains: q } },
              { ownerName: { contains: q, mode: 'insensitive' as const } },
              { jobs: { some: { cancelledAt: null, customer: { OR: [{ name: { contains: q, mode: 'insensitive' as const } }, { company: { contains: q, mode: 'insensitive' as const } }] } } } },
            ],
          }
        : {}),
    };
    // สถานะของงานที่ยื่นแล้วอยู่ในตารางงานจริง จึงกรอง open / done ในหน่วยความจำ - อ่านไม่เกิน LOAD_CAP คัน (คันที่รับงานล่าสุดก่อน:
    // รับงานทุกครั้งแตะ updatedAt ของรถ) ถึงเพดานเมื่อไร = truncated ให้หน้าเว็บบอกผู้ใช้ ไม่ตัดทิ้งเงียบๆ
    const rows = await this.prisma.oldVehicle.findMany({ where, include: vehicleInclude, orderBy: { updatedAt: 'desc' }, take: LOAD_CAP });
    const all = await this.hubVehicles(rows);
    const open = (v: HubVehicle) => v.jobs.some((j) => !isClosedStatus(j.status));
    const filtered = scopeParam === 'all' || scopeParam === 'inspection' ? all : all.filter((v) => (scopeParam === 'open' ? open(v) : !open(v)));
    filtered.sort((a, b) => (b.jobs[0]?.receivedDate ?? '').localeCompare(a.jobs[0]?.receivedDate ?? ''));
    const openCount = all.filter(open).length;
    return {
      vehicles: filtered.slice(0, PAGE_CAP),
      truncated: filtered.length > PAGE_CAP || rows.length === LOAD_CAP,
      counts: { open: openCount, done: all.length - openCount },
    };
  }

  // ค้นรถที่มีอยู่แล้วตอนพิมพ์ทะเบียน/เลขตัวถังในฟอร์มรับงาน - เจอ = เติมข้อมูลเดิมและรับงานเพิ่มให้คันเดิม
  async lookup(chassisRaw?: string, plateCategoryRaw?: string, plateNumberRaw?: string): Promise<{ vehicle: HubVehicle | null; plateMatches: HubVehicle[]; warnings: string[] }> {
    const chassis = typeof chassisRaw === 'string' ? chassisRaw.trim() : '';
    const plateCategory = typeof plateCategoryRaw === 'string' ? plateCategoryRaw.trim() : '';
    const plateNumber = typeof plateNumberRaw === 'string' ? plateNumberRaw.trim() : '';
    const key = chassis ? chassisKeyOf(chassis) : '';
    const [byChassis, byPlate] = await Promise.all([
      key ? this.prisma.oldVehicle.findUnique({ where: { chassisKey: key }, include: vehicleInclude }) : null,
      plateCategory && plateNumber
        ? this.prisma.oldVehicle.findMany({ where: { plateCategory, plateNumber, ...(key ? { NOT: { chassisKey: key } } : {}) }, include: vehicleInclude, take: 5 })
        : [],
    ]);
    const readable = (v: { vehicleClass: string }) => {
      const scope = this.readScope();
      return scope === 'ALL' || scope === v.vehicleClass;
    };
    const hub = await this.hubVehicles([...(byChassis ? [byChassis] : []), ...byPlate].filter(readable));
    const vehicle = byChassis && readable(byChassis) ? hub[0] : null;
    return { vehicle, plateMatches: vehicle ? hub.slice(1) : hub, warnings: chassis ? chassisWarnings(chassis) : [] };
  }

  // ---------------------------------------------------------------------------------------------
  private async resolveCustomerId(raw: unknown): Promise<string> {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) throw new BadRequestException({ error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' });
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) throw new BadRequestException({ error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' });
    return customer.id;
  }

  private async resolveBrandName(raw: unknown): Promise<string> {
    const name = requiredText(raw, 'ยี่ห้อ', 100);
    const brand = await this.prisma.brand.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { name: true } });
    if (!brand) throw new BadRequestException({ error: 'กรุณาเลือกยี่ห้อจากรายการ' });
    return brand.name;
  }

  private parseVehicleType(raw: unknown): string {
    if (!isOldVehicleType(raw)) throw new BadRequestException({ error: 'กรุณาเลือกประเภทรถ (รย. / ขส.) จากรายการ' });
    return raw;
  }

  // ข้อมูลของประเภทงานที่เลือก: ต่อภาษีต้องรู้วันจดทะเบียนครั้งแรก + วันครบภาษี เพื่อให้ระบบตัดสินเรื่องตรวจรถ
  private jobTypeData(
    vehicle: { vehicleType: string | null; vehicleClass: string },
    dto: { jobType?: unknown; swapKind?: unknown; firstRegistrationDate?: unknown; taxExpiryDate?: unknown },
  ) {
    if (!isOldJobType(dto.jobType)) throw new BadRequestException({ error: 'กรุณาเลือกประเภทงานจากรายการ' });
    const jobType = dto.jobType;
    if (isTransportType(vehicle.vehicleType) && jobType !== 'TAX_RENEWAL') {
      throw new BadRequestException({ error: 'รถตาม พ.ร.บ.ขนส่ง (ขส.) ทำได้เฉพาะงานต่อภาษี' });
    }
    // สลับเลขต้องบอกแบบตั้งแต่รับงาน (ผู้ใช้ 2026-11-18): รถเก่า กับ รถใหม่ = คันเดียว / รถเก่า กับ รถเก่า = 2 คันพร้อมกัน
    let jobVariant: string | null = null;
    if (jobType === 'PLATE_SWAP') {
      // CHANGE = เปลี่ยนเลขทะเบียน (ผู้ใช้ 2026-11-18): รถคันเดียวรับเลขที่จองไว้ - งานจริงเก็บใน PlateSwap kind CHANGE จึงเป็นแบบหนึ่งของสลับเลข
      if (dto.swapKind !== 'OLD_NEW' && dto.swapKind !== 'OLD_OLD' && dto.swapKind !== 'CHANGE') {
        throw new BadRequestException({ error: 'กรุณาเลือกแบบ (สลับเลข รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า / เปลี่ยนเลขทะเบียน)' });
      }
      jobVariant = dto.swapKind;
    }
    let firstRegistrationDate: Date | null = null;
    let taxExpiryDate: Date | null = null;
    if (jobType === 'TAX_RENEWAL') {
      if (!vehicle.vehicleType) throw new BadRequestException({ error: 'กรุณาระบุประเภทรถ (รย. / ขส.) ของคันนี้ก่อนเลือกงานต่อภาษี' });
      firstRegistrationDate = parseIsoDate(dto.firstRegistrationDate);
      taxExpiryDate = parseIsoDate(dto.taxExpiryDate);
      if (!firstRegistrationDate) throw new BadRequestException({ error: 'กรุณาระบุวันจดทะเบียนครั้งแรกให้ถูกต้อง' });
      if (!taxExpiryDate) throw new BadRequestException({ error: 'กรุณาระบุวันครบกำหนดภาษีให้ถูกต้อง' });
      assertNotFuture('วันจดทะเบียนครั้งแรก', firstRegistrationDate);
      if (taxExpiryDate < firstRegistrationDate) throw new BadRequestException({ error: 'วันครบกำหนดภาษีต้องไม่ก่อนวันจดทะเบียนครั้งแรก' });
    }
    const inspectionRequired = inspectionRequiredFor({
      jobType,
      vehicleType: vehicle.vehicleType,
      firstRegistrationDate,
      taxExpiryDate,
      today: todayDate(),
    });
    return { jobType, jobVariant, firstRegistrationDate, taxExpiryDate, inspectionRequired };
  }

  // รถคันเดิม งานประเภทเดิม ที่งานก่อนยังไม่เสร็จ = น่าจะรับซ้ำ -> ต้องมีเหตุผล (ผู้ใช้ 2026-11-18)
  // งานคนละประเภท หรือประเภทเดิมที่งานก่อนเสร็จแล้ว (เช่น ต่อภาษีปีถัดไป) รับได้เลย
  private async assertNotDuplicate(vehicleId: string, jobType: OldJobType, exceptJobId: string | null, reasonRaw: unknown, index?: number): Promise<string | null> {
    const others = await this.prisma.oldVehicleJob.findMany({
      where: { vehicleId, jobType, cancelledAt: null, ...(exceptJobId ? { id: { not: exceptJobId } } : {}) },
      select: { id: true, jobType: true, jobId: true, receivedDate: true, inspectionRequired: true, inspectionSentDate: true, inspectionResult: true },
    });
    if (!others.length) return null;
    const linked = await this.loadLinked(others);
    const open = others.filter((job) => !isClosedStatus(this.statusOf(job, linked)));
    if (!open.length) return null;
    const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
    if (!reason) {
      throw new ConflictException({
        error: `คันนี้มีงาน${OLD_JOB_TYPE_LABEL[jobType]}ที่ยังไม่เสร็จอยู่แล้ว (รับเมื่อ ${isoDate(open[0].receivedDate)!.split('-').reverse().join('/')}) - ถ้าจะรับซ้ำกรุณาระบุเหตุผล`,
        needsDuplicateReason: true,
        vehicleIndex: index ?? null,
      });
    }
    return reason.slice(0, 500);
  }

  // รับงาน: ลูกค้า + วันที่รับ ใช้ร่วมกันทุกคันในฟอร์ม - รถใหม่คีย์ข้อมูลรถ / รถที่มีอยู่แล้วส่ง vehicleId (รับงานเพิ่มให้คันเดิม)
  async intake(dto: IntakeDto): Promise<{ vehicles: HubVehicle[] }> {
    this.assertCanIntake();
    const customerId = await this.resolveCustomerId(dto?.customerId);
    const receivedDate = parseIsoDate(dto?.receivedDate);
    if (!receivedDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่รับงานให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    assertNotFuture('วันที่รับงาน', receivedDate);
    const list = Array.isArray(dto?.vehicles) ? (dto.vehicles as IntakeVehicleDto[]) : [];
    if (!list.length) throw new BadRequestException({ error: 'กรุณาเพิ่มรถอย่างน้อย 1 คัน' });
    if (list.length > 50) throw new BadRequestException({ error: 'รับงานได้ครั้งละไม่เกิน 50 คัน' });

    // ตรวจและเตรียมข้อมูลทุกคันก่อนเขียน - คันไหนผิดทั้งฟอร์มไม่ถูกบันทึก
    const seen = new Set<string>();
    const prepared: {
      vehicleId: string | null;
      create: Prisma.OldVehicleUncheckedCreateInput | null;
      vehicleClass: string;
      pairKey: string | null;
      job: {
        jobType: OldJobType | null;
        jobVariant: string | null;
        pairId: string | null;
        newVehicleId: string | null;
        firstRegistrationDate: Date | null;
        taxExpiryDate: Date | null;
        inspectionRequired: boolean;
        note: string | null;
        duplicateReason: string | null;
      };
    }[] = [];
    for (const [index, item] of list.entries()) {
      const label = `คันที่ ${index + 1}: `;
      try {
        let vehicleId: string | null = null;
        let create: Prisma.OldVehicleUncheckedCreateInput | null = null;
        let vehicle: { vehicleType: string | null; vehicleClass: string };
        let key: string;
        const existingId = typeof item?.vehicleId === 'string' ? item.vehicleId.trim() : '';
        if (existingId) {
          const row = await this.prisma.oldVehicle.findUnique({ where: { id: existingId } });
          if (!row) throw new BadRequestException({ error: 'ไม่พบรถคันนี้ในระบบ - ค้นหาใหม่อีกครั้ง' });
          vehicleId = row.id;
          vehicle = row;
          key = row.chassisKey;
        } else {
          const vehicleType = this.parseVehicleType(item?.vehicleType);
          const chassis = cleanChassis(requiredText(item?.chassis, 'เลขตัวถัง', 100));
          key = chassisKeyOf(chassis);
          if (!key) throw new BadRequestException({ error: 'กรุณากรอกเลขตัวถัง' });
          const row = await this.prisma.oldVehicle.findUnique({ where: { chassisKey: key } });
          if (row) {
            // มีคนรับคันนี้เข้ามาก่อนระหว่างที่เปิดฟอร์มอยู่ - ใช้คันเดิม ไม่สร้างซ้ำ (ข้อมูลรถที่พิมพ์ไม่ถูกเขียนทับ)
            vehicleId = row.id;
            vehicle = row;
          } else {
            create = {
              vehicleType,
              vehicleClass: vehicleClassOfType(vehicleType),
              plateCategory: requiredText(item?.plateCategory, 'หมวดทะเบียน', 10),
              plateNumber: requiredText(item?.plateNumber, 'เลขทะเบียน', 10),
              chassis,
              chassisKey: key,
              engine: optionalText(item?.engine, 'เลขเครื่อง', 100),
              brand: await this.resolveBrandName(item?.brand),
              ownerName: requiredText(item?.ownerName, 'ชื่อเจ้าของรถ'),
              createdById: currentUser()?.id ?? null,
            };
            vehicle = { vehicleType, vehicleClass: create.vehicleClass as string };
          }
        }
        // รับงาน: ผ่าน assertCanIntake แล้ว (กลุ่มรับงานรับได้ทุกประเภทรถ) ไม่ตรวจขอบเขตการแก้ซ้ำ
        if (seen.has(key)) throw new BadRequestException({ error: 'เลขตัวถังซ้ำกับคันอื่นในฟอร์มนี้' });
        seen.add(key);

        const hasType = item?.jobType !== undefined && item?.jobType !== null && item?.jobType !== '';
        const typed = hasType ? this.jobTypeData(vehicle, item) : null;
        const duplicateReason = typed && vehicleId ? await this.assertNotDuplicate(vehicleId, typed.jobType, null, item?.duplicateReason, index) : null;
        const pairKey = typeof item?.pairKey === 'string' && item.pairKey.trim() ? item.pairKey.trim() : null;
        prepared.push({
          vehicleId,
          create,
          vehicleClass: vehicle.vehicleClass,
          pairKey,
          job: {
            jobType: typed?.jobType ?? null,
            jobVariant: typed?.jobVariant ?? null,
            pairId: null,
            newVehicleId: typed ? await this.resolveNewVehicleId(item?.newVehicleId, typed, vehicle.vehicleClass) : null,
            firstRegistrationDate: typed?.firstRegistrationDate ?? null,
            taxExpiryDate: typed?.taxExpiryDate ?? null,
            inspectionRequired: typed?.inspectionRequired ?? false,
            note: optionalText(item?.note, 'หมายเหตุ', 500),
            duplicateReason,
          },
        });
      } catch (err) {
        // ใส่ลำดับคันนำหน้าข้อความ ให้รู้ว่าแถวไหนในฟอร์มผิด (คงรหัสสถานะและช่องอื่นของคำตอบเดิม)
        if (list.length > 1 && (err instanceof BadRequestException || err instanceof ConflictException)) {
          const body = err.getResponse() as Record<string, unknown>;
          const next = { ...body, error: `${label}${typeof body.error === 'string' ? body.error : ''}` };
          throw err instanceof ConflictException ? new ConflictException(next) : new BadRequestException(next);
        }
        throw err;
      }
    }

    // สลับเลข รถเก่า กับ รถเก่า: ต้องมาครบคู่ 2 คันในคำขอเดียว (ผู้ใช้ 2026-11-18: มาพร้อมกันทั้ง 2 คัน ลูกค้าเดียวกัน)
    // และเป็นรถยนต์ทั้งคู่หรือมอเตอร์ไซค์ทั้งคู่ (อัตราและหน้ายื่นของงานสลับเลขแยกตามประเภทรถ)
    const groups = new Map<string, typeof prepared>();
    for (const item of prepared) {
      const oldOld = item.job.jobType === 'PLATE_SWAP' && item.job.jobVariant === 'OLD_OLD';
      if (!oldOld) {
        if (item.pairKey) throw new BadRequestException({ error: 'จับคู่ได้เฉพาะงานสลับเลข รถเก่า กับ รถเก่า' });
        continue;
      }
      if (!item.pairKey) throw new BadRequestException({ error: 'สลับเลข รถเก่า กับ รถเก่า ต้องรับ 2 คันพร้อมกัน - กรุณากรอกคันคู่' });
      groups.set(item.pairKey, [...(groups.get(item.pairKey) ?? []), item]);
    }
    for (const members of groups.values()) {
      if (members.length !== 2) throw new BadRequestException({ error: 'สลับเลข รถเก่า กับ รถเก่า ต้องรับ 2 คันพร้อมกัน - กรุณากรอกคันคู่' });
      if (members[0].vehicleClass !== members[1].vehicleClass) {
        throw new BadRequestException({ error: 'คู่สลับเลขต้องเป็นรถยนต์ทั้งคู่ หรือมอเตอร์ไซค์ทั้งคู่' });
      }
      const pairId = randomUUID();
      for (const member of members) member.job.pairId = pairId;
    }

    const ids = await this.prisma
      .$transaction(async (tx) => {
        const out: string[] = [];
        for (const item of prepared) {
          const vehicleId = item.vehicleId ?? (await tx.oldVehicle.create({ data: item.create!, select: { id: true } })).id;
          // รับงานเพิ่มให้คันเดิม -> แตะ updatedAt ของรถ ให้คันที่เพิ่งรับงานอยู่ต้นรายการ (list อ่านตาม updatedAt)
          if (item.vehicleId) await tx.oldVehicle.update({ where: { id: vehicleId }, data: { updatedAt: new Date() } });
          await tx.oldVehicleJob.create({
            data: { vehicleId, customerId, receivedDate, ...item.job, createdById: currentUser()?.id ?? null },
          });
          out.push(vehicleId);
        }
        return out;
      })
      .catch((err: unknown) => {
        if (isUniqueConflict(err)) throw new ConflictException({ error: 'มีคนรับรถคันเดียวกันเข้ามาพร้อมกัน - โหลดรายการใหม่แล้วลองอีกครั้ง' });
        throw err;
      });
    const rows = await this.prisma.oldVehicle.findMany({ where: { id: { in: ids } }, include: vehicleInclude });
    return { vehicles: await this.hubVehicles(rows) };
  }

  // ---------------------------------------------------------------------------------------------
  // งานที่ยังไม่ยื่น (ยังแก้ในหน้านี้ได้) - ยื่นแล้วต้องไปแก้ที่หน้าของงานนั้น
  private async findOpenJob(id: string) {
    const job = await this.prisma.oldVehicleJob.findUnique({ where: { id }, include: { vehicle: true } });
    if (!job) throw new NotFoundException({ error: 'ไม่พบการรับงานนี้' });
    this.assertWritable(job.vehicle.vehicleClass);
    if (job.cancelledAt) throw new ConflictException({ error: 'การรับงานนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return job;
  }

  private assertNotSubmitted(job: { jobId: string | null }) {
    if (job.jobId) throw new BadRequestException({ error: 'งานนี้ยื่นแล้ว - แก้ไขที่หน้าของงานนั้น' });
  }

  // เลือก / เปลี่ยนประเภทงาน - ได้จนกว่าจะส่งตรวจหรือยื่น (หลังจากนั้นต้องยกเลิกการส่งตรวจก่อน)
  async chooseType(id: string, dto: ChooseTypeDto): Promise<{ vehicle: HubVehicle }> {
    const job = await this.findOpenJob(id);
    this.assertNotSubmitted(job);
    if (job.inspectionSentDate) throw new BadRequestException({ error: 'งานนี้ส่งตรวจรถแล้ว - ยกเลิกการส่งตรวจก่อนจึงเปลี่ยนประเภทงานได้' });
    // คู่สลับเลขรับเป็นคู่ - เปลี่ยนประเภทงานของคันเดียวจะทำให้อีกคันค้าง ต้องยกเลิกการรับงาน (ทั้งคู่) แล้วรับใหม่
    if (job.pairId) throw new BadRequestException({ error: 'งานนี้เป็นคู่สลับเลข รถเก่า กับ รถเก่า - ถ้าจะเปลี่ยนประเภทงานให้ยกเลิกการรับงานแล้วรับใหม่' });
    const typed = this.jobTypeData(job.vehicle, dto ?? {});
    if (typed.jobVariant === 'OLD_OLD') {
      throw new BadRequestException({ error: 'สลับเลข รถเก่า กับ รถเก่า ต้องรับ 2 คันพร้อมกันจากปุ่ม + รับงาน' });
    }
    const duplicateReason = await this.assertNotDuplicate(job.vehicleId, typed.jobType, job.id, dto?.duplicateReason);
    await this.prisma.oldVehicleJob
      .update({
        where: { id, cancelledAt: null, jobId: null, inspectionSentDate: null, updatedAt: job.updatedAt },
        data: { ...typed, duplicateReason, newVehicleId: await this.resolveNewVehicleId(dto?.newVehicleId, typed, job.vehicle.vehicleClass) },
      })
      .catch(staleIfMissing);
    return this.reloadVehicle(job.vehicleId);
  }

  // บันทึกส่งตรวจ (หลายคันพร้อมกันได้ - ติ๊กแล้วปริ้นใบส่งตรวจ): วันที่ส่ง + แบบการตรวจ ใช้ร่วมกัน ค่าตรวจรายคัน
  // OUTSIDE = ส่งตรวจนอก ต้องกรอกค่าตรวจทุกคัน (0 ได้) / BRING_IN = นำรถมาตรวจ เก็บ 0 เสมอ
  // ส่งซ้ำได้เฉพาะคันที่ผลตรวจไม่ผ่าน (ล้างผลเดิม เก็บประวัติลง AuditLog)
  async sendInspection(dto: { sentDate?: unknown; sentType?: unknown; items?: unknown }): Promise<{ vehicles: HubVehicle[] }> {
    const sentDate = parseIsoDate(dto?.sentDate);
    if (!sentDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ส่งตรวจให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    assertNotFuture('วันที่ส่งตรวจ', sentDate);
    const sentType = dto?.sentType;
    if (sentType !== 'OUTSIDE' && sentType !== 'BRING_IN') throw new BadRequestException({ error: 'กรุณาเลือกแบบการตรวจ (ส่งตรวจนอก / นำรถมาตรวจ)' });
    const items = Array.isArray(dto?.items) ? (dto.items as { id?: unknown; cost?: unknown }[]) : [];
    if (!items.length) throw new BadRequestException({ error: 'กรุณาเลือกรถที่จะส่งตรวจ' });
    if (items.length > 100) throw new BadRequestException({ error: 'ส่งตรวจได้ครั้งละไม่เกิน 100 คัน' });
    if (new Set(items.map((i) => i?.id)).size !== items.length) throw new BadRequestException({ error: 'เลือกรถคันเดียวกันซ้ำ' });

    const prepared: { job: Awaited<ReturnType<OldVehicleJobsService['findOpenJob']>>; cost: number }[] = [];
    for (const item of items) {
      const job = await this.findOpenJob(typeof item?.id === 'string' ? item.id : '');
      this.assertCanInspect(job.vehicle.vehicleClass);
      const plate = `${job.vehicle.plateCategory} ${job.vehicle.plateNumber}`;
      this.assertNotSubmitted(job);
      if (!job.jobType || !job.inspectionRequired) throw new BadRequestException({ error: `${plate}: งานนี้ไม่ต้องตรวจรถ` });
      if (job.inspectionSentDate && job.inspectionResult !== 'FAIL') throw new BadRequestException({ error: `${plate}: ส่งตรวจแล้ว` });
      if (sentDate < job.receivedDate) throw new BadRequestException({ error: `${plate}: วันที่ส่งตรวจต้องไม่ก่อนวันที่รับงาน` });
      if (job.inspectionResultDate && sentDate < job.inspectionResultDate) {
        throw new BadRequestException({ error: `${plate}: วันที่ส่งตรวจใหม่ต้องไม่ก่อนวันที่ผลตรวจครั้งก่อน` });
      }
      prepared.push({ job, cost: sentType === 'OUTSIDE' ? parseCost(item?.cost) : 0 });
    }

    await this.prisma.$transaction(async (tx) => {
      for (const { job, cost } of prepared) {
        await tx.oldVehicleJob
          .update({
            where: { id: job.id, cancelledAt: null, jobId: null, updatedAt: job.updatedAt },
            data: { inspectionSentDate: sentDate, inspectionSentType: sentType, inspectionCost: cost, inspectionResult: null, inspectionResultDate: null },
          })
          .catch(staleIfMissing);
        if (job.inspectionResult === 'FAIL') {
          await writeAudit(tx, {
            entity: 'OldVehicleJob',
            entityId: job.id,
            action: 'inspection-resend',
            remark: 'ส่งตรวจใหม่หลังตรวจไม่ผ่าน',
            changes: {
              inspectionSentDate: { from: job.inspectionSentDate, to: sentDate },
              inspectionSentType: { from: job.inspectionSentType, to: sentType },
              inspectionCost: { from: job.inspectionCost, to: cost },
              inspectionResult: { from: job.inspectionResult, to: null },
              inspectionResultDate: { from: job.inspectionResultDate, to: null },
            },
          });
        }
      }
    });
    const rows = await this.prisma.oldVehicle.findMany({ where: { id: { in: prepared.map((p) => p.job.vehicleId) } }, include: vehicleInclude });
    return { vehicles: await this.hubVehicles(rows) };
  }

  // บันทึกผลตรวจ PASS | FAIL - ผ่านเท่านั้นจึงยื่นได้ / ไม่ผ่านกลับไปรอส่งตรวจ
  async recordInspectionResult(id: string, dto: { result?: unknown; resultDate?: unknown }): Promise<{ vehicle: HubVehicle }> {
    const job = await this.findOpenJob(id);
    this.assertCanInspect(job.vehicle.vehicleClass);
    this.assertNotSubmitted(job);
    if (!job.inspectionSentDate) throw new BadRequestException({ error: 'ยังไม่ได้บันทึกวันที่ส่งตรวจ' });
    if (job.inspectionResult) throw new BadRequestException({ error: 'งานนี้บันทึกผลตรวจแล้ว' });
    const result = dto?.result;
    if (result !== 'PASS' && result !== 'FAIL') throw new BadRequestException({ error: 'กรุณาเลือกผลตรวจ (ผ่าน / ไม่ผ่าน)' });
    const resultDate = parseIsoDate(dto?.resultDate);
    if (!resultDate) throw new BadRequestException({ error: 'กรุณาระบุวันที่ได้ผลตรวจให้ถูกต้อง (ค.ศ. YYYY-MM-DD)' });
    if (resultDate < job.inspectionSentDate) throw new BadRequestException({ error: 'วันที่ได้ผลตรวจต้องไม่ก่อนวันที่ส่งตรวจ' });
    assertNotFuture('วันที่ได้ผลตรวจ', resultDate);
    await this.prisma.oldVehicleJob
      .update({
        where: { id, cancelledAt: null, jobId: null, inspectionResult: null, updatedAt: job.updatedAt },
        data: { inspectionResult: result, inspectionResultDate: resultDate },
      })
      .catch(staleIfMissing);
    return this.reloadVehicle(job.vehicleId);
  }

  // ยกเลิกขั้นตรวจที่บันทึกผิด (ต้องมีเหตุผล): มีผลตรวจ = ล้างผล กลับไปรอผลตรวจ / ยังไม่มีผล = ล้างการส่งตรวจ กลับไปรอส่งตรวจ
  async undoInspection(id: string, remarkRaw: unknown): Promise<{ vehicle: HubVehicle }> {
    this.assertCanInspect((await this.findOpenJob(id)).vehicle.vehicleClass);
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกการบันทึกตรวจรถ');
    const job = await this.findOpenJob(id);
    this.assertNotSubmitted(job);
    if (!job.inspectionSentDate) throw new BadRequestException({ error: 'งานนี้ยังไม่ได้ส่งตรวจ' });
    const data = job.inspectionResult
      ? { inspectionResult: null, inspectionResultDate: null }
      : { inspectionSentDate: null, inspectionSentType: null, inspectionCost: 0 };
    await this.prisma.$transaction(async (tx) => {
      await tx.oldVehicleJob.update({ where: { id, cancelledAt: null, jobId: null, updatedAt: job.updatedAt }, data }).catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'OldVehicleJob',
        entityId: id,
        action: job.inspectionResult ? 'inspection-result-undo' : 'inspection-sent-undo',
        remark,
        changes: diffChanges(job, data),
      });
    });
    return this.reloadVehicle(job.vehicleId);
  }

  // ---------------------------------------------------------------------------------------------
  // ติดขัด: ติดได้ทุกขั้นจนกว่างานจะเสร็จ - ไม่เปลี่ยนขั้นของงาน / เหตุผลเลือกจากรายการ + พิมพ์เพิ่ม ("อื่นๆ" บังคับพิมพ์)
  async block(id: string, dto: { reason?: unknown; note?: unknown }): Promise<{ vehicle: HubVehicle }> {
    const job = await this.findOpenJob(id);
    if (!isBlockReason(dto?.reason)) throw new BadRequestException({ error: 'กรุณาเลือกเหตุผลที่ติดขัดจากรายการ' });
    const note = optionalText(dto?.note, 'รายละเอียด', 500);
    if (dto.reason === 'OTHER' && !note) throw new BadRequestException({ error: 'เหตุผล "อื่นๆ" กรุณาพิมพ์รายละเอียด' });
    if (job.blockedAt) throw new BadRequestException({ error: 'งานนี้ติดธงติดขัดอยู่แล้ว' });
    const linked = await this.loadLinked([job]);
    if (isClosedStatus(this.statusOf(job, linked))) throw new BadRequestException({ error: 'งานนี้เสร็จแล้ว ติดธงติดขัดไม่ได้' });
    const data = { blockedAt: new Date(), blockedReason: dto.reason, blockedNote: note, blockedById: currentUser()?.id ?? null };
    await this.prisma.$transaction(async (tx) => {
      await tx.oldVehicleJob.update({ where: { id, cancelledAt: null, blockedAt: null }, data }).catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'OldVehicleJob',
        entityId: id,
        action: 'block',
        remark: note ? `${BLOCK_REASON_LABEL[dto.reason as keyof typeof BLOCK_REASON_LABEL]}: ${note}` : BLOCK_REASON_LABEL[dto.reason as keyof typeof BLOCK_REASON_LABEL],
        changes: { blockedReason: { from: null, to: dto.reason }, blockedNote: { from: null, to: note } },
      });
    });
    return this.reloadVehicle(job.vehicleId);
  }

  async unblock(id: string): Promise<{ vehicle: HubVehicle }> {
    const job = await this.findOpenJob(id);
    if (!job.blockedAt) throw new BadRequestException({ error: 'งานนี้ไม่ได้ติดธงติดขัด' });
    await this.prisma.$transaction(async (tx) => {
      await tx.oldVehicleJob
        .update({ where: { id, cancelledAt: null, blockedAt: job.blockedAt }, data: { blockedAt: null, blockedReason: null, blockedNote: null, blockedById: null } })
        .catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'OldVehicleJob',
        entityId: id,
        action: 'unblock',
        remark: 'ปลดติดขัด',
        changes: { blockedAt: { from: job.blockedAt, to: null }, blockedReason: { from: job.blockedReason, to: null }, blockedNote: { from: job.blockedNote, to: null } },
      });
    });
    return this.reloadVehicle(job.vehicleId);
  }

  // ยกเลิกการรับงาน (ต้องมีเหตุผล ไม่ลบแถว) - ได้เฉพาะงานที่ยังไม่ยื่น งานที่ยื่นแล้วยกเลิกที่หน้าของงานนั้น
  async cancel(id: string, remarkRaw: unknown): Promise<{ id: string }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกการรับงาน');
    const job = await this.findOpenJob(id);
    this.assertNotSubmitted(job);
    // คู่สลับเลข: ยกเลิกทั้งคู่พร้อมกัน (คันเดียวสลับเลขไม่ได้) - คันคู่ที่ยื่นไปแล้วยกเลิกจากที่นี่ไม่ได้
    const partners = job.pairId
      ? await this.prisma.oldVehicleJob.findMany({ where: { pairId: job.pairId, id: { not: id }, cancelledAt: null } })
      : [];
    if (partners.some((p) => p.jobId)) throw new BadRequestException({ error: 'คันคู่ของงานสลับเลขนี้ยื่นไปแล้ว - ยกเลิกที่หน้าของงานสลับเลข' });
    await this.prisma.$transaction(async (tx) => {
      for (const row of [job, ...partners]) {
        await tx.oldVehicleJob
          .update({ where: { id: row.id, cancelledAt: null, jobId: null }, data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null } })
          .catch(staleIfMissing);
        await writeAudit(tx, {
          entity: 'OldVehicleJob',
          entityId: row.id,
          action: 'cancel',
          remark,
          changes: { jobType: row.jobType, jobVariant: row.jobVariant, pairId: row.pairId, receivedDate: row.receivedDate, customerId: row.customerId, inspectionSentDate: row.inspectionSentDate, inspectionResult: row.inspectionResult },
        });
      }
    });
    return { id };
  }

  // แก้ข้อมูลรถ (ที่เดียวของรถเก่า) - ต้องมีเหตุผล เก็บประวัติลง AuditLog 'OldVehicle'
  // ข้อมูลรถในงานที่ยื่นไปแล้วเป็น snapshot ของงานนั้น ไม่ถูกแก้ตาม (แก้ที่หน้าของงานนั้นถ้าต้องการ)
  async updateVehicle(id: string, dto: UpdateOldVehicleDto): Promise<{ vehicle: HubVehicle }> {
    const remark = requireRemark(dto?.remark, 'กรุณาระบุเหตุผลที่แก้ข้อมูลรถ');
    const expected = parseExpectedUpdatedAt(dto?.expectedUpdatedAt);
    const existing = await this.prisma.oldVehicle.findUnique({ where: { id }, include: { jobs: { where: { cancelledAt: null }, select: { jobId: true, jobType: true, inspectionSentDate: true, pairId: true } } } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบรถคันนี้' });
    this.assertWritable(existing.vehicleClass);
    if (expected && !sameTime(expected, existing.updatedAt)) throw new ConflictException({ error: STALE_ERROR });

    const vehicleType = dto.vehicleType === undefined ? existing.vehicleType : this.parseVehicleType(dto.vehicleType);
    const vehicleClass = vehicleType ? vehicleClassOfType(vehicleType) : existing.vehicleClass;
    if (vehicleClass !== existing.vehicleClass) {
      this.assertWritable(vehicleClass);
      // งานที่ยื่นแล้วผูกกับรถยนต์/มอเตอร์ไซค์ของงานนั้น (อัตราคนละชุด) - เปลี่ยนข้ามประเภทไม่ได้
      if (existing.jobs.some((j) => j.jobId)) throw new BadRequestException({ error: 'รถคันนี้มีงานที่ยื่นแล้ว เปลี่ยนระหว่างรถยนต์กับมอเตอร์ไซค์ไม่ได้' });
    }
    if (vehicleType !== existing.vehicleType && existing.jobs.some((j) => !j.jobId && j.jobType && j.inspectionSentDate)) {
      throw new BadRequestException({ error: 'รถคันนี้มีงานที่ส่งตรวจรถแล้ว - ยกเลิกการส่งตรวจก่อนจึงเปลี่ยนประเภทรถได้' });
    }
    // งานที่ยังไม่ยื่นต้องยังทำกับประเภทรถใหม่ได้ (กฎเดียวกับตอนเลือกประเภทงาน: ขส. เฉพาะต่อภาษี / โอนย้ายเข้าเฉพาะมอเตอร์ไซค์)
    const pending = existing.jobs.filter((j) => !j.jobId && j.jobType).map((j) => j.jobType);
    if (isTransportType(vehicleType) && pending.some((t) => t !== 'TAX_RENEWAL')) {
      throw new BadRequestException({ error: 'รถคันนี้มีงานที่ยังไม่ยื่นซึ่งไม่ใช่ต่อภาษี - รถ ขส. ทำได้เฉพาะต่อภาษี ยกเลิกหรือเปลี่ยนประเภทงานนั้นก่อน' });
    }
    if (vehicleClass !== existing.vehicleClass && existing.jobs.some((j) => !j.jobId && j.pairId)) {
      throw new BadRequestException({ error: 'รถคันนี้มีงานสลับเลขคู่ที่ยังไม่ยื่น - คู่สลับต้องเป็นประเภทรถเดียวกัน ยกเลิกการรับงานนั้นก่อน' });
    }
    const chassis = dto.chassis === undefined ? existing.chassis : cleanChassis(requiredText(dto.chassis, 'เลขตัวถัง', 100));
    const data = {
      vehicleType,
      vehicleClass,
      plateCategory: dto.plateCategory === undefined ? existing.plateCategory : requiredText(dto.plateCategory, 'หมวดทะเบียน', 10),
      plateNumber: dto.plateNumber === undefined ? existing.plateNumber : requiredText(dto.plateNumber, 'เลขทะเบียน', 10),
      chassis,
      chassisKey: chassisKeyOf(chassis),
      engine: dto.engine === undefined ? existing.engine : optionalText(dto.engine, 'เลขเครื่อง', 100),
      brand: dto.brand === undefined ? existing.brand : await this.resolveBrandName(dto.brand),
      ownerName: dto.ownerName === undefined ? existing.ownerName : requiredText(dto.ownerName, 'ชื่อเจ้าของรถ'),
    };
    const changes: AuditChanges = diffChanges(existing, data);
    if (!Object.keys(changes).length) throw new BadRequestException({ error: 'ยังไม่ได้แก้ข้อมูลช่องใด' });

    await this.prisma
      .$transaction(async (tx) => {
        await tx.oldVehicle.update({ where: { id, updatedAt: existing.updatedAt }, data }).catch(staleIfMissing);
        // ประเภทรถเปลี่ยน -> งานที่ยังไม่ยื่นถูกตัดสินเรื่องตรวจรถใหม่ (ต่อภาษีใช้ประเภทรถ)
        if (changes.vehicleType) {
          const open = await tx.oldVehicleJob.findMany({ where: { vehicleId: id, cancelledAt: null, jobId: null, jobType: { not: null } } });
          for (const job of open) {
            if (!isOldJobType(job.jobType)) continue;
            const inspectionRequired = inspectionRequiredFor({ jobType: job.jobType, vehicleType, firstRegistrationDate: job.firstRegistrationDate, taxExpiryDate: job.taxExpiryDate, today: todayDate() });
            if (inspectionRequired !== job.inspectionRequired) await tx.oldVehicleJob.update({ where: { id: job.id }, data: { inspectionRequired } });
          }
        }
        await writeAudit(tx, { entity: 'OldVehicle', entityId: id, action: 'update', remark, changes });
      })
      .catch((err: unknown) => {
        if (isUniqueConflict(err)) throw new ConflictException({ error: 'เลขตัวถังนี้ตรงกับรถอีกคันที่มีอยู่ในระบบแล้ว' });
        throw err;
      });
    return this.reloadVehicle(id);
  }

  // ---------------------------------------------------------------------------------------------
  // ผูกงานจริงกับแถวรับงาน (เรียกทุกครั้งที่เปิดหน้ารวม ทำซ้ำได้ ไม่มีผลถ้าไม่มีอะไรใหม่):
  // 1) งานที่ยื่นจากหน้าเดิมของรถที่รับงานไว้ (เลขตัวถัง + ประเภทงานตรงกัน และแถวรับงานยังไม่ยื่น) -> ผูกเข้าแถวนั้น
  //    และคัดลอกผลตรวจรถที่ทำก่อนยื่นไปที่งาน (งานโอน: ช่องตรวจรถของงาน / ต่อภาษี: ติ๊กมีใบตรวจ หรือวันที่ตรวจของรถ ขส.)
  // 2) งานที่ไม่มีแถวรับงานรองรับ (คีย์ไว้ก่อนมีหน้านี้ หรือคีย์จากเมนูเดิมโดยไม่รับงาน) -> สร้างรถ + แถวรับงานย้อนหลัง
  //    วันที่รับ = วันที่สร้างงาน (receivedIsBackfill)
  // งานที่ถูกยกเลิกไปแล้วไม่สร้างแถวย้อนหลัง
  async sync(): Promise<{ linked: number; backfilled: number }> {
    const unlinked = await this.unlinkedJobs();
    if (!unlinked.length) return { linked: 0, backfilled: 0 };

    const keys = [...new Set(unlinked.map((j) => chassisKeyOf(j.chassis)).filter(Boolean))];
    const findVehicles = async () => {
      const found: { id: string; chassisKey: string }[] = [];
      for (let i = 0; i < keys.length; i += 1000) {
        found.push(...(await this.prisma.oldVehicle.findMany({ where: { chassisKey: { in: keys.slice(i, i + 1000) } }, select: { id: true, chassisKey: true } })));
      }
      return new Map(found.map((v) => [v.chassisKey, v.id]));
    };
    let vehicleIdByKey = await findVehicles();

    // รถที่ยังไม่มี - ใช้ข้อมูลจากงานล่าสุดของเลขตัวถังนั้น
    const newest = new Map<string, UnlinkedJob>();
    for (const job of unlinked) {
      const key = chassisKeyOf(job.chassis);
      if (!key || vehicleIdByKey.has(key)) continue;
      const prev = newest.get(key);
      if (!prev || job.createdAt > prev.createdAt) newest.set(key, job);
    }
    if (newest.size) {
      await this.prisma.oldVehicle.createMany({
        data: [...newest].map(([key, job]) => ({
          vehicleType: job.vehicleType,
          vehicleClass: job.vehicleClass === 'MOTO' ? 'MOTO' : 'CAR',
          plateCategory: job.plateCategory,
          plateNumber: job.plateNumber,
          chassis: cleanChassis(job.chassis),
          chassisKey: key,
          engine: job.engine,
          brand: job.brand,
          ownerName: job.ownerName,
          createdById: job.createdById,
        })),
        skipDuplicates: true,
      });
      vehicleIdByKey = await findVehicles();
    }

    // แถวรับงานที่ยังไม่ยื่น ของรถเหล่านี้ - เก่าสุดก่อน (งานที่ยื่นก่อนผูกกับแถวที่รับก่อน)
    const waiting = await this.prisma.oldVehicleJob.findMany({
      where: { vehicleId: { in: [...new Set(vehicleIdByKey.values())] }, jobId: null, cancelledAt: null },
      orderBy: { createdAt: 'asc' },
    });
    const taken = new Set<string>();
    let linked = 0;
    const backfill: Prisma.OldVehicleJobCreateManyInput[] = [];
    for (const job of [...unlinked].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())) {
      const vehicleId = vehicleIdByKey.get(chassisKeyOf(job.chassis));
      if (!vehicleId) continue;
      // แถวรับงานที่งานนี้ควรผูกด้วย เรียงตามความตรง: ประเภทงานตรงกัน > งานโอนคนละแบบ (รับเป็นโอนแบบหนึ่ง ยื่นจริงอีกแบบ) >
      // รับไว้แล้วยังไม่เลือกประเภทงาน (รอทำ) - ถ้าไม่ผูก แถวรับงานเดิมจะค้าง และงานได้แถวย้อนหลังซ้ำอีกแถว
      const candidates = waiting.filter((w) => w.vehicleId === vehicleId && !taken.has(w.id) && w.createdAt <= job.createdAt);
      const isTransfer = (t: string | null) => !!t && t.startsWith('TRANSFER_');
      const intake =
        candidates.find((w) => w.jobType === job.jobType) ??
        (isTransfer(job.jobType) ? candidates.find((w) => isTransfer(w.jobType)) : undefined) ??
        candidates.find((w) => w.jobType === null);
      if (intake) {
        taken.add(intake.id);
        try {
          await this.prisma.$transaction(async (tx) => {
            await tx.oldVehicleJob.update({ where: { id: intake.id, jobId: null, cancelledAt: null }, data: { jobId: job.id, jobType: job.jobType } });
            await this.copyInspectionToJob(tx, intake, job);
          });
          linked += 1;
        } catch (err) {
          // อีกคำขอผูกงานนี้ไปก่อน (unique jobType+jobId / แถวรับงานถูกผูกแล้ว) - ข้าม
          if (!isUniqueConflict(err) && (err as { code?: string } | null)?.code !== 'P2025') throw err;
        }
        continue;
      }
      backfill.push({
        vehicleId,
        customerId: job.customerId,
        receivedDate: bangkokDateOf(job.createdAt),
        receivedIsBackfill: true,
        jobType: job.jobType,
        jobVariant: job.variant ?? null,
        pairId: job.pairId ?? null,
        jobId: job.id,
        createdById: job.createdById,
      });
    }
    const created = backfill.length ? await this.prisma.oldVehicleJob.createMany({ data: backfill, skipDuplicates: true }) : { count: 0 };
    return { linked, backfilled: created.count };
  }

  // ตรวจรถที่ทำก่อนยื่น (ผ่านแล้ว) -> เขียนลงงานจริง ให้ขั้นต่อไปของงานนั้นเดินได้โดยไม่ต้องบันทึกตรวจซ้ำ
  private async copyInspectionToJob(
    tx: Prisma.TransactionClient,
    intake: { id: string; inspectionResult: string | null; inspectionSentDate: Date | null; inspectionSentType: string | null; inspectionCost: Prisma.Decimal; inspectionResultDate: Date | null },
    job: UnlinkedJob,
  ) {
    if (intake.inspectionResult !== 'PASS' || !intake.inspectionSentDate || !intake.inspectionResultDate) return;
    // ผู้ทำใน AuditLog คือคนที่ทำให้ระบบผูกงาน (คนยื่นงาน หรือคนเปิดหน้ารวม) ไม่ใช่คนบันทึกตรวจรถ - บอกไว้ในเหตุผล
    const remark = 'ตรวจรถก่อนยื่นจากหน้างานรถเก่า (ระบบผูกงานอัตโนมัติ)';
    if (job.jobType === 'TRANSFER_INSPECTION' || job.jobType === 'TRANSFER_MOVE_IN') {
      const data = {
        inspectionSentDate: intake.inspectionSentDate,
        inspectionSentType: intake.inspectionSentType,
        inspectionCost: intake.inspectionCost,
        inspectionResult: 'PASS',
        inspectionResultDate: intake.inspectionResultDate,
      };
      const updated = await tx.vehicleTransfer.updateMany({ where: { id: job.id, cancelledAt: null, returnedDate: null, inspectionSentDate: null }, data });
      if (updated.count) {
        await writeAudit(tx, { entity: 'VehicleTransfer', entityId: job.id, action: 'inspection-from-intake', remark, changes: { ...data, oldVehicleJobId: intake.id } });
      }
    } else if (job.jobType === 'TAX_RENEWAL') {
      const transport = isTransportType(job.vehicleType);
      const updated = transport
        ? await tx.taxRenewal.updateMany({ where: { id: job.id, cancelledAt: null, paymentDate: null, inspectionDate: null }, data: { inspectionDate: intake.inspectionResultDate, inspectionConfirmed: true } })
        : await tx.taxRenewal.updateMany({ where: { id: job.id, cancelledAt: null, inspectionConfirmed: false }, data: { inspectionConfirmed: true } });
      if (updated.count) {
        await writeAudit(tx, {
          entity: 'TaxRenewal',
          entityId: job.id,
          action: 'inspection-from-intake',
          remark,
          changes: { inspectionConfirmed: true, ...(transport ? { inspectionDate: intake.inspectionResultDate } : {}), oldVehicleJobId: intake.id },
        });
      }
    }
  }

  // งานจริงที่ยังไม่มีแถวรับงาน และยังไม่ถูกยกเลิก - anti-join ทีละตาราง (ไม่ส่งรายการ id ยาวๆ เข้า query)
  private async unlinkedJobs(): Promise<UnlinkedJob[]> {
    type Raw = Omit<UnlinkedJob, 'jobType'> & { transferType?: string };
    const notLinked = (types: string[]) =>
      Prisma.sql`NOT EXISTS (SELECT 1 FROM "OldVehicleJob" o WHERE o."jobId" = j."id" AND o."jobType" IN (${Prisma.join(types)}))`;
    const [swaps, transfers, taxes, cancels, moveOuts, copies] = await Promise.all([
      this.prisma.$queryRaw<Raw[]>`SELECT j."id", j."vehicleClass", NULL::text AS "vehicleType", j."customerId", j."oldOwnerName" AS "ownerName", j."oldEngine" AS "engine",
          j."oldChassis" AS "chassis", j."oldBrand" AS "brand", j."oldPlateCategory" AS "plateCategory", j."oldPlateNumber" AS "plateNumber", j."createdAt", j."createdById",
          j."kind"::text AS "variant", j."pairId"
        FROM "PlateSwap" j WHERE j."cancelledAt" IS NULL AND ${notLinked(['PLATE_SWAP'])}`,
      this.prisma.$queryRaw<Raw[]>`SELECT j."id", j."vehicleClass", NULL::text AS "vehicleType", j."customerId", j."transferorName" AS "ownerName", j."engine",
          j."chassis", j."brand", j."plateCategory", j."plateNumber", j."createdAt", j."createdById", j."transferType"
        FROM "VehicleTransfer" j WHERE j."cancelledAt" IS NULL AND ${notLinked(['TRANSFER_OWNER', 'TRANSFER_INSPECTION', 'TRANSFER_MOVE_IN'])}`,
      this.prisma.$queryRaw<Raw[]>`SELECT j."id", 'CAR' AS "vehicleClass", j."vehicleType", j."customerId", j."ownerName", j."engine",
          j."chassis", NULL::text AS "brand", j."plateCategory", j."plateNumber", j."createdAt", j."createdById"
        FROM "TaxRenewal" j WHERE j."cancelledAt" IS NULL AND ${notLinked(['TAX_RENEWAL'])}`,
      this.prisma.$queryRaw<Raw[]>`SELECT j."id", j."vehicleClass", NULL::text AS "vehicleType", j."customerId", j."ownerName", j."engine",
          j."chassis", j."brand", j."plateCategory", j."plateNumber", j."createdAt", j."createdById"
        FROM "VehicleUseCancellation" j WHERE j."cancelledAt" IS NULL AND ${notLinked(['USE_CANCEL'])}`,
      this.prisma.$queryRaw<Raw[]>`SELECT j."id", j."vehicleClass", NULL::text AS "vehicleType", j."customerId", j."ownerName", j."engine",
          j."chassis", j."brand", j."plateCategory", j."plateNumber", j."createdAt", j."createdById"
        FROM "VehicleMoveOut" j WHERE j."cancelledAt" IS NULL AND ${notLinked(['MOVE_OUT'])}`,
      this.prisma.$queryRaw<Raw[]>`SELECT j."id", j."vehicleClass", NULL::text AS "vehicleType", j."customerId", j."ownerName", j."engine",
          j."chassis", j."brand", j."plateCategory", j."plateNumber", j."createdAt", j."createdById"
        FROM "PlateCopy" j WHERE j."cancelledAt" IS NULL AND ${notLinked(['PLATE_COPY'])}`,
    ]);
    const tag = (rows: Raw[], jobType: OldJobType): UnlinkedJob[] => rows.map((r) => ({ ...r, jobType }));
    return [
      ...tag(swaps, 'PLATE_SWAP'),
      ...transfers.map((r): UnlinkedJob => ({ ...r, jobType: r.transferType === 'MOVE_IN' ? 'TRANSFER_MOVE_IN' : r.transferType === 'INSPECTION' ? 'TRANSFER_INSPECTION' : 'TRANSFER_OWNER' })),
      // ต่อภาษีไม่มีคอลัมน์ vehicleClass - คิดจากประเภทรถ (รย.12 / รย.17 = มอเตอร์ไซค์)
      ...taxes.map((r): UnlinkedJob => ({ ...r, jobType: 'TAX_RENEWAL', vehicleClass: vehicleClassOfType(r.vehicleType) })),
      ...tag(cancels, 'USE_CANCEL'),
      ...tag(moveOuts, 'MOVE_OUT'),
      ...tag(copies, 'PLATE_COPY'),
    ];
  }
}
