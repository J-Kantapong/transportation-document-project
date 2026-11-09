import { describe, expect, it, vi } from 'vitest';
import { GovTaxFuelGroup, GovTaxVehicleFamily, OwnerType } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { classifyVehicleFamily } from '../tax/government-tax-reference-data.js';
import { TaxService } from '../tax/tax.service.js';
import { isTransportType, TRANSPORT_VEHICLE_TYPES, VEHICLE_TYPES } from '../vehicles/vehicle-reference-data.js';
import { calculateTaxRenewalFees, contributionAmountFor, vehicleClassOf } from './tax-renewal-fee.js';
import { TaxRenewalService } from './tax-renewal.service.js';
import {
  calculateVehicleTax,
  requiresInspection,
  resolveTaxMethod,
  VehicleTaxInput,
  VehicleTaxInputError,
  VehicleTaxResult,
  VehicleTaxRuleSet,
} from './vehicle-tax-calculator.js';

// รถตาม พ.ร.บ.การขนส่งทางบก (ผู้ใช้ 2026-11-09, งานต่อภาษีรถใหญ่): บัญชีอัตราภาษีรถตามมาตรา 85 คิดจาก "น้ำหนักรถ" แยกคอลัมน์
// ตามประเภทใบอนุญาตขนส่ง ไม่คูณ 2 นิติบุคคล ไม่มีส่วนลดอายุรถ ตรวจสภาพรถทุกครั้งก่อนต่อภาษี (ค่าตรวจ 1,000 + ลงขัน 100 = No Bill)
// ใบเสร็จจริง: HINO 6 ล้อ รถบรรทุกส่วนบุคคล น้ำหนักรถ 7,800 กก. (น้ำหนักรวม 12,000) จด 21 ม.ค. 2548 เจ้าของ บมจ. = ภาษี 3,600

const BOUNDS: Array<number | null> = [500, 750, 1000, 1250, 1500, 1750, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 6000, 7000, null];
const PRIVATE = [150, 300, 450, 800, 1000, 1300, 1600, 1900, 2200, 2400, 2600, 2800, 3000, 3200, 3400, 3600];
const NON_FIXED = [450, 600, 750, 900, 1050, 1350, 1650, 1950, 2250, 2550, 2850, 3150, 3450, 3750, 4050, 4350];

// ตาราง ขส. เฉพาะ 2 คอลัมน์ที่เทสใช้ (ประจำทาง/รถขนาดเล็กเว้นไว้ = ยังไม่มีอัตราที่ยืนยัน)
function transportRules(): VehicleTaxRuleSet {
  const weightBrackets: VehicleTaxRuleSet['weightBrackets'] = [];
  BOUNDS.forEach((weightTo, i) => {
    const weightFrom = i === 0 ? 0 : (BOUNDS[i - 1] as number);
    weightBrackets.push({ vehicleFamily: GovTaxVehicleFamily.TRANSPORT_PRIVATE, fuelGroup: null, weightFrom, weightTo, amount: PRIVATE[i] });
    weightBrackets.push({ vehicleFamily: GovTaxVehicleFamily.TRANSPORT_NON_FIXED, fuelGroup: null, weightFrom, weightTo, amount: NON_FIXED[i] });
  });
  return { ccBrackets: [], weightBrackets, evIncentives: [], motorcycleFlat: [], fuelPolicies: [] };
}

const JURISTIC = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: false, hirerType: null };

// HINO จด 21 ม.ค. 2548 ครบกำหนด 21 ม.ค. 2566 ชำระวันที่ 10 ม.ค. 2566 (ก่อนครบกำหนด)
function hino(overrides: Partial<VehicleTaxInput> = {}): VehicleTaxInput {
  return {
    vehicleType: 'ขส.-ส่วนบุคคล',
    fuel: 'ดีเซล',
    engineCc: null,
    vehicleWeightKg: 7800,
    firstRegistrationDate: new Date(Date.UTC(2005, 0, 21)),
    taxExpiryDate: new Date(Date.UTC(2023, 0, 21)),
    paymentDate: new Date(Date.UTC(2023, 0, 10)),
    owner: JURISTIC,
    inspectionCertificateConfirmed: true,
    ...overrides,
  };
}

