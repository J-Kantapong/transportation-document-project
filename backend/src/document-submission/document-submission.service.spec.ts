import { vi } from 'vitest';
import { DocumentSubmissionService } from './document-submission.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TaxService } from '../tax/tax.service.js';

const VEHICLE = {
  id: 'v1',
  body: 'รย.1-เก๋ง 2 ตอน',
  registrationProvince: 'กรุงเทพมหานคร',
  ownerProvince: 'กรุงเทพมหานคร',
  ownerId: null,
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

describe('DocumentSubmissionService.submit - บล็อกยื่นซ้ำระหว่างรอใบเสร็จ', () => {
  it('ยื่นไม่ได้ถ้ายื่นครั้งล่าสุดยังค้างสถานะ PENDING', async () => {
    const prisma = mockPrisma({
      documentSubmission: {
        findFirst: vi.fn().mockResolvedValue({ id: 'sub0', status: 'PENDING' }),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());

    await expect(service.submit('v1', OPTIONS)).rejects.toMatchObject({
      response: { error: expect.stringContaining('รอใบเสร็จ') },
    });
  });

  it.each(['RECEIPT_RECEIVED', 'FAILED'])('ยื่นได้ปกติถ้ายื่นครั้งล่าสุดมีสถานะ %s แล้ว', async (status) => {
    const prisma = mockPrisma({
      documentSubmission: {
        findFirst: vi.fn().mockResolvedValue({ id: 'sub0', status }),
        findUnique: vi.fn(),
        create: vi.fn().mockResolvedValue({ id: 'sub1', status: 'PENDING' }),
        update: vi.fn(),
      },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());

    const result = await service.submit('v1', OPTIONS);
    expect(result.submission).toEqual({ id: 'sub1', status: 'PENDING' });
  });

  it('ยื่นได้ปกติถ้ายังไม่เคยยื่นเลย (ไม่มี DocumentSubmission ก่อนหน้า)', async () => {
    const prisma = mockPrisma();
    const service = new DocumentSubmissionService(prisma, mockTaxService());

    const result = await service.submit('v1', OPTIONS);
    expect(result.submission).toEqual({ id: 'sub1', status: 'PENDING' });
  });
});

describe('DocumentSubmissionService.updateStatus', () => {
  it('ปฏิเสธ status ที่ไม่ใช่ RECEIPT_RECEIVED หรือ FAILED', async () => {
    const service = new DocumentSubmissionService(mockPrisma(), mockTaxService());
    await expect(service.updateStatus('sub1', 'PENDING')).rejects.toMatchObject({
      response: { error: expect.stringContaining('RECEIPT_RECEIVED') },
    });
  });

  it('ปฏิเสธถ้ารายการนั้นอัปเดตสถานะไปแล้ว (ไม่ใช่ PENDING)', async () => {
    const prisma = mockPrisma({
      documentSubmission: {
        findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 'sub1', status: 'RECEIPT_RECEIVED' }),
        create: vi.fn(),
        update: vi.fn(),
      },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    await expect(service.updateStatus('sub1', 'FAILED')).rejects.toMatchObject({
      response: { error: expect.stringContaining('อัปเดตสถานะไปแล้ว') },
    });
  });

  it('อัปเดตสำเร็จจากสถานะ PENDING', async () => {
    const updateMock = vi.fn().mockResolvedValue({ id: 'sub1', status: 'RECEIPT_RECEIVED' });
    const prisma = mockPrisma({
      documentSubmission: {
        findFirst: vi.fn(),
        findUnique: vi.fn().mockResolvedValue({ id: 'sub1', status: 'PENDING' }),
        create: vi.fn(),
        update: updateMock,
      },
    });
    const service = new DocumentSubmissionService(prisma, mockTaxService());
    const result = await service.updateStatus('sub1', 'RECEIPT_RECEIVED');
    expect(result.status).toBe('RECEIPT_RECEIVED');
    expect(updateMock).toHaveBeenCalledWith({ where: { id: 'sub1' }, data: { status: 'RECEIPT_RECEIVED' } });
  });
});
