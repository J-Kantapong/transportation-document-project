import { vi } from 'vitest';
import { DocumentSubmissionService } from './document-submission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';
import { requestContext } from '../auth/request-context.js';

const VEHICLE = {
  id: 'v1',
  body: 'รย.1-เก๋ง 2 ตอน',
  registrationProvince: 'กรุงเทพมหานคร',
  ownerProvince: 'กรุงเทพมหานคร',
  // มีเจ้าของรถอยู่แล้ว - ยื่นได้โดยไม่ต้องส่ง ownerType (ดูเทสต์ "ต้องระบุประเภทเจ้าของรถ" ด้านล่าง)
  ownerId: 'owner1',
  owner: { id: 'owner1', ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null },
  // ผ่าน Step 2 + ตรวจผ่านเมื่อ 10 วันก่อนวันที่ยื่นใน OPTIONS (2026-09-19) - ยื่นได้
  transferDone: true,
  inspectionSentDate: new Date('2026-09-08T00:00:00.000Z'),
  inspectionResult: 'ผ่าน',
  inspectionResultDate: new Date('2026-09-09T00:00:00.000Z'),
};

function mockPrisma(overrides: Record<string, unknown> = {}) {
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(VEHICLE), update: vi.fn().mockResolvedValue(VEHICLE) },
    vehicleOwner: { create: vi.fn().mockResolvedValue({ id: 'owner-new' }) },
    vehicleEditLog: { create: vi.fn().mockResolvedValue({}) },
    // งานสลับเลขของรถคันนี้ - ไม่มี = รถทั่วไป (ดู assertEligible)
    plateSwap: { findFirst: vi.fn().mockResolvedValue(null) },
    documentSubmission: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'sub1', status: 'PENDING' }),
      update: vi.fn(),
    },
    // ล็อกแถวรถ (SELECT ... FOR UPDATE) ใน submit()
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'v1' }]),
    feeCarBillParam: {
      findMany: vi.fn().mockResolvedValue([
        { key: 'ค่าคำขอ (ปกติ)', amount: 5 },
        { key: 'ค่าตรวจสภาพรถ (Step4)', amount: 50 },
        { key: 'ค่าแผ่นป้ายทะเบียนรถ', amount: 200 },
        { key: 'ค่าใบคู่มือการจดทะเบียน', amount: 100 },
      ]),
    },
    feeCarNoBillParam: {
      findMany: vi.fn().mockResolvedValue([
        { key: 'ค่าอากร (ปกติ)', amount: 10 },
        { key: 'ลงขัน - รย.1-เก๋ง 2 ตอน', amount: 40 },
      ]),
    },
    feeMotorcycleBillParam: { findMany: vi.fn().mockResolvedValue([]) },
    feeMotorcycleNoBillParam: { findMany: vi.fn().mockResolvedValue([]) },
    supplierProvinceRate: { findMany: vi.fn().mockResolvedValue([]) },
    ...overrides,
  } as Record<string, unknown>;
  // interactive transaction: ส่ง prisma ตัวเดิมเป็น tx (เทสต์ที่ส่ง $transaction มาเองใช้ของตัวเอง)
  if (!('$transaction' in overrides)) prisma.$transaction = vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma));
  return prisma as unknown as PrismaService;
}

function mockTaxService(): TaxService {
  return {
    calculateAndSave: vi.fn().mockResolvedValue({ finalAmount: null }),
    loadRuleSet: vi.fn().mockResolvedValue({ ccBrackets: [], weightBrackets: [], evIncentives: [], motorcycleFlat: [] }),
    previewMany: vi.fn(async (inputs: unknown[]) => inputs.map(() => ({ amount: 100 }))),
  } as unknown as TaxService;
}

// อ่าน mock ของ prisma/tax โดยไม่อ้างอิง method ตรงๆ (oxlint unbound-method)
const mocksOf = (mock: unknown) => mock as Record<string, Record<string, ReturnType<typeof vi.fn>>> & Record<string, ReturnType<typeof vi.fn>>;

const OPTIONS = {
  plateNumberOption: 'NONE',
  includePlateFee: true,
  newPlateOption: 'NONE',
  relocateAddon: false,
  stopUseRelocateOut: false,
  urgent: false,
  submitDate: '2026-09-19',
};

