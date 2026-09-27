import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { assertTransferNoticeInScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { currentUser } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';
import type { GovernmentTaxOwnerInput, GovernmentTaxVehicleInput } from '../tax/government-tax-calculator.js';
import { vehicleListWhere } from './vehicle-list-filter.js';
import {
  affectedSteps,
  changedStepFields,
  isImpactConfirmed,
  needsTaxPreview,
  ownerNameChanged,
  ownerTaxChanged,
  type AffectedStep,
} from './vehicle-edit-impact.js';
import { CreateVehiclesDto } from './dto/create-vehicles.dto.js';
import { UpdateTransferNoticeDto } from './dto/update-transfer-notice.dto.js';
import { CorrectTransferNoticeDto } from './dto/correct-transfer-notice.dto.js';
import { UpdateInspectionSentDto } from './dto/update-inspection-sent.dto.js';
import { CorrectInspectionSentDto } from './dto/correct-inspection-sent.dto.js';
import { CancelInspectionSentDto } from './dto/cancel-inspection-sent.dto.js';
import { UpdateInspectionResultDto } from './dto/update-inspection-result.dto.js';
import { CorrectInspectionResultDto } from './dto/correct-inspection-result.dto.js';
import { UpdateVehicleDto } from './dto/update-vehicle.dto.js';
import { DeleteVehicleDto } from './dto/delete-vehicle.dto.js';
import { getVehicleRowErrors, normalizeVehicleRow, NormalizedVehicleRow } from './vehicle-validation.js';
import { OWNER_TYPE_CHOICES } from './vehicle-reference-data.js';
import { cancelledSubmitDate, resubmitWindow, type ResubmitWindow, type SubmitAttempt } from './resubmit-window.js';
import { OwnerType } from '../generated/prisma/enums.js';
import { addDays, bangkokToday, isoOf, toDate } from '../overview/overview-calculator.js';
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

// คำเตือนตอนแก้ข้อมูลรถที่ผ่านขั้นตอนถัดไปแล้ว (ผู้ใช้ 2026-09-27) - tax = ภาษีที่ยื่นไว้ + ข้อมูลใหม่สำหรับ preview ภาษี
// (เฉพาะรายการยื่นที่รอใบเสร็จและช่องที่ใช้คิดภาษีเปลี่ยน)
interface EditWarning {
  affected: AffectedStep[];
  tax: { old: number | null; vehicle: GovernmentTaxVehicleInput; owner: GovernmentTaxOwnerInput } | null;
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

// ผู้แก้สำหรับ VehicleEditLog.editedById (ผู้ใช้ 2026-09-24) - นอกคำขอ HTTP (script/test) เป็น null
function editorId(): string | null {
  return currentUser()?.id ?? null;
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

// ตรวจผ่านวันนี้หรือก่อนหน้านี้ = ผลตรวจหมดอายุแล้ว (ครบ 90 วัน) - นับตามวันปฏิทินไทยแบบเดียวกับ getSubmitBlockReason
// (พบ 2026-09-27: เดิมลบ 90 วันจากเวลา UTC ตอนนี้ ช่วง 00:00-07:00 รถวันที่ 90 ไม่อยู่ทั้งคิวยื่นและคิวตรวจรอบ 2)
function reinspectionThreshold(): Date {
  return toDate(addDays(bangkokToday(), -INSPECTION_VALID_DAYS));
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

// เงื่อนไข "ยังไม่ยื่นเอกสาร" ใส่ใน where ของคำสั่งบันทึก Step 2/3 ด้วย ให้การตรวจกับการบันทึกเป็นคำสั่งเดียวกัน
const NOT_SUBMITTED_WHERE = { documentSubmissions: { none: { status: { in: ACTIVE_SUBMISSION_STATUSES } } } };

// หน้าจอที่เปิดค้างไว้บันทึกทับข้อมูลที่คนอื่นเพิ่งบันทึก (พบ 2026-09-27) - บันทึกแบบมีเงื่อนไขว่าข้อมูลยังเป็นแบบที่อ่านมา
// ถ้าไม่ตรงแล้ว (มีคนแก้ไปก่อน) ตอบ 409 ให้หน้าจอโหลดรายการใหม่ แทนการเขียนทับเงียบๆ
const STALE_ERROR = 'ข้อมูลถูกแก้ไขโดยผู้อื่น - โหลดรายการใหม่';

const DAY_MS = 24 * 60 * 60 * 1000;

const dmy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// บันทึกเลขตัวถังเดียวกันพร้อมกัน 2 คำขอ ผ่านการตรวจล่วงหน้าทั้งคู่ -> partial unique index "Vehicle_chassis_active_key"
// กันไว้อีกชั้น (Prisma P2002) ต้องตอบ 409 พร้อมเลขตัวถัง ไม่ใช่ 500 "ดำเนินการไม่สำเร็จ" (พบ 2026-09-27)
export function isChassisConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null || (err as { code?: unknown }).code !== 'P2002') return false;
  // ชื่อคอลัมน์/index อยู่ใน meta.target หรือใน meta.driverAdapterError (แล้วแต่ adapter) - ไม่รู้ = ถือว่าเป็นของ chassis
  // (unique เดียวของตาราง Vehicle นอกจาก id)
  const meta = (err as { meta?: unknown }).meta;
  return meta === undefined || JSON.stringify(meta).includes('chassis');
}

// ส่งตรวจได้หลังแจ้งย้าย/ตัดบัญชีเสร็จเท่านั้น (Step 1 -> 4 ตามลำดับ) วันที่ส่งตรวจจึงต้องไม่ก่อนวันที่แจ้งย้าย/ตัดบัญชีเสร็จ
// (ไม่มี = วันที่รับงาน) - พบ 2026-09-27: เดิมตรวจแค่รูปแบบ วันส่งตรวจย้อนหลังทำให้ผลตรวจผ่านเริ่มนับ 90 วันเร็วเกินจริง
function assertSentDateInOrder(sentDateIso: string, vehicle: { date: Date; transferCompletedDate: Date | null }) {
  const earliest = isoOf(vehicle.transferCompletedDate ?? vehicle.date);
  if (sentDateIso < earliest) {
    const from = vehicle.transferCompletedDate ? 'วันที่แจ้งย้าย/ตัดบัญชีเสร็จ' : 'วันที่รับงาน';
    throw new BadRequestException({ error: `วันที่ส่งตรวจต้องไม่ก่อน${from} (${dmy(earliest)})` });
  }
}

// วันที่ทราบผลต้องไม่ก่อนวันที่ส่งตรวจ และไม่เกินวันนี้ตามเวลาไทย (พบ 2026-09-27) - ใช้ทั้งตอนบันทึกผลและตอนแก้ไขผลตรวจ
export function assertResultDateInRange(resultDateIso: string, sentDate: Date | null, today: string = bangkokToday()) {
  if (sentDate && resultDateIso < isoOf(sentDate)) {
    throw new BadRequestException({ error: `วันที่ทราบผลต้องไม่ก่อนวันที่ส่งตรวจ (${dmy(isoOf(sentDate))})` });
  }
  if (resultDateIso > today) throw new BadRequestException({ error: 'วันที่ทราบผลต้องไม่เกินวันนี้' });
}

// แก้/ยกเลิกการส่งตรวจได้เฉพาะรถที่ส่งตรวจแล้วและยังไม่มีผลตรวจ - มีผลแล้วให้ใช้ "แก้ไขผลตรวจ" แทน
function assertAwaitingResult(vehicle: { inspectionSentDate: Date | null; inspectionResult: string | null; inspectionResultDate: Date | null }) {
  if (!vehicle.inspectionSentDate || vehicle.inspectionResult != null || vehicle.inspectionResultDate != null) {
    throw new BadRequestException({ error: 'แก้/ยกเลิกการส่งตรวจได้เฉพาะรถที่ส่งตรวจแล้วและยังรอผลตรวจ' });
  }
}

// ชื่อยี่ห้อในตารางราคาเทียบแบบไม่สนตัวพิมพ์ (พบ 2026-09-27: ยี่ห้อ "BENZ" ที่เพิ่มซ้ำกับ "Benz" ตกไปใช้ราคา "อื่นๆ")
function sameBrandName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function diffField(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

// ค่าใช้จ่ายเท่ากันไหม - เทียบเป็นตัวเลข ("300" = "300.00" = Decimal 300) ว่าง/null = ไม่มีค่าใช้จ่าย
function sameCostValue(a: unknown, b: unknown): boolean {
  const empty = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  return Number(String(a)) === Number(String(b));
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

// รถที่ยังไม่ยื่นเอกสารแสดงในตาราง "ตรวจเสร็จเรียบร้อย" ครบทุกคัน ส่วนรถที่ยื่นแล้วแสดงเท่านี้คันล่าสุดไว้ดูอ้างอิง
const COMPLETED_SUBMITTED_REFERENCE = 100;

@Injectable()
export class VehiclesService {
  // TaxService ใช้ preview ภาษีตามข้อมูลใหม่ในคำเตือนตอนแก้ข้อมูลรถที่ยื่นแล้ว (ไม่บันทึก - ผู้ใช้ 2026-09-27)
  // unit test ที่ไม่ส่งมาใช้ตัวที่สร้างจาก prisma เดียวกัน
  private readonly taxService: TaxService;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(TaxService) taxService?: TaxService,
  ) {
    this.taxService = taxService ?? new TaxService(prisma);
  }

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
      // Step 4: ยื่นเอกสารจดทะเบียน - การคำนวณภาษีจริงอยู่ที่ TaxService (เรียกจากการยื่นเอกสาร)
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
      // งานที่ยังไม่รับเอกสารกลับมาก่อน (ตัวที่ล็อกการยื่น) แล้วค่อยงานล่าสุด งานที่ยกเลิกแล้วไม่นับ (ผู้ใช้ 2026-09-27: กฎเดียวกับ
      // การยื่นจริงและค้นหารถ - ดู document-submission/plate-swap-link.ts เดิมดูแค่งานล่าสุด งานเก่าที่ยังค้างไม่ล็อก)
      const swaps = await this.prisma.plateSwap.findMany({
        where: { newVehicleId: { in: vehicleIds }, cancelledAt: null },
        orderBy: [{ returnedDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
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
        if (!swap.newVehicleId || map.has(swap.newVehicleId)) continue; // งานแรกตามลำดับข้างบนของรถคันนั้นเท่านั้น
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
    // ไม่ส่งมา = วันนี้ตามเวลาไทย (พบ 2026-09-27: เดิมเป็นวันที่ UTC ช่วง 00:00-07:00 ได้วันเมื่อวาน)
    const value = raw?.trim() || bangkokToday();
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

  // รายการรถในหน้าเพิ่มข้อมูลรถจดใหม่ ทีละ 100 คัน (offset = ข้ามไปกี่คัน สำหรับปุ่ม "โหลดเพิ่ม", limit = ขนาดหน้า
  // สูงสุด 1,000 ใช้ตอนโหลดรายการใหม่หลังแก้ไข/ลบให้ได้จำนวนเท่าที่เปิดดูอยู่) ค้นหา (q) ได้จาก
  // เลขตัวถัง / เลขเครื่อง / ทะเบียน / ชื่อลูกค้า / ผู้ถือกรรมสิทธิ์ / ผู้ครอบครอง และกรองช่วง "วันที่" (Vehicle.date)
  // ด้วย from/to (ค.ศ. YYYY-MM-DD รวมวันปลายทั้งสองด้าน) - ค้นทั้งฐานข้อมูล ไม่ใช่แค่ 100 คันล่าสุด
  async findAll(params: { q?: string; from?: string; to?: string; offset?: string; limit?: string } = {}) {
    const pageSize = Math.min(1000, Math.max(1, Number.parseInt(params.limit ?? '100', 10) || 100));
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);
    const where = vehicleListWhere(params);

    const rows = await this.prisma.vehicle.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: offset,
      take: pageSize + 1, // เกินมา 1 คัน = ยังมีหน้าถัดไป
      include: this.vehicleFullInclude,
    });
    return {
      vehicles: rows.slice(0, pageSize).map((vehicle) => this.mapVehicleFull(vehicle)),
      hasMore: rows.length > pageSize,
    };
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

    await this.assertChassisAvailable(rows);

    // createMany is one SQL statement instead of one round trip per row - a $transaction of up
    // to MAX_BATCH_SIZE individual .create() calls was blowing past Prisma's 5s default
    // transaction timeout on batches above ~80 rows against the remote DB. เจ้าของรถ (VehicleOwner)
    // สร้างก่อนเป็นชุดเดียวด้วย createManyAndReturn เพื่อเอา id มาผูกกับรถแต่ละคัน (ลำดับผลลัพธ์ตรงกับ input)
    try {
      await this.prisma.$transaction(async (tx) => {
        const owners = await tx.vehicleOwner.createManyAndReturn({
          data: rows.map((row) => ownerDataFor(row, financeNames.get(row.financeId) ?? null)),
          select: { id: true },
        });
        await tx.vehicle.createMany({ data: rows.map((row, index) => this.toCreateData(row, owners[index].id)) });
      });
    } catch (err) {
      if (!isChassisConflict(err)) throw err;
      // มีคนบันทึกเลขตัวถังเดียวกันเข้ามาระหว่างนั้น - ตรวจซ้ำเพื่อบอกแถวที่ซ้ำ (ทั้งชุดถูกยกเลิกแล้ว ไม่มีอะไรถูกบันทึก)
      await this.assertChassisAvailable(rows);
      throw new ConflictException({ error: 'เลขตัวถังซ้ำกับรถที่เพิ่งบันทึกเข้ามา - โหลดรายการใหม่แล้วลองอีกครั้ง' });
    }

    return { count: rows.length };
  }

  // เลขตัวถังต้องไม่ซ้ำกับรถที่ยังไม่ถูกลบ - เทียบแบบไม่สนตัวพิมพ์ (พบ 2026-09-27: เดิม "abc" กับ "ABC" นับเป็นคนละคัน
  // และรถเก่าที่คีย์ตัวเล็กไว้ก่อนปรับเป็นตัวใหญ่ยังอยู่ในฐานข้อมูล) ซ้ำ = 409 พร้อมแถวที่ซ้ำ
  private async assertChassisAvailable(rows: NormalizedVehicleRow[]) {
    const existing = await this.prisma.vehicle.findMany({
      where: { deletedAt: null, chassis: { in: rows.map((row) => row.chassis), mode: 'insensitive' } },
      select: { chassis: true },
    });
    if (!existing.length) return;
    const existingChassis = new Set(existing.map((v) => v.chassis.toUpperCase()));
    const conflicts = rows
      .map((row, index) => ({ row: index + 1, chassis: row.chassis }))
      .filter((entry) => existingChassis.has(entry.chassis.toUpperCase()));
    throw new ConflictException({
      error: `เลขตัวถัง ${conflicts[0]?.chassis ?? existing[0].chassis} มีอยู่แล้ว`,
      errors: conflicts.map((entry) => ({ row: entry.row, errors: ['เลขตัวถังมีอยู่แล้ว'] })),
    });
  }

  // สถานะขั้นตอนของรถที่ใช้เตือนตอนแก้ข้อมูลรถ (ผู้ใช้ 2026-09-27) - ดู vehicle-edit-impact.ts
  // รายการยื่นที่ยัง active ล่าสุด (ภาษีที่ยื่นไว้) / ใบส่งงานที่ยังไม่ยกเลิก / ใบวางบิลที่ยังไม่ VOID
  private readonly editStepStateInclude = {
    owner: true,
    documentSubmissions: {
      where: { status: { in: ACTIVE_SUBMISSION_STATUSES } },
      orderBy: { createdAt: 'desc' as const },
      take: 1,
      select: { status: true, taxAmount: true, submitDate: true },
    },
    deliverySlipItems: { where: { cancelledAt: null }, select: { id: true }, take: 1 },
    invoiceLines: { where: { invoice: { status: { not: 'VOID' } } }, select: { id: true }, take: 1 },
  } as const;

  // แก้ไขรถที่บันทึกแล้ว - ต้องมี remark ทุกครั้ง ไม่งั้นห้ามแก้ไข บันทึกทุกครั้งลง VehicleEditLog
  // แก้ช่องที่ขั้นตอนถัดไปใช้ไปแล้ว (จังหวัด/ประเภทรถ/ยี่ห้อ/เชื้อเพลิง/CC/น้ำหนัก/เจ้าของ/ลูกค้า - ผู้ใช้ 2026-09-27) = ตอบ 409
  // { needsConfirm: true, affected, taxPreview? } จนกว่าจะส่ง confirm: true (+ confirmedSteps = confirmKey ของคำเตือนที่เห็น) มา
  // เตือนอย่างเดียว: ค่าใช้จ่าย/ค่าธรรมเนียม/ภาษีของขั้นตอนเดิมไม่ถูกคิดใหม่ (รายการยื่นที่รอใบเสร็จ -> ยกเลิกแล้วยื่นใหม่)
  async updateVehicle(id: string, body: UpdateVehicleDto) {
    const remark = typeof body?.remark === 'string' ? body.remark.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้ไข (Remark)' });

    const existing = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, select: { id: true, chassis: true } });
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
      // ไม่สนตัวพิมพ์ และไม่นับตัวเอง (รถเก่าที่คีย์ตัวเล็กไว้ แก้แล้วเลขตัวถังถูกปรับเป็นตัวใหญ่)
      const duplicate = await this.prisma.vehicle.findFirst({
        where: { id: { not: id }, deletedAt: null, chassis: { equals: row.chassis, mode: 'insensitive' } },
        select: { id: true },
      });
      if (duplicate) throw new ConflictException({ error: 'เลขตัวถังนี้มีอยู่แล้ว' });
    }

    const nextOwner = ownerDataFor(row, financeCompany?.name ?? null);

    let warning: EditWarning | null;
    try {
      warning = await this.prisma.$transaction(async (tx): Promise<EditWarning | null> => {
        // ล็อกแถวรถก่อนอ่านสถานะขั้นตอน (ยื่นเอกสาร/วางบิล/ลบรถล็อกแถวเดียวกัน) - ยื่นเอกสารพร้อมกับที่แก้ = อีกฝั่งรอจนแก้เสร็จ
        // หรือแก้เห็นรายการยื่นที่เพิ่งบันทึก ไม่มีทางบันทึกผ่านไปโดยไม่เตือน
        await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${id} FOR UPDATE`;
        const current = await tx.vehicle.findFirst({ where: { id, deletedAt: null }, include: this.editStepStateInclude });
        if (!current) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

        const data = this.toCreateData(row, current.ownerId);
        const changes: Record<string, { from: string | null; to: string | null }> = {};
        for (const [key] of EDITABLE_VEHICLE_FIELDS) {
          const from = diffField((current as Record<string, unknown>)[key]);
          const to = diffField((data as Record<string, unknown>)[key]);
          if (from !== to) changes[key] = { from, to };
        }

        // เจ้าของรถเปลี่ยน = สร้าง VehicleOwner แถวใหม่แล้วชี้ไปแทน (ไม่แก้แถวเดิม เพราะ Step 4 tax-input เคยให้เลือกแถวเจ้าของ
        // ที่มีอยู่ซ้ำข้ามคันได้) - บันทึกลง edit log เป็นข้อความอ่านง่ายใต้ key "owner"
        const currentOwner: OwnerData | null = current.owner
          ? {
              name: current.owner.name,
              hirerName: current.owner.hirerName,
              ownerType: current.owner.ownerType,
              isHirePurchaseBusiness: current.owner.isHirePurchaseBusiness,
              hirerType: current.owner.hirerType,
              financeCompanyId: current.owner.financeCompanyId,
            }
          : null;
        const ownerChanged = !sameOwner(currentOwner, nextOwner);
        if (ownerChanged) changes.owner = { from: describeOwner(currentOwner), to: describeOwner(nextOwner) };

        // ขั้นตอนที่ใช้ข้อมูลเดิมไปแล้ว (ผู้ใช้ 2026-09-27) - ยังไม่ได้ยืนยัน = ไม่บันทึกอะไร คืนคำเตือนให้ตอบ 409
        const submission = current.documentSubmissions[0] ?? null;
        const state = {
          transferDone: current.transferDone,
          inspectionSent: current.inspectionSentDate != null,
          inspectionResultPending: current.inspectionSentDate != null && current.inspectionResult == null && current.inspectionResultDate == null,
          submissionStatus: submission?.status ?? null,
          submitDate: submission?.submitDate ? isoOf(submission.submitDate) : null,
          delivered: current.deliveredDate != null || current.deliverySlipItems.length > 0,
          billed: current.invoiceLines.length > 0,
          billingClosed: current.billingClosedAt != null,
        };
        // ชื่อเจ้าของนับแยกจากส่วนที่มีผลกับภาษี: ใบส่งงานอ่านชื่อตอนพิมพ์ (ผู้ใช้ 2026-09-27 รอบตรวจ)
        const changed = changedStepFields(current, data, ownerTaxChanged(currentOwner, nextOwner), ownerNameChanged(currentOwner, nextOwner));
        const affected = affectedSteps(changed, state, current, data);
        if (!isImpactConfirmed(affected, body?.confirm, body?.confirmedSteps)) {
          return {
            affected,
            tax: needsTaxPreview(changed, state)
              ? {
                  old: submission?.taxAmount == null ? null : Number(submission.taxAmount),
                  vehicle: { body: data.body, fuel: data.fuel, cc: data.cc, weight: data.weight, firstRegistrationDate: current.firstRegistrationDate },
                  owner: { ownerType: nextOwner.ownerType, isHirePurchaseBusiness: nextOwner.isHirePurchaseBusiness, hirerType: nextOwner.hirerType },
                }
              : null,
          };
        }

        if (ownerChanged) {
          const owner = await tx.vehicleOwner.create({ data: nextOwner, select: { id: true } });
          data.ownerId = owner.id;
        }
        await tx.vehicle.update({ where: { id }, data });
        await tx.vehicleEditLog.create({
          data: {
            vehicleId: id,
            // แก้หลังขั้นตอนที่ใช้ข้อมูลเดิม (ผู้ใช้ยืนยันคำเตือนแล้ว) - เก็บว่าเตือนขั้นตอนไหนไว้กับเหตุผลด้วย
            remark: affected.length ? `ยืนยันแก้หลัง ${affected.map((a) => a.label).join(', ')}: ${remark}` : remark,
            changes: JSON.stringify(changes),
            editedById: editorId(),
          },
        });
        return null;
      });
    } catch (err) {
      // มีคนบันทึกเลขตัวถังเดียวกันเข้ามาระหว่างนั้น (unique index กันไว้) - ตอบ 409 แบบเดียวกับการตรวจล่วงหน้า
      if (isChassisConflict(err)) throw new ConflictException({ error: 'เลขตัวถังนี้มีอยู่แล้ว' });
      throw err;
    }

    if (warning) {
      // ภาษีตามข้อมูลใหม่แบบ preview (ไม่บันทึก TaxCalculation) เทียบกับภาษีที่ยื่นไว้ - คำนวณนอก transaction ไม่ให้ล็อกแถวรถนาน
      let taxPreview: { old: number | null; new: number | null; reason: string | null } | undefined;
      if (warning.tax) {
        const [preview] = await this.taxService.previewMany([{ vehicle: warning.tax.vehicle, owner: warning.tax.owner }]);
        taxPreview = { old: warning.tax.old, new: preview?.amount ?? null, reason: preview?.reason ?? null };
      }
      throw new ConflictException({
        error: 'รถคันนี้ผ่านขั้นตอนที่ใช้ข้อมูลเดิมไปแล้ว - ตรวจสอบผลกระทบแล้วกดยืนยันเพื่อบันทึก',
        needsConfirm: true,
        affected: warning.affected,
        ...(taxPreview ? { taxPreview } : {}),
      });
    }

    return { id };
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

    const deleted = await this.prisma.$transaction(async (tx) => {
      // ตรวจเงื่อนไขซ้ำในคำสั่งเดียวกับการลบ (พบ 2026-09-27): ถ้ามีคนยื่นเอกสาร/วางบิลรถคันนี้ระหว่างที่กำลังลบ ต้องไม่ลบ
      // ไม่งั้นได้รถที่ถูกซ่อนไปทั้งที่ยังมีรายการยื่นค้างอยู่ (งานสลับเลขตรวจแยกใน deleteBlockReason - ตารางอาจยังไม่มี)
      // ล็อกแถวรถก่อน (ยื่นเอกสาร/วางบิลล็อกแถวเดียวกัน) คำสั่งลบด้านล่างจึงเริ่มหลังอีกฝั่ง commit และเห็นรายการยื่นที่เพิ่งสร้าง
      await tx.$queryRaw`SELECT "id" FROM "Vehicle" WHERE "id" = ${id} FOR UPDATE`;
      const { count } = await tx.vehicle.updateMany({
        where: { id, deletedAt: null, documentSubmissions: { none: {} }, invoiceLines: { none: {} } },
        data: { deletedAt: new Date(), deletedReason: remark, deletedById: currentUser()?.id ?? null },
      });
      if (count === 0) return false;
      // บันทึกลงประวัติเดียวกับการแก้ไข เพื่อให้ลบ -> กู้คืน -> ลบใหม่ ยังเห็นครบทุกครั้ง (ช่องบน Vehicle เก็บได้แค่ครั้งล่าสุด)
      await tx.vehicleEditLog.create({
        data: { vehicleId: id, remark, changes: JSON.stringify({ deleted: { from: null, to: 'ลบข้อมูลรถ' } }), editedById: editorId() },
      });
      return true;
    });
    if (!deleted) {
      // สถานะเปลี่ยนไประหว่างนั้น - อ่านใหม่เพื่อบอกเหตุผลที่ลบไม่ได้
      const current = await this.prisma.vehicle.findUnique({
        where: { id },
        include: { documentSubmissions: { select: { id: true }, take: 1 }, invoiceLines: { select: { id: true }, take: 1 } },
      });
      if (!current || current.deletedAt) throw new BadRequestException({ error: 'รถคันนี้ถูกลบไปแล้ว' });
      throw new BadRequestException({ error: (await this.deleteBlockReason(current)) ?? STALE_ERROR });
    }

    return { id, deleted: true };
  }

  // กู้คืนรถที่ลบไว้ - ADMIN เท่านั้น
  async restoreVehicle(id: string) {
    const existing = await this.prisma.vehicle.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    if (!existing.deletedAt) throw new BadRequestException({ error: 'รถคันนี้ไม่ได้ถูกลบอยู่' });

    // เลขตัวถังห้ามซ้ำเฉพาะในกลุ่มคันที่ยังไม่ถูกลบ ระหว่างที่ถูกลบจึงอาจมีคนคีย์เลขเดิมเข้ามาใหม่แล้ว - กู้คืนทับไม่ได้
    // เทียบแบบไม่สนตัวพิมพ์ (รถเก่าอาจคีย์ตัวเล็กไว้ ส่วนคันใหม่เป็นตัวใหญ่)
    const conflict = new ConflictException({ error: `เลขตัวถัง ${existing.chassis} ถูกบันทึกเข้ามาใหม่แล้ว - กู้คืนคันนี้ไม่ได้` });
    const active = await this.prisma.vehicle.findFirst({
      where: { id: { not: id }, deletedAt: null, chassis: { equals: existing.chassis, mode: 'insensitive' } },
      select: { id: true },
    });
    if (active) throw conflict;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.vehicle.update({ where: { id }, data: { deletedAt: null, deletedReason: null, deletedById: null } });
        await tx.vehicleEditLog.create({
          data: {
            vehicleId: id,
            remark: `กู้คืนข้อมูลรถที่ลบไว้ (เหตุผลที่ลบ: ${existing.deletedReason ?? '—'})`,
            changes: JSON.stringify({ deleted: { from: 'ลบข้อมูลรถ', to: null } }),
            editedById: editorId(),
          },
        });
      });
    } catch (err) {
      // มีคนคีย์เลขตัวถังเดิมเข้ามาระหว่างนั้น (unique index กันไว้) - ตอบ 409 แบบเดียวกับการตรวจล่วงหน้า
      if (isChassisConflict(err)) throw conflict;
      throw err;
    }

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
      // งานสลับเลขที่ยกเลิกแล้วไม่นับ (ยกเลิกแบบซ่อน ไม่ลบแถว - ผู้ใช้ 2026-09-27)
      const swap = await this.prisma.plateSwap.findFirst({ where: { newVehicleId: vehicle.id, cancelledAt: null }, select: { id: true } });
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

  // ทุกคันที่ transferDone = true เรียงจากทำเสร็จล่าสุด ไม่กรองตามวันที่รับงาน - ทีละ 100 คัน (offset = "โหลดเพิ่ม",
  // limit สูงสุด 1,000 ใช้โหลดใหม่หลังแก้ให้ได้เท่าที่เปิดอยู่) q ค้นเลขตัวถัง/เลขเครื่อง/ทะเบียน/ลูกค้า/เจ้าของ แบบหน้าเพิ่มข้อมูลรถ
  // (ผู้ใช้ 2026-09-27: เดิมแสดงแค่ 100 คันล่าสุด คันที่เก่ากว่านั้นหาไม่เจอจึงแก้ไม่ได้)
  async findRecentlyCompletedTransferNotice(params: { q?: string; offset?: string; limit?: string } = {}) {
    const pageSize = Math.min(1000, Math.max(1, Number.parseInt(params.limit ?? '100', 10) || 100));
    const offset = Math.max(0, Number.parseInt(params.offset ?? '0', 10) || 0);
    const [vehicles, deregistrationFees, relocateFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { ...vehicleListWhere({ q: params.q }), transferDone: true },
        orderBy: [{ transferCompletedDate: 'desc' }, { updatedAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: pageSize + 1, // เกินมา 1 คัน = ยังมีหน้าถัดไป
        include: {
          customer: { select: { name: true } },
          brand: { select: { name: true } },
          ...activeSubmissionsInclude,
        },
      }),
      this.prisma.feeDeregistration.findMany(),
      this.prisma.feeRelocate.findMany(),
    ]);

    return {
      vehicles: vehicles.slice(0, pageSize).map((vehicle) => this.mapTransferNoticeVehicle(vehicle, deregistrationFees, relocateFees)),
      hasMore: vehicles.length > pageSize,
    };
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
      inspectionSentDate: Date | null;
      customer: { name: string };
      brand: { name: string };
      documentSubmissions?: Array<unknown>;
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
      // ใช้กับปุ่ม "✎ แก้" ของคันที่ดำเนินการแล้ว (ผู้ใช้ 2026-09-27): ยกเลิกสถานะได้ถ้ายังไม่ส่งตรวจ แก้ได้จนกว่าจะยื่นเอกสาร
      inspectionSentDate: vehicle.inspectionSentDate?.toISOString().slice(0, 10) ?? null,
      submitted: (vehicle.documentSubmissions?.length ?? 0) > 0,
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
      const row = deregistrationFees.find((f) => f.vehicleType === body && sameBrandName(f.brand, brandName))
        ?? deregistrationFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
      return row ? String(row.amount) : null;
    }

    const row = relocateFees.find((f) => f.vehicleType === body && sameBrandName(f.brand, brandName))
      ?? relocateFees.find((f) => f.vehicleType === body && f.brand === 'อื่นๆ');
    return row ? String(Number(row.noBillAmount) + Number(row.billAmount)) : null;
  }

  async updateTransferNotice(id: string, dto: UpdateTransferNoticeDto) {
    const done = Boolean(dto?.done);
    const completedDateRaw = typeof dto?.completedDate === 'string' ? dto.completedDate.trim() : '';
    const costRaw = typeof dto?.cost === 'string' ? dto.cost.trim() : '';
    const expectedDone = dto?.expectedTransferDone;

    if (completedDateRaw && !isValidDateParam(completedDateRaw)) {
      throw new BadRequestException({ error: 'วันที่เสร็จต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    // วันที่เสร็จในอนาคต = พิมพ์ผิด (พบ 2026-09-27): วันส่งตรวจต้องไม่ก่อนวันนี้ (assertSentDateInOrder) จึงส่งตรวจด้วยวันจริงไม่ได้
    // และหน้าเว็บแก้คันที่ดำเนินการแล้วไม่ได้ - เวลาไทยแบบเดียวกับวันที่ทราบผล
    if (completedDateRaw && completedDateRaw > bangkokToday()) {
      throw new BadRequestException({ error: 'วันที่เสร็จต้องไม่เกินวันนี้' });
    }
    // ดำเนินการแล้วต้องมีวันที่เสร็จ (พบ 2026-09-27: เดิมบันทึกได้โดยไม่มีวันที่ ภาพรวมไม่นับงาน/ค่าใช้จ่ายนั้น และแก้ย้อนหลังไม่ได้)
    if (done && !completedDateRaw) throw new BadRequestException({ error: 'กรุณาระบุวันที่เสร็จ' });
    if (costRaw && !/^\d+(\.\d+)?$/.test(costRaw)) {
      throw new BadRequestException({ error: 'ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0' });
    }
    if (expectedDone !== undefined && expectedDone !== null && typeof expectedDone !== 'boolean') {
      throw new BadRequestException({ error: 'expectedTransferDone ต้องเป็น true/false' });
    }

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertTransferNoticeInScope(vehicle.body);
    assertNotSubmitted(vehicle);
    // หน้าจอส่งสถานะที่โหลดมา (expectedTransferDone) - ไม่ตรงกับตอนนี้ = มีคนบันทึกไปก่อนแล้ว ห้ามเขียนทับ (พบ 2026-09-27:
    // "บันทึกทั้งหมด" จากหน้าที่เปิดค้างไว้เคยทำให้คันที่คนอื่นเพิ่งทำเสร็จกลับเป็นยังไม่เสร็จ วันที่/ค่าใช้จ่ายจริงหายไป)
    if (typeof expectedDone === 'boolean' && expectedDone !== vehicle.transferDone) {
      throw new ConflictException({ error: STALE_ERROR });
    }
    // คันที่ดำเนินการแล้วแก้/ยกเลิกสถานะได้ทาง "✎ แก้" ที่ต้องระบุเหตุผลเท่านั้น (ผู้ใช้ 2026-09-27: เดิมเรียก API นี้ตรงๆ ย้อนสถานะ
    // ได้แม้ส่งตรวจแล้วและไม่มีเหตุผล) - ดู correctTransferNotice
    if (vehicle.transferDone) {
      throw new BadRequestException({ error: 'รถคันนี้ดำเนินการแจ้งย้าย/ตัดบัญชีแล้ว - แก้ได้ที่ปุ่ม "✎ แก้" (ต้องระบุเหตุผล)' });
    }

    const completedDate = completedDateRaw ? toDate(completedDateRaw) : null;
    const cost = costRaw || null;
    const { count } = await this.prisma.vehicle.updateMany({
      where: { id, deletedAt: null, transferDone: false, ...NOT_SUBMITTED_WHERE },
      data: { transferDone: done, transferCompletedDate: completedDate, transferCost: cost },
    });
    if (count === 0) throw new ConflictException({ error: STALE_ERROR });

    return { id, transferDone: done, transferCompletedDate: completedDateRaw || null, transferCost: cost };
  }

  // แก้/ยกเลิกสถานะแจ้งย้าย/ตัดบัญชีที่ดำเนินการแล้ว (ผู้ใช้ 2026-09-27) - ต้องระบุเหตุผลทุกครั้ง เก็บลง VehicleEditLog
  // - ยกเลิกสถานะ (done = false) ได้เฉพาะก่อนส่งตรวจ: ล้างวันที่เสร็จ/ค่าใช้จ่าย รถกลับเข้าคิว "ต้องดำเนินการ"
  //   (ส่งตรวจแล้วค่อยพบว่าติ๊กผิดคัน = ยกเลิกส่งตรวจที่หน้าตรวจรถก่อน)
  // - แก้วันที่เสร็จ/ค่าใช้จ่าย (done = true) ได้จนกว่าจะยื่นเอกสาร: วันที่เสร็จต้องไม่เกินวันนี้ และไม่หลังวันที่ส่งตรวจ
  // สิทธิ์เท่ากับการบันทึกแจ้งย้าย/ตัดบัญชี (ADMIN/STAFF_ENTRY ทุกคัน, STAFF_MOTO เฉพาะจักรยานยนต์)
  async correctTransferNotice(id: string, dto: CorrectTransferNoticeDto) {
    if (typeof dto?.done !== 'boolean') throw new BadRequestException({ error: 'done ต้องเป็น true/false' });
    const done = dto.done;
    const completedDateRaw = typeof dto?.completedDate === 'string' ? dto.completedDate.trim() : '';
    const costRaw = typeof dto?.cost === 'string' ? dto.cost.trim() : '';
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';
    const expectedDate = dto?.expectedCompletedDate;
    const expectedCost = dto?.expectedCost;

    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้แจ้งย้าย/ตัดบัญชี' });
    if (expectedDate !== undefined && expectedDate !== null && !(typeof expectedDate === 'string' && isValidDateParam(expectedDate))) {
      throw new BadRequestException({ error: 'expectedCompletedDate ต้องเป็น ค.ศ. YYYY-MM-DD หรือ null' });
    }
    if (expectedCost !== undefined && expectedCost !== null && typeof expectedCost !== 'string' && typeof expectedCost !== 'number') {
      throw new BadRequestException({ error: 'expectedCost ต้องเป็นตัวเลขหรือ null' });
    }
    if (done) {
      if (!completedDateRaw) throw new BadRequestException({ error: 'กรุณาระบุวันที่เสร็จ' });
      if (!isValidDateParam(completedDateRaw)) throw new BadRequestException({ error: 'วันที่เสร็จต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
      if (completedDateRaw > bangkokToday()) throw new BadRequestException({ error: 'วันที่เสร็จต้องไม่เกินวันนี้' });
      if (costRaw && !/^\d+(\.\d+)?$/.test(costRaw)) throw new BadRequestException({ error: 'ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0' });
    }

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertTransferNoticeInScope(vehicle.body);
    assertNotSubmitted(vehicle);
    // dialog ส่งวันที่/ค่าใช้จ่ายที่แสดงอยู่มาด้วย - ไม่ตรงกับตอนนี้ = มีคนแก้ไปก่อนแล้ว ห้ามเขียนทับ (พบ 2026-09-27 รอบตรวจ: เดิมเทียบแค่
    // ค่าที่ service เพิ่งอ่าน dialog ที่เปิดค้างไว้จึงเขียนวันที่เดิมทับที่อีกคนเพิ่งแก้ได้ แบบเดียวกับ expectedTransferDone)
    if (expectedDate !== undefined && (expectedDate || null) !== diffField(vehicle.transferCompletedDate)) {
      throw new ConflictException({ error: STALE_ERROR });
    }
    if (expectedCost !== undefined && !sameCostValue(expectedCost, vehicle.transferCost)) {
      throw new ConflictException({ error: STALE_ERROR });
    }
    if (!vehicle.transferDone) {
      throw new BadRequestException({ error: 'รถคันนี้ยังไม่ได้ดำเนินการแจ้งย้าย/ตัดบัญชี - บันทึกที่ตาราง "ต้องดำเนินการ"' });
    }
    if (!done && vehicle.inspectionSentDate) {
      throw new BadRequestException({
        error: 'รถคันนี้ส่งตรวจแล้ว - ยกเลิกสถานะแจ้งย้าย/ตัดบัญชีไม่ได้ (แก้ได้เฉพาะวันที่เสร็จ/ค่าใช้จ่าย)',
      });
    }
    // ส่งตรวจได้หลังแจ้งย้าย/ตัดบัญชีเสร็จ (assertSentDateInOrder) - แก้วันที่เสร็จให้หลังวันส่งตรวจไม่ได้
    if (done && vehicle.inspectionSentDate && completedDateRaw > isoOf(vehicle.inspectionSentDate)) {
      throw new BadRequestException({ error: `วันที่เสร็จต้องไม่หลังวันที่ส่งตรวจ (${dmy(isoOf(vehicle.inspectionSentDate))})` });
    }

    const data = done
      ? { transferDone: true, transferCompletedDate: toDate(completedDateRaw), transferCost: costRaw || null }
      : { transferDone: false, transferCompletedDate: null, transferCost: null };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    if (!done) changes.transferDone = { from: 'true', to: 'false' };
    if (diffField(vehicle.transferCompletedDate) !== diffField(data.transferCompletedDate)) {
      changes.transferCompletedDate = { from: diffField(vehicle.transferCompletedDate), to: diffField(data.transferCompletedDate) };
    }
    const fromCost = diffField(vehicle.transferCost);
    const toCost = data.transferCost;
    if ((fromCost === null) !== (toCost === null) || (fromCost !== null && Number(fromCost) !== Number(toCost))) {
      changes.transferCost = { from: fromCost, to: toCost };
    }
    if (!Object.keys(changes).length) throw new BadRequestException({ error: 'ข้อมูลแจ้งย้าย/ตัดบัญชีเหมือนเดิม - ไม่มีอะไรต้องแก้' });

    await this.prisma.$transaction(async (tx) => {
      // บันทึกเฉพาะเมื่อยังเป็นข้อมูลที่อ่านมา (ยังไม่ยื่น/ส่งตรวจเหมือนเดิม/ไม่มีใครแก้ไปก่อน) - ไม่ตรง = 409 ไม่เขียนทับ
      const { count } = await tx.vehicle.updateMany({
        where: {
          id,
          deletedAt: null,
          transferDone: true,
          transferCompletedDate: vehicle.transferCompletedDate,
          transferCost: vehicle.transferCost,
          inspectionSentDate: vehicle.inspectionSentDate,
          ...NOT_SUBMITTED_WHERE,
        },
        data,
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: id,
          remark: done ? `แก้แจ้งย้าย/ตัดบัญชี: ${remark}` : `ยกเลิกสถานะแจ้งย้าย/ตัดบัญชี: ${remark}`,
          changes: JSON.stringify(changes),
          editedById: editorId(),
        },
      });
    });

    return {
      id,
      transferDone: data.transferDone,
      transferCompletedDate: done ? completedDateRaw : null,
      transferCost: data.transferCost,
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

    const windows = await this.resubmitWindows(vehicles.filter((v) => isReinspectionDue(v)));
    return vehicles.map((vehicle) => ({
      ...this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees),
      // ถึงกำหนดตรวจรอบ 2 แต่ยกเลิก/ยื่นไม่สำเร็จภายในอายุผลตรวจเดิม = ยังยื่นใหม่ด้วยวันที่ยื่นเดิมได้ (ดู resubmit-window.ts)
      resubmitWith: windows.get(vehicle.id) ?? null,
    }));
  }

  // รถที่ถึงกำหนดตรวจรอบ 2: ครั้งล่าสุดที่ยื่นไม่สำเร็จ (FAILED) หรือยกเลิกการยื่น (VehicleEditLog) ด้วยผลตรวจผ่านปัจจุบัน
  private async resubmitWindows(
    due: Array<{ id: string; inspectionResultDate: Date | null }>,
  ): Promise<Map<string, ResubmitWindow>> {
    const result = new Map<string, ResubmitWindow>();
    if (due.length === 0) return result;
    const ids = due.map((v) => v.id);
    const [failed, cancelLogs] = await Promise.all([
      this.prisma.documentSubmission.findMany({
        where: { vehicleId: { in: ids }, status: 'FAILED' },
        select: { vehicleId: true, submitDate: true },
      }),
      this.prisma.vehicleEditLog.findMany({
        where: { vehicleId: { in: ids }, changes: { contains: 'submission.cancelled' } },
        select: { vehicleId: true, changes: true },
      }),
    ]);
    const attempts = new Map<string, SubmitAttempt[]>();
    const add = (vehicleId: string, attempt: SubmitAttempt) => attempts.set(vehicleId, [...(attempts.get(vehicleId) ?? []), attempt]);
    for (const f of failed) add(f.vehicleId, { submitDate: isoOf(f.submitDate), reason: 'FAILED' });
    for (const log of cancelLogs) {
      const submitDate = cancelledSubmitDate(log.changes);
      if (submitDate) add(log.vehicleId, { submitDate, reason: 'CANCELLED' });
    }
    for (const v of due) {
      const found = v.inspectionResultDate ? resubmitWindow(v.inspectionResultDate, attempts.get(v.id) ?? []) : null;
      if (found) result.set(v.id, found);
    }
    return result;
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

  // ทราบผลตรวจแล้ว (ผ่าน/ไม่ผ่าน): รถที่ยังไม่ยื่นเอกสารแสดงครบทุกคัน เรียงจากตรวจเก่าสุด (ใกล้ครบกำหนดยื่นก่อน) แล้วต่อด้วย
  // รถที่ยื่นแล้ว COMPLETED_SUBMITTED_REFERENCE คันล่าสุดไว้ดูอ้างอิง (พบ 2026-09-27: เดิมแสดงแค่ 100 ผลล่าสุดรวมคันที่ยื่นแล้ว
  // คันใกล้หมดอายุหลุดจากตารางไปก่อน ทั้งป้ายเตือน "ยื่นได้ถึง" และปุ่ม "แก้ไขผลตรวจ" จึงใช้ไม่ได้กับคันที่ต้องใช้ที่สุด)
  async findRecentlyCompletedInspection() {
    const include = {
      customer: { select: { name: true } },
      brand: { select: { name: true } },
      ...activeSubmissionsInclude,
    };
    const [unsubmitted, submitted, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findMany({
        where: { deletedAt: null, inspectionResultDate: { not: null }, ...NOT_SUBMITTED_WHERE },
        orderBy: [{ inspectionResultDate: 'asc' }, { id: 'asc' }],
        include,
      }),
      this.prisma.vehicle.findMany({
        where: {
          deletedAt: null,
          inspectionResultDate: { not: null },
          documentSubmissions: { some: { status: { in: ACTIVE_SUBMISSION_STATUSES } } },
        },
        orderBy: [{ inspectionResultDate: 'desc' }, { updatedAt: 'desc' }],
        take: COMPLETED_SUBMITTED_REFERENCE,
        include,
      }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);

    return [...unsubmitted, ...submitted].map((vehicle) => this.mapInspectionVehicle(vehicle, bangkokFees, provinceFees));
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
      transferCompletedDate: Date | null;
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
      // วันที่แจ้งย้าย/ตัดบัญชีเสร็จ - วันส่งตรวจต้องไม่ก่อนวันนี้ หน้าจอใช้ตั้งวันส่งตรวจเริ่มต้นด้วย (ดู assertSentDateInOrder)
      transferCompletedDate: vehicle.transferCompletedDate?.toISOString().slice(0, 10) ?? null,
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
      // ยื่นเอกสารแล้วหรือยัง + วันสุดท้ายที่ยังยื่นได้ (ตรวจผ่าน + 89 วัน กฎเดียวกับคิวยื่น) - ย้ายมาแสดงที่หน้าตรวจรถแทน
      // คอลัมน์ "ยื่นได้ถึง" ในหน้ายื่นเอกสาร (ผู้ใช้ 2026-09-25) null = ไม่ผ่าน/ยังไม่มีผล/ยื่นแล้ว
      submitted: vehicle.documentSubmissions.length > 0,
      submitDeadline:
        vehicle.inspectionResult === 'ผ่าน' && vehicle.inspectionResultDate && vehicle.documentSubmissions.length === 0
          ? inspectionValidUntil(vehicle.inspectionResultDate)
          : null,
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
      const row = bangkokFees.find((f) => f.vehicleType === body && sameBrandName(f.brand, brandName))
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

    // ส่งตรวจต้องมีทั้งประเภทและวันที่ (พบ 2026-09-27: เดิมเว้นวันที่ได้ รถค้างอยู่ในคิวส่งตรวจทั้งที่บันทึกประเภทไปแล้ว)
    if (!sentType) throw new BadRequestException({ error: 'กรุณาเลือกประเภทการตรวจ' });
    if (!INSPECTION_SENT_TYPES.includes(sentType as (typeof INSPECTION_SENT_TYPES)[number])) {
      throw new BadRequestException({ error: 'ประเภทการตรวจไม่ถูกต้อง' });
    }
    if (!sentDateRaw) throw new BadRequestException({ error: 'กรุณาระบุวันที่ส่งตรวจ' });
    if (!isValidDateParam(sentDateRaw)) {
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
    // ส่งตรวจแล้วรอผลอยู่ = ห้ามบันทึกส่งตรวจทับ (พบ 2026-09-27: หน้าที่เปิดค้างไว้เคยเขียนทับประเภท/วันที่/ค่าใช้จ่าย
    // ของคนอื่นโดยไม่มีประวัติ) - แก้ได้ทางปุ่ม "แก้การส่งตรวจ" ที่ต้องระบุเหตุผล (correctInspectionSent)
    if (vehicle.inspectionSentDate && vehicle.inspectionResult == null) {
      throw new ConflictException({ error: 'รถคันนี้ส่งตรวจแล้ว รอผลตรวจอยู่ - แก้ได้ที่ปุ่ม "แก้การส่งตรวจ"' });
    }

    // เริ่มรอบตรวจใหม่เมื่อ: ตรวจไม่ผ่าน (ส่งตรวจซ้ำรอบเดิม) หรือผลตรวจผ่านหมดอายุ (ขึ้นรอบ 2) - ล้างผลตรวจเดิม
    // ให้รถเข้าคิวรอผลตรวจอีกครั้ง และเก็บข้อมูลรอบก่อนไว้ใน VehicleEditLog เพราะช่องบน Vehicle เก็บได้แค่ชุดล่าสุด
    const isResend = vehicle.inspectionResult === 'ไม่ผ่าน';
    const startsRound2 = isReinspectionDue(vehicle);
    if (vehicle.inspectionResult === 'ผ่าน' && !startsRound2) {
      throw new BadRequestException({ error: `รถคันนี้ตรวจผ่านแล้ว ผลตรวจยังไม่หมดอายุ (${INSPECTION_VALID_DAYS} วัน)` });
    }
    assertSentDateInOrder(sentDateRaw, vehicle);
    const startsNewCycle = isResend || startsRound2;
    const round = startsRound2 ? 2 : vehicle.inspectionRound;
    const data = {
      inspectionSentType: sentType,
      inspectionSentDate: toDate(sentDateRaw),
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

    await this.prisma.$transaction(async (tx) => {
      // บันทึกเฉพาะเมื่อสถานะส่งตรวจ/ผลตรวจยังเป็นแบบที่อ่านมา - มีคนบันทึกไปก่อน = 409 ไม่เขียนทับ
      const { count } = await tx.vehicle.updateMany({
        where: {
          id,
          deletedAt: null,
          transferDone: true,
          inspectionSentDate: vehicle.inspectionSentDate,
          inspectionResult: vehicle.inspectionResult,
          inspectionResultDate: vehicle.inspectionResultDate,
          ...NOT_SUBMITTED_WHERE,
        },
        data,
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      if (startsNewCycle) {
        await tx.vehicleEditLog.create({
          data: {
            vehicleId: id,
            remark: startsRound2
              ? `เริ่มตรวจรอบ 2 (ผลตรวจรอบ ${vehicle.inspectionRound} ผ่านวันที่ ${diffField(vehicle.inspectionResultDate)} ครบ ${INSPECTION_VALID_DAYS} วันแล้วยังไม่ได้ยื่นเอกสาร)`
              : `ส่งตรวจใหม่หลังตรวจไม่ผ่าน (เหตุผลเดิม: ${vehicle.inspectionFailRemark ?? '—'})`,
            editedById: editorId(),
            changes: JSON.stringify(changes),
          },
        });
      }
    });

    return {
      id,
      inspectionRound: round,
      inspectionSentType: data.inspectionSentType,
      inspectionSentDate: sentDateRaw,
      inspectionSentCost: data.inspectionSentCost,
      inspectionSentBillCost: data.inspectionSentBillCost,
    };
  }

  // Step 3a (แก้ไข): แก้ประเภท/วันที่ส่งตรวจของรถที่ส่งแล้วแต่ยังรอผล (พบ 2026-09-27: เดิมบันทึกผิดแล้วแก้ไม่ได้เลย
  // ส่งผิดเป็น "เอารถมาตรวจเอง" = ราคาตรวจเป็น 0 และไม่อยู่ในใบพิมพ์รายการส่งตรวจ) - ต้องระบุเหตุผลทุกครั้ง เก็บลง VehicleEditLog
  // ค่าใช้จ่ายคิดใหม่จากตารางราคาตามประเภทใหม่ (รอบตรวจเดิม) แบบเดียวกับตอนส่งตรวจปกติ
  async correctInspectionSent(id: string, dto: CorrectInspectionSentDto) {
    const sentType = typeof dto?.sentType === 'string' ? dto.sentType.trim() : '';
    const sentDateRaw = typeof dto?.sentDate === 'string' ? dto.sentDate.trim() : '';
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';

    if (!INSPECTION_SENT_TYPES.includes(sentType as (typeof INSPECTION_SENT_TYPES)[number])) {
      throw new BadRequestException({ error: 'ประเภทการตรวจไม่ถูกต้อง' });
    }
    if (!sentDateRaw || !isValidDateParam(sentDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้การส่งตรวจ' });

    const [vehicle, bangkokFees, provinceFees] = await Promise.all([
      this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: { brand: { select: { name: true } }, ...activeSubmissionsInclude } }),
      this.prisma.feeInspectionBangkok.findMany(),
      this.prisma.feeInspectionProvince.findMany(),
    ]);
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);
    assertAwaitingResult(vehicle);
    assertSentDateInOrder(sentDateRaw, vehicle);

    const data = {
      inspectionSentType: sentType,
      inspectionSentDate: toDate(sentDateRaw),
      ...this.fixedSentCosts(sentType, vehicle.inspectionRound, vehicle, bangkokFees, provinceFees),
    };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key, value] of Object.entries(data)) {
      const from = diffField((vehicle as Record<string, unknown>)[key]);
      const to = diffField(value);
      if (from !== to && !(from !== null && to !== null && Number(from) === Number(to))) changes[key] = { from, to };
    }
    if (!Object.keys(changes).length) throw new BadRequestException({ error: 'ข้อมูลการส่งตรวจเหมือนเดิม - ไม่มีอะไรต้องแก้' });

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicle.updateMany({ where: this.awaitingResultWhere(id, vehicle.inspectionSentDate), data });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await tx.vehicleEditLog.create({
        data: { vehicleId: id, remark: `แก้การส่งตรวจ: ${remark}`, editedById: editorId(), changes: JSON.stringify(changes) },
      });
    });

    return {
      id,
      inspectionRound: vehicle.inspectionRound,
      inspectionSentType: data.inspectionSentType,
      inspectionSentDate: sentDateRaw,
      inspectionSentCost: data.inspectionSentCost,
      inspectionSentBillCost: data.inspectionSentBillCost,
    };
  }

  // Step 3a (ยกเลิก): ยกเลิกการส่งตรวจของรถที่ยังรอผล (พบ 2026-09-27) - ล้างข้อมูลส่งตรวจ รถกลับเข้าคิวส่งตรวจ ต้องระบุเหตุผล
  // รอบตรวจ (inspectionRound) คงเดิม: ยกเลิกรอบ 2 แล้วส่งใหม่ยังเป็นรอบ 2 (มีค่าตรวจรถ Bill 50 บาทเหมือนเดิม)
  async cancelInspectionSent(id: string, dto: CancelInspectionSentDto) {
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่ยกเลิกส่งตรวจ' });

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);
    assertAwaitingResult(vehicle);

    const data = { inspectionSentType: null, inspectionSentDate: null, inspectionSentCost: null, inspectionSentBillCost: null };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const key of Object.keys(data)) {
      const from = diffField((vehicle as Record<string, unknown>)[key]);
      if (from !== null) changes[key] = { from, to: null };
    }

    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.vehicle.updateMany({ where: this.awaitingResultWhere(id, vehicle.inspectionSentDate), data });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await tx.vehicleEditLog.create({
        data: { vehicleId: id, remark: `ยกเลิกส่งตรวจ: ${remark}`, editedById: editorId(), changes: JSON.stringify(changes) },
      });
    });

    return { id, inspectionRound: vehicle.inspectionRound, ...data };
  }

  // รถที่ยังรอผลตรวจของการส่งตรวจครั้งที่อ่านมา - ใช้เป็นเงื่อนไขของคำสั่งแก้/ยกเลิกการส่งตรวจ
  private awaitingResultWhere(id: string, sentDate: Date | null) {
    return { id, deletedAt: null, inspectionSentDate: sentDate, inspectionResult: null, inspectionResultDate: null, ...NOT_SUBMITTED_WHERE };
  }

  // Step 3b: บันทึกผลตรวจ (ผ่าน/ไม่ผ่าน) - ตรวจไม่ผ่านต้องมี remark ทุกครั้ง
  async updateInspectionResult(id: string, dto: UpdateInspectionResultDto) {
    const result = typeof dto?.result === 'string' ? dto.result.trim() : '';
    const resultDateRaw = typeof dto?.resultDate === 'string' ? dto.resultDate.trim() : '';
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';

    if (!INSPECTION_RESULTS.includes(result as (typeof INSPECTION_RESULTS)[number])) {
      throw new BadRequestException({ error: 'ผลตรวจไม่ถูกต้อง' });
    }
    // ผลตรวจต้องมีวันที่ทราบผล (พบ 2026-09-27: เดิมเว้นได้ รถค้างอยู่ทั้งคิวรอผลและคิวส่งตรวจใหม่ในเวลาเดียวกัน)
    if (!resultDateRaw) throw new BadRequestException({ error: 'กรุณาระบุวันที่ทราบผล' });
    if (!isValidDateParam(resultDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (result === 'ไม่ผ่าน' && !remark) {
      throw new BadRequestException({ error: 'กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน' });
    }

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);
    if (!vehicle.inspectionSentDate) {
      throw new BadRequestException({ error: 'ยังไม่ได้บันทึกการส่งตรวจ - บันทึกผลตรวจไม่ได้' });
    }
    // บันทึกผลซ้ำจากหน้าที่เปิดค้างไว้ = เขียนทับผลที่คนอื่นเพิ่งบันทึกโดยไม่มีเหตุผล/ประวัติ (พบ 2026-09-27) - ผลที่มีวันที่แล้ว
    // แก้ได้ทาง "แก้ไขผลตรวจ" เท่านั้น (ผลเก่าที่ไม่มีวันที่ยังบันทึกทับให้ครบได้ เพราะหน้าแก้ไขผลตรวจต้องมีวันที่เดิม)
    if (vehicle.inspectionResultDate) {
      throw new ConflictException({ error: 'รถคันนี้บันทึกผลตรวจแล้ว - ใช้ปุ่มแก้ไขผลตรวจ' });
    }
    assertResultDateInRange(resultDateRaw, vehicle.inspectionSentDate);

    const data = {
      inspectionResult: result,
      inspectionResultDate: toDate(resultDateRaw),
      // ค่าใช้จ่ายคงที่ แก้จากหน้าจอไม่ได้: ผ่าน = ราคาตอนส่งตรวจ, ไม่ผ่าน = 0 (ได้เงินคืน)
      inspectionResultCost: result === 'ไม่ผ่าน' ? '0' : vehicle.inspectionSentCost,
      // ค่าตรวจรถ (Bill) มีเฉพาะรอบ 2 (inspectionSentBillCost ไม่ว่าง) - กติกาเดียวกับ No bill
      inspectionResultBillCost: vehicle.inspectionSentBillCost == null ? null : result === 'ไม่ผ่าน' ? '0' : vehicle.inspectionSentBillCost,
      inspectionFailRemark: result === 'ไม่ผ่าน' ? remark : null,
    };
    const { count } = await this.prisma.vehicle.updateMany({
      where: {
        id,
        deletedAt: null,
        inspectionSentDate: vehicle.inspectionSentDate,
        inspectionResult: vehicle.inspectionResult,
        inspectionResultDate: null,
        ...NOT_SUBMITTED_WHERE,
      },
      data,
    });
    if (count === 0) throw new ConflictException({ error: STALE_ERROR });

    return {
      id,
      inspectionResult: data.inspectionResult,
      inspectionResultDate: resultDateRaw,
      inspectionResultCost: data.inspectionResultCost,
      inspectionResultBillCost: data.inspectionResultBillCost,
      inspectionFailRemark: data.inspectionFailRemark,
    };
  }

  // Step 3b (แก้ไข): แก้ผลตรวจที่บันทึกไปแล้ว เช่น บันทึกว่าผ่านไปแล้วแต่จริงๆ ตรวจไม่ผ่าน (ผู้ใช้ 2026-09-23)
  // ต่างจาก updateInspectionResult ตรงที่ต้องมีผลตรวจเดิมอยู่แล้ว และต้องระบุเหตุผลที่แก้ (เก็บลง VehicleEditLog)
  // แก้เป็น "ไม่ผ่าน" แล้วรถจะกลับเข้าคิวส่งตรวจเอง (ดู findPendingInspectionSend) เหมือนบันทึกไม่ผ่านตามปกติ
  async correctInspectionResult(id: string, dto: CorrectInspectionResultDto) {
    const result = typeof dto?.result === 'string' ? dto.result.trim() : '';
    const resultDateRaw = typeof dto?.resultDate === 'string' ? dto.resultDate.trim() : '';
    const failRemark = typeof dto?.failRemark === 'string' ? dto.failRemark.trim() : '';
    const remark = typeof dto?.remark === 'string' ? dto.remark.trim() : '';

    if (!INSPECTION_RESULTS.includes(result as (typeof INSPECTION_RESULTS)[number])) {
      throw new BadRequestException({ error: 'ผลตรวจไม่ถูกต้อง' });
    }
    if (!resultDateRaw || !isValidDateParam(resultDateRaw)) {
      throw new BadRequestException({ error: 'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง' });
    }
    if (result === 'ไม่ผ่าน' && !failRemark) {
      throw new BadRequestException({ error: 'กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน' });
    }
    if (!remark) throw new BadRequestException({ error: 'กรุณาระบุเหตุผลที่แก้ไขผลตรวจ' });

    const vehicle = await this.prisma.vehicle.findFirst({ where: { id, deletedAt: null }, include: activeSubmissionsInclude });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    assertNotSubmitted(vehicle);
    if (!vehicle.inspectionResult || !vehicle.inspectionResultDate) {
      throw new BadRequestException({ error: 'รถคันนี้ยังไม่มีผลตรวจที่บันทึกไว้ - ใช้หน้าบันทึกผลตรวจแทน' });
    }
    assertResultDateInRange(resultDateRaw, vehicle.inspectionSentDate);

    const data = {
      inspectionResult: result,
      inspectionResultDate: toDate(resultDateRaw),
      // ค่าใช้จ่ายคงที่ แก้จากหน้าจอไม่ได้ - กติกาเดียวกับตอนบันทึกผลตรวจครั้งแรก
      inspectionResultCost: result === 'ไม่ผ่าน' ? '0' : vehicle.inspectionSentCost,
      inspectionResultBillCost: vehicle.inspectionSentBillCost == null ? null : result === 'ไม่ผ่าน' ? '0' : vehicle.inspectionSentBillCost,
      inspectionFailRemark: result === 'ไม่ผ่าน' ? failRemark : null,
    };
    const changes: Record<string, { from: string | null; to: string | null }> = {};
    for (const [key, value] of Object.entries(data)) {
      const from = diffField((vehicle as Record<string, unknown>)[key]);
      const to = diffField(value);
      if (from !== to) changes[key] = { from, to };
    }

    await this.prisma.$transaction(async (tx) => {
      // บันทึกเฉพาะเมื่อผลตรวจยังเป็นแบบที่อ่านมาและยังไม่ยื่นเอกสาร (พบ 2026-09-27: เดิมเขียนทับไม่มีเงื่อนไข แก้ผลพร้อมกับ
      // ยื่นเอกสาร/ส่งตรวจรอบ 2 แล้วผลเก่าไปทับรถที่ยื่นแล้วหรือเพิ่งเริ่มรอบใหม่) - มีคนบันทึกไปก่อน = 409 ไม่เขียนทับ
      const { count } = await tx.vehicle.updateMany({
        where: {
          id,
          deletedAt: null,
          inspectionSentDate: vehicle.inspectionSentDate,
          inspectionResult: vehicle.inspectionResult,
          inspectionResultDate: vehicle.inspectionResultDate,
          inspectionFailRemark: vehicle.inspectionFailRemark,
          ...NOT_SUBMITTED_WHERE,
        },
        data,
      });
      if (count === 0) throw new ConflictException({ error: STALE_ERROR });
      await tx.vehicleEditLog.create({
        data: {
          vehicleId: id,
          remark: `แก้ไขผลตรวจ (${vehicle.inspectionResult} → ${result}): ${remark}`,
          editedById: editorId(),
          changes: JSON.stringify(changes),
        },
      });
    });

    return {
      id,
      inspectionResult: data.inspectionResult,
      inspectionResultDate: resultDateRaw,
      inspectionResultCost: data.inspectionResultCost,
      inspectionResultBillCost: data.inspectionResultBillCost,
      inspectionFailRemark: data.inspectionFailRemark,
    };
  }

  // PATCH /api/vehicles/:id/tax-input (ผูกเจ้าของรถ/วันจดทะเบียนครั้งแรก) ถูกถอดออก (พบ 2026-09-27): หน้าเว็บเลิกใช้แล้ว
  // แต่ยังเรียกตรงได้และล้างเจ้าของรถของคันที่ยื่น/ส่งงานแล้วได้โดยไม่มีประวัติ - เจ้าของรถแก้ที่ "แก้ไข" (updateVehicle)

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
