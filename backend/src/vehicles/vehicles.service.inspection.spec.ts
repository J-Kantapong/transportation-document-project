import { afterEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehiclesService } from './vehicles.service.js';

// ตรวจรถ (Step 3) - กฎที่เพิ่มหลังตรวจพบปัญหา (พบ 2026-09-27):
// - บันทึกส่งตรวจ/ผลตรวจทับของเดิมจากหน้าที่เปิดค้างไว้ไม่ได้ (409) ต้องแก้ผ่านปุ่มแก้ไขที่ต้องมีเหตุผล
// - วันที่ส่งตรวจต้องไม่ก่อนวันที่แจ้งย้าย/ตัดบัญชีเสร็จ วันที่ทราบผลต้องไม่ก่อนวันส่งตรวจและไม่เกินวันนี้ (เวลาไทย)
// - แก้/ยกเลิกการส่งตรวจของรถที่ยังรอผลได้ โดยต้องระบุเหตุผลและเก็บลงประวัติการแก้ไข
// - ผลตรวจหมดอายุ (ตรวจรอบ 2) นับตามวันปฏิทินไทย

function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'MR2A79BF604099182',
    date: new Date('2026-09-10T00:00:00.000Z'),
    body: 'รย.1-เก๋ง 2 ตอน',
    registrationProvince: 'กรุงเทพมหานคร',
    brand: { name: 'BENZ' },
    transferDone: true,
    transferCompletedDate: new Date('2026-09-20T00:00:00.000Z'),
    deletedAt: null,
    inspectionRound: 1,
    inspectionSentType: null,
    inspectionSentDate: null,
    inspectionSentCost: null,
    inspectionSentBillCost: null,
    inspectionResult: null,
    inspectionResultDate: null,
    inspectionResultCost: null,
    inspectionResultBillCost: null,
    inspectionFailRemark: null,
    documentSubmissions: [] as unknown[],
    ...overrides,
  };
}

// ราคาตรวจ กทม.: ยี่ห้อในตารางเป็น "Benz" ส่วนรถคีย์ยี่ห้อ "BENZ" - ต้องได้ราคาของ Benz ไม่ใช่ "อื่นๆ"
const bangkokFees = [
  { vehicleType: 'รย.1-เก๋ง 2 ตอน', brand: 'Benz', amount: '200' },
  { vehicleType: 'รย.1-เก๋ง 2 ตอน', brand: 'อื่นๆ', amount: '150' },
];

function service(found: unknown, options: { count?: number } = {}) {
  const updateMany = vi.fn().mockResolvedValue({ count: options.count ?? 1 });
  const editLogCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const findMany = vi.fn().mockResolvedValue([]);
  const tx = { vehicle: { updateMany }, vehicleEditLog: { create: editLogCreate } };
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(found), updateMany, findMany },
    vehicleEditLog: { create: editLogCreate },
    feeInspectionBangkok: { findMany: vi.fn().mockResolvedValue(bangkokFees) },
    feeInspectionProvince: { findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma), updateMany, editLogCreate, findMany };
}

async function failureOf(promise: Promise<unknown>): Promise<{ status?: number; error?: string }> {
  try {
    await promise;
    return {};
  } catch (e) {
    const err = e as { getStatus?: () => number; response?: { error?: string } };
    return { status: err.getStatus?.(), error: err.response?.error };
  }
}

const STALE = { status: 409, error: 'ข้อมูลถูกแก้ไขโดยผู้อื่น - โหลดรายการใหม่' };

afterEach(() => {
  vi.useRealTimers();
});

