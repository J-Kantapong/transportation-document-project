import { randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { diffChanges, requireRemark, writeAudit } from '../audit/audit-log.js';
import { currentUser } from '../auth/request-context.js';
import { assertVehicleInScope, currentVehicleScope, currentWriteScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { Prisma } from '../generated/prisma/client.js';
import { bangkokToday, toDate } from '../overview/overview-calculator.js';
import { assertDateInRange, dateInRange, optionalAmount, optionalIsoDateField, optionalText, toUtcDate } from '../plate-swap/plate-swap.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RECEIPT_EXTRACTOR, type ReceiptExtractor } from '../receipts/receipt-extractor.js';
import { RECEIPT_STORAGE, type ReceiptStorage } from '../receipts/receipt-storage.js';
import { MAX_RECEIPT_BYTES, detectImageType, type UploadedReceiptFile } from '../receipts/receipts.service.js';
import { contentHashOf, duplicateUpload, isContentHashConflict } from '../receipts/upload-hash.js';
import { TaxService } from '../tax/tax.service.js';
import { calculateTaxRenewalFees } from './tax-renewal-fee.js';
import {
  parseDate,
  parseDecimal,
  parseFuel,
  parseRenewalOwner,
  parseText,
  parseVehicleType,
  RenewalOwner,
  storedRenewalOwner,
} from './tax-renewal-validation.js';
import {
  calculateVehicleTax,
  VehicleTaxInput,
  VehicleTaxInputError,
  VehicleTaxResult,
} from './vehicle-tax-calculator.js';

const MOTO_PREFIX = 'รย.12-';

// snapshot ลงคอลัมน์ Json - ผ่าน JSON ก่อนเพื่อให้ Date/Decimal กลายเป็นค่าธรรมดาที่ Prisma รับได้
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as object;

// Decimal ของ Prisma เป็น object (truthy เสมอแม้ค่าเป็น 0) - cc/น้ำหนัก 0 ถือว่ายังไม่มีข้อมูล (พบ 2026-09-27)
const positiveOrNull = (value: unknown) => (Number(value) > 0 ? Number(value) : null);

// ไม่ได้ใส่วันที่ชำระ = คิด ณ วันนี้ตามปฏิทินไทย เที่ยงคืน UTC แบบเดียวกับ parseDate
// (new Date() เป็นเวลาปัจจุบัน วันครบกำหนดพอดีจึงโดนนับล่าช้า 1 เดือน - พบ 2026-09-27)
const todayInBangkok = () => toDate(bangkokToday());

// ข้อมูลรถของงานต่อภาษี - มาจาก Vehicle ที่ลิงก์ไว้ หรือกรอกเองทั้งหมด (รถที่ไม่ได้อยู่ในระบบ)
// isHirePurchaseBusiness/hirerType ใช้คิดภาษีเท่านั้น - TaxRenewal ยังไม่มีคอลัมน์ จึงเก็บใน taxBreakdown.owner แทน
interface ParsedVehicleInfo extends RenewalOwner {
  vehicleId: string | null;
  customerId: string | null;
  chassis: string;
  engine: string | null;
  plateCategory: string;
  plateNumber: string;
  registrationProvince: string | null;
  vehicleType: string;
  fuel: string;
  cc: number | null;
  weight: number | null;
  firstRegistrationDate: Date;
  ownerName: string | null;
  taxExpiryDate: Date;
}

const ownerOf = (info: RenewalOwner): RenewalOwner => ({
  ownerType: info.ownerType,
  isHirePurchaseBusiness: info.isHirePurchaseBusiness,
  hirerType: info.hirerType,
});

const sameOwner = (a: RenewalOwner, b: RenewalOwner) =>
  a.ownerType === b.ownerType && a.isHirePurchaseBusiness === b.isHirePurchaseBusiness && a.hirerType === b.hirerType;

// แก้/ยกเลิกงานต่อภาษี (ผู้ใช้ 2026-09-27): ADMIN / STAFF_CAR / STAFF_MOTO ตามประเภทรถของตัวเอง ต้องระบุเหตุผลเสมอ
// บันทึกประวัติลง AuditLog (entity 'TaxRenewal') - ยกเลิกไม่ลบแถว (cancelledAt) และไม่นับในรายการ/ยอดรวม/ภาพรวม
const STALE_ERROR = 'งานต่อภาษีนี้ถูกแก้หรือยกเลิกไปก่อนแล้ว - โหลดรายการใหม่';

// update แบบมีเงื่อนไขไม่เจอแถว (Prisma P2025) = มีคนแก้/ยกเลิกไปก่อน -> 409 ให้หน้าเว็บโหลดใหม่
function staleIfMissing(err: unknown): never {
  if ((err as { code?: string } | null)?.code === 'P2025') throw new ConflictException({ error: STALE_ERROR });
  throw err;
}

// updatedAt ที่ฟอร์ม ✎ แก้โหลดมา (ISO) - ไม่ส่ง = null / ส่งมาแต่อ่านเป็นวันเวลาไม่ได้ = 400
function parseExpectedUpdatedAt(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const date = typeof raw === 'string' ? new Date(raw) : new Date(Number.NaN);
  if (Number.isNaN(date.getTime())) throw new BadRequestException({ error: 'expectedUpdatedAt ต้องเป็นวันเวลา ISO' });
  return date;
}

// ช่องข้อมูลรถ/ภาษีที่ใช้คิดยอด - เปลี่ยนช่องใดช่องหนึ่ง = คิด inspectionRequired และยอดเงินใหม่
const TAX_INPUT_FIELDS = ['taxExpiryDate', 'vehicleType', 'fuel', 'cc', 'weight', 'firstRegistrationDate'] as const;
const RECEIPT_REQUIRED_ERROR = 'กรุณาแนบรูปใบเสร็จก่อนยืนยันรับใบเสร็จ (หน้ารับใบเสร็จ)';
const LAST_RECEIPT_ERROR = 'งานที่รับใบเสร็จแล้วต้องมีรูปใบเสร็จอย่างน้อย 1 รูป - แนบรูปที่ถูกต้องก่อนแล้วจึงลบรูปนี้';
const WORKFLOW_DATE_FIELDS = ['paymentDate', 'receivedDate', 'deliveredDate'] as const;

@Injectable()
export class TaxRenewalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxService: TaxService,
    @Inject(RECEIPT_STORAGE) private readonly storage: ReceiptStorage,
    @Inject(RECEIPT_EXTRACTOR) private readonly extractor: ReceiptExtractor,
  ) {}

  // เจ้าของงานเลือกจาก dropdown ลูกค้าในฐานข้อมูล (ผู้ใช้ 2026-10-08) - ส่งมาแล้วต้องมีอยู่จริง
  private async resolveCustomerId(raw: unknown): Promise<string> {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id) throw new BadRequestException({ error: 'กรุณาเลือกเจ้าของงาน (ลูกค้าที่ส่งงานมา)' });
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!customer) throw new BadRequestException({ error: 'ไม่พบเจ้าของงานที่เลือกในฐานข้อมูลลูกค้า' });
    return customer.id;
  }

  // รถที่ลิงก์จากฐานข้อมูลรถจดใหม่: ใช้ข้อมูลจากแถว Vehicle เป็นหลัก ช่องที่รถยังไม่มีให้กรอกเสริมได้
  private async resolveVehicleInfo(body: Record<string, unknown>): Promise<ParsedVehicleInfo> {
    const vehicleId = parseText(body.vehicleId, 'รถ', false, 50);
    const taxExpiryDate = parseDate(body.taxExpiryDate, 'วันครบกำหนดภาษี', true);

    if (!vehicleId) {
      const vehicleType = parseVehicleType(body.vehicleType);
      assertVehicleInScope(vehicleType);
      return {
        vehicleId: null,
        customerId: body.customerId ? await this.resolveCustomerId(body.customerId) : null,
        chassis: parseText(body.chassis, 'เลขตัวถัง', true, 50)!,
        engine: parseText(body.engine, 'เลขเครื่อง', false, 50),
        plateCategory: parseText(body.plateCategory, 'หมวดทะเบียน', true, 20)!,
        plateNumber: parseText(body.plateNumber, 'เลขทะเบียน', true, 20)!,
        registrationProvince: parseText(body.registrationProvince, 'จังหวัดที่จดทะเบียน', false),
        vehicleType,
        fuel: parseFuel(body.fuel),
        cc: parseDecimal(body.cc, 'ขนาด CC'),
        weight: parseDecimal(body.weight, 'น้ำหนักรถ'),
        firstRegistrationDate: parseDate(body.firstRegistrationDate, 'วันจดทะเบียนครั้งแรก', true),
        ...parseRenewalOwner(body),
        ownerName: parseText(body.ownerName, 'ชื่อเจ้าของรถ', false),
        taxExpiryDate,
      };
    }

    const vehicle = await this.prisma.vehicle.findFirst({
      where: { id: vehicleId, deletedAt: null, ...vehicleTypeWhere() },
      include: { owner: true },
    });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบรถคันนี้ในฐานข้อมูล' });

    const vehicleType = vehicle.body ?? parseVehicleType(body.vehicleType);
    // ค้นด้วยขอบเขตการอ่าน แต่งานต่อภาษีเป็นการบันทึก - ถือ ACCOUNTANT คู่ STAFF_* ต้องไม่ข้ามไปอีกประเภทรถ (พบ 2026-09-27)
    assertVehicleInScope(vehicleType);
    const firstRegistrationDate =
      vehicle.firstRegistrationDate ?? parseDate(body.firstRegistrationDate, 'วันจดทะเบียนครั้งแรก', true);
    const fuel = vehicle.fuel ?? parseFuel(body.fuel);
    // รถติดไฟแนนซ์เก็บเป็นนิติบุคคล + เช่าซื้อ + ประเภทผู้เช่าซื้อ (VehiclesService.ownerDataFor) - ต้องส่งครบทั้งสามค่า
    // ไม่งั้นผู้เช่าซื้อบุคคลธรรมดาโดนคูณสองแบบนิติบุคคล (พบ 2026-09-27) รถที่ยังไม่มีเจ้าของใช้ค่าที่กรอกในฟอร์ม
    const owner = vehicle.owner ? ownerOf(vehicle.owner) : parseRenewalOwner(body);

    return {
      vehicleId: vehicle.id,
      customerId: vehicle.customerId,
      // รถในระบบมีเลขตัวถังเสมอ ส่วนทะเบียนอาจยังว่างถ้ายังไม่ได้รับป้าย - หน้าเว็บจะให้กรอกเพิ่มเอง
      chassis: vehicle.chassis,
      engine: vehicle.engine ?? parseText(body.engine, 'เลขเครื่อง', false, 50),
      plateCategory: vehicle.plateCategory ?? parseText(body.plateCategory, 'หมวดทะเบียน', true, 20)!,
      plateNumber: vehicle.plateNumber ?? parseText(body.plateNumber, 'เลขทะเบียน', true, 20)!,
      registrationProvince: vehicle.registrationProvince,
      vehicleType,
      fuel,
      cc: positiveOrNull(vehicle.cc) ?? parseDecimal(body.cc, 'ขนาด CC'),
      weight: positiveOrNull(vehicle.weight) ?? parseDecimal(body.weight, 'น้ำหนักรถ'),
      firstRegistrationDate,
      ...owner,
      ownerName: vehicle.owner?.name ?? parseText(body.ownerName, 'ชื่อเจ้าของรถ', false),
      taxExpiryDate,
    } as ParsedVehicleInfo;
  }

  private async computeTax(
    info: ParsedVehicleInfo,
    paymentDate: Date,
    extras: { inspectionConfirmed: boolean },
  ): Promise<VehicleTaxResult> {
    const rules = await this.taxService.loadRuleSet();
    const input: VehicleTaxInput = {
      vehicleType: info.vehicleType,
      fuel: info.fuel,
      engineCc: info.cc,
      vehicleWeightKg: info.weight,
      firstRegistrationDate: info.firstRegistrationDate,
      taxExpiryDate: info.taxExpiryDate,
      paymentDate,
      owner: ownerOf(info),
      inspectionCertificateConfirmed: extras.inspectionConfirmed,
    };
    try {
      return calculateVehicleTax(input, rules);
    } catch (error) {
      if (error instanceof VehicleTaxInputError) throw new BadRequestException({ error: error.message });
      throw error;
    }
  }

  // คิดยอดสดให้ฟอร์มดูก่อนบันทึก - ไม่แตะฐานข้อมูล
  async preview(body: Record<string, unknown>) {
    const info = await this.resolveVehicleInfo(body);
    const paymentDate = parseDate(body.paymentDate, 'วันที่ชำระ') ?? todayInBangkok();
    const tax = await this.computeTax(info, paymentDate, {
      inspectionConfirmed: Boolean(body.inspectionConfirmed),
    });
    const fees = calculateTaxRenewalFees(tax, { skipContribution: Boolean(body.skipContribution) });
    return { tax, fees };
  }

  async create(body: Record<string, unknown>) {
    const info = await this.resolveVehicleInfo(body);
    const inspectionConfirmed = Boolean(body.inspectionConfirmed);
    // วันที่ยื่นงาน - เป็นข้อมูลของงาน ไม่ใช่ของรถ จึงไม่อยู่ใน resolveVehicleInfo และไม่มีผลกับยอดภาษี
    const submitDate = parseDate(body.submitDate, 'วันที่ยื่นงาน', true);
    // คิด ณ วันที่ชำระถ้ามี ไม่งั้นใช้วันนี้เพื่อดูว่าต้องตรวจสภาพไหม (ยอดเงินยัง snapshot ไม่ได้จนกว่าจะชำระ)
    const paymentDate = parseDate(body.paymentDate, 'วันที่ชำระ');
    const tax = await this.computeTax(info, paymentDate ?? todayInBangkok(), { inspectionConfirmed });
    const fees = paymentDate
      ? calculateTaxRenewalFees(tax, { skipContribution: Boolean(body.skipContribution) })
      : null;
    // เรื่องเช่าซื้อยังไม่มีคอลัมน์ใน TaxRenewal - เก็บเจ้าของที่ใช้คิดไว้ใน taxBreakdown.owner เสมอ (งานที่ยังไม่ชำระด้วย)
    // เพื่อให้ update() คิดยอดตอนใส่วันที่ชำระทีหลังด้วยเจ้าของเดิม (พบ 2026-09-27)
    const { isHirePurchaseBusiness, hirerType, ...columns } = info;
    const owner: RenewalOwner = { ownerType: info.ownerType, isHirePurchaseBusiness, hirerType };

    return this.prisma.taxRenewal.create({
      data: {
        ...columns,
        submitDate,
        inspectionRequired: tax.inspectionRequired,
        inspectionConfirmed,
        insuranceConfirmed: Boolean(body.insuranceConfirmed),
        paymentDate,
        skipContribution: Boolean(body.skipContribution),
        billItems: fees ? toJson(fees.billItems) : undefined,
        noBillItems: fees ? toJson(fees.noBillItems) : undefined,
        billTotal: fees?.billTotal ?? undefined,
        noBillTotal: fees?.noBillTotal ?? undefined,
        taxBreakdown: toJson(fees ? { ...tax, owner } : { owner }),
      },
    });
  }

  // ค้นรถในฐานข้อมูลรถจดใหม่เพื่อนำมาต่อภาษี - หาได้จากเลขตัวถัง เลขเครื่อง เลขทะเบียน
  // ชื่อลูกค้า/บริษัท ชื่อผู้ถือกรรมสิทธิ์ (รวมชื่อไฟแนนซ์) และชื่อผู้ครอบครอง
  // ไม่ผูกกับคิวยื่นเอกสารแบบ /api/vehicles/search เพราะรถที่จดเสร็จแล้วก็ต้องต่อภาษีได้
  async searchVehicles(query: string) {
    const q = query.trim();
    if (q.length < 2) return [];
    const contains = { contains: q, mode: 'insensitive' as const };
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        deletedAt: null,
        // ค้นเพื่อเลือกรถมาบันทึกงาน จึงใช้ขอบเขตการแก้ - STAFF_CAR + ACCOUNTANT ต้องไม่เห็นจักรยานยนต์ที่เลือกแล้วบันทึกไม่ได้ (พบ 2026-09-27)
        ...vehicleTypeWhere(currentWriteScope()),
        OR: [
          { chassis: contains },
          { engine: contains },
          { plateNumber: contains },
          { plateCategory: contains },
          { customer: { name: contains } },
          { customer: { company: contains } },
          { owner: { name: contains } }, // ผู้ถือกรรมสิทธิ์ (ติดไฟแนนซ์ = ชื่อไฟแนนซ์)
          { owner: { hirerName: contains } }, // ผู้ครอบครอง
          // รถเก่าบางคันมีแต่ financeCompanyId ยังไม่ได้ snapshot ชื่อลง owner.name จึงค้นจากตารางไฟแนนซ์ด้วย
          { owner: { financeCompany: { name: contains } } },
        ],
      },
      take: 20,
      orderBy: { date: 'desc' },
      select: {
        id: true,
        chassis: true,
        engine: true,
        plateCategory: true,
        plateNumber: true,
        body: true,
        fuel: true,
        cc: true,
        weight: true,
        firstRegistrationDate: true,
        customer: { select: { name: true, company: true } },
        owner: { select: { name: true, hirerName: true, ownerType: true } },
      },
    });
    // ส่ง cc/weight/ownerType กลับไปด้วย เพื่อให้หน้าเว็บรู้ว่ารถคันนี้ยังขาดข้อมูลอะไรสำหรับคำนวณภาษี
    // (รถที่ยังไม่ถึงขั้นที่ 4 มักยังไม่มีวันจดทะเบียนครั้งแรกและเจ้าของ)
    // ownerName = ผู้ถือกรรมสิทธิ์ (ติดไฟแนนซ์ = ชื่อไฟแนนซ์) / hirerName = ผู้ครอบครอง (null เมื่อไม่มีไฟแนนซ์)
    // แยกสองช่องเพื่อให้หน้าเว็บโชว์ได้ทั้งคู่ ไม่ยุบเหลือชื่อเดียว
    return vehicles.map((v) => ({
      id: v.id,
      chassis: v.chassis,
      engine: v.engine,
      plateCategory: v.plateCategory,
      plateNumber: v.plateNumber,
      body: v.body,
      fuel: v.fuel,
      cc: positiveOrNull(v.cc),
      weight: positiveOrNull(v.weight),
      firstRegistrationDate: v.firstRegistrationDate,
      ownerType: v.owner?.ownerType ?? null,
      ownerName: v.owner?.name ?? null,
      hirerName: v.owner?.hirerName ?? null,
      customerName: v.customer?.company || v.customer?.name || null,
    }));
  }

  // งานที่ยกเลิกแล้วไม่แสดง (ผู้ใช้ 2026-09-27) - ownerFromVehicle / financed / hirerType ให้ฟอร์ม ✎ แก้ รู้ว่าเจ้าของมาจากไหน
  async findAll() {
    const rows = await this.prisma.taxRenewal.findMany({
      where: { cancelledAt: null, ...vehicleTypeWhereForRenewal() },
      orderBy: [{ paymentDate: 'asc' }, { taxExpiryDate: 'asc' }],
      include: {
        customer: { select: { id: true, name: true, company: true } },
        vehicle: { select: { owner: { select: { id: true } } } },
        receipts: { orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } },
      },
    });
    return rows.map(({ vehicle, ...row }) => {
      const stored = storedRenewalOwner(row.taxBreakdown);
      return {
        ...row,
        ownerFromVehicle: Boolean(vehicle?.owner),
        financed: stored?.isHirePurchaseBusiness ?? false,
        hirerType: stored?.hirerType ?? null,
      };
    });
  }

  // เจ้าของตอนคิดยอดใหม่: รถที่ลิงก์ไว้อ่านจาก VehicleOwner ปัจจุบัน (มีเรื่องเช่าซื้อครบ) ถ้ารถไม่มีเจ้าของ/ไม่ได้ลิงก์
  // ใช้ที่เก็บไว้ใน taxBreakdown.owner ตอนบันทึก - งานเก่าที่ไม่มีก็เหลือแค่ ownerType แบบเดิม (พบ 2026-09-27)
  // fromVehicle = เจ้าของมาจากข้อมูลรถ -> แก้ที่งานต่อภาษีไม่ได้ (คิดยอดครั้งหน้าก็จะอ่านจากรถอยู่ดี)
  private async ownerForRecompute(existing: {
    vehicleId: string | null;
    ownerType: RenewalOwner['ownerType'];
    taxBreakdown: unknown;
  }): Promise<RenewalOwner & { fromVehicle: boolean }> {
    if (existing.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: existing.vehicleId },
        select: { owner: { select: { ownerType: true, isHirePurchaseBusiness: true, hirerType: true } } },
      });
      if (vehicle?.owner) return { ...ownerOf(vehicle.owner), fromVehicle: true };
    }
    const stored = storedRenewalOwner(existing.taxBreakdown) ?? {
      ownerType: existing.ownerType,
      isHirePurchaseBusiness: false,
      hirerType: null,
    };
    return { ...stored, fromVehicle: false };
  }

  // งานที่จะแก้/ยกเลิก - ต้องอยู่ในขอบเขตการแก้ของผู้ใช้ และยังไม่ถูกยกเลิก (409 ให้หน้าเว็บโหลดใหม่)
  private async findActive(id: string) {
    const existing = await this.prisma.taxRenewal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบงานต่อภาษีนี้' });
    assertVehicleInScope(existing.vehicleType);
    if (existing.cancelledAt) throw new ConflictException({ error: 'งานต่อภาษีนี้ถูกยกเลิกแล้ว - โหลดรายการใหม่' });
    return existing;
  }

  // ยกเลิกงาน (ผู้ใช้ 2026-09-27: ไม่ลบแถว ยกเลิกได้ทุกสถานะรวมงานที่ชำระแล้ว) - เก็บ snapshot + เหตุผลลง AuditLog
  async cancel(id: string, remarkRaw: unknown): Promise<{ id: string }> {
    const remark = requireRemark(remarkRaw, 'กรุณาระบุเหตุผลที่ยกเลิกงานต่อภาษี');
    const existing = await this.findActive(id);
    await this.prisma.$transaction(async (tx) => {
      await tx.taxRenewal
        .update({
          where: { id, cancelledAt: null },
          data: { cancelledAt: new Date(), cancelReason: remark, cancelledById: currentUser()?.id ?? null },
        })
        .catch(staleIfMissing);
      await writeAudit(tx, {
        entity: 'TaxRenewal',
        entityId: id,
        action: 'cancel',
        remark,
        changes: {
          chassis: existing.chassis,
          plate: `${existing.plateCategory} ${existing.plateNumber}`,
          vehicleType: existing.vehicleType,
          submitDate: existing.submitDate,
          taxExpiryDate: existing.taxExpiryDate,
          paymentDate: existing.paymentDate,
          receivedDate: existing.receivedDate,
          deliveredDate: existing.deliveredDate,
          billTotal: existing.billTotal,
          noBillTotal: existing.noBillTotal,
        },
      });
    });
    return { id };
  }

  // เติมวันที่/ติ๊กทีหลังจากหน้ารายการ - ตั้ง paymentDate ครั้งแรกคือจุดที่ snapshot ยอดเงิน
  // แก้งานที่บันทึกผิด (ผู้ใช้ 2026-09-27, ปุ่ม ✎ แก้): ข้อมูลรถ/ภาษี วันที่ยื่นงาน ลงขัน และแก้/ล้างวันที่ที่เคยกรอกแล้ว
  // = การแก้ข้อมูล ต้องมี remark และบันทึก AuditLog / ติ๊ก ตรอ.-พ.ร.บ. และกรอกวันที่ที่ยังว่างเป็นงานปกติ ไม่ต้องมีเหตุผล
  // ข้อมูลรถ/ภาษีเปลี่ยน = คิด inspectionRequired และยอดเงินใหม่ (ถ้าชำระแล้ว) / ล้างวันที่ชำระ = ล้างยอดเงินที่ snapshot ไว้
  // รถที่เลือกผิดคันแก้ที่นี่ไม่ได้ - ยกเลิกงานแล้วบันทึกใหม่
  async update(id: string, body: Record<string, unknown>) {
    const expectedUpdatedAt = parseExpectedUpdatedAt(body.expectedUpdatedAt);
    const existing = await this.findActive(id);
    // ฟอร์ม ✎ แก้ส่งทุกช่องจากตอนเปิด + expectedUpdatedAt - มีคนแก้/ติ๊กไปก่อนระหว่างที่เปิดฟอร์มอยู่ = 409 ไม่เอาค่าเก่าไปทับ
    // (พบ 2026-09-27: เดิมเทียบกับ updatedAt ที่อ่านในคำขอนี้เอง จึงกันได้แค่ช่วงไม่กี่มิลลิวินาที)
    if (expectedUpdatedAt && expectedUpdatedAt.getTime() !== existing.updatedAt.getTime()) {
      throw new ConflictException({ error: STALE_ERROR });
    }
    const has = (key: string) => body[key] !== undefined;

    if (existing.vehicleId && (has('chassis') || has('engine'))) {
      throw new BadRequestException({
        error: 'รถที่เลือกจากระบบแก้เลขตัวถัง/เลขเครื่องที่งานต่อภาษีไม่ได้ - ถ้าเลือกรถผิดคันให้ยกเลิกงานแล้วบันทึกใหม่',
      });
    }
    const vehicleType = has('vehicleType') ? parseVehicleType(body.vehicleType) : existing.vehicleType;
    // เปลี่ยนประเภทรถต้องอยู่ในขอบเขตการแก้ทั้งค่าเดิมและค่าใหม่ (STAFF_CAR เปลี่ยนเป็นจักรยานยนต์ไม่ได้)
    if (vehicleType !== existing.vehicleType) assertVehicleInScope(vehicleType);
    const details = {
      submitDate: has('submitDate') ? parseDate(body.submitDate, 'วันที่ยื่นงาน', true) : existing.submitDate,
      chassis: has('chassis') ? parseText(body.chassis, 'เลขตัวถัง', true, 50)! : existing.chassis,
      engine: has('engine') ? parseText(body.engine, 'เลขเครื่อง', false, 50) : existing.engine,
      plateCategory: has('plateCategory') ? parseText(body.plateCategory, 'หมวดทะเบียน', true, 20)! : existing.plateCategory,
      plateNumber: has('plateNumber') ? parseText(body.plateNumber, 'เลขทะเบียน', true, 20)! : existing.plateNumber,
      vehicleType,
      fuel: has('fuel') ? parseFuel(body.fuel) : existing.fuel,
      cc: has('cc') ? parseDecimal(body.cc, 'ขนาด CC') : existing.cc,
      weight: has('weight') ? parseDecimal(body.weight, 'น้ำหนักรถ') : existing.weight,
      firstRegistrationDate: has('firstRegistrationDate')
        ? parseDate(body.firstRegistrationDate, 'วันจดทะเบียนครั้งแรก', true)
        : existing.firstRegistrationDate,
      ownerName: has('ownerName') ? parseText(body.ownerName, 'ชื่อเจ้าของรถ', false) : existing.ownerName,
      taxExpiryDate: has('taxExpiryDate') ? parseDate(body.taxExpiryDate, 'วันครบกำหนดภาษี', true) : existing.taxExpiryDate,
    };

    // เจ้าของ: รถที่มีเจ้าของในฐานข้อมูลรถใช้ของรถเสมอ (แก้ที่ข้อมูลรถ) ที่เหลือแก้ได้ที่นี่ (ประเภท + ติดไฟแนนซ์)
    const { fromVehicle, ...currentOwner } = await this.ownerForRecompute(existing);
    let owner: RenewalOwner = currentOwner;
    if (has('ownerType') || has('financed')) {
      const edited = parseRenewalOwner(body);
      if (fromVehicle && !sameOwner(edited, currentOwner)) {
        throw new BadRequestException({
          error: 'รถคันนี้มีข้อมูลเจ้าของในฐานข้อมูลรถแล้ว - แก้ประเภทเจ้าของ/ไฟแนนซ์ที่ข้อมูลรถ (หน้าเพิ่มข้อมูลรถจดใหม่)',
        });
      }
      owner = edited;
    }
    const ownerChanged = !sameOwner(owner, currentOwner);

    const inspectionConfirmed =
      body.inspectionConfirmed === undefined ? existing.inspectionConfirmed : Boolean(body.inspectionConfirmed);
    const insuranceConfirmed =
      body.insuranceConfirmed === undefined ? existing.insuranceConfirmed : Boolean(body.insuranceConfirmed);
    const skipContribution =
      body.skipContribution === undefined ? existing.skipContribution : Boolean(body.skipContribution);
    const paymentDate =
      body.paymentDate === undefined ? existing.paymentDate : parseDate(body.paymentDate, 'วันที่ชำระ');
    const receivedDate =
      body.receivedDate === undefined ? existing.receivedDate : parseDate(body.receivedDate, 'วันที่รับป้ายภาษี');
    const deliveredDate =
      body.deliveredDate === undefined ? existing.deliveredDate : parseDate(body.deliveredDate, 'วันที่คืนลูกค้า');
    // เจ้าของงาน: เติมจากว่างเป็นงานปกติ / เปลี่ยนคนที่มีอยู่แล้วเป็นการแก้ข้อมูล (ต้องมีเหตุผล)
    const customerId = has('customerId') ? await this.resolveCustomerId(body.customerId) : existing.customerId;
    const customerChanged = customerId !== existing.customerId;
    const customerCorrected = customerChanged && existing.customerId !== null;
    const customerData: Prisma.TaxRenewalUpdateInput = customerChanged ? { customer: { connect: { id: customerId! } } } : {};

    if (receivedDate && !paymentDate) {
      throw new BadRequestException({ error: 'ต้องบันทึกวันที่ชำระภาษีก่อนรับป้ายภาษี/ใบเสร็จ' });
    }
    // รับใบเสร็จครั้งแรกต้องมีรูปใบเสร็จอย่างน้อย 1 รูป (ผู้ใช้ 2026-10-08) - แนบที่หน้ารับใบเสร็จ
    if (receivedDate && !existing.receivedDate) {
      const receiptCount = await this.prisma.receiptImage.count({ where: { taxRenewalId: id } });
      if (receiptCount === 0) throw new BadRequestException({ error: RECEIPT_REQUIRED_ERROR });
    }
    if (deliveredDate && !receivedDate) {
      throw new BadRequestException({ error: 'ต้องรับป้ายภาษี/ใบเสร็จก่อนคืนเอกสารให้ลูกค้า' });
    }

    // แยกการแก้ข้อมูล (ต้องมีเหตุผล) ออกจากงานปกติ: กรอกวันที่ที่ยังว่าง = งานปกติ / แก้หรือล้างวันที่ที่มีแล้ว = แก้ข้อมูล
    const detailChanges = diffChanges(existing, { ...details, skipContribution });
    const dateChanges = diffChanges(existing, { paymentDate, receivedDate, deliveredDate });
    const correctedDates = WORKFLOW_DATE_FIELDS.filter((field) => field in dateChanges && existing[field] !== null);
    const isCorrection = Object.keys(detailChanges).length > 0 || ownerChanged || correctedDates.length > 0 || customerCorrected;
    const remark = isCorrection ? requireRemark(body.remark, 'กรุณาระบุเหตุผลที่แก้งานต่อภาษี') : null;

    // ยอดเงินคิดใหม่เมื่อวันที่ชำระ ตัวเลือกลงขัน หรือข้อมูลที่ใช้คิดภาษีเปลี่ยน (เงินเพิ่มผูกกับวันที่ชำระโดยตรง)
    const taxInputChanged = TAX_INPUT_FIELDS.some((field) => field in detailChanges) || ownerChanged;
    const paymentChanged = 'paymentDate' in dateChanges;
    const feesChanged = paymentChanged || skipContribution !== existing.skipContribution || taxInputChanged;
    const info: ParsedVehicleInfo = {
      vehicleId: existing.vehicleId,
      customerId: existing.customerId,
      registrationProvince: existing.registrationProvince,
      ...details,
      cc: positiveOrNull(details.cc),
      weight: positiveOrNull(details.weight),
      ...owner,
    };
    let feeData: Prisma.TaxRenewalUpdateInput = {};
    if (paymentDate && feesChanged) {
      const tax = await this.computeTax(info, paymentDate, { inspectionConfirmed });
      const fees = calculateTaxRenewalFees(tax, { skipContribution });
      feeData = {
        inspectionRequired: tax.inspectionRequired,
        billItems: toJson(fees.billItems),
        noBillItems: toJson(fees.noBillItems),
        billTotal: fees.billTotal,
        noBillTotal: fees.noBillTotal,
        taxBreakdown: toJson({ ...tax, owner }),
      };
    } else if (!paymentDate && (paymentChanged || taxInputChanged)) {
      // ยังไม่ชำระ = ยังไม่มียอดเงิน: ล้าง snapshot เดิม (เพิ่งล้างวันที่ชำระ) เก็บแค่เจ้าของไว้คิดตอนชำระ
      // ข้อมูลรถเปลี่ยน -> คิดใหม่แค่ว่าต้องตรวจสภาพไหม ณ วันนี้ (เหมือนตอนบันทึกงาน)
      const inspectionRequired = taxInputChanged
        ? (await this.computeTax(info, todayInBangkok(), { inspectionConfirmed })).inspectionRequired
        : existing.inspectionRequired;
      feeData = {
        inspectionRequired,
        billItems: Prisma.DbNull,
        noBillItems: Prisma.DbNull,
        billTotal: null,
        noBillTotal: null,
        taxBreakdown: toJson({ owner }),
      };
    }

    if (!remark) {
      // งานปกติ (ติ๊ก / กรอกวันที่ครั้งแรก): เขียนเฉพาะช่องที่ส่งมา (+ ยอดเงินที่เพิ่งคิดตอนใส่วันที่ชำระ) - ไม่เขียนข้อมูลรถ/เจ้าของ/
      // วันที่อื่นที่อ่านไว้ต้นคำขอ ติ๊กที่แทรกกับการ ✎ แก้ของอีกคนจึงไม่เอาค่าเก่าไปทับโดยไม่มีประวัติ (พบ 2026-09-27)
      // ownerType เขียนเฉพาะตอนคิดยอดใหม่ ให้ตรงกับ taxBreakdown.owner ที่ใช้คิด (เดิมทุกติ๊กคัดลอกเจ้าของปัจจุบันของรถมาทับ)
      const dates = { paymentDate, receivedDate, deliveredDate };
      const sentDates = WORKFLOW_DATE_FIELDS.filter((field) => has(field));
      const routine: Prisma.TaxRenewalUpdateInput = {
        ...(has('inspectionConfirmed') ? { inspectionConfirmed } : {}),
        ...(has('insuranceConfirmed') ? { insuranceConfirmed } : {}),
        ...Object.fromEntries(sentDates.map((field) => [field, dates[field]])),
        ...customerData,
        ...feeData,
        ...('taxBreakdown' in feeData ? { ownerType: owner.ownerType } : {}),
      };
      // ติ๊กอย่างเดียวไม่เช็ก updatedAt (ติ๊กหลายช่องติดกันเร็วๆ ได้) แต่ยอดเงินที่คิดใหม่ขึ้นกับข้อมูลรถที่อ่านมา จึงต้องเช็ก
      // - ฟอร์ม ✎ แก้ที่ส่ง expectedUpdatedAt มาเช็กเสมอ
      const guard = expectedUpdatedAt ?? (Object.keys(feeData).length > 0 ? existing.updatedAt : null);
      // กรอกวันที่: วันที่ทั้งสามต้องยังเป็นค่าที่ตรวจไว้ - อีกคนกรอก/แก้ไปก่อน = 409 (ไม่ทับวันที่ของเขาโดยไม่มีเหตุผล
      // และลำดับ ชำระ -> รับป้าย -> คืนลูกค้า ที่ตรวจข้างบนยังถูกตอนเขียน)
      const datesAsChecked =
        sentDates.length > 0
          ? { paymentDate: existing.paymentDate, receivedDate: existing.receivedDate, deliveredDate: existing.deliveredDate }
          : {};
      return this.prisma.taxRenewal
        .update({ where: { id, cancelledAt: null, ...datesAsChecked, ...(guard ? { updatedAt: guard } : {}) }, data: routine })
        .catch(staleIfMissing);
    }
    const data: Prisma.TaxRenewalUpdateInput = {
      ...details,
      ownerType: owner.ownerType,
      inspectionConfirmed,
      insuranceConfirmed,
      skipContribution,
      paymentDate,
      receivedDate,
      deliveredDate,
      ...customerData,
      ...feeData,
    };
    const changes = {
      ...detailChanges,
      ...(ownerChanged ? { owner: { from: currentOwner, to: owner } } : {}),
      ...dateChanges,
      ...(customerChanged ? { customerId: { from: existing.customerId, to: customerId } } : {}),
      ...diffChanges(existing, { inspectionConfirmed, insuranceConfirmed }),
      ...('billTotal' in feeData ? diffChanges(existing, { billTotal: feeData.billTotal, noBillTotal: feeData.noBillTotal }) : {}),
    };
    return this.prisma.$transaction(async (tx) => {
      // เงื่อนไข updatedAt ที่ฟอร์มโหลดมา: อีกคนแก้ไปก่อน (รวมช่วงระหว่างอ่านกับเขียนในคำขอนี้) -> 409 ไม่ทับของเขา
      const updated = await tx.taxRenewal
        .update({ where: { id, cancelledAt: null, updatedAt: expectedUpdatedAt ?? existing.updatedAt }, data })
        .catch(staleIfMissing);
      await writeAudit(tx, { entity: 'TaxRenewal', entityId: id, action: 'update', remark, changes });
      return updated;
    });
  }

  // ---------------------------------------------------------------------------------------------
  // ใบเสร็จของงานต่อภาษี (ผู้ใช้ 2026-10-08, แบบเดียวกับงานย้ายออก/คัดแผ่นป้าย): แนบรูป -> OCR เติมเลขที่/วันที่/ยอด -> ยืนยันรับ (receivedDate)
  // หลังรับแล้วแนบ/ลบรูปและแก้ข้อมูลใบเสร็จต้องมีเหตุผล บันทึก AuditLog และต้องเหลือรูปอย่างน้อย 1 รูป
  // ---------------------------------------------------------------------------------------------

  private async reloadOne(id: string) {
    return this.prisma.taxRenewal.findUniqueOrThrow({
      where: { id },
      include: {
        customer: { select: { id: true, name: true, company: true } },
        receipts: { orderBy: { createdAt: 'asc' }, select: { id: true, createdAt: true } },
      },
    });
  }

  // ล็อกแถวงาน (FOR UPDATE) แล้วอ่านสถานะล่าสุด - กันลบรูปสุดท้ายพร้อมกับการยืนยันรับ
  private async lockRow(tx: Prisma.TransactionClient, id: string, expectedReceivedDate: Date | null) {
    await tx.$queryRaw`SELECT "id" FROM "TaxRenewal" WHERE "id" = ${id} FOR UPDATE`;
    const live = await tx.taxRenewal.findFirst({
      where: { id, cancelledAt: null },
      select: { receivedDate: true, _count: { select: { receipts: true } } },
    });
    if (!live) throw new ConflictException({ error: STALE_ERROR });
    if ((live.receivedDate?.getTime() ?? null) !== (expectedReceivedDate?.getTime() ?? null)) {
      throw new ConflictException({ error: STALE_ERROR });
    }
    return live;
  }

  async addReceipt(id: string, file: UploadedReceiptFile | undefined, remarkRaw?: unknown) {
    const existing = await this.findActive(id);
    const remark = existing.receivedDate ? requireRemark(remarkRaw, 'งานนี้รับใบเสร็จแล้ว - แนบรูปเพิ่มต้องระบุเหตุผล') : null;
    if (!file || file.size === 0) throw new BadRequestException({ error: 'ไม่พบไฟล์รูปใบเสร็จ' });
    if (file.size > MAX_RECEIPT_BYTES) throw new BadRequestException({ error: 'ไฟล์รูปใหญ่เกิน 8MB' });
    const type = detectImageType(file.buffer);
    if (!type) throw new BadRequestException({ error: 'รองรับเฉพาะรูป JPEG, PNG หรือ WebP' });

    // ตาราง ReceiptImage เดียวกับใบเสร็จอื่น - รูปที่ใช้เป็นใบเสร็จที่ไหนแล้วก็ใช้ซ้ำไม่ได้
    const contentHash = contentHashOf(file.buffer);
    if (await this.prisma.receiptImage.findUnique({ where: { contentHash }, select: { id: true } })) throw duplicateUpload();

    const extraction = await this.extractor.extract(file.buffer, type.mimeType);

    const now = new Date();
    const storageKey = `receipts/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}/${randomUUID()}.${type.ext}`;
    await this.storage.put(storageKey, file.buffer, type.mimeType);
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.lockRow(tx, id, existing.receivedDate);
        const created = await tx.receiptImage.create({
          data: {
            taxRenewalId: existing.id,
            storageKey,
            contentHash,
            mimeType: type.mimeType,
            sizeBytes: file.size,
            originalName: file.originalname ? file.originalname.slice(0, 200) : null,
            extractionSource: this.extractor.source,
            ...(extraction ? { extraction: extraction as object } : {}),
          },
          select: { id: true },
        });
        // เติมจาก OCR ครั้งแรกที่อ่านสำเร็จ - เฉพาะตอนช่องยังว่างทั้ง 3 ช่อง (กันทับของที่พนักงานแก้ไปแล้ว)
        if (extraction && 'reading' in extraction) {
          const { receiptNo, date, total } = extraction.reading;
          const readDate = date && dateInRange(toUtcDate(date), existing.submitDate) ? toUtcDate(date) : undefined;
          if (receiptNo || readDate || total !== null) {
            await tx.taxRenewal.updateMany({
              where: { id, receiptNo: null, receiptDate: null, receiptAmount: null },
              data: { receiptNo: receiptNo || undefined, receiptDate: readDate, receiptAmount: total !== null ? total : undefined },
            });
          }
        }
        if (remark) {
          await writeAudit(tx, { entity: 'TaxRenewal', entityId: id, action: 'add-receipt', remark, changes: { receipt: { from: null, to: created.id } } });
        }
      });
    } catch (err) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isContentHashConflict(err)) throw duplicateUpload();
      throw err;
    }
    return this.reloadOne(id);
  }

  async removeReceipt(id: string, receiptId: string, remarkRaw?: unknown) {
    const existing = await this.findActive(id);
    const remark = existing.receivedDate ? requireRemark(remarkRaw, 'งานนี้รับใบเสร็จแล้ว - ลบรูปใบเสร็จต้องระบุเหตุผล') : null;
    const receipt = await this.prisma.receiptImage.findFirst({ where: { id: receiptId, taxRenewalId: id }, select: { id: true, storageKey: true } });
    if (!receipt) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
    await this.prisma.$transaction(async (tx) => {
      const live = await this.lockRow(tx, id, existing.receivedDate);
      if (remark && live._count.receipts <= 1) throw new BadRequestException({ error: LAST_RECEIPT_ERROR });
      const { count } = await tx.receiptImage.deleteMany({ where: { id: receipt.id, taxRenewalId: id } });
      if (count === 0) throw new NotFoundException({ error: 'ไม่พบรูปใบเสร็จ' });
      if (remark) {
        await writeAudit(tx, {
          entity: 'TaxRenewal',
          entityId: id,
          action: 'remove-receipt',
          remark,
          changes: { receipt: { from: receipt.id, to: null }, storageKey: receipt.storageKey },
        });
      }
    });
    // หลังรับแล้วรูปเป็นหลักฐาน: ถอดแถวออกแต่ไม่ลบไฟล์ใน storage
    if (!remark) await this.storage.delete(receipt.storageKey).catch(() => undefined);
    return this.reloadOne(id);
  }

  async updateReceiptFields(id: string, dto: { receiptNo?: unknown; receiptDate?: unknown; receiptAmount?: unknown; remark?: unknown }) {
    const existing = await this.findActive(id);
    const receiptNo = optionalText(dto?.receiptNo, 'เลขที่ใบเสร็จ', 100);
    const receiptDate = optionalIsoDateField(dto?.receiptDate, 'วันที่ใบเสร็จ');
    if (receiptDate) assertDateInRange('วันที่ใบเสร็จ', receiptDate, existing.submitDate);
    const receiptAmount = optionalAmount(dto?.receiptAmount, 'ยอดเงินตามใบเสร็จ');
    const next = { receiptNo, receiptDate, receiptAmount };
    const changes = diffChanges(existing, next);
    if (Object.keys(changes).length === 0) return this.reloadOne(id);
    const where = { id, cancelledAt: null, receivedDate: existing.receivedDate };
    if (!existing.receivedDate) {
      await this.prisma.taxRenewal.update({ where, data: next }).catch(staleIfMissing);
      return this.reloadOne(id);
    }
    const remark = requireRemark(dto?.remark, 'งานนี้รับใบเสร็จแล้ว - แก้ข้อมูลใบเสร็จต้องระบุเหตุผล');
    await this.prisma.$transaction(async (tx) => {
      await tx.taxRenewal.update({ where, data: next }).catch(staleIfMissing);
      await writeAudit(tx, { entity: 'TaxRenewal', entityId: id, action: 'update-receipt-fields', remark, changes });
    });
    return this.reloadOne(id);
  }
}

// เงื่อนไขเดียวกับ vehicleTypeWhere() แต่อ่านจาก TaxRenewal.vehicleType แทน Vehicle.body
// (รถที่ไม่ได้อยู่ในฐานข้อมูลรถจดใหม่ไม่มีแถว Vehicle ให้ join)
function vehicleTypeWhereForRenewal() {
  const scope = currentVehicleScope();
  if (scope === 'ALL') return {};
  if (scope === 'MOTO') return { vehicleType: { startsWith: MOTO_PREFIX } };
  if (scope === 'CAR') return { NOT: { vehicleType: { startsWith: MOTO_PREFIX } } };
  return { id: { in: [] as string[] } };
}
