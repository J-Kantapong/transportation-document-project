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

// sameModel = รถในระบบที่เลขตัวถัง 8 ตัวแรกเหมือนกัน (คำค้นของ "รุ่นที่รู้จัก" - where.OR startsWith ดู vehicle-data-check.ts)
function service(
  options: { existing?: Array<{ chassis: string }>[]; createError?: unknown; duplicate?: unknown; current?: unknown; sameModel?: unknown[] } = {},
) {
  const existingQueue = [...(options.existing ?? [[]])];
  const vehicleFindMany = vi
    .fn()
    .mockImplementation(async (args: { where: { OR?: unknown } }) => (args.where.OR ? (options.sameModel ?? []) : (existingQueue.shift() ?? [])));
  const createMany = vi.fn().mockImplementation(async (args: { data: Array<{ chassis: string }> }) => {
    if (options.createError) throw options.createError;
    return args.data.map((v, i) => ({ id: `v${i + 1}`, chassis: v.chassis }));
  });
  const editLogCreateMany = vi.fn().mockResolvedValue({ count: 1 });
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
    vehicle: { createManyAndReturn: createMany, update, findFirst },
    // แก้ไขรถล็อกแถวรถก่อนอ่านสถานะขั้นตอน (ผู้ใช้ 2026-09-27 - เตือนเมื่อแก้หลังขั้นตอนที่ใช้ข้อมูลเดิม)
    $queryRaw: vi.fn().mockResolvedValue([]),
    vehicleEditLog: { create: vi.fn().mockResolvedValue({ id: 'log1' }), createMany: editLogCreateMany },
  };
  const prisma = {
    customer: { findMany: vi.fn().mockResolvedValue([{ id: 'c1' }]), findUnique: vi.fn().mockResolvedValue({ id: 'c1' }) },
    brand: { findMany: vi.fn().mockResolvedValue([{ id: 'b1', name: 'Toyota' }]), findUnique: vi.fn().mockResolvedValue({ id: 'b1', name: 'Toyota' }) },
    financeCompany: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn().mockResolvedValue(null) },
    vehicle: { findMany: vehicleFindMany, findFirst },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma), vehicleFindMany, createMany, update, findFirst, editLogCreateMany };
}