describe('VehiclesService.updateInspectionSent', () => {
  const body = { sentType: 'ส่งตรวจนอก', sentDate: '2026-09-21' };

  it('ส่งตรวจครั้งแรก: ราคาตามตาราง (ยี่ห้อเทียบแบบไม่สนตัวพิมพ์) บันทึกแบบมีเงื่อนไขตามสถานะที่อ่านมา', async () => {
    const { service: svc, updateMany, editLogCreate } = service(vehicleRow());
    await expect(svc.updateInspectionSent('v1', body)).resolves.toMatchObject({
      inspectionRound: 1,
      inspectionSentType: 'ส่งตรวจนอก',
      inspectionSentDate: '2026-09-21',
      inspectionSentCost: '200',
      inspectionSentBillCost: null,
    });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'v1',
      deletedAt: null,
      transferDone: true,
      inspectionSentDate: null,
      inspectionResult: null,
      inspectionResultDate: null,
    });
    expect(editLogCreate).not.toHaveBeenCalled();
  });

  it('ส่งตรวจแล้วรอผลอยู่ บันทึกส่งตรวจทับไม่ได้ (409)', async () => {
    const sent = vehicleRow({ inspectionSentType: 'เอารถมาตรวจเอง', inspectionSentDate: new Date('2026-09-21T00:00:00.000Z') });
    const { service: svc, updateMany } = service(sent);
    expect(await failureOf(svc.updateInspectionSent('v1', body))).toEqual({
      status: 409,
      error: 'รถคันนี้ส่งตรวจแล้ว รอผลตรวจอยู่ - แก้ได้ที่ปุ่ม "แก้การส่งตรวจ"',
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('มีคนบันทึกไปก่อนระหว่างนั้น (บันทึกแบบมีเงื่อนไขไม่โดนแถวไหน) ตอบ 409', async () => {
    const { service: svc } = service(vehicleRow(), { count: 0 });
    expect(await failureOf(svc.updateInspectionSent('v1', body))).toEqual(STALE);
  });

  it('วันที่ส่งตรวจต้องไม่ก่อนวันที่แจ้งย้าย/ตัดบัญชีเสร็จ', async () => {
    const { service: svc } = service(vehicleRow());
    expect(await failureOf(svc.updateInspectionSent('v1', { ...body, sentDate: '2026-09-11' }))).toEqual({
      status: 400,
      error: 'วันที่ส่งตรวจต้องไม่ก่อนวันที่แจ้งย้าย/ตัดบัญชีเสร็จ (20/09/2026)',
    });
  });

  it('ไม่มีวันที่แจ้งย้ายเสร็จ (ข้อมูลเก่า) ใช้วันที่รับงานแทน', async () => {
    const { service: svc } = service(vehicleRow({ transferCompletedDate: null }));
    expect((await failureOf(svc.updateInspectionSent('v1', { ...body, sentDate: '2026-09-09' }))).error).toBe(
      'วันที่ส่งตรวจต้องไม่ก่อนวันที่รับงาน (10/09/2026)',
    );
    await expect(svc.updateInspectionSent('v1', { ...body, sentDate: '2026-09-11' })).resolves.toMatchObject({ inspectionSentDate: '2026-09-11' });
  });

  it('ต้องมีทั้งประเภทและวันที่ส่งตรวจ', async () => {
    const { service: svc } = service(vehicleRow());
    expect((await failureOf(svc.updateInspectionSent('v1', { ...body, sentDate: '' }))).error).toBe('กรุณาระบุวันที่ส่งตรวจ');
    expect((await failureOf(svc.updateInspectionSent('v1', { ...body, sentType: '' }))).error).toBe('กรุณาเลือกประเภทการตรวจ');
  });

  it('ส่งตรวจใหม่หลังตรวจไม่ผ่าน: ล้างผลเดิม และบันทึกประวัติ', async () => {
    const failed = vehicleRow({
      inspectionSentType: 'ส่งตรวจนอก',
      inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'),
      inspectionResult: 'ไม่ผ่าน',
      inspectionResultDate: new Date('2026-09-22T00:00:00.000Z'),
      inspectionFailRemark: 'เลขตัวรถผิด',
    });
    const { service: svc, updateMany, editLogCreate } = service(failed);
    await svc.updateInspectionSent('v1', { ...body, sentDate: '2026-09-23' });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ inspectionResult: 'ไม่ผ่าน' });
    expect(updateMany.mock.calls[0][0].data).toMatchObject({ inspectionResult: null, inspectionResultDate: null });
    expect(editLogCreate.mock.calls[0][0].data.remark).toContain('ส่งตรวจใหม่หลังตรวจไม่ผ่าน');
  });

  it('ผลตรวจหมดอายุนับตามวันไทย: 06:30 น. ของวันที่ 90 หลังตรวจผ่าน ส่งตรวจรอบ 2 ได้แล้ว', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T23:30:00.000Z')); // 27/09/2026 06:30 เวลาไทย
    const passed = vehicleRow({
      inspectionSentType: 'ส่งตรวจนอก',
      inspectionSentDate: new Date('2026-06-28T00:00:00.000Z'),
      inspectionResult: 'ผ่าน',
      inspectionResultDate: new Date('2026-06-29T00:00:00.000Z'),
      transferCompletedDate: new Date('2026-06-20T00:00:00.000Z'),
    });
    const { service: svc } = service(passed);
    await expect(svc.updateInspectionSent('v1', { ...body, sentDate: '2026-09-27' })).resolves.toMatchObject({
      inspectionRound: 2,
      inspectionSentBillCost: '50',
    });
  });

  it('ผลตรวจผ่านยังไม่ครบ 90 วัน (วันที่ 89) ส่งตรวจใหม่ไม่ได้', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T16:59:00.000Z')); // 26/09/2026 23:59 เวลาไทย
    const passed = vehicleRow({
      inspectionSentDate: new Date('2026-06-28T00:00:00.000Z'),
      inspectionResult: 'ผ่าน',
      inspectionResultDate: new Date('2026-06-29T00:00:00.000Z'),
    });
    const { service: svc } = service(passed);
    expect((await failureOf(svc.updateInspectionSent('v1', body))).error).toBe('รถคันนี้ตรวจผ่านแล้ว ผลตรวจยังไม่หมดอายุ (90 วัน)');
  });
});