describe('DocumentSubmissionService.submit - เงื่อนไขการยื่น', () => {
  // findFirst ถูกเรียกด้วย status in [PENDING, RECEIPT_RECEIVED] - mock คืนแถว active ที่เจอ (หรือ null)
  function withActiveSubmission(status: string | null) {
    const create = vi.fn().mockResolvedValue({ id: 'sub1', status: 'PENDING' });
    const prisma = mockPrisma({
      documentSubmission: {
        findFirst: vi.fn().mockResolvedValue(status ? { id: 'sub0', status } : null),
        findUnique: vi.fn(),
        create,
        update: vi.fn(),
      },
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), create };
  }

  function withVehicle(vehicle: Record<string, unknown>) {
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue({ ...VEHICLE, ...vehicle }), update: vi.fn() },
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()) };
  }

  // รถที่รับเลขจากงานสลับเลข (ผู้ใช้ 2026-09-23) - openSwap = งานที่ยังเปิดอยู่ที่ query เจอ (null = ไม่มี/รับกลับหมดแล้ว)
  // findFirst ครั้งแรกคือเช็กว่ามีตาราง (select id) ครั้งถัดไปคือหางานที่ยังเปิดอยู่ของรถคันนี้ใน transaction
  function withPlateSwap(openSwap: { returnedDate: Date | null } | null) {
    const create = vi.fn().mockResolvedValue({ id: 'sub1', status: 'PENDING' });
    const findSwap = vi.fn(async (args: { where?: unknown }) => (args?.where ? openSwap : { id: 'any' }));
    const prisma = mockPrisma({
      plateSwap: { findFirst: findSwap },
      documentSubmission: { findFirst: vi.fn().mockResolvedValue(null), findUnique: vi.fn(), create, update: vi.fn() },
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), create, findSwap, prisma };
  }

  it('ยื่นไม่ได้ถ้างานสลับเลขยังไม่ได้ยืนยันรับเอกสารกลับ', async () => {
    const { service, create } = withPlateSwap({ returnedDate: null });
    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({
      response: { error: expect.stringContaining('ยืนยันรับเอกสารกลับ') },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('ยื่นได้เมื่องานสลับเลขรับเอกสารกลับแล้ว (ไม่มีงานที่ยังเปิดอยู่)', async () => {
    const { service, create } = withPlateSwap(null);
    await service.submit('v1', OPTIONS);
    expect(create).toHaveBeenCalled();
  });

  // ผู้ใช้ 2026-09-27: งานไหนก็ได้ที่ยังไม่รับเอกสารกลับและไม่ได้ยกเลิก = ล็อก (เดิมดูแค่งานล่าสุด)
  it('หางานสลับเลขที่ยังเปิดอยู่ของรถคันนี้ (ไม่ใช่แค่งานล่าสุด ไม่นับงานที่ยกเลิก) หลังล็อกแถวรถ', async () => {
    const { service, create, findSwap, prisma } = withPlateSwap(null);
    await service.submit('v1', OPTIONS);
    const openQuery = findSwap.mock.calls.findIndex((c) => c[0]?.where);
    expect(findSwap.mock.calls[openQuery][0]).toEqual({
      where: { newVehicleId: 'v1', returnedDate: null, cancelledAt: null },
      select: { returnedDate: true },
    });
    // อ่านใน transaction หลัง SELECT ... FOR UPDATE ของแถวรถ - ผูกงานสลับเลขแทรกระหว่างตรวจกับบันทึกไม่ได้
    const lock = mocksOf(prisma).$queryRaw as unknown as ReturnType<typeof vi.fn>;
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(findSwap.mock.invocationCallOrder[openQuery]);
    expect(create).toHaveBeenCalled();
  });

  it('เช็กว่ามีตารางงานสลับเลขครั้งเดียว แล้วจำไว้', async () => {
    const { service, findSwap } = withPlateSwap(null);
    await service.submit('v1', OPTIONS);
    await service.submit('v1', OPTIONS);
    expect(findSwap.mock.calls.filter((c) => !c[0]?.where)).toHaveLength(1);
    expect(findSwap.mock.calls.filter((c) => c[0]?.where)).toHaveLength(2);
  });

  it('ยื่นไม่ได้ถ้ายื่นครั้งล่าสุดยังค้างสถานะ PENDING', async () => {
    const { service, create } = withActiveSubmission('PENDING');
    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({
      response: { error: expect.stringContaining('รอใบเสร็จ') },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('ยื่นไม่ได้เด็ดขาดถ้าได้รับใบเสร็จแล้ว (จดทะเบียนสำเร็จ)', async () => {
    const { service, create } = withActiveSubmission('RECEIPT_RECEIVED');
    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({
      response: { error: expect.stringContaining('จดทะเบียนสำเร็จแล้ว') },
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('ยื่นใหม่ได้หลังยื่นไม่สำเร็จ (FAILED ไม่นับเป็น active)', async () => {
    const { service } = withActiveSubmission(null);
    const result = await service.submit('v1', OPTIONS);
    expect(result.submission).toEqual({ id: 'sub1', status: 'PENDING' });
  });

  it.each([
    [{ transferDone: false }, 'แจ้งย้าย/ตัดบัญชี'],
    [{ inspectionSentDate: null, inspectionResult: null, inspectionResultDate: null }, 'ยังไม่ได้ตรวจรถ'],
    [{ inspectionResult: null, inspectionResultDate: null }, 'รอผลตรวจ'],
    [{ inspectionResult: 'ไม่ผ่าน' }, 'ตรวจรถไม่ผ่าน'],
    [{ inspectionResultDate: new Date('2026-06-21T00:00:00.000Z') }, 'ผลตรวจรถหมดอายุ'], // 90 วันก่อน 2026-09-19
    [{ inspectionResultDate: new Date('2026-09-20T00:00:00.000Z') }, 'ก่อนวันที่ตรวจรถผ่าน'],
  ])('ยื่นไม่ได้ถ้ายังไม่ผ่าน Step 2/3 ตามลำดับ: %o', async (vehicle, message) => {
    const { service } = withVehicle(vehicle);
    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({
      response: { error: expect.stringContaining(message) },
    });
  });

  it('ยื่นไม่ได้ถ้ายังไม่ระบุประเภทเจ้าของรถ (ไม่ส่ง ownerType และรถยังไม่มีเจ้าของ)', async () => {
    const { service } = withVehicle({ ownerId: null, owner: null });
    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({
      response: { error: expect.stringContaining('ประเภทเจ้าของรถ') },
    });
  });

  it('ยื่นได้วันสุดท้ายของอายุผลตรวจ (ตรวจผ่าน 89 วันก่อนวันที่ยื่น)', async () => {
    const { service } = withVehicle({ inspectionResultDate: new Date('2026-06-22T00:00:00.000Z') });
    const result = await service.submit('v1', OPTIONS);
    expect(result.submission).toEqual({ id: 'sub1', status: 'PENDING' });
  });

  it('ยื่นหลายคัน: รถคันเดียวกันซ้ำในชุดเดียวกันรับแค่แถวแรก', async () => {
    const { service, create } = withActiveSubmission(null);
    const result = await service.submitBulk({ entries: [{ vehicleId: 'v1', ...OPTIONS }, { vehicleId: 'v1', ...OPTIONS }] });
    expect(result.succeeded).toHaveLength(1);
    expect(result.failed).toEqual([{ vehicleId: 'v1', error: 'รถคันนี้ซ้ำในรายการเดียวกัน' }]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ยื่นได้ปกติถ้ายังไม่เคยยื่นเลย (ไม่มี DocumentSubmission ก่อนหน้า)', async () => {
    const prisma = mockPrisma();
    const service = new DocumentSubmissionService(prisma, mockTaxService());

    const result = await service.submit('v1', OPTIONS);
    expect(result.submission).toEqual({ id: 'sub1', status: 'PENDING' });
  });

  // มีคนทำสลับเลขมาให้ (ผู้ใช้ 2026-09-27): ต้องมีหมวด+เลข บันทึกลงรถ ไม่มีค่าขอใช้เลข คิดค่าแผ่นป้าย
  it('มีคนทำสลับเลขมาให้: ไม่มีทะเบียน = ไม่บันทึก / มีทะเบียน = บันทึกทะเบียนลงรถและเก็บตัวเลือกไว้', async () => {
    const { service, create } = withActiveSubmission(null);
    await expect(service.submit('v1', { ...OPTIONS, plateNumberOption: 'SWAP_NORMAL' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('สลับเลข') },
    });
    expect(create).not.toHaveBeenCalled();

    const prisma = mockPrisma();
    const ok = new DocumentSubmissionService(prisma, mockTaxService());
    await ok.submit('v1', { ...OPTIONS, plateNumberOption: 'SWAP_AUCTION', includePlateFee: false, plateCategory: '1กข', plateNumber: '1234' });
    expect(mocksOf(prisma).vehicle.update).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateCategory: '1กข', plateNumber: '1234' } });
    const data = mocksOf(prisma).documentSubmission.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ plateNumberOption: 'SWAP_AUCTION', includePlateFee: true });
    expect(data.billItems.map((i: { label: string }) => i.label)).toContain('ค่าแผ่นป้ายทะเบียนรถ');
    expect(data.billItems.some((i: { label: string }) => i.label.includes('ขอใช้เลข'))).toBe(false);
  });
});

// ยื่นซ้ำพร้อมกัน (พบ 2026-09-27): ล็อกแถวรถแล้วตรวจสิทธิ์ยื่นใน transaction เดียวกับการบันทึก
describe('DocumentSubmissionService.submit - transaction และล็อกแถวรถ', () => {
  it('ล็อกแถวรถก่อนอ่านข้อมูลรถและตรวจยื่นซ้ำ แล้วบันทึกภาษี/รายการยื่นด้วย transaction เดียวกัน', async () => {
    const prisma = mockPrisma();
    const tax = mockTaxService();
    const service = new DocumentSubmissionService(prisma, tax);
    await service.submit('v1', OPTIONS);

    const queryRaw = mocksOf(prisma).$queryRaw as unknown as ReturnType<typeof vi.fn>;
    const findVehicle = mocksOf(prisma).vehicle.findFirst;
    const findActive = mocksOf(prisma).documentSubmission.findFirst;
    expect(queryRaw.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(queryRaw.mock.calls[0][1]).toBe('v1');
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findVehicle.mock.invocationCallOrder[0]);
    expect(queryRaw.mock.invocationCallOrder[0]).toBeLessThan(findActive.mock.invocationCallOrder[0]);
    expect(findVehicle.mock.calls[0][0]).toMatchObject({ where: { id: 'v1', deletedAt: null } });
    expect(mocksOf(tax).calculateAndSave.mock.calls[0]).toEqual(['v1', { client: prisma, rules: undefined }]);
  });

  it('ฐานข้อมูลที่ยังไม่มีตารางงานสลับเลข (P2021) ยังยื่นได้ - เช็กนอก transaction และไม่อ่านตารางนั้นใน transaction', async () => {
    const plateSwapFind = vi.fn().mockRejectedValue(Object.assign(new Error('missing table'), { code: 'P2021' }));
    const prisma = mockPrisma({ plateSwap: { findFirst: plateSwapFind } });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    await expect(service.submit('v1', OPTIONS)).resolves.toMatchObject({ submission: { id: 'sub1' } });
    expect(plateSwapFind).toHaveBeenCalledTimes(1);
    expect(plateSwapFind.mock.invocationCallOrder[0]).toBeLessThan(mocksOf(prisma).$transaction.mock.invocationCallOrder[0]);
  });

  it('รถถูกลบไประหว่างนั้น -> ไม่พบข้อมูลรถ ไม่บันทึก', async () => {
    const create = vi.fn();
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue(null), update: vi.fn() },
      documentSubmission: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({ status: 404 });
    expect(create).not.toHaveBeenCalled();
  });

  it('STAFF_CAR ยื่นจักรยานยนต์ไม่ได้ (ตรวจกับข้อมูลรถที่อ่านหลังล็อก)', async () => {
    const create = vi.fn();
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue({ ...VEHICLE, body: 'รย.12-รถจักรยานยนต์' }), update: vi.fn() },
      documentSubmission: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    await expect(
      requestContext.run({ user: { id: 'u1', roles: ['STAFF_CAR'], customerId: null, name: 'ทดสอบ' } }, () => service.submit('v1', OPTIONS)),
    ).rejects.toMatchObject({ status: 403 });
    expect(create).not.toHaveBeenCalled();
  });
});

// เจ้าของรถ (พบ 2026-09-27): ownerType ใช้ได้เฉพาะรถที่ยังไม่มีเจ้าของ - ห้ามแทนเจ้าของที่กรอกจากหน้าเพิ่มข้อมูลรถ
describe('DocumentSubmissionService.submit - ประเภทเจ้าของรถที่ส่งมา', () => {
  const FINANCED_OWNER = { id: 'owner1', ownerType: 'JURISTIC', isHirePurchaseBusiness: true, hirerType: 'INDIVIDUAL', financeCompanyId: 'f1' };

  function setup(owner: Record<string, unknown> | null) {
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn().mockResolvedValue({ ...VEHICLE, ownerId: owner ? 'owner1' : null, owner }), update: vi.fn() },
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), prisma };
  }

  it('หน้าที่เปิดค้างไว้ส่งประเภทมา แต่รถเพิ่งถูกกรอกเจ้าของ (ไฟแนนซ์) คนละประเภท -> ให้โหลดใหม่ ไม่แทนเจ้าของเดิม', async () => {
    const { service, prisma } = setup(FINANCED_OWNER);
    await expect(service.submit('v1', { ...OPTIONS, ownerType: 'INDIVIDUAL' })).rejects.toMatchObject({
      response: { error: 'ข้อมูลเจ้าของรถถูกแก้ไขแล้ว กรุณาโหลดใหม่' },
    });
    expect(mocksOf(prisma).vehicleOwner.create.mock.calls).toHaveLength(0);
    expect(mocksOf(prisma).vehicle.update.mock.calls).toHaveLength(0);
    expect(mocksOf(prisma).documentSubmission.create.mock.calls).toHaveLength(0);
  });

  it('ประเภทตรงกับเจ้าของเดิม -> ใช้ของเดิม ไม่สร้างแถวใหม่', async () => {
    const { service, prisma } = setup(FINANCED_OWNER);
    await service.submit('v1', { ...OPTIONS, ownerType: 'JURISTIC' });
    expect(mocksOf(prisma).vehicleOwner.create.mock.calls).toHaveLength(0);
    expect(mocksOf(prisma).documentSubmission.create.mock.calls).toHaveLength(1);
  });

  it('รถที่ยังไม่มีเจ้าของ -> สร้างเจ้าของแบบไม่ระบุชื่อ ผูกกับรถ และเก็บประวัติการแก้ไข', async () => {
    const { service, prisma } = setup(null);
    await service.submit('v1', { ...OPTIONS, ownerType: 'JURISTIC' });
    expect(mocksOf(prisma).vehicleOwner.create.mock.calls[0][0].data).toEqual({ ownerType: 'JURISTIC', isHirePurchaseBusiness: false, hirerType: null });
    expect(mocksOf(prisma).vehicle.update.mock.calls[0][0]).toEqual({ where: { id: 'v1' }, data: { ownerId: 'owner-new' } });
    const log = mocksOf(prisma).vehicleEditLog.create.mock.calls[0][0].data;
    expect(log).toMatchObject({ vehicleId: 'v1', remark: 'ระบุประเภทเจ้าของรถตอนยื่นเอกสาร' });
    expect(JSON.parse(log.changes)).toEqual({ owner: { from: null, to: 'นิติบุคคล' } });
  });

  it('ownerType ผิดรูปแบบ -> 400', async () => {
    const { service } = setup(null);
    await expect(service.submit('v1', { ...OPTIONS, ownerType: 'COMPANY' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('INDIVIDUAL หรือ JURISTIC') },
    });
  });
});

describe('DocumentSubmissionService.submitBulk - ลำดับและขนาด', () => {
  // createdAt ของแต่ละคันที่บันทึก (key = vehicleId)
  const createdAtOf = (create: ReturnType<typeof vi.fn>) =>
    Object.fromEntries(create.mock.calls.map((c) => [c[0].data.vehicleId as string, (c[0].data.createdAt as Date).getTime()]));

  it('createdAt ตามลำดับที่ส่งมา (ไม่ใช่ลำดับที่บันทึกเสร็จ) ผลเรียงตามคำขอ และโหลดตารางอัตราครั้งเดียว', async () => {
    const vehicles: Record<string, unknown> = { a: { ...VEHICLE, id: 'a' }, b: { ...VEHICLE, id: 'b' }, c: { ...VEHICLE, id: 'c' } };
    // คันแรกในคำขอบันทึกเสร็จช้าสุด
    const delay: Record<string, number> = { c: 30, a: 10, b: 0 };
    const create = vi.fn(async ({ data }: { data: { vehicleId: string } }) => {
      await new Promise((resolve) => setTimeout(resolve, delay[data.vehicleId]));
      return { id: `sub-${data.vehicleId}` };
    });
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => vehicles[where.id]), update: vi.fn() },
      documentSubmission: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const tax = mockTaxService();
    const service = new DocumentSubmissionService(prisma, tax);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T03:00:00.000Z')); // นาฬิกาไม่เดิน = ทุกคันได้เวลาเดียวกัน
    try {
      const res = await service.submitBulk({ entries: ['c', 'a', 'b'].map((vehicleId) => ({ vehicleId, ...OPTIONS })) });
      expect(res.succeeded.map((s) => s.vehicleId)).toEqual(['c', 'a', 'b']);
    } finally {
      vi.useRealTimers();
    }
    const times = createdAtOf(create);
    expect(times.a).toBe(times.c + 1);
    expect(times.b).toBe(times.a + 1);
    expect(mocksOf(tax).loadRuleSet).toHaveBeenCalledTimes(1);
    expect(mocksOf(prisma).feeCarBillParam.findMany).toHaveBeenCalledTimes(1);
  });

  it('บันทึกพร้อมกันหลายคันแต่ไม่เกิน 8 คัน', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const create = vi.fn(async ({ data }: { data: { vehicleId: string } }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      return { id: `sub-${data.vehicleId}` };
    });
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...VEHICLE, id: where.id })), update: vi.fn() },
      documentSubmission: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    const entries = Array.from({ length: 20 }, (_, i) => ({ vehicleId: `v${i}`, ...OPTIONS }));
    const res = await service.submitBulk({ entries });
    expect(res.succeeded).toHaveLength(20);
    expect(maxInFlight).toBe(8);
  });

  it('คำขอถัดไป (ชุดถัดไปของหน้าเว็บ) ได้ createdAt ต่อจากชุดก่อนเสมอ แม้เวลาเครื่องยังไม่เดิน', async () => {
    const create = vi.fn(async ({ data }: { data: { vehicleId: string } }) => ({ id: `sub-${data.vehicleId}` }));
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...VEHICLE, id: where.id })), update: vi.fn() },
      documentSubmission: { findFirst: vi.fn().mockResolvedValue(null), create },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T03:00:00.000Z'));
    try {
      await service.submitBulk({ entries: ['a', 'b', 'c'].map((vehicleId) => ({ vehicleId, ...OPTIONS })) });
      await service.submitBulk({ entries: ['d', 'e'].map((vehicleId) => ({ vehicleId, ...OPTIONS })) });
    } finally {
      vi.useRealTimers();
    }
    const times = createdAtOf(create);
    expect(['a', 'b', 'c', 'd', 'e'].map((id) => times[id] - times.a)).toEqual([0, 1, 2, 3, 4]);
  });

  it('เกิน 1,000 คันต่อครั้ง -> 400 ไม่บันทึกคันไหน', async () => {
    const prisma = mockPrisma();
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    const entries = Array.from({ length: 1001 }, (_, i) => ({ vehicleId: `v${i}`, ...OPTIONS }));
    await expect(service.submitBulk({ entries })).rejects.toMatchObject({ status: 400 });
    expect(mocksOf(prisma).documentSubmission.create).not.toHaveBeenCalled();
  });

  it('คันที่พลาดคืนเหตุผล คันอื่นบันทึกต่อ', async () => {
    const prisma = mockPrisma({
      vehicle: {
        findFirst: vi.fn(async ({ where }: { where: { id: string } }) => (where.id === 'gone' ? null : { ...VEHICLE, id: where.id })),
        update: vi.fn(),
      },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    const res = await service.submitBulk({ entries: [{ vehicleId: 'gone', ...OPTIONS }, { vehicleId: 'v1', ...OPTIONS }] });
    expect(res.failed).toEqual([{ vehicleId: 'gone', error: 'ไม่พบข้อมูลรถ' }]);
    expect(res.succeeded.map((s) => s.vehicleId)).toEqual(['v1']);
  });
});