// คำตอบทั้งก้อนของ error (409 needsConfirm ของคำเตือนข้อมูลน่าจะคีย์ผิดมี warnings / dataWarnings)
async function responseOf(promise: Promise<unknown>): Promise<{ status?: number; body?: Record<string, unknown> }> {
  try {
    await promise;
    return {};
  } catch (e) {
    const err = e as { getStatus?: () => number; response?: Record<string, unknown> };
    return { status: err.getStatus?.(), body: err.response };
  }
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
  const current = {
    id: 'v1',
    chassis: 'mr0ha3cd100123456',
    ownerId: 'o1',
    owner: null,
    deletedAt: null,
    transferDone: false,
    inspectionSentDate: null,
    documentSubmissions: [],
    deliverySlipItems: [],
    invoiceLines: [],
  };

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

// คำเตือนข้อมูลน่าจะคีย์ผิด (ผู้ใช้ 2026-10-13): เลขตัวถังผิดหลัก / ยี่ห้อ CC ประเภทรถ ไม่ตรงรุ่นที่เคยคีย์ - เตือนแล้วให้ยืนยัน ไม่ห้าม
describe('คำเตือนข้อมูลน่าจะคีย์ผิด', () => {
  // รถ 3 คันในระบบที่เลขตัวถังขึ้นต้น MR0HA3CD เป็นยี่ห้อ b2 (Honda) 1,498 cc
  const sameModel = [1, 2, 3].map((n) => ({
    chassis: `MR0HA3CD10000000${n}`,
    brandId: 'b2',
    cc: '1498',
    body: 'รย.1-เก๋ง 2 ตอน',
    brand: { name: 'Honda' },
  }));
  const keysOf = (body: Record<string, unknown> | undefined, field: 'warnings' | 'dataWarnings') =>
    field === 'warnings'
      ? (body?.warnings as Array<{ warnings: Array<{ key: string }> }>).flatMap((entry) => entry.warnings.map((w) => w.key))
      : (body?.dataWarnings as Array<{ key: string }>).map((w) => w.key);

  it('คีย์ใหม่: เลขตัวถัง 16 หลัก ตอบ 409 พร้อมคำเตือนรายแถว ไม่บันทึกอะไร', async () => {
    const { service: svc, createMany } = service();
    const failure = await responseOf(svc.createBatch({ vehicles: [row({ chassis: 'MR0HA3CD10012345' })] }));
    expect(failure.status).toBe(409);
    expect(failure.body).toMatchObject({ needsConfirm: true, warnings: [{ row: 1, chassis: 'MR0HA3CD10012345', warnings: [{ code: 'CHASSIS_LENGTH' }] }] });
    expect(createMany).not.toHaveBeenCalled();
  });

  it('คีย์ใหม่: ยืนยันคำเตือนที่เห็นแล้วบันทึกได้ และเก็บประวัติว่ายืนยันข้ามคำเตือน', async () => {
    const { service: svc, createMany, editLogCreateMany } = service();
    const vehicles = [row({ chassis: 'MR0HA3CD10012345' })];
    const failure = await responseOf(svc.createBatch({ vehicles }));
    await expect(svc.createBatch({ vehicles, confirmedWarnings: keysOf(failure.body, 'warnings') })).resolves.toEqual({ count: 1 });
    expect(createMany).toHaveBeenCalledTimes(1);
    const log = editLogCreateMany.mock.calls[0][0].data[0];
    expect(log.vehicleId).toBe('v1');
    expect(log.remark).toContain('ยืนยันข้ามคำเตือนตอนคีย์');
    expect(log.remark).toContain('16 หลัก');
  });

  it('คีย์ใหม่: ยืนยันของคำเตือนชุดอื่นใช้ไม่ได้', async () => {
    const { service: svc, createMany } = service();
    const failure = await responseOf(svc.createBatch({ vehicles: [row({ chassis: 'MR0HA3CD10012345' })], confirmedWarnings: ['CHASSIS_LENGTH:XXXX'] }));
    expect(failure.status).toBe(409);
    expect(createMany).not.toHaveBeenCalled();
  });

  it('คีย์ใหม่: ยี่ห้อและ CC ไม่ตรงกับรถรุ่นเดียวกันในระบบ = เตือนทั้งสองข้อ', async () => {
    const { service: svc } = service({ sameModel });
    const failure = await responseOf(svc.createBatch({ vehicles: [row()] }));
    const warnings = (failure.body?.warnings as Array<{ warnings: Array<{ code: string; message: string }> }>)[0].warnings;
    expect(warnings.map((w) => w.code)).toEqual(['MODEL_BRAND', 'MODEL_CC']);
    expect(warnings[0].message).toContain('Toyota');
    expect(warnings[0].message).toContain('Honda');
  });

  it('คีย์ใหม่: ข้อมูลปกติไม่มีคำเตือน ไม่เขียนประวัติ', async () => {
    const { service: svc, editLogCreateMany } = service();
    await expect(svc.createBatch({ vehicles: [row()] })).resolves.toEqual({ count: 1 });
    expect(editLogCreateMany).not.toHaveBeenCalled();
  });

  const current = {
    id: 'v1',
    chassis: 'MR0HA3CD100123456',
    brandId: 'b1',
    cc: '1598',
    body: 'รย.1-เก๋ง 2 ตอน',
    ownerId: 'o1',
    owner: null,
    deletedAt: null,
    transferDone: false,
    inspectionSentDate: null,
    documentSubmissions: [],
    deliverySlipItems: [],
    invoiceLines: [],
  };

  it('แก้ไข: แก้เลขตัวถังจนเหลือ 16 หลัก ตอบ 409 พร้อม dataWarnings แล้วยืนยันจึงบันทึก', async () => {
    const { service: svc, update } = service({ current });
    const body = { ...row({ chassis: 'MR0HA3CD10012345' }), remark: 'แก้เลขตัวถัง' };
    const failure = await responseOf(svc.updateVehicle('v1', body));
    expect(failure.status).toBe(409);
    expect(failure.body).toMatchObject({ needsConfirm: true, affected: [], dataWarnings: [{ code: 'CHASSIS_LENGTH' }] });
    expect(update).not.toHaveBeenCalled();
    await expect(svc.updateVehicle('v1', { ...body, confirm: true, confirmedWarnings: keysOf(failure.body, 'dataWarnings') })).resolves.toEqual({ id: 'v1' });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('แก้ไข: รถเก่าที่เลขตัวถังผิดหลักอยู่แล้ว แก้ช่องอื่นได้โดยไม่ถูกถามซ้ำ', async () => {
    const { service: svc, update } = service({ current: { ...current, chassis: 'MR0HA3CD10012345' } });
    await expect(svc.updateVehicle('v1', { ...row({ chassis: 'MR0HA3CD10012345', color: 'ขาว' }), remark: 'แก้สี' })).resolves.toEqual({ id: 'v1' });
    expect(update).toHaveBeenCalledTimes(1);
  });
});
