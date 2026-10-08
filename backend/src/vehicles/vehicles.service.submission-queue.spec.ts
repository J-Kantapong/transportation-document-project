import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehiclesService } from './vehicles.service.js';

// คิวยื่นเอกสาร (Step 4) - ผู้ใช้ 2026-09-27:
// - F19: คิว/ค้นเลขตัวถังตรวจ ณ วันที่ยื่นที่ส่งมา (ยื่นใหม่ด้วยวันที่ยื่นเดิมได้) ไม่ใช่วันนี้
// - F51: งานสลับเลขไหนก็ได้ที่ยังเปิดอยู่ล็อกการยื่น (เดิมดูแค่งานล่าสุด) งานที่ยกเลิกแล้วไม่นับ

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    date: day('2026-05-20'),
    customerId: 'c1',
    chassis: 'CH1',
    engine: null,
    brandId: 'b1',
    fuel: null,
    cc: null,
    weight: null,
    color: null,
    body: 'รย.1-เก๋ง 2 ตอน',
    registrationProvince: 'กรุงเทพมหานคร',
    ownerProvince: 'กรุงเทพมหานคร',
    createdAt: day('2026-05-20'),
    customer: { name: 'ลูกค้า' },
    brand: { name: 'TOYOTA' },
    firstRegistrationDate: null,
    isFactoryNew: null,
    ownerId: null,
    owner: null,
    plateCategory: null,
    plateNumber: null,
    documentSubmissions: [] as Array<{ status: string }>,
    transferDone: true,
    inspectionSentDate: day('2026-05-30'),
    inspectionResult: 'ผ่าน',
    inspectionResultDate: day('2026-06-01'), // ยื่นได้ถึง 2026-08-29
    ...overrides,
  };
}

function swap(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    newVehicleId: 'v1',
    oldOwnerName: 'เจ้าของเก่า',
    oldPlateCategory: '1กข',
    oldPlateNumber: '1234',
    newPlateCategory: '9ขค',
    newPlateNumber: '5678',
    submitDate: day('2026-06-02'),
    returnedDate: null as Date | null,
    ...overrides,
  };
}

function setup(vehicles: unknown[], swaps: unknown[] = []) {
  const findMany = vi.fn().mockResolvedValue(vehicles);
  const swapFindMany = vi.fn().mockResolvedValue(swaps);
  const prisma = {
    vehicle: { findMany },
    plateSwap: { findMany: swapFindMany },
    documentSubmission: { findMany: vi.fn().mockResolvedValue([]) },
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma, {} as never), findMany, swapFindMany };
}

describe('VehiclesService - คิวยื่นเอกสาร ณ วันที่ยื่น (F19)', () => {
  it('คิวของวันที่ยื่นเดิม: ผลตรวจที่หมดอายุแล้ว ณ วันนี้ยังอยู่ในคิวถ้าวันที่ยื่นนั้นยังไม่ครบ 90 วัน', async () => {
    const { service, findMany } = setup([vehicleRow()]);
    const queue = await service.findSubmissionQueue('2026-08-25');
    expect(queue.map((v) => v.id)).toEqual(['v1']);
    const where = findMany.mock.calls[0][0].where;
    expect(where.AND[0].OR[0]).toEqual({ inspectionResult: 'ผ่าน', inspectionResultDate: { gte: day('2026-05-28'), lte: day('2026-08-25') } });
  });

  // ผู้ใช้ 2026-10-08: จังหวัดอื่นนอกจากกรุงเทพฯ/สมุทรปราการ ส่งซับจด - แจ้งย้ายเสร็จแล้วเข้าคิวยื่นเลย ไม่ต้องตรวจรถ
  it('รถที่ส่งซับจดต่างจังหวัดอยู่ในคิวโดยไม่มีผลตรวจ ส่วนรถกรุงเทพฯ ที่ยังไม่ตรวจไม่อยู่', async () => {
    const notInspected = { inspectionSentDate: null, inspectionResult: null, inspectionResultDate: null, transferCompletedDate: day('2026-06-01') };
    const { service, findMany } = setup([
      vehicleRow({ id: 'supplier', chassis: 'CH2', registrationProvince: 'เชียงใหม่', ...notInspected }),
      vehicleRow({ id: 'bangkok', chassis: 'CH3', ...notInspected }),
    ]);
    const queue = await service.findSubmissionQueue('2026-06-10');
    expect(queue.map((v) => v.id)).toEqual(['supplier']);
    expect(findMany.mock.calls[0][0].where.AND[0].OR[1]).toEqual({
      AND: [{ registrationProvince: { not: null } }, { registrationProvince: { notIn: ['กรุงเทพมหานคร', 'สมุทรปราการ'] } }],
    });
  });

  it('ค้นเลขตัวถัง: บอกเหตุผลตามวันที่ยื่นที่ส่งมา', async () => {
    const { service } = setup([vehicleRow()]);
    const [early] = await service.searchByChassis('CH1', '2026-08-29');
    expect(early.submitBlockReason).toBeNull();
    const [late] = await service.searchByChassis('CH1', '2026-08-30');
    expect(late.submitBlockReason).toContain('ผลตรวจรถหมดอายุ');
  });
});

describe('VehiclesService - งานสลับเลขในคิวยื่นเอกสาร (F20/F51)', () => {
  it('ไม่นับงานที่ยกเลิก และเรียงงานที่ยังไม่รับเอกสารกลับขึ้นก่อน', async () => {
    const { service, swapFindMany } = setup([vehicleRow()]);
    await service.findSubmissionQueue('2026-06-10');
    expect(swapFindMany.mock.calls[0][0]).toMatchObject({
      where: { newVehicleId: { in: ['v1'] }, cancelledAt: null },
      orderBy: [{ returnedDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
    });
  });

  it('มีงานที่ยังเปิดอยู่แม้งานใหม่กว่ารับกลับแล้ว = ไม่อยู่ในคิว / ค้นเลขตัวถังบอกเหตุผล', async () => {
    // ลำดับที่ฐานข้อมูลคืนตาม orderBy: งานที่ยังเปิดอยู่ก่อน
    const swaps = [swap({ id: 'open' }), swap({ id: 'returned', returnedDate: day('2026-06-05') })];
    const { service } = setup([vehicleRow()], swaps);
    await expect(service.findSubmissionQueue('2026-06-10')).resolves.toEqual([]);
    const [hit] = await service.searchByChassis('CH1', '2026-06-10');
    expect(hit.submitBlockReason).toContain('งานสลับเลข');
    expect(hit.plateSwap?.id).toBe('open');
  });

  it('รับเอกสารกลับครบแล้ว = อยู่ในคิว พร้อมทะเบียนเก่าของรถเก่าให้หน้ายื่นเติมให้', async () => {
    const { service } = setup([vehicleRow()], [swap({ returnedDate: day('2026-06-05') })]);
    const [v] = await service.findSubmissionQueue('2026-06-10');
    expect(v.plateSwap).toMatchObject({ oldPlateCategory: '1กข', oldPlateNumber: '1234', returnedDate: '2026-06-05' });
  });
});
