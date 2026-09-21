import { vi } from 'vitest';
import { DocumentSubmissionService } from './document-submission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';

const VEHICLE = {
  id: 'v1',
  body: 'รย.1-เก๋ง 2 ตอน',
  registrationProvince: 'กรุงเทพมหานคร',
  ownerProvince: 'กรุงเทพมหานคร',
  // มีเจ้าของรถอยู่แล้ว - ยื่นได้โดยไม่ต้องส่ง ownerType (ดูเทสต์ "ต้องระบุประเภทเจ้าของรถ" ด้านล่าง)
  ownerId: 'owner1',
  // ผ่าน Step 2 + ตรวจผ่านเมื่อ 10 วันก่อนวันที่ยื่นใน OPTIONS (2026-09-19) - ยื่นได้
  transferDone: true,
  inspectionSentDate: new Date('2026-09-08T00:00:00.000Z'),
  inspectionResult: 'ผ่าน',
  inspectionResultDate: new Date('2026-09-09T00:00:00.000Z'),
};

function mockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    vehicle: { findUnique: vi.fn().mockResolvedValue(VEHICLE), update: vi.fn().mockResolvedValue(VEHICLE) },
    documentSubmission: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn(),
      create: vi.fn().mockResolvedValue({ id: 'sub1', status: 'PENDING' }),
      update: vi.fn(),
    },
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
    ...overrides,
  } as unknown as PrismaService;
}

function mockTaxService(): TaxService {
  return { calculateAndSave: vi.fn().mockResolvedValue({ finalAmount: null }) } as unknown as TaxService;
}

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
      vehicle: { findUnique: vi.fn().mockResolvedValue({ ...VEHICLE, ...vehicle }), update: vi.fn() },
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()) };
  }

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
    const { service } = withVehicle({ ownerId: null });
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
});

describe('DocumentSubmissionService.updateStatus', () => {
  const pendingSubmission = (plate: { plateCategory: string | null; plateNumber: string | null } = { plateCategory: null, plateNumber: null }) => ({
    id: 'sub1',
    vehicleId: 'v1',
    status: 'PENDING',
    vehicle: plate,
  });

  function setup(submission: unknown) {
    const submissionUpdate = vi.fn().mockImplementation(async ({ data }) => ({ id: 'sub1', ...data }));
    const vehicleUpdate = vi.fn().mockResolvedValue({});
    const prisma = mockPrisma({
      vehicle: { findUnique: vi.fn(), update: vehicleUpdate },
      documentSubmission: { findFirst: vi.fn(), findUnique: vi.fn().mockResolvedValue(submission), create: vi.fn(), update: submissionUpdate },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), submissionUpdate, vehicleUpdate };
  }

  it('ปฏิเสธ status ที่ไม่ใช่ RECEIPT_RECEIVED หรือ FAILED', async () => {
    const { service } = setup(pendingSubmission());
    await expect(service.updateStatus('sub1', 'PENDING')).rejects.toMatchObject({
      response: { error: expect.stringContaining('RECEIPT_RECEIVED') },
    });
  });

  it('ปฏิเสธถ้ารายการนั้นอัปเดตสถานะไปแล้ว (ไม่ใช่ PENDING)', async () => {
    const { service } = setup({ ...pendingSubmission(), status: 'RECEIPT_RECEIVED' });
    await expect(service.updateStatus('sub1', 'FAILED')).rejects.toMatchObject({
      response: { error: expect.stringContaining('อัปเดตสถานะไปแล้ว') },
    });
  });

  it('รับใบเสร็จ: บันทึกเลขทะเบียนลงรถ + วันที่ + ยอด + เลขที่ใบเสร็จ', async () => {
    const { service, submissionUpdate, vehicleUpdate } = setup(pendingSubmission());
    const result = await service.updateStatus('sub1', 'RECEIPT_RECEIVED', '2026-09-20', {
      plateCategory: '4กข',
      plateNumber: '1234',
      receiptAmount: '355.50',
      receiptNo: ' 69/0035358 ',
    });
    expect(result.status).toBe('RECEIPT_RECEIVED');
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateCategory: '4กข', plateNumber: '1234' } });
    expect(submissionUpdate).toHaveBeenCalledWith({
      where: { id: 'sub1' },
      data: { status: 'RECEIPT_RECEIVED', receiptReceivedDate: new Date('2026-09-20T00:00:00.000Z'), receiptAmount: 355.5, receiptNo: '69/0035358' },
    });
  });

  it('รับใบเสร็จไม่ได้ถ้ายังไม่มีเลขทะเบียนทั้งในคำขอและในรถ', async () => {
    const { service, submissionUpdate } = setup(pendingSubmission());
    await expect(service.updateStatus('sub1', 'RECEIPT_RECEIVED', '2026-09-20')).rejects.toMatchObject({
      response: { error: expect.stringContaining('เลขทะเบียน') },
    });
    expect(submissionUpdate).not.toHaveBeenCalled();
  });

  it('รับใบเสร็จได้โดยไม่ต้องส่งเลขทะเบียนซ้ำ ถ้ารถมีเลขทะเบียนอยู่แล้ว', async () => {
    const { service, vehicleUpdate } = setup(pendingSubmission({ plateCategory: '1กข', plateNumber: '99' }));
    await service.updateStatus('sub1', 'RECEIPT_RECEIVED', '2026-09-20');
    expect(vehicleUpdate).toHaveBeenCalledWith({ where: { id: 'v1' }, data: { plateCategory: '1กข', plateNumber: '99' } });
  });

  it('ยื่นไม่สำเร็จ: ไม่ต้องมีเลขทะเบียน ไม่แตะข้อมูลรถ และบันทึกเหตุผล', async () => {
    const { service, vehicleUpdate, submissionUpdate } = setup(pendingSubmission());
    const result = await service.updateStatus('sub1', 'FAILED', undefined, { failRemark: '  เอกสารไม่ครบ  ' });
    expect(result.status).toBe('FAILED');
    expect(vehicleUpdate).not.toHaveBeenCalled();
    expect(submissionUpdate).toHaveBeenCalledWith({
      where: { id: 'sub1' },
      data: { status: 'FAILED', receiptReceivedDate: null, failRemark: 'เอกสารไม่ครบ' },
    });
  });

  it.each([undefined, '', '   '])('ยื่นไม่สำเร็จ: ต้องมีเหตุผลเสมอ (%j)', async (failRemark) => {
    const { service, submissionUpdate } = setup(pendingSubmission());
    await expect(service.updateStatus('sub1', 'FAILED', undefined, { failRemark })).rejects.toMatchObject({
      response: { error: expect.stringContaining('เหตุผลที่ยื่นไม่สำเร็จ') },
    });
    expect(submissionUpdate).not.toHaveBeenCalled();
  });

  it.each([
    [{ plateCategory: '4กขคง', plateNumber: '1234' }, 'หมวดทะเบียน'],
    [{ plateCategory: '4กข', plateNumber: '12345' }, 'เลขทะเบียน'],
    [{ plateCategory: '4กข', plateNumber: 'ab12' }, 'เลขทะเบียน'],
    [{ plateCategory: '4กข', plateNumber: '1234', receiptAmount: '-5' }, 'ยอดใบเสร็จ'],
    [{ plateCategory: '4กข', plateNumber: '1234', receiptAmount: '10.123' }, 'ยอดใบเสร็จ'],
  ])('ปฏิเสธข้อมูลรูปแบบผิด %j', async (extras, expected) => {
    const { service, submissionUpdate } = setup(pendingSubmission());
    await expect(service.updateStatus('sub1', 'RECEIPT_RECEIVED', '2026-09-20', extras)).rejects.toMatchObject({
      response: { error: expect.stringContaining(expected) },
    });
    expect(submissionUpdate).not.toHaveBeenCalled();
  });
});

