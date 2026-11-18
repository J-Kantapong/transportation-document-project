import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { OldVehicleJobsService } from './old-vehicle-jobs.service.js';

// sync(): ผูกงานจริงกับแถวรับงาน / สร้างแถวย้อนหลัง - ส่วนที่เสี่ยงที่สุดของหน้ารวมงานรถเก่า (ไม่มี UI ให้เห็นว่าผูกผิด)
const d = (iso: string) => new Date(`${iso}T03:00:00.000Z`);

interface RawJob {
  id: string;
  chassis: string;
  createdAt: Date;
  transferType?: string;
  vehicleType?: string | null;
}
const raw = (o: RawJob) => ({
  vehicleClass: 'MOTO',
  vehicleType: null,
  customerId: 'cust1',
  ownerName: 'เจ้าของ',
  engine: 'E1',
  brand: 'Honda',
  plateCategory: '1กก',
  plateNumber: '1',
  createdById: 'u1',
  ...o,
});

interface Intake {
  id: string;
  vehicleId: string;
  jobType: string | null;
  createdAt: Date;
  inspectionResult?: string | null;
  inspectionSentDate?: Date | null;
  inspectionSentType?: string | null;
  inspectionCost?: number;
  inspectionResultDate?: Date | null;
}

// ลำดับของ $queryRaw ใน unlinkedJobs: สลับเลข, งานโอน, ต่อภาษี, ยกเลิกการใช้รถ, ย้ายออก, คัดแผ่นป้าย
function makeService(opts: { transfers?: RawJob[]; taxes?: RawJob[]; moveOuts?: RawJob[]; vehicles?: { id: string; chassisKey: string }[]; waiting?: Intake[] }) {
  const sets = [[], (opts.transfers ?? []).map(raw), (opts.taxes ?? []).map(raw), [], (opts.moveOuts ?? []).map(raw), []];
  const vehicles = [...(opts.vehicles ?? [])];
  const jobUpdate = vi.fn().mockResolvedValue({});
  const jobCreateMany = vi.fn(async ({ data }: { data: Record<string, unknown>[] }) => ({ count: data.length }));
  const vehicleCreateMany = vi.fn(async ({ data }: { data: { chassisKey: string }[] }) => {
    for (const v of data) vehicles.push({ id: `new-${v.chassisKey}`, chassisKey: v.chassisKey });
    return { count: data.length };
  });
  const transferUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const taxUpdateMany = vi.fn().mockResolvedValue({ count: 1 });
  const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
  const prisma = {
    $queryRaw: vi.fn().mockImplementation(async () => sets.shift() ?? []),
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
    oldVehicle: { findMany: vi.fn(async () => vehicles), createMany: vehicleCreateMany },
    oldVehicleJob: { findMany: vi.fn(async () => opts.waiting ?? []), update: jobUpdate, createMany: jobCreateMany },
    vehicleTransfer: { updateMany: transferUpdateMany },
    taxRenewal: { updateMany: taxUpdateMany },
    auditLog: { create: auditCreate },
  };
  return { svc: new OldVehicleJobsService(prisma as unknown as PrismaService), jobUpdate, jobCreateMany, vehicleCreateMany, transferUpdateMany, taxUpdateMany, auditCreate };
}

const passed = { inspectionResult: 'PASS', inspectionSentDate: d('2026-11-10'), inspectionSentType: 'OUTSIDE', inspectionCost: 300, inspectionResultDate: d('2026-11-11') };

