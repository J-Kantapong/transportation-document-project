import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TaxService } from '../tax/tax.service.js';
import { VehiclesService } from './vehicles.service.js';

// แก้ข้อมูลรถหลังขั้นตอนถัดไปใช้ข้อมูลเดิมไปแล้ว (ผู้ใช้ 2026-09-27): ตอบ 409 needsConfirm พร้อมขั้นตอนที่กระทบ
// (+ ภาษีที่ยื่นไว้เทียบกับภาษีตามข้อมูลใหม่สำหรับรายการที่รอใบเสร็จ) จนกว่าจะส่ง confirm: true - ไม่คิดใหม่ให้อัตโนมัติ

function row(overrides: Record<string, unknown> = {}) {
  return {
    date: '2026-09-01',
    customerId: 'c1',
    chassis: 'MR0HA3CD100123456',
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
    remark: 'CC ผิด',
    ...overrides,
  };
}

function current(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    date: new Date('2026-09-01T00:00:00.000Z'),
    customerId: 'c1',
    chassis: 'MR0HA3CD100123456',
    engine: 'E123',
    brandId: 'b1',
    fuel: 'เบนซิน',
    cc: '2598.00',
    weight: null,
    color: null,
    body: 'รย.1-เก๋ง 2 ตอน',
    registrationProvince: 'กรุงเทพมหานคร',
    ownerProvince: 'กรุงเทพมหานคร',
    firstRegistrationDate: null,
    ownerId: 'o1',
    owner: { name: 'นายทดสอบ', hirerName: null, ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null, financeCompanyId: null },
    deletedAt: null,
    transferDone: true,
    inspectionSentDate: new Date('2026-09-05T00:00:00.000Z'),
    inspectionResult: 'ผ่าน',
    inspectionResultDate: new Date('2026-09-06T00:00:00.000Z'),
    deliveredDate: null,
    billingClosedAt: null,
    documentSubmissions: [{ status: 'PENDING', taxAmount: '5292.00', submitDate: new Date('2026-09-20T00:00:00.000Z') }],
    deliverySlipItems: [],
    invoiceLines: [],
    ...overrides,
  };
}