describe('ประเภทรถ ขส. (เฉพาะงานต่อภาษี)', () => {
  it('4 ประเภท ขึ้นต้น ขส.- ไม่อยู่ใน 14 ประเภทของงานจดใหม่ และ map เป็น family คนละคอลัมน์', () => {
    expect(TRANSPORT_VEHICLE_TYPES).toHaveLength(4);
    expect(VEHICLE_TYPES).toHaveLength(14);
    for (const type of TRANSPORT_VEHICLE_TYPES) {
      expect(isTransportType(type)).toBe(true);
      expect((VEHICLE_TYPES as readonly string[]).includes(type)).toBe(false);
    }
    expect(classifyVehicleFamily('ขส.-ส่วนบุคคล')).toBe(GovTaxVehicleFamily.TRANSPORT_PRIVATE);
    expect(classifyVehicleFamily('ขส.-ไม่ประจำทาง')).toBe(GovTaxVehicleFamily.TRANSPORT_NON_FIXED);
    expect(classifyVehicleFamily('ขส.-ประจำทาง')).toBe(GovTaxVehicleFamily.TRANSPORT_FIXED);
    expect(classifyVehicleFamily('ขส.-รถขนาดเล็ก')).toBe(GovTaxVehicleFamily.TRANSPORT_SMALL);
    expect(classifyVehicleFamily('ขส.-รถพ่วง')).toBeNull();
    expect(isTransportType('รย.3-กระบะบรรทุก')).toBe(false);
  });

  it('นับเป็นรถยนต์ (ไม่ใช่มอเตอร์ไซค์) แต่คลาสค่าใช้จ่ายเป็น TRANSPORT ลงขัน 100', () => {
    expect(vehicleClassOf('ขส.-ส่วนบุคคล')).toBe('TRANSPORT');
    expect(vehicleClassOf('รย.3-กระบะบรรทุก')).toBe('CAR');
    expect(contributionAmountFor('TRANSPORT')).toBe(100);
  });
});

describe('ภาษีรถ ขส. (บัญชีอัตราภาษีรถตามมาตรา 85)', () => {
  it('ทุกคอลัมน์ใช้ WEIGHT_TRANSPORT / รหัส ขส.', () => {
    for (const family of [
      GovTaxVehicleFamily.TRANSPORT_PRIVATE,
      GovTaxVehicleFamily.TRANSPORT_NON_FIXED,
      GovTaxVehicleFamily.TRANSPORT_FIXED,
      GovTaxVehicleFamily.TRANSPORT_SMALL,
    ]) {
      expect(resolveTaxMethod(family, GovTaxFuelGroup.ICE)).toBe('WEIGHT_TRANSPORT');
    }
    const result = calculateVehicleTax(hino(), transportRules());
    expect(result.taxMethod).toBe('WEIGHT_TRANSPORT');
    expect(result.registrationCode).toBe('ขส.');
  });

  it('ใบเสร็จจริง: ส่วนบุคคล 7,800 กก. นิติบุคคล อายุ 18 ปี = 3,600 (ไม่คูณ 2 ไม่ลดอายุ)', () => {
    const result = calculateVehicleTax(hino(), transportRules());
    expect(result.baseTax).toBe(3600);
    expect(result.companyMultiplier).toBe(1);
    expect(result.ageDiscountRate).toBe(0);
    expect(result.annualVehicleTax).toBe(3600);
    expect(result.lateFee).toBe(0);
  });

  it.each([
    [7000, 3400],
    [7001, 3600],
    [500, 150],
    [501, 300],
    [12000, 3600],
  ])('ขอบช่วงน้ำหนัก %d กก. -> %d', (weight, expected) => {
    expect(calculateVehicleTax(hino({ vehicleWeightKg: weight }), transportRules()).annualVehicleTax).toBe(expected);
  });

  it('คอลัมน์ไม่ประจำทางใช้ตัวเลขของตัวเอง (7,800 กก. = 4,350)', () => {
    expect(calculateVehicleTax(hino({ vehicleType: 'ขส.-ไม่ประจำทาง' }), transportRules()).annualVehicleTax).toBe(4350);
  });

  it('คอลัมน์ที่ยังไม่มีอัตรายืนยัน -> คำนวณไม่ได้ (ไม่ใช่ 0 บาท)', () => {
    expect(() => calculateVehicleTax(hino({ vehicleType: 'ขส.-ประจำทาง' }), transportRules())).toThrow(VehicleTaxInputError);
  });

  it('ไม่มีน้ำหนักรถ -> error แม้มี cc', () => {
    expect(() => calculateVehicleTax(hino({ vehicleWeightKg: null, engineCc: 7684 }), transportRules())).toThrow(
      'กรุณาระบุน้ำหนักรถที่ถูกต้อง',
    );
  });

  it('ต้องตรวจสภาพทุกปี และ warning เมื่อยังไม่มีวันที่ตรวจ', () => {
    expect(requiresInspection('ขส.', 1, 0)).toBe(true);
    expect(requiresInspection('รย.1', 1, 0)).toBe(false);
    const result = calculateVehicleTax(hino({ inspectionCertificateConfirmed: false }), transportRules());
    expect(result.inspectionRequired).toBe(true);
    expect(result.warnings).toContain('รถตาม พ.ร.บ.ขนส่งต้องตรวจสภาพรถก่อนต่อภาษี - ยังไม่ได้บันทึกวันที่ตรวจสภาพรถ');
    expect(calculateVehicleTax(hino(), transportRules()).warnings).toEqual([]);
  });
});