describe('DocumentSubmissionService.previewBulk', () => {
  function setup(vehicles: unknown[]) {
    const prisma = mockPrisma({ vehicle: { findMany: vi.fn().mockResolvedValue(vehicles) } });
    return new DocumentSubmissionService(prisma, mockTaxService());
  }
  const entry = (vehicleId: string, extra: Record<string, unknown> = {}) => ({ vehicleId, ...OPTIONS, ...extra });

  it('ใช้กฎเจ้าของรถเดียวกับ submit: มีเจ้าของแล้วคนละประเภท = error รายคัน, ไม่มีเจ้าของ = ใช้ประเภทที่ส่งมา', async () => {
    const service = setup([
      { ...VEHICLE, id: 'owned', owner: { ownerType: 'JURISTIC', isHirePurchaseBusiness: true, hirerType: 'INDIVIDUAL' } },
      { ...VEHICLE, id: 'none', ownerId: null, owner: null },
    ]);
    const { results } = await service.previewBulk({ entries: [entry('owned', { ownerType: 'INDIVIDUAL' }), entry('none', { ownerType: 'INDIVIDUAL' })] });
    expect(results[0]).toEqual({ vehicleId: 'owned', error: 'ข้อมูลเจ้าของรถถูกแก้ไขแล้ว กรุณาโหลดใหม่' });
    expect(results[1]).toMatchObject({ vehicleId: 'none', fee: expect.any(Object), tax: { amount: 100 } });
  });

  it('ค่าธรรมเนียมหาไม่เจอ -> บอกคีย์ที่ขาด (ไม่ใช่ข้อความกลางๆ)', async () => {
    const service = setup([{ ...VEHICLE, id: 'm1', body: 'รย.12-รถจักรยานยนต์' }]);
    const { results } = await service.previewBulk({ entries: [entry('m1', { newPlateOption: undefined })] });
    expect(results[0]).toMatchObject({ error: expect.stringContaining('ไม่พบข้อมูลค่าธรรมเนียม') });
  });
});

