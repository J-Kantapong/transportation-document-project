import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { GovTaxRuleStatus } from '../generated/prisma/enums.js';
import {
  calculateGovernmentTax,
  GovernmentTaxOwnerInput,
  GovernmentTaxResult,
  GovernmentTaxRuleSet,
  GovernmentTaxVehicleInput,
} from './government-tax-calculator.js';
import { TaxPreviewDto } from './dto/tax-preview.dto.js';
import { parseTaxPreviewInput } from './tax-validation.js';

// เหตุผลที่คำนวณไม่ได้ (GovernmentTaxResult.reason) แยกเป็น 2 สถานะ: ข้อมูลรถ/เจ้าของไม่ครบ
// (MISSING_INPUT) กับยังไม่มีอัตราที่ยืนยันแล้วในระบบ (MISSING_VERIFIED_RULE) - ดู reason string
// ทั้งหมดใน government-tax-calculator.ts, ทุกอันที่พูดถึง "ตารางอัตรา"/"อัตราภาษี" คือกรณีหลัง
function deriveStatus(result: GovernmentTaxResult): 'CALCULATED' | 'MISSING_INPUT' | 'MISSING_VERIFIED_RULE' {
  if (result.reason === null) return 'CALCULATED';
  if (result.reason.includes('ตารางอัตรา') || result.reason.includes('อัตราภาษี')) return 'MISSING_VERIFIED_RULE';
  return 'MISSING_INPUT';
}

@Injectable()
export class TaxService {
  constructor(private readonly prisma: PrismaService) {}

  // Prisma.Decimal ไม่ใช่ string | number โดยตรง - แปลงเป็น string ตรงนี้ทีเดียว (ไม่ให้
  // government-tax-calculator.ts ต้องรู้จัก Prisma.Decimal) toNumber()/toMicroBaht() ใน
  // calculator รับ string ได้อยู่แล้ว
  private async loadRuleSet(): Promise<GovernmentTaxRuleSet> {
    const verified = { active: true, status: GovTaxRuleStatus.VERIFIED } as const;
    const [ccBrackets, weightBrackets, evIncentives, motorcycleFlat] = await Promise.all([
      this.prisma.governmentTaxCcBracket.findMany({ where: verified }),
      this.prisma.governmentTaxWeightBracket.findMany({ where: verified }),
      this.prisma.governmentTaxEvIncentive.findMany({ where: verified }),
      this.prisma.governmentTaxMotorcycleFlat.findMany({ where: verified }),
    ]);
    return {
      ccBrackets: ccBrackets.map((r) => ({ fuelGroup: r.fuelGroup, ccFrom: r.ccFrom.toString(), ccTo: r.ccTo?.toString() ?? null, ratePerCc: r.ratePerCc.toString() })),
      weightBrackets: weightBrackets.map((r) => ({
        vehicleFamily: r.vehicleFamily,
        fuelGroup: r.fuelGroup,
        weightFrom: r.weightFrom.toString(),
        weightTo: r.weightTo?.toString() ?? null,
        amount: r.amount?.toString() ?? null,
      })),
      evIncentives: evIncentives.map((r) => ({ effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo, discountPercent: r.discountPercent?.toString() ?? null })),
      motorcycleFlat: motorcycleFlat.map((r) => ({ fuelGroup: r.fuelGroup, amount: r.amount?.toString() ?? null })),
    };
  }

  async preview(dto: TaxPreviewDto): Promise<GovernmentTaxResult & { status: string }> {
    const { vehicle, owner } = parseTaxPreviewInput(dto);
    const rules = await this.loadRuleSet();
    const result = calculateGovernmentTax(vehicle, owner, rules);
    return { ...result, status: deriveStatus(result) };
  }

  // เรียกหลังบันทึก ownerId/isFactoryNew/firstRegistrationDate ของรถแล้ว (PATCH /api/vehicles/:id/tax-input)
  // สร้าง TaxCalculation แถวใหม่เสมอ (immutable snapshot) ไม่ update ของเดิม
  async calculateAndSave(vehicleId: string) {
    const vehicleRow = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, include: { owner: true } });
    if (!vehicleRow) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });

    const vehicleInput: GovernmentTaxVehicleInput = {
      body: vehicleRow.body,
      fuel: vehicleRow.fuel,
      cc: vehicleRow.cc?.toString() ?? null,
      weight: vehicleRow.weight?.toString() ?? null,
      firstRegistrationDate: vehicleRow.firstRegistrationDate,
    };
    const ownerInput: GovernmentTaxOwnerInput | null = vehicleRow.owner
      ? {
          ownerType: vehicleRow.owner.ownerType,
          isHirePurchaseBusiness: vehicleRow.owner.isHirePurchaseBusiness,
          hirerType: vehicleRow.owner.hirerType,
        }
      : null;

    const rules = await this.loadRuleSet();
    const result = calculateGovernmentTax(vehicleInput, ownerInput, rules);
    const status = deriveStatus(result);

    const snapshot = await this.prisma.taxCalculation.create({
      data: {
        vehicleId,
        status,
        vehicleFamily: result.vehicleFamily,
        fuelGroup: result.fuelGroup,
        baseAmount: result.baseAmount,
        incentiveDiscountPercent: result.discountPercent,
        juristicMultiplier: result.juristicMultiplier,
        finalAmount: result.amount,
        reason: result.reason,
        // JSON.parse(JSON.stringify(...)) - แปลงเป็น plain JSON value ตรงๆ (ตัด Date/interface
        // typing ทิ้ง) เพราะ Prisma.Json ต้องการ InputJsonValue ไม่ใช่ TS interface ที่มี typed fields
        inputSnapshot: JSON.parse(
          JSON.stringify({
            vehicle: { ...vehicleInput, firstRegistrationDate: vehicleInput.firstRegistrationDate?.toISOString() ?? null },
            owner: ownerInput,
            isFactoryNew: vehicleRow.isFactoryNew,
          }),
        ),
        breakdown: JSON.parse(JSON.stringify(result)),
      },
    });

    return snapshot;
  }

  async listForVehicle(vehicleId: string) {
    const vehicle = await this.prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { id: true } });
    if (!vehicle) throw new NotFoundException({ error: 'ไม่พบข้อมูลรถ' });
    return this.prisma.taxCalculation.findMany({ where: { vehicleId }, orderBy: { createdAt: 'desc' } });
  }
}