describe('VehiclesService.findPendingInspectionSend', () => {
  it('เกณฑ์ตรวจรอบ 2 = วันนี้ตามเวลาไทยลบ 90 วัน (ไม่ใช่เวลา UTC ตอนนี้)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T23:30:00.000Z')); // 27/09/2026 06:30 เวลาไทย
    const { service: svc, findMany } = service(null);
    await svc.findPendingInspectionSend();
    const or = findMany.mock.calls[0][0].where.OR as Array<{ inspectionResultDate?: { lte: Date } }>;
    expect(or[2].inspectionResultDate?.lte).toEqual(new Date('2026-06-29T00:00:00.000Z'));
  });

  // ผู้ใช้ 2026-09-27 (F19): ยกเลิก/ยื่นไม่สำเร็จแล้วยื่นใหม่ด้วยวันที่ยื่นเดิมได้ - คิวส่งตรวจรอบ 2 บอกไว้ให้ถามฝ่ายยื่นก่อนส่งตรวจ
  it('รถถึงกำหนดตรวจรอบ 2 ที่ยกเลิก/ยื่นไม่สำเร็จด้วยผลตรวจเดิม ได้ resubmitWith (วันที่ยื่นล่าสุด + ยื่นได้ถึง)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T03:00:00.000Z'));
    const due = vehicleRow({
      id: 'v1',
      customer: { name: 'ลูกค้า' },
      inspectionSentDate: new Date('2026-06-01T00:00:00.000Z'),
      inspectionResult: 'ผ่าน',
      inspectionResultDate: new Date('2026-06-02T00:00:00.000Z'),
    });
    const fresh = vehicleRow({ id: 'v2', customer: { name: 'ลูกค้า' } });
    const failedFindMany = vi.fn().mockResolvedValue([{ vehicleId: 'v1', submitDate: new Date('2026-07-10T00:00:00.000Z') }]);
    const logFindMany = vi.fn().mockResolvedValue([
      { vehicleId: 'v1', changes: JSON.stringify({ 'submission.cancelled': { from: 'ยื่น 2026-08-25 | Bill: -', to: 'ยกเลิกการยื่น' } }) },
    ]);
    const prisma = {
      vehicle: { findMany: vi.fn().mockResolvedValue([due, fresh]) },
      documentSubmission: { findMany: failedFindMany },
      vehicleEditLog: { findMany: logFindMany },
      feeInspectionBangkok: { findMany: vi.fn().mockResolvedValue(bangkokFees) },
      feeInspectionProvince: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const rows = await new VehiclesService(prisma).findPendingInspectionSend();
    expect(rows.map((r) => [r.id, r.round2Due, r.resubmitWith])).toEqual([
      ['v1', true, { submitDate: '2026-08-25', reason: 'CANCELLED', validUntil: '2026-08-30' }],
      ['v2', false, null],
    ]);
    // ถามเฉพาะรถที่ถึงกำหนดตรวจรอบ 2
    expect(failedFindMany.mock.calls[0][0].where).toEqual({ vehicleId: { in: ['v1'] }, status: 'FAILED' });
    expect(logFindMany.mock.calls[0][0].where.vehicleId).toEqual({ in: ['v1'] });
  });
});

describe('VehiclesService.findRecentlyCompletedInspection', () => {
  it('รถที่ยังไม่ยื่นแสดงครบทุกคัน เรียงจากตรวจเก่าสุด ตามด้วยรถที่ยื่นแล้ว 100 คันล่าสุด', async () => {
    const { service: svc, findMany } = service(null);
    findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await svc.findRecentlyCompletedInspection();
    const [unsubmitted, submitted] = findMany.mock.calls.map((call) => call[0]);
    expect(unsubmitted.where.documentSubmissions).toEqual({ none: { status: { in: ['PENDING', 'RECEIPT_RECEIVED'] } } });
    expect(unsubmitted.orderBy[0]).toEqual({ inspectionResultDate: 'asc' });
    expect(unsubmitted.take).toBeUndefined();
    expect(submitted.where.documentSubmissions).toEqual({ some: { status: { in: ['PENDING', 'RECEIPT_RECEIVED'] } } });
    expect(submitted.take).toBe(100);
  });
});