describe('ค่าใช้จ่ายงานต่อภาษี ขส.', () => {
  const tax = (overrides: Partial<VehicleTaxResult> = {}) =>
    ({ vehicleType: 'ขส.-ส่วนบุคคล', annualVehicleTax: 3600, lateFee: 0, taxCycleCount: 1, ...overrides }) as VehicleTaxResult;

  it('No Bill = ค่าตรวจสภาพรถ 1,000 + ลงขัน 100 / Bill = ภาษี 3,600', () => {
    const fees = calculateTaxRenewalFees(tax(), { skipContribution: false });
    expect(fees.billItems).toEqual([{ label: 'ภาษีรถประจำปี', amount: 3600 }]);
    expect(fees.noBillItems).toEqual([
      { label: 'ค่าตรวจสภาพรถ', amount: 1000 },
      { label: 'ลงขัน', amount: 100 },
    ]);
    expect(fees.noBillTotal).toBe(1100);
    expect(fees.total).toBe(4700);
  });

  it('ติ๊กไม่มีค่าลงขัน -> เหลือค่าตรวจสภาพรถ', () => {
    const fees = calculateTaxRenewalFees(tax(), { skipContribution: true });
    expect(fees.noBillItems).toEqual([{ label: 'ค่าตรวจสภาพรถ', amount: 1000 }]);
  });

  it('รถเล็กไม่มีบรรทัดค่าตรวจสภาพรถ', () => {
    const fees = calculateTaxRenewalFees(tax({ vehicleType: 'รย.1-เก๋ง 2 ตอน', annualVehicleTax: 2900 }), { skipContribution: false });
    expect(fees.noBillItems).toEqual([{ label: 'ลงขัน', amount: 20 }]);
  });
});

// ---- service: ขั้นตรวจสภาพรถ (วันที่ตรวจ) ---------------------------------------------------------------------

function decimal(value: number) {
  return { toString: () => String(value), valueOf: () => value, toFixed: () => value.toFixed(2), isFinite: () => true };
}

const UPDATED_AT = new Date('2026-01-05T05:00:00.000Z');

function transportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    vehicleId: null,
    customerId: 'c1',
    chassis: 'FG1JPPA-11785',
    engine: null,
    plateCategory: '96',
    plateNumber: '6433',
    registrationProvince: null,
    vehicleType: 'ขส.-ส่วนบุคคล',
    fuel: 'ดีเซล',
    cc: null,
    weight: decimal(7800),
    firstRegistrationDate: new Date('2005-01-21T00:00:00.000Z'),
    ownerType: OwnerType.JURISTIC,
    ownerName: null,
    taxExpiryDate: new Date('2026-01-21T00:00:00.000Z'),
    inspectionRequired: true,
    inspectionConfirmed: false,
    inspectionDate: null,
    insuranceConfirmed: false,
    paymentDate: null,
    skipContribution: false,
    taxBreakdown: { owner: JURISTIC },
    receivedDate: null,
    deliveredDate: null,
    cancelledAt: null,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}

