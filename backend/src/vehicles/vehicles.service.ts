import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { assertVehicleInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { currentUser } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import { UpdateTransferNoticeDto } from './dto/update-transfer-notice.dto.js';
import { UpdateInspectionSentDto } from './dto/update-inspection-sent.dto.js';
import { UpdateInspectionResultDto } from './dto/update-inspection-result.dto.js';
import { UpdateVehicleDto } from './dto/update-vehicle.dto.js';
import { DeleteVehicleDto } from './dto/delete-vehicle.dto.js';
import { getVehicleRowErrors, normalizeVehicleRow, NormalizedVehicleRow } from './vehicle-validation.js';
import { OWNER_TYPE_CHOICES } from './vehicle-reference-data.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { TaxService } from '../tax/tax.service.js';
import { UpdateTaxInputDto } from '../tax/dto/update-tax-input.dto.js';
import { parseTaxDate } from '../tax/tax-validation.js';
import {
  ACTIVE_SUBMISSION_STATUSES,
  getSubmitBlockReason,
  INSPECTION_VALID_DAYS,
  inspectionValidUntil,
} from '../document-submission/submission-eligibility.js';

// งานสลับเลขที่ส่งเลขมาให้รถจดใหม่คันหนึ่ง - หน้ายื่นเอกสาร (Step 4) แสดงและกดใช้เป็นเลขที่ขอได้ (ดู backend/src/plate-swap)
export interface PlateSwapSummary {
  id: string;
  oldOwnerName: string;
  oldPlateCategory: string;
  oldPlateNumber: string;
  newPlateCategory: string | null;
  newPlateNumber: string | null;
  submitDate: string; // YYYY-MM-DD
  returnedDate: string | null;
}

const EDITABLE_VEHICLE_FIELDS = [
  ['date', 'วันที่'],
  ['customerId', 'ลูกค้า'],
  ['chassis', 'เลขตัวถัง'],
  ['engine', 'เลขเครื่อง'],
  ['brandId', 'ยี่ห้อ'],
  ['fuel', 'ประเภทเชื้อเพลิง'],
  ['cc', 'ขนาด CC'],
  ['weight', 'น้ำหนักรถ'],
  ['color', 'สี'],
  ['body', 'ประเภทรถ'],
  ['registrationProvince', 'จังหวัดที่จดทะเบียน'],
  ['ownerProvince', 'จังหวัดเจ้าของรถ'],
] as const;

// เจ้าของรถจากหน้าเพิ่มข้อมูลรถจดใหม่ (ownerType + ไฟแนนซ์) - เก็บเป็น VehicleOwner ต่อคัน ไม่แชร์แถวข้ามคัน
// ไม่ติ๊กไฟแนนซ์: เจ้าของ = ประเภทที่เลือก / ติ๊กไฟแนนซ์: ไฟแนนซ์เป็นเจ้าของตามทะเบียน (นิติบุคคลที่ประกอบธุรกิจเช่าซื้อ)
// และประเภทที่เลือกกลายเป็นผู้เช่าซื้อ (hirerType) - ตรงกับข้อยกเว้นภาษี รย.1 ใน government-tax-calculator.ts
// (นิติบุคคลเช่าซื้อ + ผู้เช่าซื้อบุคคลธรรมดา = ไม่คูณสอง)
// name = ชื่อผู้ถือกรรมสิทธิ์ (ไฟแนนซ์ = ชื่อไฟแนนซ์ / ไม่มีไฟแนนซ์ = ชื่อที่ผู้ใช้กรอก) hirerName = ชื่อผู้ครอบครอง (เฉพาะไฟแนนซ์)
interface OwnerData {
  name: string | null;
  hirerName: string | null;
  ownerType: OwnerType;
  isHirePurchaseBusiness: boolean;
  hirerType: OwnerType | null;
  financeCompanyId: string | null;
}

function ownerDataFor(row: NormalizedVehicleRow, financeName: string | null): OwnerData {
  const chosen = row.ownerType as OwnerType;
  if (row.financeId) {
    return {
      name: financeName,
      hirerName: row.hirerName,
      ownerType: OwnerType.JURISTIC,
      isHirePurchaseBusiness: true,
      hirerType: chosen,
      financeCompanyId: row.financeId,
    };
  }
  return { name: row.ownerName, hirerName: null, ownerType: chosen, isHirePurchaseBusiness: false, hirerType: null, financeCompanyId: null };
}

function ownerTypeLabel(type: string | null | undefined): string {
  return OWNER_TYPE_CHOICES.find(([code]) => code === type)?.[1] ?? '-';
}

// ข้อความสำหรับ VehicleEditLog - เทียบเจ้าของเดิมกับใหม่ว่าเปลี่ยนจริงไหม
function describeOwner(owner: OwnerData | null): string | null {
  if (!owner) return null;
  if (owner.financeCompanyId) {
    return `${ownerTypeLabel(owner.hirerType)} · ไฟแนนซ์ ${owner.name ?? ''} · ผู้ครอบครอง ${owner.hirerName ?? ''}`.trim();
  }
  return `${ownerTypeLabel(owner.ownerType)} · ผู้ถือกรรมสิทธิ์ ${owner.name ?? ''}`.trim();
}

function sameOwner(a: OwnerData | null, b: OwnerData): boolean {
  return (
    !!a &&
    a.name === b.name &&
    a.hirerName === b.hirerName &&
    a.ownerType === b.ownerType &&
    a.isHirePurchaseBusiness === b.isHirePurchaseBusiness &&
    a.hirerType === b.hirerType &&
    a.financeCompanyId === b.financeCompanyId
  );
}

// ตรวจผ่านวันนี้หรือก่อนหน้านี้ = ผลตรวจหมดอายุแล้ว (ครบ 90 วัน)
function reinspectionThreshold(): Date {
  const threshold = new Date();
  threshold.setUTCDate(threshold.getUTCDate() - INSPECTION_VALID_DAYS);
  return threshold;
}

// ผลตรวจผ่านมีอายุ 90 วัน (กฎของผู้ใช้): ครบ 90 วันแล้วยังไม่ได้ยื่นเอกสาร (ไม่มี DocumentSubmission ที่ค้าง
// รอใบเสร็จ/ได้ใบเสร็จแล้ว) ต้องกลับไปตรวจรถใหม่เป็นรอบ 2 - ใช้ได้ทั้งผลรอบ 1 และผลรอบ 2 ที่หมดอายุอีกครั้ง
// รถที่ยื่นเอกสารไปแล้วไม่ต้องตรวจใหม่ documentSubmissions = แถวที่กรองด้วย ACTIVE_SUBMISSION_STATUSES แล้ว
// (ดู activeSubmissionsInclude)
function isReinspectionDue(vehicle: {
  inspectionResult: string | null;
  inspectionResultDate: Date | null;
  documentSubmissions: Array<unknown>;
}) {
  return (
    vehicle.inspectionResult === 'ผ่าน' &&
    vehicle.inspectionResultDate != null &&
    vehicle.inspectionResultDate <= reinspectionThreshold() &&
    vehicle.documentSubmissions.length === 0
  );
}

const activeSubmissionsInclude = {
  documentSubmissions: { where: { status: { in: ACTIVE_SUBMISSION_STATUSES } }, select: { id: true }, take: 1 },
} as const;

// ยื่นเอกสารแล้ว (ถึง Step 4) ย้อนกลับไปแก้ Step 2 (แจ้งย้าย/ตัดบัญชี) หรือ Step 3 (ตรวจรถ) ไม่ได้ - กฎของผู้ใช้
function assertNotSubmitted(vehicle: { documentSubmissions: Array<unknown> }) {
  if (vehicle.documentSubmissions.length > 0) {
    throw new BadRequestException({ error: 'รถคันนี้ยื่นเอกสารจดทะเบียนแล้ว - ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าไม่ได้' });
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

function diffField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

interface VehicleRowError {
  row: number;
  errors: string[];
}

const MAX_BATCH_SIZE = 1000;

type TransferStatus = 'ตัดบัญชี' | 'แจ้งย้าย';

// Status is derived from จังหวัดที่จดทะเบียน, not stored — Bangkok registrations
// go through ตัดบัญชี, every other province goes through แจ้งย้าย. Mirrors
// frontend/src/lib/vehicle-reference-data.ts#getVehicleStatus.
function getTransferStatus(registrationProvince: string | null): TransferStatus | null {
  if (!registrationProvince) return null;
  return registrationProvince === 'กรุงเทพมหานคร' ? 'ตัดบัญชี' : 'แจ้งย้าย';
}

function isValidDateParam(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value));
}

const INSPECTION_SENT_TYPES = ['ส่งตรวจนอก', 'เอารถมาตรวจเอง'] as const;
const INSPECTION_RESULTS = ['ผ่าน', 'ไม่ผ่าน'] as const;

// ตรวจรถรอบ 2: ผลตรวจผ่านครบ 90 วันแล้วยังไม่ได้ยื่นเอกสาร รถกลับเข้าคิวส่งตรวจเอง - ค่าใช้จ่ายแยก 2 ส่วน
// คือราคาตรวจรถ (No bill) ตามตารางเดิม และค่าตรวจรถ (Bill) 50 บาท
const INSPECTION_ROUND2_BILL_FEE = 50;

@Injectable()
export class VehiclesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxService: TaxService,
  ) {}

  private readonly vehicleFullInclude = {
    customer: { select: { name: true } },
    brand: { select: { name: true } },
    owner: {
      select: {
        id: true,
        name: true,
        hirerName: true,
        ownerType: true,
        hirerType: true,
        financeCompanyId: true,
        financeCompany: { select: { name: true } },
      },
    },
    // แถวล่าสุดที่ยัง active (PENDING = รอใบเสร็จ / RECEIPT_RECEIVED = จดทะเบียนแล้ว) - มี = ยื่นซ้ำไม่ได้
    // ดู submission-eligibility.ts
    documentSubmissions: {
      where: { status: { in: ACTIVE_SUBMISSION_STATUSES } },
      orderBy: { createdAt: 'desc' as const },
      take: 1,
      select: { status: true },
    },
  } as const;

  private mapVehicleFull(vehicle: {
    id: string;
    date: Date;
    customerId: string;
    chassis: string;
    engine: string | null;
    brandId: string;
    fuel: string | null;
    cc: unknown;
    weight: unknown;
    color: string | null;
    body: string | null;
    registrationProvince: string | null;
    ownerProvince: string | null;
    createdAt: Date;
    customer: { name: string };
    brand: { name: string };
    firstRegistrationDate: Date | null;
    isFactoryNew: boolean | null;
    ownerId: string | null;
    owner: {
      name: string | null;
      hirerName: string | null;
      ownerType: string;
      hirerType: string | null;
      financeCompanyId: string | null;
      financeCompany: { name: string } | null;
    } | null;
    plateCategory: string | null;
    plateNumber: string | null;
    documentSubmissions: Array<{ status: string }>;
  }) {
    return {
      id: vehicle.id,
      date: vehicle.date.toISOString().slice(0, 10),
      customerId: vehicle.customerId,
      chassis: vehicle.chassis,
      engine: vehicle.engine,
      brandId: vehicle.brandId,
      fuel: vehicle.fuel,
      cc: vehicle.cc,
      weight: vehicle.weight,
      color: vehicle.color,
      body: vehicle.body,
      registrationProvince: vehicle.registrationProvince,
      ownerProvince: vehicle.ownerProvince,
      createdAt: vehicle.createdAt,
      customerName: vehicle.customer.name,
      brandName: vehicle.brand.name,
      // Step 4: ยื่นเอกสารจดทะเบียน - ดู tax.controller.ts (preview/tax-input) สำหรับการคำนวณจริง
      firstRegistrationDate: vehicle.firstRegistrationDate?.toISOString().slice(0, 10) ?? null,
      isFactoryNew: vehicle.isFactoryNew,
      ownerId: vehicle.ownerId,
      // ownerName = ชื่อผู้ถือกรรมสิทธิ์ (ไฟแนนซ์ = ชื่อไฟแนนซ์) hirerName = ชื่อผู้ครอบครอง (มีเฉพาะรถติดไฟแนนซ์)
      ownerName: vehicle.owner?.name ?? null,
      hirerName: vehicle.owner?.hirerName ?? null,
      // ownerType = เจ้าของตามทะเบียน (ไฟแนนซ์ = JURISTIC เสมอ) ส่วนประเภทที่ผู้ใช้เลือกในหน้าเพิ่มข้อมูลรถอยู่ที่
      // hirerType เมื่อมีไฟแนนซ์ - ฝั่ง frontend ใช้ entryOwnerType()/ownerDisplayLabel() ใน lib/vehicle-owner.ts
      ownerType: vehicle.owner?.ownerType ?? null,
      hirerType: vehicle.owner?.hirerType ?? null,
      financeCompanyId: vehicle.owner?.financeCompanyId ?? null,
      financeName: vehicle.owner?.financeCompany?.name ?? null,
      plateCategory: vehicle.plateCategory,
      plateNumber: vehicle.plateNumber,
      // งานสลับเลขที่ส่งเลขมาให้รถคันนี้ - เติมเฉพาะคิว/ค้นหาของหน้ายื่นเอกสาร (ดู attachPlateSwaps) ที่อื่นเป็น null
      plateSwap: null as PlateSwapSummary | null,
      pendingDocumentSubmission: vehicle.documentSubmissions[0]?.status === 'PENDING',
    };
  }

  // รถที่ใช้ในหน้ายื่นเอกสาร (Step 4) - เพิ่มผลตรวจ/วันหมดอายุผลตรวจ เหตุผลที่ยื่นไม่ได้ ณ วันที่ยื่น และครั้งล่าสุดที่
  // ยื่นไม่สำเร็จพร้อมเหตุผล (รถกลับมาทำ Step 4 ใหม่ - คันที่ยื่นค้าง/จดทะเบียนแล้วไม่แสดงเพราะไม่เกี่ยวแล้ว)
  // งานสลับเลขที่ส่งเลขให้รถแต่ละคัน (ผู้ใช้ 2026-09-23) - ดึงแยกจากคิวรถ ไม่ผูกไว้ใน include ของ Vehicle เพราะถ้า
  // ฐานข้อมูลยังไม่ได้รันไมเกรชันของตาราง PlateSwap คิวรถทั้งหน้าจะพังไปด้วย (P2021) - ตารางยังไม่มี = ถือว่าไม่มีงานสลับเลข
  private async plateSwapsByVehicle(vehicleIds: string[]): Promise<Map<string, PlateSwapSummary>> {
    if (vehicleIds.length === 0) return new Map();
    try {
      const swaps = await this.prisma.plateSwap.findMany({
        where: { newVehicleId: { in: vehicleIds } },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          newVehicleId: true,
          oldOwnerName: true,
          oldPlateCategory: true,
          oldPlateNumber: true,
          newPlateCategory: true,
          newPlateNumber: true,
          submitDate: true,
          returnedDate: true,
        },
      });
      const map = new Map<string, PlateSwapSummary>();
      for (const swap of swaps) {
        if (!swap.newVehicleId || map.has(swap.newVehicleId)) continue; // งานล่าสุดของรถคันนั้นเท่านั้น
        map.set(swap.newVehicleId, {
          id: swap.id,
          oldOwnerName: swap.oldOwnerName,
          oldPlateCategory: swap.oldPlateCategory,
          oldPlateNumber: swap.oldPlateNumber,
          newPlateCategory: swap.newPlateCategory,
          newPlateNumber: swap.newPlateNumber,
          submitDate: swap.submitDate.toISOString().slice(0, 10),
          returnedDate: swap.returnedDate?.toISOString().slice(0, 10) ?? null,
        });
      }
      return map;
    } catch (err) {
      if ((err as { code?: string })?.code === 'P2021') return new Map(); // ยังไม่ได้รันไมเกรชัน
      throw err;
    }
  }

  private async mapSubmitCandidates(
    vehicles: Array<
      Parameters<VehiclesService['mapVehicleFull']>[0] & {
        transferDone: boolean;
        inspectionSentDate: Date | null;
        inspectionResult: string | null;
        inspectionResultDate: Date | null;
      }
    >,
    submitDate: Date,
  ) {
    const failed = vehicles.length
      ? await this.prisma.documentSubmission.findMany({
          where: { vehicleId: { in: vehicles.map((v) => v.id) }, status: 'FAILED' },
          orderBy: { createdAt: 'desc' },
          distinct: ['vehicleId'],
          select: { vehicleId: true, submitDate: true, failRemark: true },
        })
      : [];
    const lastFailedByVehicle = new Map(failed.map((f) => [f.vehicleId, f]));
    const plateSwaps = await this.plateSwapsByVehicle(vehicles.map((v) => v.id));
    return vehicles.map((vehicle) => {
      const activeSubmissionStatus = vehicle.documentSubmissions[0]?.status ?? null;
      const lastFailed = activeSubmissionStatus ? undefined : lastFailedByVehicle.get(vehicle.id);
      return {
        ...this.mapVehicleFull(vehicle),
        plateSwap: plateSwaps.get(vehicle.id) ?? null,
        // รอรับเอกสารกลับของงานสลับเลขอยู่ = ยังยื่นไม่ได้ (ผู้ใช้ 2026-09-23) - ดู getSubmitBlockReason
        inspectionResultDate: vehicle.inspectionResultDate?.toISOString().slice(0, 10) ?? null,
        inspectionValidUntil:
          vehicle.inspectionResult === 'ผ่าน' && vehicle.inspectionResultDate ? inspectionValidUntil(vehicle.inspectionResultDate) : null,
        submitBlockReason: getSubmitBlockReason(
          { ...vehicle, activeSubmissionStatus, plateSwap: plateSwaps.get(vehicle.id) ?? null },
          submitDate,
        ),
        lastFailedSubmission: lastFailed
          ? { submitDate: lastFailed.submitDate.toISOString().slice(0, 10), failRemark: lastFailed.failRemark }
          : null,
      };
    });
  }

  private parseSubmitDateParam(raw: string | undefined): Date {
    const value = raw?.trim() || new Date().toISOString().slice(0, 10);
    if (!isValidDateParam(value)) throw new BadRequestException({ error: 'submitDate ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    return new Date(`${value}T00:00:00.000Z`);
  }

  // คิวรอยื่นเอกสาร (Step 4) ณ วันที่ยื่น: แจ้งย้าย/ตัดบัญชีเสร็จ + ตรวจผ่านไม่เกิน 90 วัน + ยังไม่เคยยื่นที่ค้างอยู่
  // หรือได้ใบเสร็จแล้ว - เรียงจากตรวจผ่านเก่าสุด (ใกล้หมดอายุสุด) ก่อน หน้าจอกรองยี่ห้อ/เจ้าของงาน/วันที่ตรวจเอง
  async findSubmissionQueue(submitDateRaw?: string) {
    const submitDate = this.parseSubmitDateParam(submitDateRaw);
    const earliestValidPass = new Date(submitDate.getTime() - (INSPECTION_VALID_DAYS - 1) * DAY_MS);
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        deletedAt: null, // รถที่ถูกลบไม่เข้าคิวไหนอีก (ดู deleteVehicle)
        transferDone: true,
        inspectionResult: 'ผ่าน',
        inspectionResultDate: { gte: earliestValidPass, lte: submitDate },
        documentSubmissions: { none: { status: { in: ACTIVE_SUBMISSION_STATUSES } } },
        ...vehicleTypeWhere(), // STAFF_CAR / STAFF_MOTO เห็นเฉพาะประเภทรถของตัวเอง
      },
      orderBy: [{ inspectionResultDate: 'asc' }, { date: 'asc' }, { chassis: 'asc' }],
      include: this.vehicleFullInclude,
    });
    // กฎเดียวกับตอน submit() - กรองซ้ำอีกชั้นให้คิวกับการยื่นจริงไม่มีทางไม่ตรงกัน
    return (await this.mapSubmitCandidates(vehicles, submitDate)).filter((v) => v.submitBlockReason === null);
  }

  async findAll() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: this.vehicleFullInclude,
    });
    return vehicles.map((vehicle) => this.mapVehicleFull(vehicle));
  }

  // ค้นหารถด้วยเลขตัวถัง (บางส่วนก็ได้) สำหรับหน้ายื่นเอกสารจดทะเบียน (Step 4) - แยกจาก findAll() เพราะ
  // findAll() จำกัดแค่ 100 คันล่าสุด รถเก่ากว่านั้นต้องค้นด้วย endpoint นี้ถึงจะเจอ
  async searchByChassis(query: string, submitDateRaw?: string) {
    const submitDate = this.parseSubmitDateParam(submitDateRaw);
    const trimmed = query.trim();
    if (!trimmed) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถัง' });
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, chassis: { contains: trimmed, mode: 'insensitive' }, ...vehicleTypeWhere() },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 20,
      include: this.vehicleFullInclude,
    });
    return this.mapSubmitCandidates(vehicles, submitDate);
  }

  // นำเข้าหลายคันพร้อมกัน (bulk paste เลขตัวถัง สูงสุด 1,000 คัน) - จับคู่แบบ exact match
  // (case-insensitive) กับรถที่มีอยู่แล้วในระบบ ไม่ใช่การสร้างรถใหม่ - รถที่ไม่พบคืนแยกไว้ให้ผู้ใช้แก้ไข
  async lookupByChassis(chassisList: string[], submitDateRaw?: string) {
    const submitDate = this.parseSubmitDateParam(submitDateRaw);
    const trimmed = Array.from(new Set(chassisList.map((c) => c.trim()).filter(Boolean)));
    if (trimmed.length === 0) throw new BadRequestException({ error: 'กรุณาระบุเลขตัวถังอย่างน้อย 1 รายการ' });
    if (trimmed.length > MAX_BATCH_SIZE) throw new BadRequestException({ error: `รองรับไม่เกิน ${MAX_BATCH_SIZE} คันต่อครั้ง` });

    // รถนอกขอบเขตประเภท (STAFF_CAR / STAFF_MOTO) ไม่ถูกดึงมา -> ไปอยู่ใน notFound เหมือนไม่มีในระบบ
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, chassis: { in: trimmed, mode: 'insensitive' }, ...vehicleTypeWhere() },
      include: this.vehicleFullInclude,
    });
    const mapped = await this.mapSubmitCandidates(vehicles, submitDate);
    // คันที่ยื่นไม่ได้ (ยังไม่ผ่าน Step 2/3, ผลตรวจหมดอายุ, รอใบเสร็จ, จดทะเบียนแล้ว) แยกออกจาก found พร้อมเหตุผล
    // - submit() ก็ปฏิเสธอยู่แล้วเช่นกัน (defense in depth) แต่แยกไว้ตั้งแต่ต้นทางให้ผู้ใช้เห็นชัดกว่า
    const found = mapped.filter((v) => v.submitBlockReason === null);
    const blocked = mapped
      .filter((v) => v.submitBlockReason !== null)
      .map((v) => ({ chassis: v.chassis, reason: v.submitBlockReason as string }));
    const foundChassisLower = new Set(mapped.map((v) => v.chassis.toLowerCase()));
    const notFound = trimmed.filter((c) => !foundChassisLower.has(c.toLowerCase()));
    return { found, notFound, blocked };
  }

  async createBatch(body: CreateVehiclesDto): Promise<{ count: number }> {
    const input = Array.isArray(body?.vehicles) ? (body.vehicles as Record<string, unknown>[]) : null;
    if (!input || input.length < 1 || input.length > MAX_BATCH_SIZE) {
      throw new BadRequestException({ error: 'รองรับ 1–1,000 รายการต่อครั้ง' });
    }

    const [customers, brands, financeCompanies] = await Promise.all([
      this.prisma.customer.findMany({ select: { id: true } }),
      this.prisma.brand.findMany({ select: { id: true } }),
      this.prisma.financeCompany.findMany({ select: { id: true, name: true } }),
    ]);
    const customerIds = new Set(customers.map((c) => c.id));
    const brandIds = new Set(brands.map((b) => b.id));
    const financeNames = new Map(financeCompanies.map((f) => [f.id, f.name]));

    const rowErrors: VehicleRowError[] = [];
    const seenChassis = new Set<string>();
    const rows: NormalizedVehicleRow[] = [];

    input.forEach((raw, index) => {
      const normalized = normalizeVehicleRow(raw);
      const errors = getVehicleRowErrors(normalized);

      if (!customerIds.has(normalized.customerId)) errors.push('ไม่พบลูกค้าในฐานข้อมูล');
      if (!brandIds.has(normalized.brandId)) errors.push('ไม่พบยี่ห้อในฐานข้อมูล');
      if (normalized.financeId && !financeNames.has(normalized.financeId)) errors.push('ไม่พบไฟแนนซ์ในฐานข้อมูล');
      if (seenChassis.has(normalized.chassis)) errors.push('เลขตัวถังซ้ำในชุดข้อมูล');
      seenChassis.add(normalized.chassis);

      if (errors.length) rowErrors.push({ row: index + 1, errors });
      rows.push(normalized);
    });

    if (rowErrors.length) {
      throw new BadRequestException({ error: 'กรุณาแก้ไขข้อมูลก่อนบันทึก', errors: rowErrors });
    }

    const existing = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, chassis: { in: rows.map((row) => row.chassis) } },
      select: { chassis: true },
    });
    if (existing.length) {
      const existingChassis = new Set(existing.map((v) => v.chassis));
      const conflicts = rows
        .map((row, index) => ({ row: index + 1, chassis: row.chassis }))
        .filter((entry) => existingChassis.has(entry.chassis));
      throw new ConflictException({
        error: `เลขตัวถัง ${conflicts[0].chassis} มีอยู่แล้ว`,
        errors: conflicts.map((entry) => ({ row: entry.row, errors: ['เลขตัวถังมีอยู่แล้ว'] })),
      });
    }

    // createMany is one SQL statement instead of one round trip per row - a $transaction of up
    // to MAX_BATCH_SIZE individual .create() calls was blowing past Prisma's 5s default
    // transaction timeout on batches above ~80 rows against the remote DB. เจ้าของรถ (VehicleOwner)
    // สร้างก่อนเป็นชุดเดียวด้วย createManyAndReturn เพื่อเอา id มาผูกกับรถแต่ละคัน (ลำดับผลลัพธ์ตรงกับ input)
    await this.prisma.$transaction(async (tx) => {
      const owners = await tx.vehicleOwner.createManyAndReturn({
        data: rows.map((row) => ownerDataFor(row, financeNames.get(row.financeId) ?? null)),
        select: { id: true },
      });
      await tx.vehicle.createMany({ data: rows.map((row, index) => this.toCreateData(row, owners[index].id)) });
    });

    return { count: rows.length };
  }

  // แก้ไขรถที่บันทึกแล้ว - ต้องมี remark ทุกครั้ง ไม่งั้นห้ามแก้ไข บันทึกทุกครั้งลง VehicleEditLog
  async updateVehicle(id: string, body: UpdateVehicleDto) {
    const remark = typeof body?.remark === 'string' ? body.remark.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้ไข (Remark)' });

    const existing = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: { owner: true } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    const row = normalizeVehicleRow(body as unknown as Record<string, unknown>);
    const errors = getVehicleRowErrors(row);
    if (errors.length) {
      throw new BadRequestException({ error: 'กรุณาแก้ไขข้อมูลก่อนบันทึก', errors: [{ row: 1, errors }] });
    }

    const [customer, brand, financeCompany] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: row.customerId } }),
      this.prisma.brand.findUnique({ where: { id: row.brandId } }),
      row.financeId ? this.prisma.financeCompany.findUnique({ where: { id: row.financeId } }) : null,
    ]);
    if (!customer) throw new BadRequestException({ error: 'ไม่พบลูกค้าในฐานข้อมูล' });
    if (!brand) throw new BadRequestException({ error: 'ไม่พบยี่ห้อในฐานข้อมูล' });
    if (row.financeId && !financeCompany) throw new BadRequestException({ error: 'ไม่พบไฟแนนซ์ในฐานข้อมูล' });

    if (row.chassis !== existing.chassis) {
      const duplicate = await this.prisma.vehicle.findFirst({ where: { chassis: row.chassis, deletedAt: null }, select: { id: true } });
      if (duplicate) throw new ConflictException({ error: 'เลขตัวถังนี้มีอยู่แล้ว' });
    }

    const data = this.toCreateData(row, existing.ownerId);
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key] of EDITABLE_VEHICLE_FIELDS) {
      const from = diffField((existing as Record<string, unknown>)[key]);
      const to = diffField((data as Record<string, unknown>)[key]);
      if (from !== to) changes[key] = { from, to };
    }

    // เจ้าของรถเปลี่ยน = สร้าง VehicleOwner แถวใหม่แล้วชี้ไปแทน (ไม่แก้แถวเดิม เพราะ Step 4 tax-input เคยให้เลือกแถวเจ้าของ
    // ที่มีอยู่ซ้ำข้ามคันได้) - บันทึกลง edit log เป็นข้อความอ่านง่ายใต้ key "owner"
    const currentOwner: OwnerData | null = existing.owner
      ? {
          name: existing.owner.name,
          hirerName: existing.owner.hirerName,
          ownerType: existing.owner.ownerType,
          isHirePurchaseBusiness: existing.owner.isHirePurchaseBusiness,
          hirerType: existing.owner.hirerType,
          financeCompanyId: existing.owner.financeCompanyId,
        }
      : null;
    const nextOwner = ownerDataFor(row, financeCompany?.name ?? null);
    const ownerChanged = !sameOwner(currentOwner, nextOwner);
    if (ownerChanged) changes.owner = { from: describeOwner(currentOwner), to: describeOwner(nextOwner) };

    const updated = await this.prisma.$transaction(async (tx) => {
      if (ownerChanged) {
        const owner = await tx.vehicleOwner.create({ data: nextOwner, select: { id: true } });
        data.ownerId = owner.id;
      }
      const vehicle = await tx.vehicle.update({ where: { id }, data });
      await tx.vehicleEditLog.create({ data: { vehicleId: id, remark, changes: JSON.stringify(changes) } });
      return vehicle;
    });

    return { id: updated.id };
  }

  // ลบข้อมูลรถจดใหม่ (ผู้ใช้ 2026-09-23) - ADMIN เท่านั้น (บังคับใน auth/access-policy.ts) ต้องระบุเหตุผลทุกครั้ง
  // ลบแบบซ่อน: แถวยังอยู่ในฐานข้อมูลแต่ deletedAt ไม่ว่าง จึงหายไปจากทุกหน้าจอและทุกคิว และ ADMIN กู้คืนได้
  // (ลบจริงไม่ได้เพราะเหตุผลที่ลบต้องตรวจสอบย้อนหลังได้ และแถวที่ผูกอยู่ เช่น ภาษี/ใบเสร็จ/บิล จะขาดไปด้วย)
  async deleteVehicle(id: string, body: DeleteVehicleDto) {
    const remark = typeof body?.remark === 'string' ? body.remark.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่ลบ (Remark)' });

    const existing = await this.prisma.vehicle.findUnique({
      where: { id },
      include: {
        // ทุกสถานะรวมถึง FAILED: ยื่นไปแล้วแม้จะไม่สำเร็จก็ถือว่าเดินงานไปแล้ว ให้แก้ไขข้อมูลแทนการลบ
        documentSubmissions: { select: { id: true }, take: 1 },
        invoiceLines: { select: { id: true }, take: 1 },
      },
    });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    if (existing.deletedAt) throw new BadRequestException({ error: 'รถคันนี้ถูกลบไปแล้ว' });

    const blockReason = await this.deleteBlockReason(existing);
    if (blockReason) throw new BadRequestException({ error: blockReason });

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.update({
        where: { id },
        data: { deletedAt: new Date(), deletedReason: remark, deletedById: currentUser()?.id ?? null },
      });
      // บันทึกลงประวัติเดียวกับการแก้ไข เพื่อให้ลบ -> กู้คืน -> ลบใหม่ ยังเห็นครบทุกครั้ง (ช่องบน Vehicle เก็บได้แค่ครั้งล่าสุด)
      await tx.vehicleEditLog.create({
        data: { vehicleId: id, remark, changes: JSON.stringify({ deleted: { from: null, to: 'ลบข้อมูลรถ' } }) },
      });
    });

    return { id, deleted: true };
  }

  // กู้คืนรถที่ลบไว้ - ADMIN เท่านั้น
  async restoreVehicle(id: string) {
    const existing = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    if (!existing.deletedAt) throw new BadRequestException({ error: 'รถคันนี้ไม่ได้ถูกลบอยู่' });

    // เลขตัวถังห้ามซ้ำเฉพาะในกลุ่มคันที่ยังไม่ถูกลบ ระหว่างที่ถูกลบจึงอาจมีคนคีย์เลขเดิมเข้ามาใหม่แล้ว - กู้คืนทับไม่ได้
    const active = await this.prisma.vehicle.findFirst({ where: { chassis: existing.chassis, deletedAt: null }, select: { id: true } });
    if (active) {
      throw new ConflictException({ error: `เลขตัวถัง ${existing.chassis} ถูกบันทึกเข้ามาใหม่แล้ว - กู้คืนคันนี้ไม่ได้` });
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.vehicle.update({ where: { id }, data: { deletedAt: null, deletedReason: null, deletedById: null } });
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: id,
          remark: `กู้คืนข้อมูลรถที่ลบไว้ (เหตุผลที่ลบ: ${existing.deletedReason ?? '—'})`,
          changes: JSON.stringify({ deleted: { from: 'ลบข้อมูลรถ', to: null } }),
        },
      });
    });

    return { id, deleted: false };
  }

  // รายการรถที่ถูกลบไว้ (100 รายการล่าสุด) - ADMIN เท่านั้น ใช้ตรวจสอบเหตุผลและกู้คืน
  async findDeleted() {
    const vehicles = await this.prisma.vehicle.findMany({
      where: { deletedAt: { not: null } },
      orderBy: [{ deletedAt: 'desc' }, { id: 'desc' }],
      take: 100,
      include: { ...this.vehicleFullInclude, deletedBy: { select: { name: true, displayName: true } } },
    });
    return vehicles.map((vehicle) => ({
      ...this.mapVehicleFull(vehicle),
      deletedAt: vehicle.deletedAt?.toISOString() ?? null,
      deletedReason: vehicle.deletedReason,
      deletedByName: vehicle.deletedBy ? vehicle.deletedBy.displayName || vehicle.deletedBy.name : null,
    }));
  }

  // เหตุผลที่ลบรถคันนี้ไม่ได้ (null = ลบได้) - กฎของผู้ใช้ 2026-09-23: ลบได้เฉพาะรถที่ยังไม่เลยขั้นยื่นเอกสาร
  private async deleteBlockReason(vehicle: { id: string; documentSubmissions: Array<unknown>; invoiceLines: Array<unknown> }): Promise<string | null> {
    if (vehicle.documentSubmissions.length > 0) {
      return 'รถคันนี้ยื่นเอกสารจดทะเบียนไปแล้ว - ลบไม่ได้ ถ้าข้อมูลผิดให้ใช้ปุ่มแก้ไขแทน';
    }
    if (vehicle.invoiceLines.length > 0) {
      return 'รถคันนี้ถูกวางบิลแล้ว - ลบไม่ได้';
    }
    try {
      const swap = await this.prisma.plateSwap.findFirst({ where: { newVehicleId: vehicle.id }, select: { id: true } });
      if (swap) return 'รถคันนี้ถูกผูกเป็นรถใหม่ของงานสลับเลข - ต้องไปแก้งานสลับเลขให้ผูกคันอื่นก่อนจึงจะลบได้';
    } catch {
      // ฐานข้อมูลที่ยังไม่ได้รันไมเกรชันตาราง PlateSwap (P2021) - ถือว่าไม่มีงานสลับเลข เหมือน plateSwapsByVehicle()
    }
    return null;
  }

  // ทุกคันที่ transferDone = false ไม่จำกัดวันที่รับงาน - ใช้แสดงคิวงานที่ต้องดำเนินการทั้งหมด
  async findPendingTransferNotice() {
    const [vehicles, deregistrationFees, relocateFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { deletedAt: null, transferDone: false },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeDeregistration.findMany(),
      this.prisma.feeRelocate.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapTransferNoticeVehicle(vehicle, deregistrationFees, relocateFees));
  }

  // ทุกคันที่ transferDone = true เรียงจากทำเสร็จล่าสุด ไม่กรองตามวันที่รับงาน
  async findRecentlyCompletedTransferNotice() {
    const [vehicles, deregistrationFees, relocateFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { deletedAt: null, transferDone: true },
        orderBy: [{ transferCompletedDate: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
        },
      }),
      this.prisma.feeDeregistration.findMany(),
      this.prisma.feeRelocate.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapTransferNoticeVehicle(vehicle, deregistrationFees, relocateFees));
  }

  private mapTransferNoticeVehicle(
    vehicle: {
      id: string;
      date: Date;
      chassis: string;
      body: string | null;
      registrationProvince: string | null;
      transferDone: boolean;
      transferCompletedDate: Date | null;
      transferCost: unknown;
      customer: { name: string };
      brand: { name: string };
    },
    deregistrationFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    relocateFees: Array<{ vehicleType: string; brand: string; noBillAmount: unknown; billAmount: unknown }>,
  ) {
    const status = getTransferStatus(vehicle.registrationProvince);
    const suggestedCost = this.suggestTransferCost(status, vehicle.body, vehicle.brand.name, deregistrationFees, relocateFees);

    return {
      id: vehicle.id,
      date: vehicle.date.toISOString().slice(0, 10),
      customerName: vehicle.customer.name,
      chassis: vehicle.chassis,
      brandName: vehicle.brand.name,
      body: vehicle.body,
      registrationProvince: vehicle.registrationProvince,
      status,
      suggestedCost,
      transferDone: vehicle.transferDone,
      transferCompletedDate: vehicle.transferCompletedDate?.toISOString().slice(0, 10) ?? null,
      transferCost: vehicle.transferCost,
    };
  }

  private suggestTransferCost(
    status: TransferStatus | null,
    body: string | null,
    brandName: string,
    deregistrationFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    relocateFees: Array<{ vehicleType: string; brand: string; noBillAmount: unknown; billAmount: unknown }>,
  ): string | null {
    if (!status || !body) return null;

    if (status === 'ตัดบัญชี') {
      const row = deregistrationFees.find((f) => f.vehicleType === body && f.brand === brandName)
        ?? deregistrationFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
      return row ? String(row.amount) : null;
    }

    const row = relocateFees.find((f) => f.vehicleType === body && f.brand === brandName)
      ?? relocateFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
    return row ? String(Number(row.noBillAmount) + Number(row.billAmount)) : null;
  }

  async updateTransferNotice(id: string, dto: UpdateTransferNoticeDto) {
    const done = Boolean(dto?.done);
    const completedDateRaw = typeof dto?.completedDate === 'string' ? dto.completedDate.trim() : '';
    const costRaw = typeof dto?.cost === 'string' ? dto.cost.trim() : '';

    if (completedDateRaw && !isValidDateParam(completedDateRaw)) {
      throw new BadRequestException({ error: 'วันที่เสร็จต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (costRaw && !/^\d+(\.\d+)?$/.test(costRaw)) {
      throw new BadRequestException({ error: 'ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0' });
    }

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);

    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        transferDone: done,
        transferCompletedDate: completedDateRaw ? new Date(`${completedDateRaw}T00:00:00.000Z`) : null,
        transferCost: costRaw ? costRaw : null,
      },
    });

    return {
      id: updated.id,
      transferDone: updated.transferDone,
      transferCompletedDate: updated.transferCompletedDate?.toISOString().slice(0, 10) ?? null,
      transferCost: updated.transferCost,
    };
  }

  // ผ่าน Step 2 แล้ว (transferDone = true) และ: ยังไม่ได้ส่งตรวจ, ตรวจไม่ผ่าน (ส่งตรวจใหม่), หรือผลตรวจผ่านครบ
  // 90 วันแล้วยังไม่ได้ยื่นเอกสาร (ต้องตรวจรอบ 2 - ดู isReinspectionDue) - ไม่จำกัดวันที่รับงาน
  async findPendingInspectionSend() {
    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: {
          deletedAt: null,
          transferDone: true,
          OR: [
            { inspectionSentDate: null },
            { inspectionResult: 'ไม่ผ่าน' },
            {
              inspectionResult: 'ผ่าน',
              inspectionResultDate: { lte: reinspectionThreshold() },
              documentSubmissions: { none: { status: { in: ACTIVE_SUBMISSION_STATUSES } } },
            },
          ],
        },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
          ...activeSubmissionsInclude,
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
  }

  // ส่งตรวจแล้ว (inspectionSentDate มีค่า) แต่ยังไม่ทราบผล (inspectionResultDate ยังไม่มี)
  async findPendingInspectionResult() {
    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { deletedAt: null, inspectionSentDate: { not: null }, inspectionResultDate: null },
        orderBy: [{ inspectionSentDate: 'desc' }, { id: 'desc' }],
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
          ...activeSubmissionsInclude,
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
  }

  // ทราบผลตรวจแล้ว (ผ่าน/ไม่ผ่าน) เรียงจากทำเสร็จล่าสุด
  async findRecentlyCompletedInspection() {
    const [vehicles, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { deletedAt: null, inspectionResultDate: { not: null } },
        orderBy: [{ inspectionResultDate: 'desc' }, { updatedAt: 'desc' }],
        take: 100,
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
          ...activeSubmissionsInclude,
        },
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return vehicles.map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
  }

  private mapInspectionVehicle(
    vehicle: {
      id: string;
      date: Date;
      chassis: string;
      engine: string | null;
      color: string | null;
      body: string | null;
      registrationProvince: string | null;
      customer: { name: string };
      brand: { name: string };
      inspectionRound: number;
      inspectionSentType: string | null;
      inspectionSentDate: Date | null;
      inspectionSentCost: unknown;
      inspectionSentBillCost: unknown;
      inspectionResult: string | null;
      inspectionResultDate: Date | null;
      inspectionResultCost: unknown;
      inspectionResultBillCost: unknown;
      inspectionFailRemark: string | null;
      documentSubmissions: Array<unknown>;
    },
    bangkokFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    provinceFees: Array<{ province: string; vehicleType: string; amount: unknown }>,
  ) {
    const suggestedCost = this.suggestInspectionCost(
      vehicle.registrationProvince,
      vehicle.body,
      vehicle.brand.name,
      bangkokFees,
      provinceFees,
    );

    return {
      id: vehicle.id,
      date: vehicle.date.toISOString().slice(0, 10),
      customerName: vehicle.customer.name,
      chassis: vehicle.chassis,
      // เลขเครื่อง/สี ใช้ในใบพิมพ์รายการส่งตรวจรถ (PDF) หน้าตรวจรถ
      engine: vehicle.engine,
      color: vehicle.color,
      brandName: vehicle.brand.name,
      body: vehicle.body,
      registrationProvince: vehicle.registrationProvince,
      suggestedCost,
      inspectionRound: vehicle.inspectionRound,
      // ผลตรวจผ่านหมดอายุ (ครบ 90 วัน ยังไม่ยื่นเอกสาร) ต้องตรวจรอบ 2 - หน้าจอใช้แสดงหมายเหตุในคิวส่งตรวจ
      round2Due: isReinspectionDue(vehicle),
      // ค่าตรวจรถ (Bill) มีเฉพาะรอบ 2 (ทั้งตอนถึงกำหนดและตอนส่งตรวจรอบ 2 ซ้ำหลังไม่ผ่าน)
      suggestedBillCost: isReinspectionDue(vehicle) || vehicle.inspectionRound === 2 ? String(INSPECTION_ROUND2_BILL_FEE) : null,
      inspectionSentType: vehicle.inspectionSentType,
      inspectionSentDate: vehicle.inspectionSentDate?.toISOString().slice(0, 10) ?? null,
      inspectionSentCost: vehicle.inspectionSentCost,
      inspectionSentBillCost: vehicle.inspectionSentBillCost,
      inspectionResult: vehicle.inspectionResult,
      inspectionResultDate: vehicle.inspectionResultDate?.toISOString().slice(0, 10) ?? null,
      inspectionResultCost: vehicle.inspectionResultCost,
      inspectionResultBillCost: vehicle.inspectionResultBillCost,
      inspectionFailRemark: vehicle.inspectionFailRemark,
    };
  }

  // ค่าใช้จ่ายส่งตรวจคงที่ (หน้าจอแก้ไม่ได้): ราคาตรวจรถ (No bill) ตามตาราง - เอารถมาตรวจเองเป็น 0 - และค่าตรวจรถ
  // (Bill) 50 บาทเฉพาะรอบ 2 ยังไม่เลือกประเภทการตรวจ = ยังไม่มีค่าใช้จ่าย
  private fixedSentCosts(
    sentType: string,
    round: number,
    vehicle: { registrationProvince: string | null; body: string | null; brand: { name: string } },
    bangkokFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    provinceFees: Array<{ province: string; vehicleType: string; amount: unknown }>,
  ): { inspectionSentCost: string | null; inspectionSentBillCost: string | null } {
    if (!sentType) return { inspectionSentCost: null, inspectionSentBillCost: null };
    return {
      inspectionSentCost:
        sentType === 'เอารถมาตรวจเอง'
          ? '0'
          : this.suggestInspectionCost(vehicle.registrationProvince, vehicle.body, vehicle.brand.name, bangkokFees, provinceFees),
      inspectionSentBillCost: round === 2 ? String(INSPECTION_ROUND2_BILL_FEE) : null,
    };
  }

  private suggestInspectionCost(
    registrationProvince: string | null,
    body: string | null,
    brandName: string,
    bangkokFees: Array<{ vehicleType: string; brand: string; amount: unknown }>,
    provinceFees: Array<{ province: string; vehicleType: string; amount: unknown }>,
  ): string | null {
    if (!registrationProvince || !body) return null;

    if (registrationProvince === 'กรุงเทพมหานคร') {
      const row = bangkokFees.find((f) => f.vehicleType === body && f.brand === brandName)
        ?? bangkokFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
      return row ? String(row.amount) : null;
    }

    const row = provinceFees.find((f) => f.province === registrationProvince && f.vehicleType === body);
    return row?.amount != null ? String(row.amount) : null;
  }

  // Step 3a: บันทึกว่าส่งตรวจแบบไหน (ส่งตรวจนอก/เอารถมาตรวจเอง) วันที่ส่ง และค่าใช้จ่าย
  async updateInspectionSent(id: string, dto: UpdateInspectionSentDto) {
    const sentType = typeof dto?.sentType === 'string' ? dto.sentType.trim() : '';
    const sentDateRaw = typeof dto?.sentDate === 'string' ? dto.sentDate.trim() : '';

    if (sentType && !INSPECTION_SENT_TYPES.includes(sentType as (typeof INSPECTION_SENT_TYPES)[number])) {
      throw new BadRequestException({ error: 'ประเภทการตรวจไม่ถูกต้อง' });
    }
    if (sentDateRaw && !isValidDateParam(sentDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }

    const [vehicle, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: { brand: { select: { name: true } }, ...activeSubmissionsInclude } }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);
    // Step 1 -> 4 ต้องทำตามลำดับ: ส่งตรวจได้หลังแจ้งย้าย/ตัดบัญชีเสร็จแล้วเท่านั้น
    if (!vehicle.transferDone) throw new BadRequestException({ error: 'ยังไม่ผ่านขั้นตอนแจ้งย้าย/ตัดบัญชี - ส่งตรวจรถไม่ได้' });

    // เริ่มรอบตรวจใหม่เมื่อ: ตรวจไม่ผ่าน (ส่งตรวจซ้ำรอบเดิม) หรือผลตรวจผ่านหมดอายุ (ขึ้นรอบ 2) - ล้างผลตรวจเดิม
    // ให้รถเข้าคิวรอผลตรวจอีกครั้ง และเก็บข้อมูลรอบก่อนไว้ใน VehicleEditLog เพราะช่องบน Vehicle เก็บได้แค่ชุดล่าสุด
    const isResend = vehicle.inspectionResult === 'ไม่ผ่าน';
    const startsRound2 = isReinspectionDue(vehicle);
    if (vehicle.inspectionResult === 'ผ่าน' && !startsRound2) {
      throw new BadRequestException({ error: `รถคันนี้ตรวจผ่านแล้ว ผลตรวจยังไม่หมดอายุ (${INSPECTION_VALID_DAYS} วัน)` });
    }
    const startsNewCycle = isResend || startsRound2;
    const round = startsRound2 ? 2 : vehicle.inspectionRound;
    const data = {
      inspectionSentType: sentType || null,
      inspectionSentDate: sentDateRaw ? new Date(`${sentDateRaw}T00:00:00.000Z`) : null,
      ...this.fixedSentCosts(sentType, round, vehicle, bangkokFees, provinceFees),
      ...(startsNewCycle
        ? {
            inspectionResult: null,
            inspectionResultDate: null,
            inspectionResultCost: null,
            inspectionResultBillCost: null,
            inspectionFailRemark: null,
          }
        : {}),
      ...(startsRound2 ? { inspectionRound: 2 } : {}),
    };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key, value] of Object.entries(data)) {
      const from = diffField((vehicle as Record<string, unknown>)[key]);
      const to = diffField(value);
      if (from !== to) changes[key] = { from, to };
    }

    const [updated] = await this.prisma.$transaction([
      this.prisma.vehicle.update({ where: { id }, data }),
      ...(startsNewCycle
        ? [
            this.prisma.vehicleEditLog.create({
              data: {
                vehicleId: id,
                remark: startsRound2
                  ? `เริ่มตรวจรอบ 2 (ผลตรวจรอบ ${vehicle.inspectionRound} ผ่านวันที่ ${diffField(vehicle.inspectionResultDate)} ครบ ${INSPECTION_VALID_DAYS} วันแล้วยังไม่ได้ยื่นเอกสาร)`
                  : `ส่งตรวจใหม่หลังตรวจไม่ผ่าน (เหตุผลเดิม: ${vehicle.inspectionFailRemark ?? '—'})`,
                changes: JSON.stringify(changes),
              },
            }),
          ]
        : []),
    ]);

    return {
      id: updated.id,
      inspectionRound: updated.inspectionRound,
      inspectionSentType: updated.inspectionSentType,
      inspectionSentDate: updated.inspectionSentDate?.toISOString().slice(0, 10) ?? null,
      inspectionSentCost: updated.inspectionSentCost,
      inspectionSentBillCost: updated.inspectionSentBillCost,
    };
  }

  // Step 3b: บันทึกผลตรวจ (ผ่าน/ไม่ผ่าน) - ตรวจไม่ผ่านต้องมี remark ทุกครั้ง
  async updateInspectionResult(id: string, dto: UpdateInspectionResultDto) {
    const result = typeof dto?.result === 'string' ? dto.result.trim() : '';
    const resultDateRaw = typeof dto?.resultDate === 'string' ? dto.resultDate.trim() : '';
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';

    if (result && !INSPECTION_RESULTS.includes(result as (typeof INSPECTION_RESULTS)[number])) {
      throw new BadRequestException({ error: 'ผลตรวจไม่ถูกต้อง' });
    }
    if (resultDateRaw && !isValidDateParam(resultDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (result === 'ไม่ผ่าน' && !remark) {
      throw new BadRequestException({ error: 'กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน' });
    }

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);
    if (result && !vehicle.inspectionSentDate) {
      throw new BadRequestException({ error: 'ยังไม่ได้บันทึกการส่งตรวจ - บันทึกผลตรวจไม่ได้' });
    }

    const updated = await this.prisma.vehicle.update({
      where: { id },
      data: {
        inspectionResult: result || null,
        inspectionResultDate: resultDateRaw ? new Date(`${resultDateRaw}T00:00:00.000Z`) : null,
        // ค่าใช้จ่ายคงที่ แก้จากหน้าจอไม่ได้: ผ่าน = ราคาตอนส่งตรวจ, ไม่ผ่าน = 0 (ได้เงินคืน)
        inspectionResultCost: result === 'ไม่ผ่าน' ? '0' : result === 'ผ่าน' ? vehicle.inspectionSentCost : null,
        // ค่าตรวจรถ (Bill) มีเฉพาะรอบ 2 (inspectionSentBillCost ไม่ว่าง) - กติกาเดียวกับ No bill
        inspectionResultBillCost:
          vehicle.inspectionSentBillCost == null ? null : result === 'ไม่ผ่าน' ? '0' : result === 'ผ่าน' ? vehicle.inspectionSentBillCost : null,
        inspectionFailRemark: result === 'ไม่ผ่าน' ? remark : null,
      },
    });

    return {
      id: updated.id,
      inspectionResult: updated.inspectionResult,
      inspectionResultDate: updated.inspectionResultDate?.toISOString().slice(0, 10) ?? null,
      inspectionResultCost: updated.inspectionResultCost,
      inspectionResultBillCost: updated.inspectionResultBillCost,
      inspectionFailRemark: updated.inspectionFailRemark,
    };
  }

  // Step 4: ผูกเจ้าของรถ + วันจดทะเบียนครั้งแรก + รถใหม่จากโรงงานหรือไม่ แล้วคำนวณและบันทึก
  // TaxCalculation snapshot ใหม่ทันที (immutable - ไม่ update ผลเดิม)
  async updateTaxInput(id: string, dto: UpdateTaxInputDto) {
    const ownerIdRaw = dto?.ownerId;
    if (ownerIdRaw !== null && ownerIdRaw !== undefined && typeof ownerIdRaw !== 'string') {
      throw new BadRequestException({ error: 'ownerId ต้องเป็นข้อความหรือ null' });
    }
    const isFactoryNewRaw = dto?.isFactoryNew;
    if (isFactoryNewRaw !== null && isFactoryNewRaw !== undefined && typeof isFactoryNewRaw !== 'boolean') {
      throw new BadRequestException({ error: 'isFactoryNew ต้องเป็น true/false หรือ null' });
    }
    const firstRegistrationDate = parseTaxDate(dto?.firstRegistrationDate, 'firstRegistrationDate');

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertVehicleInScope(vehicle.body); // Step 4 - STAFF_CAR / STAFF_MOTO แก้ได้เฉพาะประเภทรถของตัวเอง

    if (ownerIdRaw) {
      const owner = await this.prisma.vehicleOwner.findUnique({ where: { id: ownerIdRaw } });
      if (!owner) throw new BadRequestException({ error: 'ไม่พบเจ้าของรถในฐานข้อมูล' });
    }

    await this.prisma.vehicle.update({
      where: { id },
      data: {
        ownerId: ownerIdRaw || null,
        isFactoryNew: isFactoryNewRaw ?? null,
        firstRegistrationDate,
      },
    });

    return this.taxService.calculateAndSave(id);
  }

  // ownerId = VehicleOwner ที่สร้างจาก ownerDataFor(row) - ดู createBatch/updateVehicle
  private toCreateData(row: NormalizedVehicleRow, ownerId: string | null) {
    return {
      ownerId,
      date: new Date(`${row.date}T00:00:00.000Z`),
      customerId: row.customerId,
      chassis: row.chassis,
      engine: row.engine || null,
      brandId: row.brandId,
      fuel: row.fuel || null,
      cc: row.cc === '' ? null : row.cc,
      weight: row.weight === '' ? null : row.weight,
      color: row.color || null,
      body: row.body || null,
      registrationProvince: row.registrationProvince || null,
      ownerProvince: row.ownerProvince || null,
    };
  }
}