// ยกเลิกรายการ (พบ 2026-09-27): ลบแบบมีเงื่อนไขใน transaction - ถ้าอีกคนบันทึกได้ใบเสร็จไปก่อน ต้องไม่ลบ
describe('DocumentSubmissionService.cancel', () => {
  function setup(deleteCount: number, status = 'PENDING') {
    const deleteMany = vi.fn().mockResolvedValue({ count: deleteCount });
    const detach = vi.fn().mockResolvedValue({ count: 0 });
    const logCreate = vi.fn().mockResolvedValue({});
    const prisma = mockPrisma({
      documentSubmission: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'sub1',
          vehicleId: 'v1',
          status,
          submitDate: new Date('2026-09-19T00:00:00.000Z'),
          urgent: false,
          billItems: [],
          noBillItems: [{ label: 'ค่าอากร (ปกติ)', amount: 10 }],
          taxAmount: null,
          vehicle: { body: 'รย.1-เก๋ง 2 ตอน' },
          _count: { receipts: 0 },
        }),
        deleteMany,
      },
      receiptImage: { updateMany: detach },
      vehicleEditLog: { create: logCreate },
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), deleteMany, logCreate, detach, lockRows: mocksOf(prisma).$queryRaw };
  }

  it('ลบเฉพาะที่ยังรอใบเสร็จ แล้วเก็บประวัติพร้อมเหตุผล', async () => {
    const { service, deleteMany, logCreate, detach, lockRows } = setup(1);
    await expect(service.cancel('sub1', ' เลือกตัวเลือกผิด ')).resolves.toEqual({ id: 'sub1', cancelled: true });
    expect(deleteMany).toHaveBeenCalledWith({ where: { id: 'sub1', status: 'PENDING' } });
    expect(logCreate.mock.calls[0][0].data).toMatchObject({ vehicleId: 'v1', remark: 'เลือกตัวเลือกผิด' });
    // ล็อกแถวรายการก่อนถอดรูป - ลำดับเดียวกับตอนแนบ/ย้ายรูป กัน deadlock (พบ 2026-09-27)
    expect(lockRows.mock.calls[0][1]).toEqual(['sub1']);
    expect(lockRows.mock.invocationCallOrder[0]).toBeLessThan(detach.mock.invocationCallOrder[0]);
  });

  it('อีกคนบันทึกได้ใบเสร็จแทรกเข้ามาก่อนลบ (ลบไม่โดนแถวไหน) -> ปฏิเสธ ไม่เก็บประวัติ', async () => {
    const { service, logCreate } = setup(0);
    await expect(service.cancel('sub1', 'x')).rejects.toMatchObject({ response: { error: 'ยกเลิกได้เฉพาะรายการที่ยังรอใบเสร็จ' } });
    expect(logCreate).not.toHaveBeenCalled();
  });

  it('ได้ใบเสร็จแล้ว / ไม่มีเหตุผล -> ปฏิเสธก่อนลบ', async () => {
    const received = setup(1, 'RECEIPT_RECEIVED');
    await expect(received.service.cancel('sub1', 'x')).rejects.toMatchObject({ status: 400 });
    expect(received.deleteMany).not.toHaveBeenCalled();
    await expect(setup(1).service.cancel('sub1', '  ')).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
  });
});

describe('DocumentSubmissionService.listDates - วันที่ยื่นทั้งหมด', () => {
  it('นับรายการต่อวันที่ (วันที่ UTC แบบตัวกรอง date) ใหม่สุดก่อน ตามขอบเขตประเภทรถ', async () => {
    const groupBy = vi.fn().mockResolvedValue([
      { submitDate: new Date('2026-09-20T00:00:00.000Z'), _count: { _all: 3 } },
      { submitDate: new Date('2026-09-19T05:00:00.000Z'), _count: { _all: 1 } },
      { submitDate: new Date('2026-09-19T00:00:00.000Z'), _count: { _all: 2 } },
    ]);
    const service = new DocumentSubmissionService(mockPrisma({ documentSubmission: { groupBy } }), mockTaxService());
    const res = await requestContext.run({ user: { id: 'u1', roles: ['STAFF_MOTO'], customerId: null, name: 'ทดสอบ' } }, () => service.listDates());
    expect(res.dates).toEqual([
      { date: '2026-09-20', count: 3 },
      { date: '2026-09-19', count: 3 },
    ]);
    expect(groupBy.mock.calls[0][0]).toMatchObject({ by: ['submitDate'], where: { vehicle: { AND: [{ OR: [{ body: { startsWith: 'รย.12-' } }, { body: { startsWith: 'รย.17-' } }] }] } } });
  });
});