describe('VehiclesService.updateInspectionResult', () => {
  const sent = { inspectionSentType: 'ส่งตรวจนอก', inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'), inspectionSentCost: '200' };
  const body = { result: 'ผ่าน', resultDate: '2026-09-22', remark: null };

  it('บันทึกผลตรวจ: ค่าตรวจ = ราคาตอนส่งตรวจ บันทึกแบบมีเงื่อนไขว่ายังไม่มีผล', async () => {
    const { service: svc, updateMany } = service(vehicleRow(sent));
    await expect(svc.updateInspectionResult('v1', body)).resolves.toMatchObject({
      inspectionResult: 'ผ่าน',
      inspectionResultDate: '2026-09-22',
      inspectionResultCost: '200',
    });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'v1',
      inspectionSentDate: sent.inspectionSentDate,
      inspectionResultDate: null,
    });
  });

  it('มีผลตรวจแล้ว บันทึกทับไม่ได้ ต้องใช้ปุ่มแก้ไขผลตรวจ (409)', async () => {
    const done = vehicleRow({ ...sent, inspectionResult: 'ผ่าน', inspectionResultDate: new Date('2026-09-22T00:00:00.000Z') });
    const { service: svc, updateMany } = service(done);
    expect(await failureOf(svc.updateInspectionResult('v1', { ...body, result: 'ไม่ผ่าน', remark: 'เลขตัวรถผิด' }))).toEqual({
      status: 409,
      error: 'รถคันนี้บันทึกผลตรวจแล้ว - ใช้ปุ่มแก้ไขผลตรวจ',
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ผลเก่าที่บันทึกไว้โดยไม่มีวันที่ บันทึกให้ครบได้', async () => {
    const legacy = vehicleRow({ ...sent, inspectionResult: 'ผ่าน', inspectionResultDate: null });
    const { service: svc, updateMany } = service(legacy);
    await svc.updateInspectionResult('v1', body);
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ inspectionResult: 'ผ่าน', inspectionResultDate: null });
  });

  it('มีคนบันทึกผลไปก่อนระหว่างนั้น ตอบ 409', async () => {
    const { service: svc } = service(vehicleRow(sent), { count: 0 });
    expect(await failureOf(svc.updateInspectionResult('v1', body))).toEqual(STALE);
  });

  it('ต้องมีวันที่ทราบผล', async () => {
    const { service: svc } = service(vehicleRow(sent));
    expect((await failureOf(svc.updateInspectionResult('v1', { ...body, resultDate: '' }))).error).toBe('กรุณาระบุวันที่ทราบผล');
  });

  it('วันที่ทราบผลต้องไม่ก่อนวันที่ส่งตรวจ', async () => {
    const { service: svc } = service(vehicleRow(sent));
    expect((await failureOf(svc.updateInspectionResult('v1', { ...body, resultDate: '2026-09-20' }))).error).toBe(
      'วันที่ทราบผลต้องไม่ก่อนวันที่ส่งตรวจ (21/09/2026)',
    );
  });

  it('วันที่ทราบผลต้องไม่เกินวันนี้ตามเวลาไทย', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T18:00:00.000Z')); // 27/09/2026 01:00 เวลาไทย
    const { service: svc } = service(vehicleRow(sent));
    await expect(svc.updateInspectionResult('v1', { ...body, resultDate: '2026-09-27' })).resolves.toMatchObject({
      inspectionResultDate: '2026-09-27',
    });
    expect((await failureOf(svc.updateInspectionResult('v1', { ...body, resultDate: '2026-09-28' }))).error).toBe(
      'วันที่ทราบผลต้องไม่เกินวันนี้',
    );
  });
});

