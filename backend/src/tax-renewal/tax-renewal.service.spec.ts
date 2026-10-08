import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { Prisma } from '../generated/prisma/client.js';
import { GovTaxFuelGroup, OwnerType, type UserRole } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';
import { TaxRenewalService } from './tax-renewal.service.js';
import type { VehicleTaxRuleSet } from './vehicle-tax-calculator.js';

// Prisma.Decimal เป็น object (truthy เสมอ แม้ค่าเป็น 0) - จำลองแบบนั้นเพื่อจับการเช็ค cc/น้ำหนักด้วย truthiness
// toFixed/isFinite ให้ audit-log มองเป็น Decimal แล้วเก็บเป็นข้อความ
function decimal(value: number) {
  return { toString: () => String(value), valueOf: () => value, toFixed: () => value.toFixed(2), isFinite: () => true };
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
  const renewalFindMany = vi.fn().mockResolvedValue([]);
  const auditCreate = vi.fn().mockResolvedValue({ id: 'audit1' });
  const prisma = {
    $transaction: vi.fn(),
    vehicle: {
      findFirst: vi.fn().mockResolvedValue(vehicle),
      findUnique: vehicleFindUnique,
      findMany: vehicleFindMany,
    },
    taxRenewal: { create, update, findUnique: vi.fn().mockResolvedValue(renewal), findMany: renewalFindMany },
    auditLog: { create: auditCreate },
    receiptImage: { count: vi.fn().mockResolvedValue(1) },
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
  const taxService = { loadRuleSet: vi.fn().mockResolvedValue(rules()) } as unknown as TaxService;
  return {
    svc: new TaxRenewalService(
      prisma as unknown as PrismaService,
      taxService,
      { put: vi.fn(), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) },
      { source: 'NONE', extract: vi.fn().mockResolvedValue(null) },
    ),
    create,
    update,
    vehicleFindUnique,
    vehicleFindMany,
    renewalFindMany,
    auditCreate,
  };
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

const runAs = <T>(id: string, roles: UserRole[], fn: () => T) => requestContext.run({ user: { id, roles, customerId: null, name: 'ทดสอบ' } }, fn);

// ผู้ใช้ 2026-09-27: แก้งานต่อภาษีที่บันทึกผิดได้ ต้องมีเหตุผล + ประวัติ / ยกเลิกแบบไม่ลบแถว
describe('TaxRenewalService - แก้งานที่บันทึกผิด', () => {
  const UPDATED_AT = new Date('2026-12-01T05:00:00.000Z');
  const paidRow = (overrides: Record<string, unknown> = {}) =>
    renewalRow({
      submitDate: new Date('2026-11-30T00:00:00.000Z'),
      paymentDate: new Date('2026-12-01T00:00:00.000Z'),
      billTotal: decimal(1797),
      noBillTotal: decimal(200),
      billItems: [],
      noBillItems: [],
      taxBreakdown: { owner: FINANCED_INDIVIDUAL },
      cancelledAt: null,
      updatedAt: UPDATED_AT,
      ...overrides,
    });
  const auditData = (auditCreate: ReturnType<typeof setup>['auditCreate']) => auditCreate.mock.calls[0][0].data;

  it('ติ๊ก พ.ร.บ. / กรอกวันที่ที่ยังว่าง = งานปกติ ไม่ต้องมีเหตุผล ไม่เขียนประวัติ', async () => {
    const { svc, update, auditCreate } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { insuranceConfirmed: true });
    await svc.update('r1', { receivedDate: '2026-12-05' });
    expect(update).toHaveBeenCalledTimes(2);
    expect(update.mock.calls[0][0].where).toEqual({ id: 'r1', cancelledAt: null });
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('แก้วันที่ชำระที่มีแล้วต้องมีเหตุผล', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    await expect(svc.update('r1', { paymentDate: '2026-12-02' })).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่แก้งานต่อภาษี' },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('ล้างวันที่ชำระ: ล้างยอดเงินที่ snapshot ไว้ เหลือแค่เจ้าของ และบันทึกประวัติ', async () => {
    const { svc, update, auditCreate } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { paymentDate: null, remark: 'ยังไม่ได้ชำระจริง' });
    const { data, where } = update.mock.calls[0][0];
    expect(where).toEqual({ id: 'r1', cancelledAt: null, updatedAt: UPDATED_AT });
    expect(data.paymentDate).toBeNull();
    expect(data.billTotal).toBeNull();
    expect(data.noBillTotal).toBeNull();
    expect(data.billItems).toBe(Prisma.DbNull);
    expect(data.taxBreakdown).toEqual({ owner: FINANCED_INDIVIDUAL });
    expect(auditData(auditCreate)).toMatchObject({
      entity: 'TaxRenewal',
      action: 'update',
      remark: 'ยังไม่ได้ชำระจริง',
      changes: { paymentDate: { from: '2026-12-01', to: null }, billTotal: { from: '1797', to: null } },
    });
  });

  it('แก้วันครบกำหนดภาษีของงานที่ชำระแล้ว: คิดเงินเพิ่มและยอดเงินใหม่', async () => {
    const { svc, update, auditCreate } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { taxExpiryDate: '2026-09-30', remark: 'พิมพ์วันครบกำหนดผิด' });
    const { data } = update.mock.calls[0][0];
    expect(data.taxExpiryDate).toEqual(new Date('2026-09-30T00:00:00.000Z'));
    expect(data.taxBreakdown.lateMonths).toBeGreaterThan(0);
    expect(Number(data.billTotal)).toBeGreaterThan(1797);
    expect(auditData(auditCreate).changes).toMatchObject({ taxExpiryDate: { from: '2026-12-31', to: '2026-09-30' } });
    expect(auditData(auditCreate).changes).toHaveProperty('billTotal');
  });

  it('งานที่ยังไม่ชำระ: แก้ข้อมูลรถแล้วคิดแค่ว่าต้องตรวจสภาพไหม ไม่มียอดเงิน', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow({ paymentDate: null, billTotal: null, noBillTotal: null }) });
    await svc.update('r1', { firstRegistrationDate: '2015-01-10', remark: 'วันจดทะเบียนผิด' });
    const { data } = update.mock.calls[0][0];
    expect(data.inspectionRequired).toBe(true); // รถอายุเกิน 7 ปี
    expect(data.billTotal).toBeNull();
  });

  it('แก้ประเภทเจ้าของ (กรอกเอง): เก็บลง ownerType และ taxBreakdown.owner แล้วคิดยอดใหม่', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { ownerType: 'JURISTIC', financed: false, remark: 'เป็นบริษัท ไม่ได้ติดไฟแนนซ์' });
    const { data } = update.mock.calls[0][0];
    expect(data.ownerType).toBe(OwnerType.JURISTIC);
    expect(data.taxBreakdown.owner).toEqual(JURISTIC);
    expect(data.taxBreakdown.companyMultiplier).toBe(2);
  });

  it('รถที่มีเจ้าของในฐานข้อมูลรถ: แก้เจ้าของที่งานต่อภาษีไม่ได้', async () => {
    const { svc, update } = setup({ renewal: paidRow({ vehicleId: 'v1' }) });
    await expect(svc.update('r1', { ownerType: 'JURISTIC', financed: false, remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('แก้ประเภทเจ้าของ/ไฟแนนซ์ที่ข้อมูลรถ') },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('รถที่เลือกจากระบบแก้เลขตัวถังไม่ได้ (ผิดคัน = ยกเลิกแล้วบันทึกใหม่)', async () => {
    const { svc } = setup({ renewal: paidRow({ vehicleId: 'v1' }) });
    await expect(svc.update('r1', { chassis: 'OTHER', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('ยกเลิกงานแล้วบันทึกใหม่') },
    });
  });

  it('STAFF_CAR เปลี่ยนประเภทรถเป็นจักรยานยนต์ไม่ได้', async () => {
    const { svc } = setup({ vehicle: null, renewal: paidRow() });
    await expect(
      runAs('u1', ['STAFF_CAR'], () => svc.update('r1', { vehicleType: 'รย.12-น้อยกว่า 300cc', remark: 'x' })),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('มีคนแก้ไปก่อน (updatedAt ไม่ตรง) = 409', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    update.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'P2025' }));
    await expect(svc.update('r1', { plateNumber: '5678', remark: 'x' })).rejects.toMatchObject({ status: 409 });
  });

  // พบ 2026-09-27: ฟอร์ม ✎ แก้ส่งทุกช่องจากตอนเปิด เดิมเทียบกับ updatedAt ที่อ่านในคำขอเดียวกัน ฟอร์มที่เปิดค้างไว้จึงเอา
  // ค่าเก่าไปทับการแก้ของอีกคนได้โดยไม่มี 409 - ตอนนี้ฟอร์มส่ง expectedUpdatedAt (updatedAt ที่โหลดมา)
  it('ฟอร์มเปิดจากข้อมูลเก่า (expectedUpdatedAt ไม่ตรง) = 409 ไม่บันทึก ไม่เขียนประวัติ', async () => {
    const { svc, update, auditCreate } = setup({ vehicle: null, renewal: paidRow() });
    await expect(
      svc.update('r1', { plateNumber: '5678', remark: 'x', expectedUpdatedAt: '2026-11-30T09:00:00.000Z' }),
    ).rejects.toMatchObject({ status: 409 });
    expect(update).not.toHaveBeenCalled();
    expect(auditCreate).not.toHaveBeenCalled();
  });

  it('expectedUpdatedAt ตรง = ใช้ค่านั้นเป็นเงื่อนไขของการบันทึก', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { plateNumber: '5678', remark: 'x', expectedUpdatedAt: UPDATED_AT.toISOString() });
    expect(update.mock.calls[0][0].where).toEqual({ id: 'r1', cancelledAt: null, updatedAt: UPDATED_AT });
  });

  it('ฟอร์มที่ส่ง expectedUpdatedAt มาแต่แก้แค่กรอกวันที่ที่ยังว่าง ก็เช็ก updatedAt ด้วย', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { receivedDate: '2026-12-05', remark: 'x', expectedUpdatedAt: UPDATED_AT.toISOString() });
    expect(update.mock.calls[0][0].where).toMatchObject({ id: 'r1', cancelledAt: null, updatedAt: UPDATED_AT });
  });

  // กรอกวันที่ครั้งแรกไม่ต้องมีเหตุผล - ถ้าอีกคนกรอก/แก้วันที่ไปก่อน ต้องไม่ทับของเขาเงียบๆ
  it('กรอกวันที่ครั้งแรก: เขียนเฉพาะวันที่นั้น โดยมีเงื่อนไขว่าวันที่ทั้งสามยังเป็นค่าที่ตรวจไว้', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    await svc.update('r1', { receivedDate: '2026-12-05' });
    const { data, where } = update.mock.calls[0][0];
    expect(data).toEqual({ receivedDate: new Date('2026-12-05T00:00:00.000Z') });
    expect(where).toEqual({
      id: 'r1',
      cancelledAt: null,
      paymentDate: new Date('2026-12-01T00:00:00.000Z'),
      receivedDate: null,
      deliveredDate: null,
    });
  });

  it('expectedUpdatedAt อ่านเป็นวันเวลาไม่ได้ = 400', async () => {
    const { svc, update } = setup({ vehicle: null, renewal: paidRow() });
    await expect(svc.update('r1', { plateNumber: '5678', remark: 'x', expectedUpdatedAt: 'เมื่อวาน' })).rejects.toMatchObject({ status: 400 });
    expect(update).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: ทางติ๊ก/กรอกวันที่ครั้งแรกเคยเขียน data ทั้งก้อน (ข้อมูลรถทุกช่อง + ownerType ของรถปัจจุบัน) จากที่อ่านไว้ต้นคำขอ
  // ติ๊กที่แทรกกับการ ✎ แก้ของอีกคนจึงเอาค่าเก่าไปทับโดยไม่มีประวัติ และทุกติ๊กคัดลอกประเภทเจ้าของของรถมาทับโดยไม่คิดยอดใหม่
  it('ติ๊กเขียนเฉพาะช่องที่ติ๊ก ไม่เขียนข้อมูลรถ เจ้าของ หรือวันที่ที่อ่านไว้', async () => {
    const individual = { name: 'สมชาย', hirerName: null, ownerType: OwnerType.INDIVIDUAL, isHirePurchaseBusiness: false, hirerType: null };
    const { svc, update } = setup({ vehicle: vehicleRow({ owner: individual }), renewal: paidRow({ vehicleId: 'v1' }) });
    await svc.update('r1', { insuranceConfirmed: true });
    const { data, where } = update.mock.calls[0][0];
    expect(data).toEqual({ insuranceConfirmed: true });
    expect(where).toEqual({ id: 'r1', cancelledAt: null });
  });

  it('ใส่วันที่ชำระครั้งแรก: เก็บ ownerType คู่กับ taxBreakdown.owner ที่ใช้คิด และเช็ก updatedAt (ยอดขึ้นกับข้อมูลรถที่อ่านมา)', async () => {
    const individual = { name: 'สมชาย', hirerName: null, ownerType: OwnerType.INDIVIDUAL, isHirePurchaseBusiness: false, hirerType: null };
    const { svc, update, auditCreate } = setup({
      vehicle: vehicleRow({ owner: individual }),
      renewal: paidRow({ vehicleId: 'v1', paymentDate: null, billTotal: null, noBillTotal: null, billItems: null, noBillItems: null }),
    });
    await svc.update('r1', { paymentDate: '2026-12-01' });
    const { data, where } = update.mock.calls[0][0];
    expect(data.ownerType).toBe(OwnerType.INDIVIDUAL);
    expect(data.taxBreakdown.owner.ownerType).toBe(OwnerType.INDIVIDUAL);
    expect(data).not.toHaveProperty('chassis');
    expect(data).not.toHaveProperty('taxExpiryDate');
    expect(where).toEqual({ id: 'r1', cancelledAt: null, paymentDate: null, receivedDate: null, deliveredDate: null, updatedAt: UPDATED_AT });
    expect(auditCreate).not.toHaveBeenCalled();
  });
});

