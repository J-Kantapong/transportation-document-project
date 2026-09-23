import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { assertVehicleInScope, currentVehicleScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';
import { calculateTaxRenewalFees } from './tax-renewal-fee.js';
import {
  parseDate,
  parseDecimal,
  parseFuel,
  parseOwnerType,
  parseText,
  parseVehicleType,
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

// ข้อมูลรถของงานต่อภาษี - มาจาก Vehicle ที่ลิงก์ไว้ หรือกรอกเองทั้งหมด (รถที่ไม่ได้อยู่ในระบบ)
interface ParsedVehicleInfo {
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
  ownerType: ReturnType<typeof parseOwnerType>;
  ownerName: string | null;
  taxExpiryDate: Date;
}

@Injectable()
export class TaxRenewalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly taxService: TaxService,
  ) {}

  // รถที่ลิงก์จากฐานข้อมูลรถจดใหม่: ใช้ข้อมูลจากแถว Vehicle เป็นหลัก ช่องที่รถยังไม่มีให้กรอกเสริมได้
  private async resolveVehicleInfo(body: Record<string, unknown>): Promise<ParsedVehicleInfo> {
    const vehicleId = parseText(body.vehicleId, 'รถ', false, 50);
    const taxExpiryDate = parseDate(body.taxExpiryDate, 'วันครบกำหนดภาษี', true);

    if (!vehicleId) {
      const vehicleType = parseVehicleType(body.vehicleType);
      assertVehicleInScope(vehicleType);
      return {
        vehicleId: null,
        customerId: parseText(body.customerId, 'ลูกค้า', false, 50),
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
        ownerType: parseOwnerType(body.ownerType),
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
    const firstRegistrationDate =
      vehicle.firstRegistrationDate ?? parseDate(body.firstRegistrationDate, 'วันจดทะเบียนครั้งแรก', true);
    const fuel = vehicle.fuel ?? parseFuel(body.fuel);
    const ownerType = vehicle.owner?.ownerType ?? parseOwnerType(body.ownerType);

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
      cc: vehicle.cc ? Number(vehicle.cc) : parseDecimal(body.cc, 'ขนาด CC'),
      weight: vehicle.weight ? Number(vehicle.weight) : parseDecimal(body.weight, 'น้ำหนักรถ'),
      firstRegistrationDate,
      ownerType,
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
      owner: { ownerType: info.ownerType, isHirePurchaseBusiness: false, hirerType: null },
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
    const paymentDate = parseDate(body.paymentDate, 'วันที่ชำระ') ?? new Date();
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
    const tax = await this.computeTax(info, paymentDate ?? new Date(), { inspectionConfirmed });
    const fees = paymentDate
      ? calculateTaxRenewalFees(tax, { skipContribution: Boolean(body.skipContribution) })
      : null;

    return this.prisma.taxRenewal.create({
      data: {
        ...info,
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
        taxBreakdown: fees ? toJson(tax) : undefined,
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
        ...vehicleTypeWhere(),
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
      cc: v.cc ? Number(v.cc) : null,
      weight: v.weight ? Number(v.weight) : null,
      firstRegistrationDate: v.firstRegistrationDate,
      ownerType: v.owner?.ownerType ?? null,
      ownerName: v.owner?.name ?? null,
      hirerName: v.owner?.hirerName ?? null,
      customerName: v.customer?.company || v.customer?.name || null,
    }));
  }

  findAll() {
    return this.prisma.taxRenewal.findMany({
      where: vehicleTypeWhereForRenewal(),
      orderBy: [{ paymentDate: 'asc' }, { taxExpiryDate: 'asc' }],
      include: { customer: { select: { id: true, name: true, company: true } } },
    });
  }

  // เติมวันที่/ติ๊กทีหลังจากหน้ารายการ - ตั้ง paymentDate ครั้งแรกคือจุดที่ snapshot ยอดเงิน
  async update(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.taxRenewal.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException({ error: 'ไม่พบงานต่อภาษีนี้' });
    assertVehicleInScope(existing.vehicleType);

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

    if (receivedDate && !paymentDate) {
      throw new BadRequestException({ error: 'ต้องบันทึกวันที่ชำระภาษีก่อนรับป้ายภาษี/ใบเสร็จ' });
    }
    if (deliveredDate && !receivedDate) {
      throw new BadRequestException({ error: 'ต้องรับป้ายภาษี/ใบเสร็จก่อนคืนเอกสารให้ลูกค้า' });
    }

    // ยอดเงินคิดใหม่เมื่อวันที่ชำระหรือตัวเลือกลงขันเปลี่ยน (เงินเพิ่มผูกกับวันที่ชำระโดยตรง)
    const feesChanged =
      paymentDate?.getTime() !== existing.paymentDate?.getTime() || skipContribution !== existing.skipContribution;
    let feeData = {};
    if (paymentDate && feesChanged) {
      const info: ParsedVehicleInfo = {
        vehicleId: existing.vehicleId,
        customerId: existing.customerId,
        chassis: existing.chassis,
        engine: existing.engine,
        plateCategory: existing.plateCategory,
        plateNumber: existing.plateNumber,
        registrationProvince: existing.registrationProvince,
        vehicleType: existing.vehicleType,
        fuel: existing.fuel,
        cc: existing.cc ? Number(existing.cc) : null,
        weight: existing.weight ? Number(existing.weight) : null,
        firstRegistrationDate: existing.firstRegistrationDate,
        ownerType: existing.ownerType,
        ownerName: existing.ownerName,
        taxExpiryDate: existing.taxExpiryDate,
      };
      const tax = await this.computeTax(info, paymentDate, { inspectionConfirmed });
      const fees = calculateTaxRenewalFees(tax, { skipContribution });
      feeData = {
        inspectionRequired: tax.inspectionRequired,
        billItems: toJson(fees.billItems),
        noBillItems: toJson(fees.noBillItems),
        billTotal: fees.billTotal,
        noBillTotal: fees.noBillTotal,
        taxBreakdown: toJson(tax),
      };
    }

    return this.prisma.taxRenewal.update({
      where: { id },
      data: {
        inspectionConfirmed,
        insuranceConfirmed,
        skipContribution,
        paymentDate,
        receivedDate,
        deliveredDate,
        ...feeData,
      },
    });
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