function setup(renewal: unknown = transportRow()) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
  const update = vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
  const renewalFindMany = vi.fn().mockResolvedValue([]);
  const auditCreate = vi.fn().mockResolvedValue({ id: 'audit1' });
  const prisma = {
    $transaction: vi.fn(),
    vehicle: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    customer: { findUnique: vi.fn().mockResolvedValue({ id: 'c1' }) },
    taxRenewal: { create, update, findUnique: vi.fn().mockResolvedValue(renewal), findMany: renewalFindMany },
    auditLog: { create: auditCreate },
    receiptImage: { count: vi.fn().mockResolvedValue(1) },
    deliverySlipItem: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const taxService = { loadRuleSet: vi.fn().mockResolvedValue(transportRules()) } as unknown as TaxService;
  const svc = new TaxRenewalService(
    prisma as unknown as PrismaService,
    taxService,
    { put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) },
    { source: 'NONE', extract: vi.fn().mockResolvedValue(null) },
  );
  return { svc, create, update, auditCreate, renewalFindMany };
}

const transportBody = {
  customerId: 'c1',
  chassis: 'FG1JPPA-11785',
  plateCategory: '96',
  plateNumber: '6433',
  vehicleType: 'ขส.-ส่วนบุคคล',
  fuel: 'ดีเซล',
  weight: '7800',
  firstRegistrationDate: '2005-01-21',
  ownerType: 'JURISTIC',
  taxExpiryDate: '2026-01-21',
  submitDate: '2026-01-05',
};

const INSPECTION_REQUIRED = 'รถตาม พ.ร.บ.ขนส่งต้องบันทึกวันที่ตรวจสภาพรถก่อนบันทึกวันที่ชำระภาษี';

