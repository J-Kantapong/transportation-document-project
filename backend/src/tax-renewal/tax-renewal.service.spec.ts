import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { GovTaxFuelGroup, OwnerType, type UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';
import { TaxRenewalService } from './tax-renewal.service.js';
import type { VehicleTaxRuleSet } from './vehicle-tax-calculator.js';

// Prisma.Decimal เป็น object (truthy เสมอ แม้ค่าเป็น 0) - จำลองแบบนั้นเพื่อจับการเช็ค cc/น้ำหนักด้วย truthiness
function decimal(value: number) {
  return { toString: () => String(value), valueOf: () => value };
}

// อัตรา CC ตามแถว VERIFIED ใน seed: 1,598 cc บุคคลธรรมดา = 300 + 998 x 1.5 = 1,797 บาท
function rules(): VehicleTaxRuleSet {
  return {
    ccBrackets: [GovTaxFuelGroup.ICE, GovTaxFuelGroup.HEV, GovTaxFuelGroup.PHEV].flatMap((fuelGroup) => [
      { fuelGroup, ccFrom: 0, ccTo: 600, ratePerCc: 0.5 },
      { fuelGroup, ccFrom: 600, ccTo: 1800, ratePerCc: 1.5 },
      { fuelGroup, ccFrom: 1800, ccTo: null, ratePerCc: 4 },
    ]),
    weightBrackets: [],
    evIncentives: [],
    motorcycleFlat: [],
    fuelPolicies: [],
  };
}

const FINANCED_INDIVIDUAL = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: true, hirerType: OwnerType.INDIVIDUAL };
const FINANCED_JURISTIC = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: true, hirerType: OwnerType.JURISTIC };
const JURISTIC = { ownerType: OwnerType.JURISTIC, isHirePurchaseBusiness: false, hirerType: null };

// รถ รย.1 ที่บันทึกตอนเพิ่มข้อมูลรถแบบติดไฟแนนซ์ (VehiclesService.ownerDataFor)
function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    customerId: 'c1',
    chassis: 'MR0FZ29G001234567',
    engine: '2AZ1234567',
    plateCategory: '1กก',
    plateNumber: '1234',
    registrationProvince: 'กรุงเทพมหานคร',
    body: 'รย.1-เก๋ง 2 ตอน',
    fuel: 'เบนซิน',
    cc: decimal(1598),
    weight: null,
    firstRegistrationDate: new Date('2026-01-10T00:00:00.000Z'),
    owner: { name: 'ไฟแนนซ์ A', hirerName: 'สมชาย', ...FINANCED_INDIVIDUAL },
    ...overrides,
  };
}

function renewalRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    vehicleId: null,
    customerId: null,
    chassis: 'MR0FZ29G001234567',
    engine: null,
    plateCategory: '1กก',
    plateNumber: '1234',
    registrationProvince: null,
    vehicleType: 'รย.1-เก๋ง 2 ตอน',
    fuel: 'เบนซิน',
    cc: decimal(1598),
    weight: null,
    firstRegistrationDate: new Date('2026-01-10T00:00:00.000Z'),
    ownerType: OwnerType.JURISTIC,
    ownerName: null,
    taxExpiryDate: new Date('2026-12-31T00:00:00.000Z'),
    inspectionRequired: false,
    inspectionConfirmed: false,
    insuranceConfirmed: false,
    paymentDate: null,
    skipContribution: false,
    taxBreakdown: null,
    receivedDate: null,
    deliveredDate: null,
    ...overrides,
  };
}

function setup({ vehicle = vehicleRow(), renewal = renewalRow() }: { vehicle?: unknown; renewal?: unknown } = {}) {
  const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
  const update = vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
  const vehicleFindUnique = vi.fn().mockResolvedValue(vehicle);
  const vehicleFindMany = vi.fn().mockResolvedValue(vehicle ? [vehicle] : []);
  const prisma = {
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(vehicle),
      findUnique: vehicleFindUnique,
      findMany: vehicleFindMany,
    },
    taxRenewal: { create, update, findUnique: vi.fn().mockResolvedValue(renewal) },
  } as unknown as PrismaService;
  const taxService = { loadRuleSet: vi.fn().mockResolvedValue(rules()) } as unknown as TaxService;
  return { svc: new TaxRenewalService(prisma, taxService), create, update, vehicleFindUnique, vehicleFindMany };
}

const linkedBody = { vehicleId: 'v1', taxExpiryDate: '2026-12-31', paymentDate: '2026-12-01' };
const manualBody = {
  chassis: 'MR0FZ29G001234567',
  plateCategory: '1กก',
  plateNumber: '1234',
  vehicleType: 'รย.1-เก๋ง 2 ตอน',
  fuel: 'เบนซิน',
  cc: '1598',
  firstRegistrationDate: '2026-01-10',
  taxExpiryDate: '2026-12-31',
  paymentDate: '2026-12-01',
};