describe('DocumentSubmissionService.saveReceiptCheck - บันทึกทั้งใบยื่น', () => {
  function setup(photoCount: number) {
    const submissionUpdate = vi.fn().mockImplementation(async ({ data }) => ({ id: 'sub1', ...data }));
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const prisma = mockPrisma({
      vehicle: { findUnique: vi.fn(), update: vi.fn().mockResolvedValue({}) },
      documentSubmission: {
        findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 'sub1', vehicleId: 'v1', status: 'PENDING', vehicle: { plateCategory: null, plateNumber: null } }),
        create: vi.fn(),
        update: submissionUpdate,
        updateMany,
      },
      receiptImage: { count: vi.fn().mockResolvedValue(photoCount) },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    });
    return { service: new DocumentSubmissionService(prisma, mockTaxService()), submissionUpdate, updateMany };
  }

  it('ได้รับใบเสร็จต้องแนบรูปก่อน - ไม่มีรูปคืนเหตุผล ไม่บันทึก', async () => {
    const { service, submissionUpdate } = setup(0);
    const res = await service.saveReceiptCheck({
      receivedDate: '2026-09-20',
      entries: [{ submissionId: 'sub1', action: 'RECEIVED', plateCategory: '8ขก', plateNumber: '3484' }],
    });
    expect(res.failed[0].error).toContain('แนบรูปใบเสร็จ');
    expect(submissionUpdate).not.toHaveBeenCalled();
  });

  it('มีรูปแล้วบันทึกว่าได้รับใบเสร็จพร้อมทะเบียน', async () => {
    const { service, submissionUpdate } = setup(1);
    const res = await service.saveReceiptCheck({
      receivedDate: '2026-09-20',
      entries: [{ submissionId: 'sub1', action: 'RECEIVED', plateCategory: '8ขก', plateNumber: '3484', receiptAmount: '1955' }],
    });
    expect(res.succeeded).toEqual(['sub1']);
    expect(submissionUpdate.mock.calls[0][0].data).toMatchObject({ status: 'RECEIPT_RECEIVED', receiptAmount: 1955 });
  });

  it('ยื่นไม่สำเร็จเก็บสาเหตุ / ค้างไว้ย้ายไปค้างจากใบก่อน', async () => {
    const { service, submissionUpdate, updateMany } = setup(0);
    const failed = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub1', action: 'FAILED', failRemark: 'บัตรประชาชนหมดอายุ' }] });
    expect(failed.succeeded).toEqual(['sub1']);
    expect(submissionUpdate.mock.calls[0][0].data).toMatchObject({ status: 'FAILED', failRemark: 'บัตรประชาชนหมดอายุ' });

    const carried = await service.saveReceiptCheck({ entries: [{ submissionId: 'sub2', action: 'CARRY' }] });
    expect(carried.succeeded).toEqual(['sub2']);
    expect(updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'sub2', status: 'PENDING' } });
  });
});