describe('TaxRenewalService - รถตาม พ.ร.บ.ขนส่ง (ขส.)', () => {
  it('preview: ภาษี 3,600 ไม่คูณ 2 + No Bill ค่าตรวจ 1,000 และลงขัน 100 / ยังไม่มีวันที่ตรวจ = warning', async () => {
    const { svc } = setup();
    const { tax, fees } = await svc.preview({ ...transportBody, paymentDate: '2026-01-10' });
    expect(tax.annualVehicleTax).toBe(3600);
    expect(tax.companyMultiplier).toBe(1);
    expect(tax.inspectionRequired).toBe(true);
    expect(tax.warnings).toContain('รถตาม พ.ร.บ.ขนส่งต้องตรวจสภาพรถก่อนต่อภาษี - ยังไม่ได้บันทึกวันที่ตรวจสภาพรถ');
    expect(fees.billTotal).toBe(3600);
    expect(fees.noBillItems).toEqual([
      { label: 'ค่าตรวจสภาพรถ', amount: 1000 },
      { label: 'ลงขัน', amount: 100 },
    ]);
  });

  it('บันทึกพร้อมวันที่ชำระแต่ไม่มีวันที่ตรวจ -> 400', async () => {
    const { svc, create } = setup();
    await expect(svc.create({ ...transportBody, paymentDate: '2026-01-10' })).rejects.toMatchObject({
      response: { error: INSPECTION_REQUIRED },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('บันทึกพร้อมวันที่ตรวจและวันที่ชำระ: เก็บวันที่ตรวจ ติ๊กตรวจแล้วให้เอง snapshot ยอด 3,600 / 1,100', async () => {
    const { svc, create } = setup();
    await svc.create({ ...transportBody, inspectionDate: '2026-01-08', paymentDate: '2026-01-10' });
    const { data } = create.mock.calls[0][0];
    expect(data.inspectionDate).toEqual(new Date('2026-01-08T00:00:00.000Z'));
    expect(data.inspectionRequired).toBe(true);
    expect(data.inspectionConfirmed).toBe(true);
    expect(data.billTotal).toBe(3600);
    expect(data.noBillTotal).toBe(1100);
  });

  it('วันที่ตรวจหลังวันที่ชำระ -> 400', async () => {
    const { svc } = setup();
    await expect(svc.create({ ...transportBody, inspectionDate: '2026-01-12', paymentDate: '2026-01-10' })).rejects.toMatchObject({
      response: { error: 'วันที่ตรวจสภาพรถต้องไม่หลังวันที่ชำระภาษี' },
    });
  });

  it('บันทึกยังไม่ตรวจ ไม่ชำระ ได้ (กรอกทีหลังในตาราง) - ติ๊กตรวจเป็น false แม้ส่ง inspectionConfirmed มา', async () => {
    const { svc, create } = setup();
    await svc.create({ ...transportBody, inspectionConfirmed: true });
    const { data } = create.mock.calls[0][0];
    expect(data.inspectionDate).toBeNull();
    expect(data.inspectionConfirmed).toBe(false);
    expect(data.paymentDate).toBeNull();
    expect(data.billTotal).toBeUndefined();
  });

  it('รถเล็กส่งวันที่ตรวจมา -> 400 (ใช้ติ๊ก ตรอ. แทน)', async () => {
    const { svc } = setup();
    const carBody = { ...transportBody, vehicleType: 'รย.3-กระบะบรรทุก', ownerType: 'INDIVIDUAL', weight: '1800' };
    await expect(svc.create({ ...carBody, inspectionDate: '2026-01-08' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ใช้กับรถตาม พ.ร.บ.ขนส่ง') },
    });
  });

  it('ตาราง: ใส่วันที่ชำระก่อนวันที่ตรวจ -> 400 / ใส่วันที่ตรวจครั้งแรก = งานปกติ ไม่ต้องมีเหตุผล และติ๊กตรวจแล้วให้', async () => {
    const { svc, update, auditCreate } = setup();
    await expect(svc.update('r1', { paymentDate: '2026-01-10' })).rejects.toMatchObject({ response: { error: INSPECTION_REQUIRED } });
    await svc.update('r1', { inspectionDate: '2026-01-08' });
    const { data, where } = update.mock.calls[0][0];
    expect(data.inspectionDate).toEqual(new Date('2026-01-08T00:00:00.000Z'));
    expect(data.inspectionConfirmed).toBe(true);
    expect(where).toMatchObject({ id: 'r1', cancelledAt: null, inspectionDate: null, paymentDate: null });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('ตาราง: มีวันที่ตรวจแล้ว ใส่วันที่ชำระ -> คิดยอด 3,600 / 1,100', async () => {
    const { svc, update } = setup(transportRow({ inspectionDate: new Date('2026-01-08T00:00:00.000Z'), inspectionConfirmed: true }));
    await svc.update('r1', { paymentDate: '2026-01-10' });
    const { data } = update.mock.calls[0][0];
    expect(data.billTotal).toBe(3600);
    expect(data.noBillTotal).toBe(1100);
    expect(data.noBillItems).toEqual([
      { label: 'ค่าตรวจสภาพรถ', amount: 1000 },
      { label: 'ลงขัน', amount: 100 },
    ]);
  });

  it('แก้วันที่ตรวจที่มีแล้วต้องมีเหตุผล และบันทึกประวัติ', async () => {
    const { svc, update, auditCreate } = setup(transportRow({ inspectionDate: new Date('2026-01-08T00:00:00.000Z'), inspectionConfirmed: true }));
    await expect(svc.update('r1', { inspectionDate: '2026-01-07' })).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่แก้งานต่อภาษี' },
    });
    await svc.update('r1', { inspectionDate: '2026-01-07', remark: 'พิมพ์วันที่ผิด' });
    expect(update.mock.calls[0][0].data.inspectionDate).toEqual(new Date('2026-01-07T00:00:00.000Z'));
    expect(auditCreate.mock.calls[0][0].data.changes).toHaveProperty('inspectionDate');
  });

  it('ล้างวันที่ตรวจของงานที่ชำระแล้วโดยไม่ล้างวันที่ชำระ -> 400', async () => {
    const { svc } = setup(
      transportRow({
        inspectionDate: new Date('2026-01-08T00:00:00.000Z'),
        inspectionConfirmed: true,
        paymentDate: new Date('2026-01-10T00:00:00.000Z'),
      }),
    );
    await expect(svc.update('r1', { inspectionDate: null, remark: 'ยังไม่ได้ตรวจ' })).rejects.toMatchObject({
      response: { error: INSPECTION_REQUIRED },
    });
  });

  it('รายการ: vehicleClass TRANSPORT', async () => {
    const { svc, renewalFindMany } = setup();
    renewalFindMany.mockResolvedValue([{ ...transportRow(), vehicle: null, customer: null, receipts: [] }]);
    const rows = await svc.findAll();
    expect(rows[0].vehicleClass).toBe('TRANSPORT');
    expect(rows[0].inspectionDate).toBeNull();
  });
});