function service(vehicle: ReturnType<typeof current>) {
  const findFirst = vi.fn().mockImplementation(async (args: { where: { id?: unknown } }) => (typeof args.where.id === 'string' ? vehicle : null));
  const update = vi.fn().mockResolvedValue({ id: 'v1' });
  const editLogCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const ownerCreate = vi.fn().mockResolvedValue({ id: 'o2' });
  const queryRaw = vi.fn().mockResolvedValue([]);
  const tx = {
    $queryRaw: queryRaw,
    vehicle: { findFirst, update },
    vehicleOwner: { create: ownerCreate },
    vehicleEditLog: { create: editLogCreate },
  };
  const prisma = {
    customer: { findUnique: vi.fn().mockResolvedValue({ id: 'c1' }) },
    brand: { findUnique: vi.fn().mockResolvedValue({ id: 'b1' }) },
    financeCompany: { findUnique: vi.fn().mockResolvedValue(null) },
    vehicle: { findFirst },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const previewMany = vi.fn().mockResolvedValue([{ amount: 1797, reason: null }]);
  const taxService = { previewMany } as unknown as TaxService;
  return { service: new VehiclesService(prisma, taxService), update, editLogCreate, previewMany, queryRaw };
}

async function failureOf(promise: Promise<unknown>): Promise<{ status?: number; body?: Record<string, unknown> }> {
  try {
    await promise;
    return {};
  } catch (e) {
    const err = e as { getStatus?: () => number; response?: Record<string, unknown> };
    return { status: err.getStatus?.(), body: err.response };
  }
}

describe('VehiclesService.updateVehicle - เตือนเมื่อแก้หลังขั้นตอนที่ใช้ข้อมูลเดิม', () => {
  it('รายการยื่นรอใบเสร็จ + แก้ CC: ตอบ 409 พร้อมขั้นตอนที่กระทบและภาษีเดิม/ใหม่ ไม่บันทึกอะไร', async () => {
    const { service: svc, update, editLogCreate, previewMany, queryRaw } = service(current());
    const failure = await failureOf(svc.updateVehicle('v1', row()));
    expect(failure.status).toBe(409);
    expect(failure.body).toMatchObject({
      needsConfirm: true,
      affected: [{ step: 'submission', label: 'ยื่นเอกสาร (รอใบเสร็จ)', fields: ['ขนาด CC'] }],
      taxPreview: { old: 5292, new: 1797, reason: null },
    });
    expect(String(failure.body?.error)).toContain('ตรวจสอบผลกระทบ');
    // preview ด้วยข้อมูลใหม่ (CC 1598) ไม่ใช่ข้อมูลเดิม และไม่บันทึก TaxCalculation
    expect(previewMany.mock.calls[0][0][0].vehicle).toMatchObject({ body: 'รย.1-เก๋ง 2 ตอน', fuel: 'เบนซิน', cc: '1598' });
    expect(previewMany.mock.calls[0][0][0].owner).toEqual({ ownerType: 'INDIVIDUAL', isHirePurchaseBusiness: false, hirerType: null });
    expect(queryRaw).toHaveBeenCalled(); // ล็อกแถวรถก่อนอ่านสถานะขั้นตอน
    expect(update).not.toHaveBeenCalled();
    expect(editLogCreate).not.toHaveBeenCalled();
  });

  it('ยืนยันแล้ว (confirm: true + confirmKey ของคำเตือนที่เห็นครบ) บันทึก และเก็บว่ายืนยันขั้นตอนไหนไว้ในประวัติ', async () => {
    const { service: svc, update, editLogCreate, previewMany } = service(current());
    const warned = await failureOf(svc.updateVehicle('v1', row()));
    const confirmedSteps = (warned.body?.affected as Array<{ confirmKey: string }>).map((a) => a.confirmKey);
    previewMany.mockClear();
    await expect(svc.updateVehicle('v1', { ...row(), confirm: true, confirmedSteps })).resolves.toEqual({ id: 'v1' });
    expect(update.mock.calls[0][0].data.cc).toBe('1598');
    const log = editLogCreate.mock.calls[0][0].data as { remark: string; changes: string };
    expect(log.remark).toBe('ยืนยันแก้หลัง ยื่นเอกสาร (รอใบเสร็จ): CC ผิด');
    expect(JSON.parse(log.changes)).toEqual({ cc: { from: '2598.00', to: '1598' } });
    expect(previewMany).not.toHaveBeenCalled();
  });

  it('ระหว่างที่ดูคำเตือน รายการยื่นได้ใบเสร็จแล้ว (ขั้นตอนเดิม สถานะเปลี่ยน) = เตือนใหม่ ไม่บันทึก (ผู้ใช้ 2026-09-27 รอบตรวจ)', async () => {
    const pending = service(current());
    const warned = await failureOf(pending.service.updateVehicle('v1', row()));
    const confirmedSteps = (warned.body?.affected as Array<{ confirmKey: string }>).map((a) => a.confirmKey);

    const received = service(current({ documentSubmissions: [{ status: 'RECEIPT_RECEIVED', taxAmount: '5292.00', submitDate: new Date('2026-09-20T00:00:00.000Z') }] }));
    const failure = await failureOf(received.service.updateVehicle('v1', { ...row(), confirm: true, confirmedSteps }));
    expect(failure.status).toBe(409);
    expect(failure.body?.affected).toMatchObject([{ step: 'submission', label: 'ยื่นเอกสาร (ได้ใบเสร็จแล้ว)' }]);
    expect(received.update).not.toHaveBeenCalled();
  });

  it('ส่งงานแล้วแก้ชื่อผู้ถือกรรมสิทธิ์ (ประเภทเจ้าของเดิม): เตือนขั้นส่งงาน ไม่มี preview ภาษี (ผู้ใช้ 2026-09-27 รอบตรวจ)', async () => {
    const vehicle = current({
      cc: '1598.00',
      deliverySlipItems: [{ id: 'i1' }],
      documentSubmissions: [{ status: 'RECEIPT_RECEIVED', taxAmount: '5292.00', submitDate: null }],
    });
    const { service: svc, update, previewMany } = service(vehicle);
    const failure = await failureOf(svc.updateVehicle('v1', row({ ownerName: 'นายทดสอบ ใจดี', remark: 'ชื่อสะกดผิด' })));
    expect(failure.status).toBe(409);
    // รถยนต์: ใบส่งงานยื่นเอกสารไม่พิมพ์ชื่อเจ้าของ จึงเตือนแค่ใบส่งงาน (Delivery) ที่อ่านชื่อตอนพิมพ์
    expect(failure.body?.affected).toMatchObject([{ step: 'delivery', fields: ['ชื่อเจ้าของรถ'] }]);
    expect(failure.body?.taxPreview).toBeUndefined();
    expect(previewMany).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('ยื่นแล้วแก้ยี่ห้อรถยนต์: เตือนว่าใบส่งงานที่พิมพ์ใหม่ไม่ตรงกับที่ยื่น (ผู้ใช้ 2026-09-27 รอบตรวจ)', async () => {
    const vehicle = current({ cc: '1598.00', transferDone: false, inspectionSentDate: null });
    const { service: svc, update } = service(vehicle);
    const failure = await failureOf(svc.updateVehicle('v1', row({ brandId: 'b2', remark: 'ยี่ห้อผิด' })));
    expect(failure.status).toBe(409);
    expect(failure.body?.affected).toMatchObject([{ step: 'submission', fields: ['ยี่ห้อ'], repriceable: false }]);
    expect(update).not.toHaveBeenCalled();
  });

  it('มีขั้นตอนที่กระทบเพิ่มจากที่เห็นตอนยืนยัน (เช่น มีคนส่งงานไประหว่างนั้น) = เตือนใหม่ ไม่บันทึก', async () => {
    // ผู้ใช้เห็นคำเตือนแค่ขั้นยื่นเอกสาร (เปลี่ยนลูกค้า) แล้วกดยืนยัน แต่ระหว่างนั้นมีคนส่งงานคันนี้ไปแล้ว
    const vehicle = current({
      cc: '1598.00',
      deliverySlipItems: [{ id: 'i1' }],
      documentSubmissions: [{ status: 'RECEIPT_RECEIVED', taxAmount: '5292.00', submitDate: null }],
    });
    const { service: svc, update } = service(vehicle);
    const failure = await failureOf(svc.updateVehicle('v1', { ...row({ customerId: 'c2' }), confirm: true, confirmedSteps: ['submission'] }));
    expect(failure.status).toBe(409);
    expect((failure.body?.affected as Array<{ step: string }>).map((a) => a.step)).toEqual(['submission', 'delivery']);
    expect(failure.body?.taxPreview).toBeUndefined(); // ได้ใบเสร็จแล้ว ไม่ preview ภาษี
    expect(update).not.toHaveBeenCalled();
  });

  it('ช่องที่ไม่มีขั้นตอนไหนใช้ (สี/เลขเครื่อง) หรือรถที่ยังไม่ผ่านขั้นตอนใด บันทึกได้เลยไม่ต้องยืนยัน', async () => {
    const { service: svc, update } = service(current({ cc: '1598.00' }));
    await expect(svc.updateVehicle('v1', row({ color: 'ขาว', engine: 'E999' }))).resolves.toEqual({ id: 'v1' });
    expect(update).toHaveBeenCalled();

    const fresh = service(
      current({ transferDone: false, inspectionSentDate: null, inspectionResult: null, inspectionResultDate: null, documentSubmissions: [] }),
    );
    await expect(fresh.service.updateVehicle('v1', row({ registrationProvince: 'นนทบุรี' }))).resolves.toEqual({ id: 'v1' });
    expect(fresh.update).toHaveBeenCalled();
  });

  it('แจ้งย้าย/ตัดบัญชีเสร็จแล้ว เปลี่ยนจังหวัด: เตือนขั้นตอนเปลี่ยนจากตัดบัญชีเป็นแจ้งย้าย ไม่มี preview ภาษี', async () => {
    const vehicle = current({ inspectionSentDate: null, inspectionResult: null, inspectionResultDate: null, documentSubmissions: [], cc: '1598.00' });
    const { service: svc, previewMany } = service(vehicle);
    const failure = await failureOf(svc.updateVehicle('v1', row({ registrationProvince: 'นนทบุรี' })));
    expect(failure.status).toBe(409);
    const affected = failure.body?.affected as Array<{ step: string; note: string }>;
    expect(affected.map((a) => a.step)).toEqual(['transfer']);
    expect(affected[0].note).toContain('ขั้นตอนเปลี่ยนจากตัดบัญชีเป็นแจ้งย้าย');
    expect(failure.body?.taxPreview).toBeUndefined();
    expect(previewMany).not.toHaveBeenCalled();
  });
});