describe('VehiclesService.correctInspectionSent', () => {
  const awaiting = vehicleRow({
    inspectionSentType: 'เอารถมาตรวจเอง',
    inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'),
    inspectionSentCost: '0',
  });
  const body = { sentType: 'ส่งตรวจนอก', sentDate: '2026-09-21', remark: 'ส่งตรวจนอกจริง บันทึกผิด' };

  it('แก้ประเภทการส่งตรวจ: คิดราคาใหม่ตามตาราง และบันทึกประวัติพร้อมเหตุผล', async () => {
    const { service: svc, updateMany, editLogCreate } = service(awaiting);
    await expect(svc.correctInspectionSent('v1', body)).resolves.toMatchObject({
      inspectionSentType: 'ส่งตรวจนอก',
      inspectionSentCost: '200',
    });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      inspectionSentDate: awaiting.inspectionSentDate,
      inspectionResult: null,
      inspectionResultDate: null,
    });
    const log = editLogCreate.mock.calls[0][0].data as { remark: string; changes: string };
    expect(log.remark).toBe('แก้การส่งตรวจ: ส่งตรวจนอกจริง บันทึกผิด');
    expect(JSON.parse(log.changes)).toEqual({
      inspectionSentType: { from: 'เอารถมาตรวจเอง', to: 'ส่งตรวจนอก' },
      inspectionSentCost: { from: '0', to: '200' },
    });
  });

  it('ต้องระบุเหตุผลที่แก้', async () => {
    const { service: svc, updateMany } = service(awaiting);
    expect((await failureOf(svc.correctInspectionSent('v1', { ...body, remark: ' ' }))).error).toBe('กรุณาระบุเหตุผลที่แก้การส่งตรวจ');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ข้อมูลเหมือนเดิม ไม่ต้องแก้', async () => {
    const { service: svc } = service(awaiting);
    expect((await failureOf(svc.correctInspectionSent('v1', { ...body, sentType: 'เอารถมาตรวจเอง' }))).error).toBe(
      'ข้อมูลการส่งตรวจเหมือนเดิม - ไม่มีอะไรต้องแก้',
    );
  });

  it('มีผลตรวจแล้ว แก้การส่งตรวจไม่ได้', async () => {
    const { service: svc } = service({ ...awaiting, inspectionResult: 'ผ่าน', inspectionResultDate: new Date('2026-09-22T00:00:00.000Z') });
    expect((await failureOf(svc.correctInspectionSent('v1', body))).error).toBe(
      'แก้/ยกเลิกการส่งตรวจได้เฉพาะรถที่ส่งตรวจแล้วและยังรอผลตรวจ',
    );
  });

  it('มีคนบันทึกผลไปก่อนระหว่างนั้น ตอบ 409 และไม่บันทึกประวัติ', async () => {
    const { service: svc } = service(awaiting, { count: 0 });
    expect(await failureOf(svc.correctInspectionSent('v1', body))).toEqual(STALE);
  });
});

describe('VehiclesService.cancelInspectionSent', () => {
  const awaiting = vehicleRow({
    inspectionRound: 2,
    inspectionSentType: 'ส่งตรวจนอก',
    inspectionSentDate: new Date('2026-09-21T00:00:00.000Z'),
    inspectionSentCost: '200',
    inspectionSentBillCost: '50',
  });

  it('ยกเลิกส่งตรวจ: ล้างข้อมูลส่งตรวจ รอบตรวจคงเดิม และบันทึกประวัติพร้อมเหตุผล', async () => {
    const { service: svc, updateMany, editLogCreate } = service(awaiting);
    await expect(svc.cancelInspectionSent('v1', { remark: 'ยังไม่ได้เอารถไปตรวจ' })).resolves.toEqual({
      id: 'v1',
      inspectionRound: 2,
      inspectionSentType: null,
      inspectionSentDate: null,
      inspectionSentCost: null,
      inspectionSentBillCost: null,
    });
    expect(updateMany.mock.calls[0][0].data).toEqual({
      inspectionSentType: null,
      inspectionSentDate: null,
      inspectionSentCost: null,
      inspectionSentBillCost: null,
    });
    expect(editLogCreate.mock.calls[0][0].data.remark).toBe('ยกเลิกส่งตรวจ: ยังไม่ได้เอารถไปตรวจ');
  });

  it('ต้องระบุเหตุผลที่ยกเลิก', async () => {
    const { service: svc } = service(awaiting);
    expect((await failureOf(svc.cancelInspectionSent('v1', { remark: '' }))).error).toBe('กรุณาระบุเหตุผลที่ยกเลิกส่งตรวจ');
  });

  it('ยื่นเอกสารแล้ว ย้อนกลับมายกเลิกไม่ได้', async () => {
    const { service: svc } = service({ ...awaiting, documentSubmissions: [{ id: 'sub1' }] });
    expect((await failureOf(svc.cancelInspectionSent('v1', { remark: 'ขอยกเลิก' }))).error).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนแล้ว - ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าไม่ได้',
    );
  });
});