describe('OldVehicleJobsService.sync', () => {
  it('ไม่มีงานใหม่ = ไม่เขียนอะไร', async () => {
    const { svc, jobUpdate, jobCreateMany, vehicleCreateMany } = makeService({});
    expect(await svc.sync()).toEqual({ linked: 0, backfilled: 0 });
    expect(jobUpdate).not.toHaveBeenCalled();
    expect(jobCreateMany).not.toHaveBeenCalled();
    expect(vehicleCreateMany).not.toHaveBeenCalled();
  });

  it('งานที่คีย์ไว้ก่อนมีหน้ารับงาน -> สร้างรถ + แถวรับงานย้อนหลัง วันที่รับ = วันที่คีย์ตามเวลาไทย', async () => {
    // 2026-10-05 18:30 UTC = 2026-10-06 01:30 เวลาไทย
    const { svc, vehicleCreateMany, jobCreateMany } = makeService({ moveOuts: [{ id: 'm1', chassis: 'abc-123', createdAt: new Date('2026-10-05T18:30:00.000Z') }] });
    expect(await svc.sync()).toEqual({ linked: 0, backfilled: 1 });
    expect(vehicleCreateMany.mock.calls[0][0].data[0]).toMatchObject({ chassis: 'ABC-123', chassisKey: 'ABC123', vehicleClass: 'MOTO', brand: 'Honda' });
    expect(jobCreateMany.mock.calls[0][0]).toMatchObject({
      skipDuplicates: true,
      data: [{ vehicleId: 'new-ABC123', jobType: 'MOVE_OUT', jobId: 'm1', receivedIsBackfill: true, receivedDate: new Date('2026-10-06T00:00:00.000Z'), customerId: 'cust1' }],
    });
  });

  it('งานที่ยื่นจากหน้าเดิมของรถที่รับงานไว้ -> ผูกเข้าแถวรับงานเดิม ไม่สร้างแถวซ้ำ และส่งผลตรวจรถที่ผ่านแล้วไปที่งานโอน', async () => {
    const { svc, jobUpdate, jobCreateMany, transferUpdateMany, auditCreate } = makeService({
      transfers: [{ id: 't1', chassis: 'ABC123', createdAt: d('2026-11-18'), transferType: 'INSPECTION' }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: 'TRANSFER_INSPECTION', createdAt: d('2026-11-09'), ...passed }],
    });
    expect(await svc.sync()).toEqual({ linked: 1, backfilled: 0 });
    expect(jobUpdate).toHaveBeenCalledWith({ where: { id: 'i1', jobId: null, cancelledAt: null }, data: { jobId: 't1', jobType: 'TRANSFER_INSPECTION' } });
    expect(jobCreateMany).not.toHaveBeenCalled();
    // เขียนเฉพาะงานโอนที่ยังไม่มีการส่งตรวจของตัวเอง ยังไม่รับกลับ และไม่ถูกยกเลิก
    expect(transferUpdateMany).toHaveBeenCalledWith({
      where: { id: 't1', cancelledAt: null, returnedDate: null, inspectionSentDate: null },
      data: { inspectionSentDate: passed.inspectionSentDate, inspectionSentType: 'OUTSIDE', inspectionCost: 300, inspectionResult: 'PASS', inspectionResultDate: passed.inspectionResultDate },
    });
    expect(auditCreate.mock.calls[0][0].data).toMatchObject({ entity: 'VehicleTransfer', entityId: 't1', action: 'inspection-from-intake' });
  });

  it('ผลตรวจยังไม่ผ่าน -> ผูกงานแต่ไม่แตะช่องตรวจรถของงานโอน', async () => {
    const { svc, transferUpdateMany } = makeService({
      transfers: [{ id: 't1', chassis: 'ABC123', createdAt: d('2026-11-18'), transferType: 'INSPECTION' }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: 'TRANSFER_INSPECTION', createdAt: d('2026-11-09'), ...passed, inspectionResult: 'FAIL' }],
    });
    expect((await svc.sync()).linked).toBe(1);
    expect(transferUpdateMany).not.toHaveBeenCalled();
  });

  it('ต่อภาษี: รถทั่วไปติ๊กมีใบตรวจ / รถ ขส. ใส่วันที่ตรวจ', async () => {
    const normal = makeService({
      taxes: [{ id: 'x1', chassis: 'ABC123', createdAt: d('2026-11-18'), vehicleType: 'รย.1-เก๋ง 2 ตอน' }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: 'TAX_RENEWAL', createdAt: d('2026-11-09'), ...passed }],
    });
    await normal.svc.sync();
    expect(normal.taxUpdateMany).toHaveBeenCalledWith({ where: { id: 'x1', cancelledAt: null, inspectionConfirmed: false }, data: { inspectionConfirmed: true } });

    const transport = makeService({
      taxes: [{ id: 'x2', chassis: 'TRUCK1', createdAt: d('2026-11-18'), vehicleType: 'ขส.-ส่วนบุคคล' }],
      vehicles: [{ id: 'v2', chassisKey: 'TRUCK1' }],
      waiting: [{ id: 'i2', vehicleId: 'v2', jobType: 'TAX_RENEWAL', createdAt: d('2026-11-09'), ...passed }],
    });
    await transport.svc.sync();
    expect(transport.taxUpdateMany).toHaveBeenCalledWith({
      where: { id: 'x2', cancelledAt: null, paymentDate: null, inspectionDate: null },
      data: { inspectionDate: passed.inspectionResultDate, inspectionConfirmed: true },
    });
  });

  it('แถวรับงานที่ยังไม่เลือกประเภทงาน (รอทำ) รับงานที่ยื่นจากหน้าเดิมไปเป็นของตัวเอง', async () => {
    const { svc, jobUpdate, jobCreateMany } = makeService({
      moveOuts: [{ id: 'm1', chassis: 'ABC123', createdAt: d('2026-11-18') }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: null, createdAt: d('2026-11-09') }],
    });
    expect(await svc.sync()).toEqual({ linked: 1, backfilled: 0 });
    expect(jobUpdate.mock.calls[0][0].data).toEqual({ jobId: 'm1', jobType: 'MOVE_OUT' });
    expect(jobCreateMany).not.toHaveBeenCalled();
  });

  it('รับงานเป็นโอนแบบหนึ่งแต่ยื่นจริงอีกแบบ -> ยังผูกกับแถวรับงานงานโอนเดิม และเปลี่ยนประเภทตามงานจริง', async () => {
    const { svc, jobUpdate } = makeService({
      transfers: [{ id: 't1', chassis: 'ABC123', createdAt: d('2026-11-18'), transferType: 'INSPECTION' }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: 'TRANSFER_OWNER', createdAt: d('2026-11-09') }],
    });
    expect((await svc.sync()).linked).toBe(1);
    expect(jobUpdate.mock.calls[0][0].data).toEqual({ jobId: 't1', jobType: 'TRANSFER_INSPECTION' });
  });

  it('เลือกแถวรับงานที่ประเภทงานตรงกันก่อนแถวที่ยังไม่เลือกประเภท และงานคนละประเภทไม่ถูกผูกผิด', async () => {
    const { svc, jobUpdate, jobCreateMany } = makeService({
      moveOuts: [{ id: 'm1', chassis: 'ABC123', createdAt: d('2026-11-18') }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [
        { id: 'tax', vehicleId: 'v1', jobType: 'TAX_RENEWAL', createdAt: d('2026-11-01') },
        { id: 'untyped', vehicleId: 'v1', jobType: null, createdAt: d('2026-11-02') },
        { id: 'exact', vehicleId: 'v1', jobType: 'MOVE_OUT', createdAt: d('2026-11-03') },
      ],
    });
    await svc.sync();
    expect(jobUpdate.mock.calls[0][0].where.id).toBe('exact');
    expect(jobCreateMany).not.toHaveBeenCalled();
  });

  it('แถวรับงานที่สร้างหลังงาน (รับงานรอบใหม่ของคันเดิม) ไม่ถูกผูกกับงานเก่า -> งานเก่าได้แถวย้อนหลัง', async () => {
    const { svc, jobUpdate, jobCreateMany } = makeService({
      moveOuts: [{ id: 'm1', chassis: 'ABC123', createdAt: d('2026-10-01') }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'later', vehicleId: 'v1', jobType: 'MOVE_OUT', createdAt: d('2026-11-09') }],
    });
    expect(await svc.sync()).toEqual({ linked: 0, backfilled: 1 });
    expect(jobUpdate).not.toHaveBeenCalled();
    expect(jobCreateMany.mock.calls[0][0].data[0]).toMatchObject({ jobId: 'm1', receivedIsBackfill: true });
  });

  it('สองงานของคันเดียวกัน ผูกได้แถวรับงานละงาน งานที่เหลือได้แถวย้อนหลัง', async () => {
    const { svc, jobUpdate, jobCreateMany } = makeService({
      moveOuts: [
        { id: 'm1', chassis: 'ABC123', createdAt: d('2026-11-10') },
        { id: 'm2', chassis: 'ABC123', createdAt: d('2026-11-12') },
      ],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: 'MOVE_OUT', createdAt: d('2026-11-09') }],
    });
    expect(await svc.sync()).toEqual({ linked: 1, backfilled: 1 });
    expect(jobUpdate.mock.calls[0][0].data.jobId).toBe('m1'); // งานที่ยื่นก่อนผูกก่อน
    expect(jobCreateMany.mock.calls[0][0].data[0].jobId).toBe('m2');
  });

  it('อีกคำขอผูกงานนี้ไปก่อน (unique ชน) = ข้าม ไม่ล้ม', async () => {
    const { svc, jobUpdate } = makeService({
      moveOuts: [{ id: 'm1', chassis: 'ABC123', createdAt: d('2026-11-18') }],
      vehicles: [{ id: 'v1', chassisKey: 'ABC123' }],
      waiting: [{ id: 'i1', vehicleId: 'v1', jobType: 'MOVE_OUT', createdAt: d('2026-11-09') }],
    });
    jobUpdate.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002' }));
    expect(await svc.sync()).toEqual({ linked: 0, backfilled: 0 });
  });
});

