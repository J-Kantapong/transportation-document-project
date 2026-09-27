import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { isChassisConflict, VehiclesService } from './vehicles.service.js';

// เลขตัวถังซ้ำ (พบ 2026-09-27): เทียบแบบไม่สนตัวพิมพ์ เก็บเป็นตัวใหญ่ และบันทึกพร้อมกันจนชน unique index ต้องตอบ 409 ไม่ใช่ 500

function row(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-27',
    customerId: 'c1',
    chassis: 'mr0ha3cd100123456',
    engine: 'E123',
    brandId: 'b1',
    fuel: 'เบนซิน',
    cc: '1598',
    weight: '',
    color: '',
    body: 'รย.1-เก๋ง 2 ตอน',
    registrationProvince: 'กรุงเทพมหานคร',
    ownerProvince: 'กรุงเทพมหานคร',
    ownerType: 'INDIVIDUAL',
    financeId: '',
    ownerName: 'นายทดสอบ',
    hirerName: '',
    ...overrides,
  };
}

const chassisConflict = Object.assign(new Error('Unique constraint failed'), {
  code: 'P2002',
  meta: { target: 'Vehicle_chassis_active_key' },
});

function service(options: { existing?: Array<{ chassis: string }>[]; createError?: unknown; duplicate?: unknown; current?: unknown } = {}) {
  const vehicleFindMany = vi.fn();
  for (const result of options.existing ?? [[]]) vehicleFindMany.mockResolvedValueOnce(result);
  vehicleFindMany.mockResolvedValue([]);
  const createMany = vi.fn().mockImplementation(async () => {
    if (options.createError) throw options.createError;
    return { count: 1 };
  });
  const update = vi.fn().mockImplementation(async () => {
    if (options.createError) throw options.createError;
    return { id: 'v1' };
  });
  const findFirst = vi.fn().mockImplementation(async (args: { where: { id?: unknown } }) =>
    // ครั้งแรก = รถที่กำลังแก้ ครั้งที่สอง = ตรวจเลขตัวถังซ้ำ
    typeof args.where.id === 'string' ? (options.current ?? null) : (options.duplicate ?? null),
  );
  const tx = {
    vehicleOwner: { createManyAndReturn: vi.fn().mockResolvedValue([{ id: 'o1' }]), create: vi.fn().mockResolvedValue({ id: 'o2' }) },
    vehicle: { createMany, update },
    vehicleEditLog: { create: vi.fn().mockResolvedValue({ id: 'log1' }) },
  };
  const prisma = {
    customer: { findMany: vi.fn().mockResolvedValue([{ id: 'c1' }]), findUnique: vi.fn().mockResolvedValue({ id: 'c1' }) },
    brand: { findMany: vi.fn().mockResolvedValue([{ id: 'b1' }]), findUnique: vi.fn().mockResolvedValue({ id: 'b1' }) },
    financeCompany: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    vehicle: { findMany: vehicleFindMany, findFirst },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma), vehicleFindMany, createMany, update, findFirst };
}

async function failureOf(promise: Promise<unknown>): Promise<{ status?: number; error?: string; errors?: unknown }> {
  try {
    await promise;
    return {};
  } catch (e) {
    const err = e as { getStatus?: () => number; response?: { error?: string; errors?: unknown } };
    return { status: err.getStatus?.(), error: err.response?.error, errors: err.response?.errors };
  }
}

describe('isChassisConflict', () => {
  it('P2002 ของเลขตัวถังเท่านั้น', () => {
    expect(isChassisConflict(chassisConflict)).toBe(true);
    expect(isChassisConflict({ code: 'P2002' })).toBe(true);
    expect(isChassisConflict({ code: 'P2002', meta: { target: ['contentHash'] } })).toBe(false);
    expect(isChassisConflict({ code: 'P2025' })).toBe(false);
  });
});