describe('TaxRenewalService - ยกเลิกงาน', () => {
  it('ต้องมีเหตุผล', async () => {
    const { svc, update } = setup();
    await expect(svc.cancel('r1', '')).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่ยกเลิกงานต่อภาษี' } });
    expect(update).not.toHaveBeenCalled();
  });

  it('ตั้ง cancelledAt ไม่ลบแถว และเก็บ snapshot ลงประวัติ', async () => {
    const { svc, update, auditCreate } = setup({ renewal: renewalRow({ submitDate: new Date('2026-12-01T00:00:00.000Z') }) });
    await runAs('u9', ['STAFF_CAR'], () => svc.cancel('r1', 'คีย์ซ้ำ'));
    const { where, data } = update.mock.calls[0][0];
    expect(where).toEqual({ id: 'r1', cancelledAt: null });
    expect(data).toMatchObject({ cancelReason: 'คีย์ซ้ำ', cancelledById: 'u9' });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({
      entity: 'TaxRenewal',
      action: 'cancel',
      editedById: 'u9',
      changes: { plate: '1กก 1234', taxExpiryDate: '2026-12-31' },
    });
  });

  it('งานที่ยกเลิกแล้วแก้/ยกเลิกซ้ำไม่ได้ (409)', async () => {
    const { svc } = setup({ renewal: renewalRow({ cancelledAt: new Date() }) });
    await expect(svc.cancel('r1', 'x')).rejects.toMatchObject({ status: 409 });
    await expect(svc.update('r1', { insuranceConfirmed: true })).rejects.toMatchObject({ status: 409 });
  });

  it('รายการไม่รวมงานที่ยกเลิกแล้ว และบอกว่าเจ้าของมาจากข้อมูลรถหรือไม่', async () => {
    const { svc, renewalFindMany } = setup();
    renewalFindMany.mockResolvedValueOnce([
      { ...renewalRow({ vehicleId: 'v1' }), vehicle: { owner: { id: 'o1' } } },
      { ...renewalRow({ id: 'r2', taxBreakdown: { owner: FINANCED_INDIVIDUAL } }), vehicle: null },
    ]);
    const rows = await svc.findAll();
    expect(renewalFindMany.mock.calls[0][0].where).toMatchObject({ cancelledAt: null });
    expect(rows[0]).toMatchObject({ ownerFromVehicle: true, financed: false });
    expect(rows[1]).toMatchObject({ ownerFromVehicle: false, financed: true, hirerType: OwnerType.INDIVIDUAL });
    expect(rows[0]).not.toHaveProperty('vehicle');
  });
});