// พบ 2026-09-27: ต่อภาษีเคยส่ง isHirePurchaseBusiness: false, hirerType: null ตายตัว รถติดไฟแนนซ์ที่ผู้เช่าซื้อเป็น
// บุคคลธรรมดาจึงโดนคูณสองแบบนิติบุคคล ทั้งที่ขั้นยื่นเอกสาร (ขั้นที่ 4) คิดตัวคูณ 1
describe('TaxRenewalService - รถติดไฟแนนซ์ (เช่าซื้อ)', () => {
  it('รถในระบบ รย.1 ติดไฟแนนซ์ ผู้เช่าซื้อบุคคลธรรมดา -> ตัวคูณ 1 ไม่คิดภาษีสองเท่า', async () => {
    const { svc } = setup();
    const { tax } = await svc.preview(linkedBody);
    expect(tax.companyMultiplier).toBe(1);
    expect(tax.baseTax).toBe(1797);
    expect(tax.annualVehicleTax).toBe(1797);
  });

  it('รถในระบบ ติดไฟแนนซ์ ผู้เช่าซื้อเป็นนิติบุคคล -> ยังคูณสอง', async () => {
    const { svc } = setup({ vehicle: vehicleRow({ owner: { name: 'ไฟแนนซ์ A', hirerName: 'บริษัท ข', ...FINANCED_JURISTIC } }) });
    const { tax } = await svc.preview(linkedBody);
    expect(tax.companyMultiplier).toBe(2);
    expect(tax.annualVehicleTax).toBe(3594);
  });

  it('บันทึกงาน: ไม่ส่งค่าเช่าซื้อเป็นคอลัมน์ (TaxRenewal ไม่มี) แต่เก็บไว้ใน taxBreakdown.owner', async () => {
    const { svc, create } = setup();
    await svc.create({ ...linkedBody, submitDate: '2026-12-01' });
    const data = create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('isHirePurchaseBusiness');
    expect(data).not.toHaveProperty('hirerType');
    expect(data.ownerType).toBe(OwnerType.JURISTIC);
    expect(Number(data.billTotal)).toBe(1797);
    expect(data.taxBreakdown.companyMultiplier).toBe(1);
    expect(data.taxBreakdown.owner).toEqual(FINANCED_INDIVIDUAL);
  });

  it('บันทึกงานที่ยังไม่ชำระ: ยังไม่มียอดเงิน แต่เก็บเจ้าของไว้ใช้คิดตอนใส่วันที่ชำระ', async () => {
    const { svc, create } = setup({ vehicle: null });
    await svc.create({ ...manualBody, ownerType: 'INDIVIDUAL', financed: true, paymentDate: null, submitDate: '2026-12-01' });
    const data = create.mock.calls[0][0].data;
    expect(data.billTotal).toBeUndefined();
    expect(data.taxBreakdown).toEqual({ owner: FINANCED_INDIVIDUAL });
  });

  it.each([
    ['INDIVIDUAL', 1],
    ['JURISTIC', 2],
  ])('กรอกรถเอง ติ๊กติดไฟแนนซ์ ผู้เช่าซื้อ %s -> ตัวคูณ %i', async (ownerType, multiplier) => {
    const { svc } = setup({ vehicle: null });
    const { tax } = await svc.preview({ ...manualBody, ownerType, financed: true });
    expect(tax.companyMultiplier).toBe(multiplier);
  });

  it('ใส่วันที่ชำระทีหลัง (รถในระบบ): อ่านเจ้าของจาก Vehicle ใหม่ ไม่คิดสองเท่า', async () => {
    const { svc, update, vehicleFindUnique } = setup({ renewal: renewalRow({ vehicleId: 'v1' }) });
    await svc.update('r1', { paymentDate: '2026-12-01' });
    expect(vehicleFindUnique).toHaveBeenCalled();
    const data = update.mock.calls[0][0].data;
    expect(data.taxBreakdown.companyMultiplier).toBe(1);
    expect(Number(data.billTotal)).toBe(1797);
  });

  it('ใส่วันที่ชำระทีหลัง (กรอกเอง): ใช้เจ้าของที่เก็บไว้ใน taxBreakdown.owner', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: renewalRow({ taxBreakdown: { owner: FINANCED_INDIVIDUAL } }) });
    await svc.update('r1', { paymentDate: '2026-12-01' });
    const data = update.mock.calls[0][0].data;
    expect(data.taxBreakdown.companyMultiplier).toBe(1);
    expect(data.taxBreakdown.owner).toEqual(FINANCED_INDIVIDUAL);
  });

  it('งานเก่าที่ไม่มี taxBreakdown.owner: ใช้ ownerType ของงานแบบเดิม', async () => {
    const { svc, update } = setup({ vehicle: null });
    await svc.update('r1', { paymentDate: '2026-12-01' });
    const data = update.mock.calls[0][0].data;
    expect(data.taxBreakdown.companyMultiplier).toBe(2);
    expect(data.taxBreakdown.owner).toEqual(JURISTIC);
  });
});