describe('VehiclesService.createBatch', () => {
  it('เก็บเลขตัวถังเป็นตัวพิมพ์ใหญ่ และตรวจซ้ำกับฐานข้อมูลแบบไม่สนตัวพิมพ์', async () => {
    const { service: svc, vehicleFindMany, createMany } = service();
    await expect(svc.createBatch({ vehicles: [row()] })).resolves.toEqual({ count: 1 });
    expect(vehicleFindMany.mock.calls[0][0].where.chassis).toEqual({ in: ['MR0HA3CD100123456'], mode: 'insensitive' });
    expect(createMany.mock.calls[0][0].data[0].chassis).toBe('MR0HA3CD100123456');
  });

  it('ในไฟล์เดียวกันต่างกันแค่ตัวพิมพ์ = ซ้ำในชุดข้อมูล', async () => {
    const { service: svc } = service();
    const failure = await failureOf(svc.createBatch({ vehicles: [row(), row({ chassis: 'MR0HA3CD100123456' })] }));
    expect(failure.errors).toEqual([{ row: 2, errors: ['เลขตัวถังซ้ำในชุดข้อมูล'] }]);
  });

  it('ซ้ำกับรถเก่าที่คีย์ตัวเล็กไว้ ตอบ 409 พร้อมแถวที่ซ้ำ', async () => {
    const { service: svc, createMany } = service({ existing: [[{ chassis: 'mr0ha3cd100123456' }]] });
    expect(await failureOf(svc.createBatch({ vehicles: [row()] }))).toEqual({
      status: 409,
      error: 'เลขตัวถัง MR0HA3CD100123456 มีอยู่แล้ว',
      errors: [{ row: 1, errors: ['เลขตัวถังมีอยู่แล้ว'] }],
    });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('มีคนบันทึกเลขเดียวกันเข้ามาระหว่างนั้น (unique index) ตอบ 409 พร้อมแถว ไม่ใช่ 500', async () => {
    const { service: svc } = service({
      existing: [[], [{ chassis: 'MR0HA3CD100123456' }]],
      createError: chassisConflict,
    });
    expect(await failureOf(svc.createBatch({ vehicles: [row()] }))).toMatchObject({
      status: 409,
      error: 'เลขตัวถัง MR0HA3CD100123456 มีอยู่แล้ว',
    });
  });

  it('error อื่นที่ไม่ใช่เลขตัวถังซ้ำ ส่งต่อตามเดิม', async () => {
    const boom = new Error('connection lost');
    const { service: svc } = service({ createError: boom });
    await expect(svc.createBatch({ vehicles: [row()] })).rejects.toBe(boom);
  });
});

describe('VehiclesService.updateVehicle', () => {
  const current = { id: 'v1', chassis: 'mr0ha3cd100123456', ownerId: 'o1', owner: null, deletedAt: null };

  it('ตรวจเลขตัวถังซ้ำแบบไม่สนตัวพิมพ์ และไม่นับรถคันที่กำลังแก้', async () => {
    const { service: svc, findFirst, update } = service({ current });
    await expect(svc.updateVehicle('v1', { ...row(), remark: 'แก้เลขตัวถังเป็นตัวใหญ่' })).resolves.toEqual({ id: 'v1' });
    expect(findFirst.mock.calls[1][0].where).toEqual({
      id: { not: 'v1' },
      deletedAt: null,
      chassis: { equals: 'MR0HA3CD100123456', mode: 'insensitive' },
    });
    expect(update.mock.calls[0][0].data.chassis).toBe('MR0HA3CD100123456');
  });

  it('ชน unique index ระหว่างบันทึก ตอบ 409', async () => {
    const { service: svc } = service({ current, createError: chassisConflict });
    expect(await failureOf(svc.updateVehicle('v1', { ...row(), remark: 'แก้' }))).toMatchObject({
      status: 409,
      error: 'เลขตัวถังนี้มีอยู่แล้ว',
    });
  });
});
