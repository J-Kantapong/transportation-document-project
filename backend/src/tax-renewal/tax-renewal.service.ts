import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { assertVehicleInScope, currentVehicleScope, currentWriteScope, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { bangkokToday, toDate } from '../overview/overview-calculator.js';
import { PrismaService } from '../prisma/prisma.service.js';
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

  findAll() {
    return this.prisma.taxRenewal.findMany({
      where: vehicleTypeWhereForRenewal(),
      orderBy: [{ paymentDate: 'asc' }, { taxExpiryDate: 'asc' }],
      include: { customer: { select: { id: true, name: true, company: true } } },
    });
  }

  // เจ้าของตอนคิดยอดใหม่: รถที่ลิงก์ไว้อ่านจาก VehicleOwner ปัจจุบัน (มีเรื่องเช่าซื้อครบ) ถ้ารถไม่มีเจ้าของ/ไม่ได้ลิงก์
  // ใช้ที่เก็บไว้ใน taxBreakdown.owner ตอนบันทึก - งานเก่าที่ไม่มีก็เหลือแค่ ownerType แบบเดิม (พบ 2026-09-27)
  private async ownerForRecompute(existing: {
    vehicleId: string | null;
    ownerType: RenewalOwner['ownerType'];
    taxBreakdown: unknown;
  }): Promise<RenewalOwner> {
    if (existing.vehicleId) {
      const vehicle = await this.prisma.vehicle.findUnique({
        where: { id: existing.vehicleId },
        select: { owner: { select: { ownerType: true, isHirePurchaseBusiness: true, hirerType: true } } },
      });
      if (vehicle?.owner) return ownerOf(vehicle.owner);
    }
    return (
      storedRenewalOwner(existing.taxBreakdown) ?? {
        ownerType: existing.ownerType,
        isHirePurchaseBusiness: false,
        hirerType: null,
      }
    );
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
      const owner = await this.ownerForRecompute(existing);
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
        cc: positiveOrNull(existing.cc),
        weight: positiveOrNull(existing.weight),
        firstRegistrationDate: existing.firstRegistrationDate,
        ...owner,
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
        taxBreakdown: toJson({ ...tax, owner }),
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