// ---- สิทธิ์รับงาน + บังคับรับงานก่อนยื่น (ผู้ใช้ 2026-11-18) ----
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';

const asRole = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

describe('OldVehicleJobsService - ใครรับงานได้', () => {
  const svc = () => new OldVehicleJobsService({ customer: { findUnique: vi.fn().mockResolvedValue(null) } } as unknown as PrismaService);

  it('STAFF_CAR / STAFF_MOTO / ACCOUNTANT รับงานใหม่ไม่ได้ (403)', async () => {
    for (const roles of [['STAFF_CAR'], ['STAFF_MOTO'], ['STAFF_CAR', 'STAFF_MOTO'], ['ACCOUNTANT']] as UserRole[][]) {
      await expect(asRole(roles, () => svc().intake({ customerId: 'c1', receivedDate: '2026-11-18', vehicles: [] }))).rejects.toMatchObject({ status: 403 });
    }
  });

  it('ADMIN / STAFF_ENTRY / DELIVERY ผ่านด่านสิทธิ์ (ไปติดที่การตรวจข้อมูลแทน = 400)', async () => {
    for (const roles of [['ADMIN'], ['STAFF_ENTRY'], ['DELIVERY'], ['STAFF_CAR', 'DELIVERY']] as UserRole[][]) {
      await expect(asRole(roles, () => svc().intake({ customerId: 'ไม่มี', receivedDate: '2026-11-18', vehicles: [] }))).rejects.toMatchObject({ status: 400 });
    }
  });
});