// หน้ารับใบเสร็จบันทึกผ่าน saveReceiptCheck เท่านั้น (PATCH .../:id/status ถอดออกแล้ว 2026-09-27) - ทดสอบ updateStatus ผ่านทางนี้
describe('DocumentSubmissionService.saveReceiptCheck - บันทึกทั้งใบยื่น', () => {
  const CAR_BODY = 'รย.1-เก๋ง 2 ตอน';
  const MOTO_BODY = 'รย.12-รถจักรยานยนต์';

  function setup(
    opts: { photos?: number; status?: string; plate?: { plateCategory: string | null; plateNumber: string | null }; body?: string; updateCount?: number } = {},
  ) {
    const submission = {
      id: 'sub1',
      vehicleId: 'v1',
      status: opts.status ?? 'PENDING',
      submitDate: new Date('2026-09-19T00:00:00.000Z'),
      vehicle: { plateCategory: null, plateNumber: null, ...opts.plate, body: opts.body ?? CAR_BODY },
      _count: { receipts: opts.photos ?? 0 },
    };
    const findUnique = vi.fn().mockResolvedValue(submission);
    const updateMany = vi.fn().mockResolvedValue({ count: opts.updateCount ?? 1 });
    const vehicleUpdate = vi.fn().mockResolvedValue({});
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn(), update: vehicleUpdate },
      documentSubmission: { findFirst: vi.fn(), findUnique, create: vi.fn(), update: vi.fn(), updateMany },
    });
    // interactive transaction: ส่ง prisma ตัวเดิมเป็น tx
    Object.assign(prisma, { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) });
    const lockRows = mocksOf(prisma).$queryRaw;
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), submission, findUnique, updateMany, vehicleUpdate, lockRows };
  }

  const received = (extras: Record<string, unknown> = {}) => ({ submissionId: 'sub1', action: 'RECEIVED', plateCategory: '8ขก', plateNumber: '3484', ...extras });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T05:00:00.000Z')); // 26/09/2026 12:00 เวลาไทย
  });
  afterEach(() => vi.useRealTimers());

  it('ได้รับใบเสร็จต้องแนบรูปก่อน - ไม่มีรูปคืนเหตุผล ไม่บันทึก', async () => {
    const { service, updateMany } = setup({ photos: 0 });
    const res = await service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [received()] });
    expect(res.failed[0].error).toContain('แนบรูปใบเสร็จ');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('มีรูปแล้วบันทึกว่าได้รับใบเสร็จพร้อมทะเบียน - เขียนแบบมีเงื่อนไข (ยังรอใบเสร็จ + มีรูป)', async () => {
    const { service, updateMany, vehicleUpdate } = setup({ photos: 1 });
    const res = await service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [received({ receiptAmount: '1955', receiptNo: ' 69/0035358 ' })] });
    expect(res.succeeded).toEqual(['sub1']);
    const call = updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'sub1', status: 'PENDING', receipts: { some: {} } });
    expect(call.data).toMatchObject({ status: 'RECEIPT_RECEIVED', receiptAmount: 1955, receiptNo: '69/0035358' });
    // ไม่ได้ส่งวันที่ในใบเสร็จมา = ใช้วันที่ยื่น · วันที่รับ = วันที่ของหน้า
    expect(call.data.receiptDate.toISOString().slice(0, 10)).toBe('2026-09-19');
    expect(call.data.receiptReceivedDate.toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateCategory: '8ขก', plateNumber: '3484' } });
  });

  it('เก็บวันที่ในใบเสร็จแยกจากวันที่รับใบเสร็จ', async () => {
    const { service, updateMany } = setup({ photos: 1 });
    await service.saveReceiptCheck({ receivedDate: '2026-09-25', entries: [received({ receiptDate: '2026-09-22' })] });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.receiptDate.toISOString().slice(0, 10)).toBe('2026-09-22');
    expect(data.receiptReceivedDate.toISOString().slice(0, 10)).toBe('2026-09-25');
  });

  it('ไม่ส่งวันที่รับใบเสร็จ = วันนี้ตามเวลาไทย (ตี 3 เวลาไทยยังเป็น 26/09 UTC)', async () => {
    vi.setSystemTime(new Date('2026-09-26T20:00:00.000Z')); // 27/09/2026 03:00 เวลาไทย
    const { service, updateMany } = setup({ photos: 1 });
    await service.saveReceiptCheck({ entries: [received()] });
    expect(updateMany.mock.calls[0][0].data.receiptReceivedDate.toISOString().slice(0, 10)).toBe('2026-09-27');
  });

  it('รับรถที่มีทะเบียนอยู่แล้วโดยไม่ต้องส่งทะเบียนซ้ำ / ไม่มีทะเบียนเลยบันทึกไม่ได้', async () => {
    const withPlate = setup({ photos: 1, plate: { plateCategory: '1กข', plateNumber: '99' } });
    await withPlate.service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [{ submissionId: 'sub1', action: 'RECEIVED' }] });
    expect(withPlate.vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateCategory: '1กข', plateNumber: '99' } });

    const noPlate = setup({ photos: 1 });
    const res = await noPlate.service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [{ submissionId: 'sub1', action: 'RECEIVED' }] });
    expect(res.failed[0].error).toContain('เลขทะเบียน');
    expect(noPlate.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    [{ plateCategory: '4กขคง' }, 'หมวดทะเบียน'],
    [{ plateNumber: '12345' }, 'เลขทะเบียน'],
    [{ plateNumber: 'ab12' }, 'เลขทะเบียน'],
    [{ receiptAmount: '-5' }, 'ยอดใบเสร็จ'],
    [{ receiptAmount: '10.123' }, 'ยอดใบเสร็จ'],
  ])('ปฏิเสธข้อมูลรูปแบบผิด %j', async (extras, expected) => {
    const { service, updateMany } = setup({ photos: 1 });
    const res = await service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [received(extras)] });
    expect(res.failed[0].error).toContain(expected);
    expect(updateMany).not.toHaveBeenCalled();
  });

  // ตรวจช่วงวันที่ตั้งแต่บันทึกครั้งแรก (พบ 2026-09-27) - เดิมบันทึกได้แล้วแก้ย้อนหลังไม่ได้อีกเลย
  it.each([
    ['2026-09-18', {}, 'วันที่รับใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (19/09/2026)'],
    ['2026-09-27', {}, 'วันที่รับใบเสร็จต้องไม่เกินวันนี้'],
    ['2026-02-31', {}, 'วันที่รับใบเสร็จต้องเป็น'],
    ['2026-09-20', { receiptDate: '2026-09-18' }, 'วันที่ในใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (19/09/2026)'],
    ['2026-09-20', { receiptDate: '2026-09-21' }, 'วันที่ในใบเสร็จต้องไม่หลังวันที่รับใบเสร็จ (20/09/2026)'],
  ])('วันที่รับ %s %j ผิดช่วง -> ไม่บันทึก', async (receivedDate, extras, expected) => {
    const { service, updateMany } = setup({ photos: 1 });
    const res = await service.saveReceiptCheck({ receivedDate, entries: [received(extras)] });
    expect(res.failed[0].error).toContain(expected);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('รายการอัปเดตสถานะไปแล้ว (อ่านทีหลังเจอว่าไม่ใช่ PENDING) -> ปฏิเสธ', async () => {
    const { service, updateMany } = setup({ photos: 1, status: 'RECEIPT_RECEIVED' });
    const res = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', action: 'FAILED', failRemark: 'x' }] });
    expect(res.failed[0].error).toContain('อัปเดตสถานะไปแล้ว');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('สองคนบันทึกพร้อมกัน: อีกคนเปลี่ยนสถานะไปก่อนตอนเขียน -> ไม่ทับ ไม่แตะทะเบียนรถ', async () => {
    const { service, findUnique, submission, vehicleUpdate } = setup({ photos: 1, updateCount: 0 });
    // อ่านครั้งแรกยัง PENDING -> เขียนไม่โดนแถวไหน -> อ่านใหม่เจอว่าอีกคนบันทึกยื่นไม่สำเร็จไปแล้ว
    findUnique.mockResolvedValueOnce(submission).mockResolvedValueOnce({ status: 'FAILED' });
    const res = await service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [received()] });
    expect(res.failed[0].error).toBe('รายการนี้อัปเดตสถานะไปแล้ว');
    expect(vehicleUpdate).not.toHaveBeenCalled();
  });

  it('ยื่นไม่สำเร็จ: ไม่ต้องมีเลขทะเบียน ไม่แตะข้อมูลรถ และบันทึกเหตุผล (เขียนเฉพาะที่ยังไม่มีรูป)', async () => {
    const { service, updateMany, vehicleUpdate } = setup();
    const res = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', action: 'FAILED', failRemark: '  บัตรประชาชนหมดอายุ  ' }] });
    expect(res.succeeded).toEqual(['sub1']);
    expect(vehicleUpdate).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'sub1', status: 'PENDING', receipts: { none: {} } },
      data: { status: 'FAILED', receiptReceivedDate: null, receiptDate: null, receivedById: null, failRemark: 'บัตรประชาชนหมดอายุ' },
    });
  });

  it.each([undefined, '', '   '])('ยื่นไม่สำเร็จ: ต้องมีเหตุผลเสมอ (%j)', async (failRemark) => {
    const { service, updateMany } = setup();
    const res = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', action: 'FAILED', failRemark }] });
    expect(res.failed[0].error).toContain('เหตุผลที่ยื่นไม่สำเร็จ');
    expect(updateMany).not.toHaveBeenCalled();
  });

  // หน้าที่เปิดค้างไว้ไม่เห็นรูปที่อีกเครื่องเพิ่งแนบ (พบ 2026-09-27) - ห้ามบันทึกยื่นไม่สำเร็จ/ค้างไว้ทับ ไม่งั้นรูปค้างเข้าถึงไม่ได้
  it.each([
    [{ action: 'FAILED', failRemark: 'อื่นๆ: x' }],
    [{ action: 'CARRY' }],
  ])('มีรูปใบเสร็จแนบแล้ว -> ยื่นไม่สำเร็จ/ค้างไว้ไม่ได้ %j', async (entry) => {
    const { service, updateMany } = setup({ photos: 1 });
    const res = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', ...entry }] });
    expect(res.failed[0].error).toBe('รายการนี้มีรูปใบเสร็จแนบแล้ว - โหลดหน้าใหม่แล้วบันทึกเป็นได้ใบเสร็จ');
    expect(updateMany).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: เงื่อนไขรูปในคำสั่งเขียนอย่างเดียวไม่พอ ถ้าอีกเครื่องกำลังแนบ/ย้าย/ลบรูปพร้อมกัน - ล็อกแถวรายการก่อน
  // (ReceiptsService ล็อกแถวเดียวกัน) แล้วคำสั่งเขียนจะเห็นรูปที่อีกฝั่งบันทึกไปแล้ว
  it.each([
    [{ action: 'RECEIVED', plateCategory: '8ขก', plateNumber: '3484' }, 1],
    [{ action: 'FAILED', failRemark: 'x' }, 0],
    [{ action: 'CARRY' }, 0],
  ])('ล็อกแถวรายการก่อนเขียนแบบมีเงื่อนไข %j', async (entry, photos) => {
    const { service, updateMany, lockRows } = setup({ photos });
    const res = await service.saveReceiptCheck({ receivedDate: '2026-09-20', entries: [{ submissionId: 'sub1', ...entry }] });
    expect(res.succeeded).toEqual(['sub1']);
    expect(lockRows.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(lockRows.mock.calls[0][1]).toEqual(['sub1']);
    expect(lockRows.mock.invocationCallOrder[0]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
  });

  it('ค้างไว้: ยังรอใบเสร็จ ไม่มีรูป -> ตั้ง receiptCarriedAt แบบมีเงื่อนไข', async () => {
    const { service, updateMany } = setup();
    const carried = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub2', action: 'CARRY' }] });
    expect(carried.succeeded).toEqual(['sub2']);
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'sub2', status: 'PENDING', receipts: { none: {} } } });
  });

  it('ค้างไว้/ยื่นไม่สำเร็จ ตรวจประเภทรถของผู้ใช้ (STAFF_CAR ทำกับจักรยานยนต์ไม่ได้)', async () => {
    const { service, updateMany } = setup({ body: MOTO_BODY });
    const res = await requestContext.run({ user: { id: 'u1', roles: ['STAFF_CAR'], customerId: null, name: 'ทดสอบ' } }, () =>
      service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', action: 'CARRY' }, { submissionId: 'sub2', action: 'FAILED', failRemark: 'x' }] }),
    );
    expect(res.failed.map((f) => f.error)).toEqual([expect.stringContaining('เฉพาะรถยนต์'), expect.stringContaining('เฉพาะรถยนต์')]);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('action ไม่รู้จัก / submissionId ซ้ำ -> คืนเหตุผลรายแถว', async () => {
    const { service } = setup();
    const res = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', action: 'X' }, { submissionId: 'sub1', action: 'CARRY' }] });
    expect(res.failed.map((f) => f.error)).toEqual([expect.stringContaining('action ต้องเป็น'), expect.stringContaining('ซ้ำ')]);
  });
});

describe('DocumentSubmissionService.updateReceiptDate - แก้วันที่ในใบเสร็จย้อนหลัง', () => {
  function setup(status = 'RECEIPT_RECEIVED', receiptReceivedDate: Date | null = new Date('2026-09-24T00:00:00.000Z'), plateReceivedDate: Date | null = null) {
    const update = vi.fn().mockImplementation(async ({ data }) => ({ id: 'sub1', ...data }));
    const create = vi.fn().mockResolvedValue({});
    const prisma = mockPrisma({
      documentSubmission: {
        findUnique: vi.fn().mockResolvedValue({
          status,
          vehicleId: 'v1',
          submitDate: new Date('2026-09-20T00:00:00.000Z'),
          receiptDate: new Date('2026-09-20T00:00:00.000Z'),
          receiptReceivedDate,
          vehicle: { body: 'รย.12-รถจักรยานยนต์', plateReceivedDate, bookReceivedDate: null },
        }),
        update,
      },
      vehicleEditLog: { create },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), update, create };
  }

  it('ได้ใบเสร็จแล้ว + มีเหตุผล: บันทึกวันที่ใหม่และเก็บประวัติพร้อมเหตุผล', async () => {
    const { service, update, create } = setup();
    await service.updateReceiptDate('sub1', '2026-09-22', 'AI อ่านวันที่ผิด');
    expect(update.mock.calls[0][0].data).toEqual({ receiptDate: new Date('2026-09-22T00:00:00.000Z') });
    expect(create.mock.calls[0][0].data).toMatchObject({ vehicleId: 'v1', remark: 'AI อ่านวันที่ผิด' });
    expect(JSON.parse(create.mock.calls[0][0].data.changes)).toEqual({ 'submission.receiptDate': { from: '2026-09-20', to: '2026-09-22' } });
  });

  it('ไม่มีเหตุผล / ยังไม่ได้ใบเสร็จ / วันที่ผิดรูปแบบ แก้ไม่ได้', async () => {
    await expect(setup().service.updateReceiptDate('sub1', '2026-09-22', '  ')).rejects.toMatchObject({ response: { error: expect.stringContaining('เหตุผล') } });
    await expect(setup('PENDING').service.updateReceiptDate('sub1', '2026-09-22', 'x')).rejects.toThrow();
    await expect(setup().service.updateReceiptDate('sub1', '2026/09/22', 'x')).rejects.toThrow();
  });

  it('วันที่ต้องอยู่ระหว่างวันที่ยื่นกับวันที่รับใบเสร็จ และต้องเปลี่ยนจริง', async () => {
    await expect(setup().service.updateReceiptDate('sub1', '2026-09-19', 'x')).rejects.toMatchObject({ response: { error: expect.stringContaining('20/09/2026') } });
    await expect(setup().service.updateReceiptDate('sub1', '2026-09-25', 'x')).rejects.toMatchObject({ response: { error: expect.stringContaining('24/09/2026') } });
    await expect(setup(undefined, null).service.updateReceiptDate('sub1', '2099-01-01', 'x')).rejects.toMatchObject({ response: { error: expect.stringContaining('วันนี้') } });
    await expect(setup().service.updateReceiptDate('sub1', '20/09/2026', 'x')).rejects.toMatchObject({ response: { error: 'วันที่ไม่ได้เปลี่ยน' } });
    // ไม่หลังวันที่รับป้าย/รับเล่มที่บันทึกแล้ว (พบ 2026-09-27)
    await expect(setup(undefined, undefined, new Date('2026-09-21T00:00:00.000Z')).service.updateReceiptDate('sub1', '2026-09-22', 'x')).rejects.toMatchObject({
      response: { error: 'วันที่ในใบเสร็จต้องไม่หลังวันที่รับป้าย (21/09/2026)' },
    });
  });

  it('รับ DD-MM-YYYY / DD/MM/YYYY / ปี พ.ศ. และแจ้ง error เป็น DD/MM/YYYY', async () => {
    const { service, update } = setup();
    await service.updateReceiptDate('sub1', '23-09-2026', 'x');
    await service.updateReceiptDate('sub1', '23/09/2569', 'x');
    const saved = update.mock.calls.map((c) => c[0].data.receiptDate.toISOString().slice(0, 10));
    expect(saved).toEqual(['2026-09-23', '2026-09-23']);
    await expect(service.updateReceiptDate('sub1', '31-02-2026', 'x')).rejects.toMatchObject({ response: { error: expect.stringContaining('DD/MM/YYYY') } });
  });
});

// แก้ข้อมูลใบเสร็จหลังบันทึก (ผู้ใช้ 2026-09-27 เลือกแบบ ก) - ไม่เปลี่ยนสถานะ ต้องมีเหตุผล
describe('DocumentSubmissionService.updateReceiptFields - แก้ข้อมูลใบเสร็จที่บันทึกแล้ว', () => {
  function setup(
    opts: {
      status?: string;
      body?: string;
      receiptDate?: string;
      receiptReceivedDate?: string;
      plateReceivedDate?: string;
      bookReceivedDate?: string;
      slips?: unknown[];
      invoices?: unknown[];
    } = {},
  ) {
    const day = (iso?: string) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
    const stored = {
      status: opts.status ?? 'RECEIPT_RECEIVED',
      vehicleId: 'v1',
      submitDate: new Date('2026-09-20T00:00:00.000Z'),
      receiptDate: new Date(`${opts.receiptDate ?? '2026-09-20'}T00:00:00.000Z`),
      receiptReceivedDate: new Date(`${opts.receiptReceivedDate ?? '2026-09-24'}T00:00:00.000Z`),
      receiptNo: '69/0000001',
      receiptAmount: '1955',
      vehicle: {
        body: opts.body ?? 'รย.1-เก๋ง 2 ตอน',
        plateCategory: '1กข',
        plateNumber: '1234',
        plateReceivedDate: day(opts.plateReceivedDate),
        bookReceivedDate: day(opts.bookReceivedDate),
      },
    };
    const findUnique = vi.fn().mockResolvedValueOnce(stored).mockResolvedValue({ id: 'sub1' });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const vehicleUpdate = vi.fn().mockResolvedValue({});
    const logCreate = vi.fn().mockResolvedValue({});
    const slipFind = vi.fn().mockResolvedValue(opts.slips ?? []);
    const invoiceFind = vi.fn().mockResolvedValue(opts.invoices ?? []);
    const prisma = mockPrisma({
      vehicle: { findFirst: vi.fn(), update: vehicleUpdate },
      documentSubmission: { findFirst: vi.fn(), findUnique, create: vi.fn(), update: vi.fn(), updateMany },
      vehicleEditLog: { create: logCreate },
      deliverySlipItem: { findMany: slipFind },
      invoiceLine: { findMany: invoiceFind },
    });
    Object.assign(prisma, { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), updateMany, vehicleUpdate, logCreate, slipFind, invoiceFind };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T05:00:00.000Z')); // วันนี้ 26/09/2026 เวลาไทย
  });
  afterEach(() => vi.useRealTimers());

  it('แก้ทะเบียน + เลขที่ + ยอด: เขียนรถและรายการในธุรกรรมเดียว เก็บค่าเดิม/ค่าใหม่ พร้อมบอกใบส่งงาน/บิลที่ยังเป็นค่าเดิม', async () => {
    const { service, updateMany, vehicleUpdate, logCreate } = setup({
      slips: [{ slip: { slipNo: 12 } }, { slip: { slipNo: 12 } }],
      invoices: [{ invoice: { invoiceNo: 'IV6909-0001' } }],
    });
    const res = await service.updateReceiptFields('sub1', {
      plateCategory: '1กฃ',
      plateNumber: '1234',
      receiptNo: '69/0000002',
      receiptAmount: '1960.50',
      remark: 'AI อ่านพยัญชนะผิด',
    });
    expect(updateMany.mock.calls[0][0].where).toEqual({ id: 'sub1', status: 'RECEIPT_RECEIVED' });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ receiptNo: '69/0000002', receiptAmount: 1960.5 });
    expect(updateMany.mock.calls[0][0].data.status).toBeUndefined(); // ไม่เปลี่ยนสถานะ
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateCategory: '1กฃ', plateNumber: '1234' } });
    expect(logCreate.mock.calls[0][0].data).toMatchObject({ vehicleId: 'v1', remark: 'AI อ่านพยัญชนะผิด' });
    expect(JSON.parse(logCreate.mock.calls[0][0].data.changes)).toEqual({
      plate: { from: '1กข 1234', to: '1กฃ 1234' },
      'submission.receiptNo': { from: '69/0000001', to: '69/0000002' },
      'submission.receiptAmount': { from: '1955', to: '1960.5' },
    });
    expect(res).toMatchObject({ liveSlips: ['DL-00012'], liveInvoices: ['IV6909-0001'] });
  });

  // พบ 2026-09-27: เดิมแก้แค่ยอดแล้วไม่เตือนเลย ทั้งที่บิลที่ออกแล้วเก็บยอดใบเสร็จเดิมไว้ (InvoiceLine.receiptAmount)
  it('แก้แค่ยอด: ไม่แตะรถ ไม่เตือนใบส่งงาน (ไม่มียอด) แต่เตือนบิลที่ออกแล้ว (ยังเรียกเก็บยอดเดิม)', async () => {
    const { service, vehicleUpdate, slipFind, invoiceFind } = setup({ slips: [{ slip: { slipNo: 12 } }], invoices: [{ invoice: { invoiceNo: 'IV6909-0001' } }] });
    const res = await service.updateReceiptFields('sub1', { receiptAmount: '2000', remark: 'พิมพ์ยอดผิด' });
    expect(vehicleUpdate).not.toHaveBeenCalled();
    expect(slipFind).not.toHaveBeenCalled();
    expect(invoiceFind.mock.calls[0][0].where).toEqual({ vehicleId: 'v1', invoice: { status: { not: 'VOID' } } });
    expect(res).toMatchObject({ liveSlips: [], liveInvoices: ['IV6909-0001'] });
  });

  it('แก้แค่วันที่: ไม่ต้องเตือนเรื่องใบส่งงาน/บิล (ไม่ได้เก็บวันที่ใบเสร็จไว้)', async () => {
    const { service, slipFind, invoiceFind } = setup();
    const res = await service.updateReceiptFields('sub1', { receiptDate: '2026-09-21', remark: 'x' });
    expect(slipFind).not.toHaveBeenCalled();
    expect(invoiceFind).not.toHaveBeenCalled();
    expect(res).toMatchObject({ liveSlips: [], liveInvoices: [] });
  });

  // พบ 2026-09-27: Step 6/7 บังคับวันที่รับป้าย/เล่ม >= วันที่ในใบเสร็จ แต่หน้าแก้ใบเสร็จเลื่อนวันที่ในใบเสร็จไปหลังวันรับได้
  it('วันที่ในใบเสร็จเลื่อนไปหลังวันที่รับป้าย/รับเล่มที่บันทึกแล้วไม่ได้', async () => {
    const plate = setup({ plateReceivedDate: '2026-09-22' });
    await expect(plate.service.updateReceiptFields('sub1', { receiptDate: '2026-09-23', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'วันที่ในใบเสร็จต้องไม่หลังวันที่รับป้าย (22/09/2026)' },
    });
    expect(plate.updateMany).not.toHaveBeenCalled();
    await expect(setup({ bookReceivedDate: '2026-09-21' }).service.updateReceiptFields('sub1', { receiptDate: '2026-09-22', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'วันที่ในใบเสร็จต้องไม่หลังวันที่รับเล่ม (21/09/2026)' },
    });
    // วันเดียวกับวันที่รับป้ายได้ · แก้อย่างอื่นโดยวันที่ในใบเสร็จไม่เปลี่ยน ไม่ติดตรวจนี้
    const same = setup({ plateReceivedDate: '2026-09-22' });
    await same.service.updateReceiptFields('sub1', { receiptDate: '2026-09-22', remark: 'x' });
    expect(same.updateMany).toHaveBeenCalled();
    const old = setup({ receiptDate: '2026-09-23', plateReceivedDate: '2026-09-22' });
    await old.service.updateReceiptFields('sub1', { receiptNo: '69/0000009', remark: 'x' });
    expect(old.updateMany).toHaveBeenCalled();
  });

  it('ไม่มีเหตุผล / ยังไม่ได้ใบเสร็จ / ไม่มีอะไรเปลี่ยน / ทะเบียนผิดรูป แก้ไม่ได้', async () => {
    await expect(setup().service.updateReceiptFields('sub1', { receiptNo: '1/2', remark: ' ' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('เหตุผล') },
    });
    await expect(setup({ status: 'PENDING' }).service.updateReceiptFields('sub1', { receiptNo: '1/2', remark: 'x' })).rejects.toMatchObject({
      response: { error: 'แก้ข้อมูลใบเสร็จได้เฉพาะรายการที่ได้ใบเสร็จแล้ว' },
    });
    await expect(
      setup().service.updateReceiptFields('sub1', { plateCategory: '1กข', plateNumber: '1234', receiptNo: '69/0000001', remark: 'x' }),
    ).rejects.toMatchObject({ response: { error: 'ข้อมูลไม่ได้เปลี่ยน' } });
    await expect(setup().service.updateReceiptFields('sub1', { plateNumber: '', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('หมวดทะเบียนและเลขทะเบียน') },
    });
    await expect(setup().service.updateReceiptFields('sub1', { plateNumber: '12345', remark: 'x' })).rejects.toMatchObject({
      response: { error: expect.stringContaining('เลขทะเบียน') },
    });
  });

  it('แก้ได้เฉพาะประเภทรถของตัวเอง', async () => {
    const { service, updateMany } = setup({ body: 'รย.12-รถจักรยานยนต์' });
    await expect(
      requestContext.run({ user: { id: 'u1', roles: ['STAFF_CAR'], customerId: null, name: 'ทดสอบ' } }, () =>
        service.updateReceiptFields('sub1', { receiptNo: '1/2', remark: 'x' }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(updateMany).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: วันที่รับบันทึกไว้ก่อนวันยื่น -> วันที่ในใบเสร็จแก้ไม่ได้อีกเลย ทางแก้คือแก้วันที่รับที่นี่
  it('วันที่รับใบเสร็จ: แก้ได้ในช่วงวันที่ยื่นถึงวันนี้ และต้องไม่ก่อนวันที่ในใบเสร็จ', async () => {
    const ok = setup({ receiptReceivedDate: '2026-08-27' });
    await ok.service.updateReceiptFields('sub1', { receiptReceivedDate: '2026-09-25', remark: 'พิมพ์เดือนผิด' });
    expect(ok.updateMany.mock.calls[0][0].data.receiptReceivedDate).toEqual(new Date('2026-09-25T00:00:00.000Z'));
    expect(JSON.parse(ok.logCreate.mock.calls[0][0].data.changes)).toEqual({
      'submission.receiptReceivedDate': { from: '2026-08-27', to: '2026-09-25' },
    });

    const cases: Array<[Record<string, unknown>, string]> = [
      [{ receiptReceivedDate: '2026-09-19' }, 'วันที่รับใบเสร็จต้องไม่ก่อนวันที่ยื่นเอกสาร (20/09/2026)'],
      [{ receiptReceivedDate: '2026-09-27' }, 'วันที่รับใบเสร็จต้องไม่เกินวันนี้'],
      [{ receiptReceivedDate: '25/09/2026' }, 'วันที่รับใบเสร็จต้องเป็น'],
    ];
    for (const [fields, message] of cases) {
      await expect(setup().service.updateReceiptFields('sub1', { ...fields, remark: 'x' })).rejects.toMatchObject({
        response: { error: expect.stringContaining(message) },
      });
    }
    // วันที่ในใบเสร็จ 22/09 -> วันที่รับเลื่อนมาก่อนนั้นไม่ได้
    await expect(
      setup({ receiptDate: '2026-09-22' }).service.updateReceiptFields('sub1', { receiptReceivedDate: '2026-09-21', remark: 'x' }),
    ).rejects.toMatchObject({ response: { error: expect.stringContaining('ไม่หลังวันที่รับใบเสร็จ (21/09/2026)') } });
  });

  it('แก้วันที่ในใบเสร็จพร้อมวันที่รับได้ในครั้งเดียว (ตรวจด้วยค่าใหม่ทั้งคู่)', async () => {
    const { service, updateMany } = setup({ receiptDate: '2026-09-25', receiptReceivedDate: '2026-09-26' });
    await service.updateReceiptFields('sub1', { receiptDate: '22/09/2569', receiptReceivedDate: '2026-09-23', remark: 'x' });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      receiptDate: new Date('2026-09-22T00:00:00.000Z'),
      receiptReceivedDate: new Date('2026-09-23T00:00:00.000Z'),
    });
  });

  it('แก้แค่ทะเบียนของแถวเก่าที่วันที่ไม่สมเหตุสมผล -> ไม่ติดตรวจวันที่ (วันที่ไม่ได้เปลี่ยน)', async () => {
    const { service, vehicleUpdate } = setup({ receiptReceivedDate: '2026-09-10' });
    await service.updateReceiptFields('sub1', {
      plateCategory: '1กค',
      plateNumber: '1234',
      receiptDate: '2026-09-20',
      receiptReceivedDate: '2026-09-10',
      remark: 'x',
    });
    expect(vehicleUpdate).toHaveBeenCalled();
  });
});

describe('DocumentSubmissionService.listByDate - ตาราง "ได้ใบเสร็จแล้ว"', () => {
  function setup(rows: unknown[] = []) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = mockPrisma({ documentSubmission: { findMany } });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), findMany };
  }

  it('กรองประเภทรถก่อนตัดจำนวน + ค้นหา + โหลดเพิ่ม (hasMore)', async () => {
    const { service, findMany } = setup(Array.from({ length: 101 }, (_, i) => ({ id: `s${i}` })));
    const res = await service.listByDate(undefined, 'RECEIPT_RECEIVED', { kind: 'moto', q: '69/00', offset: '100' });
    const args = findMany.mock.calls[0][0];
    expect(args).toMatchObject({ skip: 100, take: 101 });
    expect(args.where.status).toBe('RECEIPT_RECEIVED');
    expect(args.where.AND).toContainEqual({ vehicle: { AND: [{ OR: [{ body: { startsWith: 'รย.12-' } }, { body: { startsWith: 'รย.17-' } }] }] } });
    expect(JSON.stringify(args.where.AND)).toContain('"receiptNo":{"contains":"69/00"');
    expect(res.submissions).toHaveLength(100);
    expect(res.hasMore).toBe(true);
    // พบ 2026-09-27: เรียงรองด้วย updatedAt แล้วแก้ใบเสร็จทำให้แถวย้าย "โหลดเพิ่ม" ข้ามแถว - ใช้ค่าที่ไม่เปลี่ยน + id ให้ลำดับตายตัว
    expect(args.orderBy).toEqual([{ receiptReceivedDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }]);
  });

  it('ส่งวันที่ตรวจผ่านของรถมาด้วย (หน้ายกเลิกรายการเตือนผลตรวจหมดอายุ)', async () => {
    const { service, findMany } = setup();
    await service.listByDate('2026-09-19');
    expect(findMany.mock.calls[0][0].include.vehicle.select).toMatchObject({ inspectionResultDate: true });
  });

  it('ส่งรหัสลูกค้ามาด้วย - กุญแจใบยื่น/ใบส่งงานเป็นรหัสลูกค้า ชื่อซ้ำกันได้ (ผู้ใช้ 2026-09-27)', async () => {
    const { service, findMany } = setup();
    await service.listByDate('2026-09-19');
    expect(findMany.mock.calls[0][0].include.vehicle.select.customer).toEqual({ select: { id: true, name: true, company: true, branch: true } });
  });

  it('kind / offset ผิดรูปแบบ -> 400', async () => {
    const { service } = setup();
    await expect(service.listByDate(undefined, 'RECEIPT_RECEIVED', { kind: 'truck' })).rejects.toMatchObject({ status: 400 });
    await expect(service.listByDate(undefined, 'RECEIPT_RECEIVED', { offset: '-1' })).rejects.toMatchObject({ status: 400 });
  });
});