// พบ 2026-09-27: Decimal(0) เป็น truthy - cc 0 ในฐานข้อมูลเคยถูกใช้เป็นค่าจริงและไม่เปิดช่องให้กรอก
describe('TaxRenewalService - cc/น้ำหนัก 0 ถือว่ายังไม่มีข้อมูล', () => {
  it('ค้นรถ: cc 0 ส่งกลับเป็น null ให้หน้าเว็บเปิดช่องกรอก', async () => {
    const { svc } = setup({ vehicle: vehicleRow({ cc: decimal(0) }) });
    const [hit] = await svc.searchVehicles('1234');
    expect(hit.cc).toBeNull();
  });

  it('รถในระบบ cc 0: ใช้ค่าที่พนักงานกรอกเสริม', async () => {
    const { svc } = setup({ vehicle: vehicleRow({ cc: decimal(0) }) });
    const { tax } = await svc.preview({ ...linkedBody, cc: '1598' });
    expect(tax.engineCc).toBe(1598);
    expect(tax.baseTax).toBe(1797);
  });

  it('รถในระบบ cc 0 และไม่ได้กรอกเสริม -> 400 ไม่คิดภาษี 0 บาท', async () => {
    const { svc } = setup({ vehicle: vehicleRow({ cc: decimal(0) }) });
    await expect(svc.preview(linkedBody)).rejects.toMatchObject({
      response: { error: 'กรุณาระบุความจุเครื่องยนต์ที่ถูกต้อง' },
    });
  });
});

// พบ 2026-09-27: ไม่ใส่วันที่ชำระเคยใช้ new Date() (เวลาปัจจุบัน) วันครบกำหนดพอดีจึงโดนเงินเพิ่ม 1 เดือน
describe('TaxRenewalService - ไม่ใส่วันที่ชำระ = คิด ณ วันนี้ตามเวลาไทย', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('ครบกำหนดวันนี้ (10:00 น. เวลาไทย) -> ไม่ล่าช้า', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-27T03:00:00.000Z'));
    const { svc } = setup();
    const { tax } = await svc.preview({ ...linkedBody, taxExpiryDate: '2026-09-27', paymentDate: null });
    expect(tax.lateMonths).toBe(0);
    expect(tax.lateFee).toBe(0);
  });

  it('ตี 3 เวลาไทย (ยังเป็นเมื่อวานตาม UTC) นับเป็นวันนี้ของไทย', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T20:00:00.000Z')); // 27/09 03:00 น. เวลาไทย
    const { svc } = setup();
    const { tax } = await svc.preview({ ...linkedBody, taxExpiryDate: '2026-08-26', paymentDate: null });
    expect(tax.lateMonths).toBe(2); // 26/08 -> 27/09 เกิน 1 เดือนกับอีก 1 วัน (ถ้าใช้วันที่ UTC 26/09 จะได้แค่ 1)
  });
});

// พบ 2026-09-27: ค้นรถเคยใช้ขอบเขตการอ่าน STAFF_CAR + ACCOUNTANT จึงเห็นจักรยานยนต์ เลือกได้ แต่คิดยอด/บันทึกแล้วโดน 403
describe('TaxRenewalService - ค้นรถมาต่อภาษีใช้ขอบเขตการแก้', () => {
  const asUser = <T>(roles: UserRole[], fn: () => T) =>
    requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);
  const MOTO = 'รย.12-รถจักรยานยนต์ส่วนบุคคล';

  it.each([
    [['STAFF_CAR', 'ACCOUNTANT'], 'CAR'],
    [['STAFF_MOTO', 'ACCOUNTANT'], 'MOTO'],
    [['STAFF_CAR', 'STAFF_MOTO'], 'ALL'],
    [['ADMIN'], 'ALL'],
  ] as const)('%j ค้นได้เฉพาะรถขอบเขต %s', async (roles, scope) => {
    const { svc, vehicleFindMany } = setup();
    await asUser([...roles], () => svc.searchVehicles('1234'));
    const { where } = vehicleFindMany.mock.calls[0][0];
    expect(where.AND).toEqual(vehicleTypeWhere(scope).AND);
  });

  it('STAFF_CAR + ACCOUNTANT: ไม่ส่งจักรยานยนต์กลับมา (เงื่อนไขกรองเฉพาะรถยนต์)', async () => {
    const { svc, vehicleFindMany } = setup();
    await asUser(['STAFF_CAR', 'ACCOUNTANT'], () => svc.searchVehicles('1234'));
    const { where } = vehicleFindMany.mock.calls[0][0];
    expect(where.AND).toEqual([{ OR: [{ body: null }, { NOT: { body: { startsWith: 'รย.12-' } } }] }]);
  });

  it('รถที่เลือกด้วย id ตรงๆ ยังโดนกันตอนคิดยอด (403 ข้อความขอบเขต)', async () => {
    const { svc } = setup({ vehicle: vehicleRow({ body: MOTO }) });
    await expect(asUser(['STAFF_CAR', 'ACCOUNTANT'], () => svc.preview(linkedBody))).rejects.toMatchObject({
      response: { error: 'บัญชีของคุณดูแลเฉพาะรถยนต์ - รถคันนี้เป็นจักรยานยนต์' },
    });
  });
});