describe('OldVehicleJobsService.assertIntakeBeforeSubmit', () => {
  const make = (rows: { inspectionRequired: boolean; inspectionResult: string | null }[]) => {
    const findMany = vi.fn().mockResolvedValue(rows);
    const vehicleFind = vi.fn().mockResolvedValue({ chassis: 'FROMDB1' });
    const svc = new OldVehicleJobsService({ oldVehicleJob: { findMany }, vehicle: { findFirst: vehicleFind } } as unknown as PrismaService);
    return { svc, findMany, vehicleFind };
  };

  it('ไม่มีแถวรับงานของรถคันนี้ในประเภทงานนี้ = 400 บอกให้ไปรับงานก่อน', async () => {
    const { svc, findMany } = make([]);
    await expect(svc.assertIntakeBeforeSubmit('/api/vehicle-move-outs', { chassis: ' abc 123 ' })).rejects.toMatchObject({ status: 400 });
    expect(findMany.mock.calls[0][0].where).toMatchObject({ cancelledAt: null, jobId: null, jobType: { in: ['MOVE_OUT'] }, vehicle: { chassisKey: 'ABC123' } });
  });

  it('มีแถวรับงานที่ไม่ต้องตรวจรถ หรือตรวจผ่านแล้ว = ยื่นได้ / ต้องตรวจแต่ยังไม่ผ่าน = 400', async () => {
    await expect(make([{ inspectionRequired: false, inspectionResult: null }]).svc.assertIntakeBeforeSubmit('/api/plate-copies/', { chassis: 'A1' })).resolves.toBeUndefined();
    await expect(make([{ inspectionRequired: true, inspectionResult: 'PASS' }]).svc.assertIntakeBeforeSubmit('/api/vehicle-transfers', { chassis: 'A1', transferType: 'INSPECTION' })).resolves.toBeUndefined();
    await expect(make([{ inspectionRequired: true, inspectionResult: null }]).svc.assertIntakeBeforeSubmit('/api/vehicle-transfers', { chassis: 'A1', transferType: 'MOVE_IN' })).rejects.toMatchObject({ status: 400 });
    await expect(make([{ inspectionRequired: true, inspectionResult: 'FAIL' }]).svc.assertIntakeBeforeSubmit('/api/tax-renewals', { chassis: 'A1' })).rejects.toMatchObject({ status: 400 });
  });

  it('แยกประเภทงานโอนและแบบของสลับเลข / เปลี่ยนเลข / คู่รถเก่า (ตรวจทั้งสองคัน)', async () => {
    const t = make([{ inspectionRequired: false, inspectionResult: null }]);
    await t.svc.assertIntakeBeforeSubmit('/api/vehicle-transfers', { chassis: 'A1', transferType: 'OWNER' });
    expect(t.findMany.mock.calls[0][0].where.jobType).toEqual({ in: ['TRANSFER_OWNER'] });
    const c = make([{ inspectionRequired: false, inspectionResult: null }]);
    await c.svc.assertIntakeBeforeSubmit('/api/plate-swaps/change', { oldChassis: 'A1' });
    expect(c.findMany.mock.calls[0][0].where).toMatchObject({ jobType: { in: ['PLATE_SWAP'] }, jobVariant: 'CHANGE' });
    const pair = make([{ inspectionRequired: false, inspectionResult: null }]);
    await pair.svc.assertIntakeBeforeSubmit('/api/plate-swaps/pair', { carA: { oldChassis: 'A1' }, carB: { oldChassis: 'B2' } });
    expect(pair.findMany).toHaveBeenCalledTimes(2);
    expect(pair.findMany.mock.calls[1][0].where).toMatchObject({ jobVariant: 'OLD_OLD', vehicle: { chassisKey: 'B2' } });
  });

  it('ต่อภาษีรถจากฐานข้อมูลรถจดใหม่ใช้เลขตัวถังของรถคันนั้น · path อื่น / ไม่มีเลขตัวถัง = ไม่ตรวจ', async () => {
    const v = make([{ inspectionRequired: false, inspectionResult: null }]);
    await v.svc.assertIntakeBeforeSubmit('/api/tax-renewals', { vehicleId: 'v1' });
    expect(v.findMany.mock.calls[0][0].where.vehicle).toEqual({ chassisKey: 'FROMDB1' });
    const none = make([]);
    await none.svc.assertIntakeBeforeSubmit('/api/tax-renewals/preview', { chassis: 'A1' });
    await none.svc.assertIntakeBeforeSubmit('/api/vehicle-move-outs', { chassis: '' });
    expect(none.findMany).not.toHaveBeenCalled();
  });
});

describe('OldVehicleJobsService - คนรับงานอย่างเดียวจัดการงานที่รับแล้วไม่ได้ (ผู้ใช้ 2026-11-19)', () => {
  const jobRow = { id: 'j1', vehicleId: 'v1', jobType: 'MOVE_OUT', jobId: null, cancelledAt: null, blockedAt: null, vehicle: { vehicleClass: 'CAR' } };
  const svc = () =>
    new OldVehicleJobsService({ oldVehicleJob: { findFirst: vi.fn().mockResolvedValue(jobRow), findUnique: vi.fn().mockResolvedValue(jobRow) } } as unknown as PrismaService);

  it('STAFF_ENTRY / DELIVERY ติดขัด / ยกเลิก ไม่ได้ (403) · STAFF_ENTRY ที่ถือ STAFF_CAR ด้วยผ่านด่านสิทธิ์', async () => {
    for (const roles of [['STAFF_ENTRY'], ['DELIVERY']] as UserRole[][]) {
      await expect(asRole(roles, () => svc().block('j1', { reason: 'OTHER' }))).rejects.toMatchObject({ status: 403 });
      await expect(asRole(roles, () => svc().cancel('j1', 'ลูกค้ายกเลิก'))).rejects.toMatchObject({ status: 403 });
    }
    await expect(asRole(['STAFF_ENTRY', 'STAFF_CAR'], () => svc().block('j1', { reason: 'OTHER' }))).rejects.not.toMatchObject({ status: 403 });
  });
});
