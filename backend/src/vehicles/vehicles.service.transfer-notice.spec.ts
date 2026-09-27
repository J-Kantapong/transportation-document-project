import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehiclesService } from './vehicles.service.js';

// แจ้งย้าย/ตัดบัญชี (Step 2) - พบ 2026-09-27: "บันทึกทั้งหมด" จากหน้าที่เปิดค้างไว้เคยทำให้คันที่คนอื่นเพิ่งทำเสร็จ
// กลับเป็นยังไม่เสร็จ และบันทึก "ดำเนินการแล้ว" โดยไม่มีวันที่เสร็จได้

function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    body: 'รย.1-เก๋ง 2 ตอน',
    deletedAt: null,
    transferDone: false,
    transferCompletedDate: null,
    transferCost: null,
    documentSubmissions: [] as unknown[],
    ...overrides,
  };
}

function service(found: unknown, options: { count?: number } = {}) {
  const updateMany = vi.fn().mockResolvedValue({ count: options.count ?? 1 });
  const editLogCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const tx = { vehicle: { updateMany }, vehicleEditLog: { create: editLogCreate } };
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(found), updateMany },
    vehicleEditLog: { create: editLogCreate },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma), updateMany, editLogCreate };
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

describe('VehiclesService.updateTransferNotice', () => {
  const body = { done: true, completedDate: '2026-09-26', cost: '500', expectedTransferDone: false };

  it('ติ๊กดำเนินการแล้ว: บันทึกแบบมีเงื่อนไขว่ายังเป็นสถานะที่อ่านมา ไม่บันทึกประวัติ (ยังไม่เคยเสร็จ)', async () => {
    const { service: svc, updateMany, editLogCreate } = service(vehicleRow());
    await expect(svc.updateTransferNotice('v1', body)).resolves.toEqual({
      id: 'v1',
      transferDone: true,
      transferCompletedDate: '2026-09-26',
      transferCost: '500',
    });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ id: 'v1', deletedAt: null, transferDone: false });
    expect(updateMany.mock.calls[0][0].data).toEqual({
      transferDone: true,
      transferCompletedDate: new Date('2026-09-26T00:00:00.000Z'),
      transferCost: '500',
    });
    expect(editLogCreate).not.toHaveBeenCalled();
  });

  it('ดำเนินการแล้วต้องมีวันที่เสร็จ', async () => {
    const { service: svc, updateMany } = service(vehicleRow());
    expect((await failureOf(svc.updateTransferNotice('v1', { ...body, completedDate: null }))).error).toBe('กรุณาระบุวันที่เสร็จ');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('วันที่เสร็จต้องไม่เกินวันนี้ตามเวลาไทย (พบ 2026-09-27: วันในอนาคตทำให้ส่งตรวจด้วยวันจริงไม่ได้)', async () => {
    vi.useFakeTimers();
    // 27/09/2026 เวลา 20:00 ที่ไทย = 13:00 UTC - วันนี้คือ 27/09 และพรุ่งนี้ (28/09) ยังบันทึกไม่ได้
    vi.setSystemTime(new Date('2026-09-27T13:00:00.000Z'));
    try {
      const { service: svc, updateMany } = service(vehicleRow());
      expect(await failureOf(svc.updateTransferNotice('v1', { ...body, completedDate: '2026-09-28' }))).toEqual({
        status: 400,
        error: 'วันที่เสร็จต้องไม่เกินวันนี้',
      });
      expect(updateMany).not.toHaveBeenCalled();
      await expect(svc.updateTransferNotice('v1', { ...body, completedDate: '2026-09-27' })).resolves.toMatchObject({
        transferCompletedDate: '2026-09-27',
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('หน้าจอโหลดมาตอนยังไม่เสร็จ แต่มีคนทำเสร็จไปแล้ว = 409 ไม่เขียนทับ', async () => {
    const done = vehicleRow({ transferDone: true, transferCompletedDate: new Date('2026-09-25T00:00:00.000Z'), transferCost: '300' });
    const { service: svc, updateMany } = service(done);
    expect(await failureOf(svc.updateTransferNotice('v1', { done: false, completedDate: null, cost: '500', expectedTransferDone: false }))).toEqual({
      status: 409,
      error: 'ข้อมูลถูกแก้ไขโดยผู้อื่น - โหลดรายการใหม่',
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('มีคนบันทึกไปก่อนระหว่างนั้น (บันทึกแบบมีเงื่อนไขไม่โดนแถวไหน) = 409', async () => {
    const { service: svc } = service(vehicleRow(), { count: 0 });
    expect((await failureOf(svc.updateTransferNotice('v1', body))).status).toBe(409);
  });

  it('คันที่ดำเนินการแล้วแก้/ย้อนสถานะทาง API นี้ไม่ได้ ต้องใช้ "✎ แก้" ที่มีเหตุผล (ผู้ใช้ 2026-09-27)', async () => {
    const done = vehicleRow({ transferDone: true, transferCompletedDate: new Date('2026-09-25T00:00:00.000Z'), transferCost: '300' });
    const { service: svc, updateMany, editLogCreate } = service(done);
    expect(await failureOf(svc.updateTransferNotice('v1', { done: false, completedDate: null, cost: '300', expectedTransferDone: true }))).toEqual({
      status: 400,
      error: 'รถคันนี้ดำเนินการแจ้งย้าย/ตัดบัญชีแล้ว - แก้ได้ที่ปุ่ม "✎ แก้" (ต้องระบุเหตุผล)',
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(editLogCreate).not.toHaveBeenCalled();
  });

  it('ยื่นเอกสารแล้ว ย้อนกลับมาแก้ไม่ได้', async () => {
    const { service: svc } = service(vehicleRow({ documentSubmissions: [{ id: 'sub1' }] }));
    expect((await failureOf(svc.updateTransferNotice('v1', body))).error).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนแล้ว - ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าไม่ได้',
    );
  });
});

// "✎ แก้" คันที่ดำเนินการแล้ว (ผู้ใช้ 2026-09-27): ยกเลิกสถานะได้เฉพาะก่อนส่งตรวจ แก้วันที่/ค่าใช้จ่ายได้จนกว่าจะยื่นเอกสาร
// ต้องระบุเหตุผลทุกครั้ง และบันทึกลงประวัติการแก้ไข (VehicleEditLog)
describe('VehiclesService.correctTransferNotice', () => {
  const doneRow = (overrides: Record<string, unknown> = {}) =>
    vehicleRow({
      transferDone: true,
      transferCompletedDate: new Date('2026-09-20T00:00:00.000Z'),
      transferCost: '300',
      inspectionSentDate: null,
      ...overrides,
    });
  const fix = { done: true, completedDate: '2026-09-21', cost: '350', remark: 'พิมพ์วันที่ผิด' };

  it('ต้องระบุเหตุผล', async () => {
    const { service: svc, updateMany } = service(doneRow());
    expect(await failureOf(svc.correctTransferNotice('v1', { ...fix, remark: '  ' }))).toEqual({
      status: 400,
      error: 'กรุณาระบุเหตุผลที่แก้แจ้งย้าย/ตัดบัญชี',
    });
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('แก้วันที่/ค่าใช้จ่าย: บันทึกแบบมีเงื่อนไขว่ายังเป็นข้อมูลที่อ่านมา และเก็บประวัติพร้อมเหตุผล', async () => {
    const { service: svc, updateMany, editLogCreate } = service(doneRow());
    await expect(svc.correctTransferNotice('v1', fix)).resolves.toEqual({
      id: 'v1',
      transferDone: true,
      transferCompletedDate: '2026-09-21',
      transferCost: '350',
    });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({
      id: 'v1',
      deletedAt: null,
      transferDone: true,
      transferCompletedDate: new Date('2026-09-20T00:00:00.000Z'),
      transferCost: '300',
      inspectionSentDate: null,
    });
    expect(updateMany.mock.calls[0][0].data).toEqual({
      transferDone: true,
      transferCompletedDate: new Date('2026-09-21T00:00:00.000Z'),
      transferCost: '350',
    });
    const log = editLogCreate.mock.calls[0][0].data as { remark: string; changes: string };
    expect(log.remark).toBe('แก้แจ้งย้าย/ตัดบัญชี: พิมพ์วันที่ผิด');
    expect(JSON.parse(log.changes)).toEqual({
      transferCompletedDate: { from: '2026-09-20', to: '2026-09-21' },
      transferCost: { from: '300', to: '350' },
    });
  });

  it('ยกเลิกสถานะก่อนส่งตรวจ: ล้างวันที่/ค่าใช้จ่าย รถกลับเข้าคิวต้องดำเนินการ', async () => {
    const { service: svc, updateMany, editLogCreate } = service(doneRow());
    await expect(svc.correctTransferNotice('v1', { done: false, completedDate: null, cost: null, remark: 'ติ๊กผิดคัน' })).resolves.toEqual({
      id: 'v1',
      transferDone: false,
      transferCompletedDate: null,
      transferCost: null,
    });
    expect(updateMany.mock.calls[0][0].data).toEqual({ transferDone: false, transferCompletedDate: null, transferCost: null });
    const log = editLogCreate.mock.calls[0][0].data as { remark: string; changes: string };
    expect(log.remark).toBe('ยกเลิกสถานะแจ้งย้าย/ตัดบัญชี: ติ๊กผิดคัน');
    expect(JSON.parse(log.changes)).toEqual({
      transferDone: { from: 'true', to: 'false' },
      transferCompletedDate: { from: '2026-09-20', to: null },
      transferCost: { from: '300', to: null },
    });
  });

  it('ส่งตรวจแล้ว: ยกเลิกสถานะไม่ได้ แต่แก้วันที่/ค่าใช้จ่ายได้ (วันที่เสร็จต้องไม่หลังวันส่งตรวจ)', async () => {
    const sent = doneRow({ inspectionSentDate: new Date('2026-09-22T00:00:00.000Z') });
    const { service: svc, updateMany } = service(sent);
    expect(await failureOf(svc.correctTransferNotice('v1', { done: false, completedDate: null, cost: null, remark: 'ติ๊กผิด' }))).toEqual({
      status: 400,
      error: 'รถคันนี้ส่งตรวจแล้ว - ยกเลิกสถานะแจ้งย้าย/ตัดบัญชีไม่ได้ (แก้ได้เฉพาะวันที่เสร็จ/ค่าใช้จ่าย)',
    });
    expect(await failureOf(svc.correctTransferNotice('v1', { ...fix, completedDate: '2026-09-23' }))).toEqual({
      status: 400,
      error: 'วันที่เสร็จต้องไม่หลังวันที่ส่งตรวจ (22/09/2026)',
    });
    expect(updateMany).not.toHaveBeenCalled();
    await expect(svc.correctTransferNotice('v1', { ...fix, completedDate: '2026-09-22' })).resolves.toMatchObject({
      transferCompletedDate: '2026-09-22',
    });
    expect(updateMany.mock.calls[0][0].where).toMatchObject({ inspectionSentDate: new Date('2026-09-22T00:00:00.000Z') });
  });

  it('ยื่นเอกสารแล้วแก้ไม่ได้ / คันที่ยังไม่ดำเนินการใช้ปุ่มนี้ไม่ได้ / ไม่มีอะไรเปลี่ยน = 400', async () => {
    expect((await failureOf(service(doneRow({ documentSubmissions: [{ id: 's1' }] })).service.correctTransferNotice('v1', fix))).error).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนแล้ว - ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าไม่ได้',
    );
    expect((await failureOf(service(vehicleRow()).service.correctTransferNotice('v1', fix))).error).toBe(
      'รถคันนี้ยังไม่ได้ดำเนินการแจ้งย้าย/ตัดบัญชี - บันทึกที่ตาราง "ต้องดำเนินการ"',
    );
    const same = { ...fix, completedDate: '2026-09-20', cost: '300.00' };
    expect((await failureOf(service(doneRow()).service.correctTransferNotice('v1', same))).error).toBe(
      'ข้อมูลแจ้งย้าย/ตัดบัญชีเหมือนเดิม - ไม่มีอะไรต้องแก้',
    );
  });

  it('วันที่เสร็จต้องมี ถูกต้อง และไม่เกินวันนี้ ค่าใช้จ่ายต้องเป็นตัวเลข', async () => {
    const { service: svc } = service(doneRow());
    expect((await failureOf(svc.correctTransferNotice('v1', { ...fix, completedDate: '' }))).error).toBe('กรุณาระบุวันที่เสร็จ');
    expect((await failureOf(svc.correctTransferNotice('v1', { ...fix, completedDate: '2999-01-01' }))).error).toBe('วันที่เสร็จต้องไม่เกินวันนี้');
    expect((await failureOf(svc.correctTransferNotice('v1', { ...fix, cost: '-5' }))).error).toBe('ค่าใช้จ่ายต้องเป็นตัวเลขตั้งแต่ 0');
    expect((await failureOf(svc.correctTransferNotice('v1', { ...fix, done: 'yes' }))).error).toBe('done ต้องเป็น true/false');
  });

  // พบ 2026-09-27 รอบตรวจ: A กับ B เปิด ✎ แก้ คันเดียวกัน A แก้วันที่ไปแล้ว B ที่ยังเห็นวันที่เดิมแก้แค่ค่าใช้จ่ายแล้วกดบันทึก
  // เดิมบันทึกผ่าน (เทียบแค่ค่าที่ service เพิ่งอ่าน) วันที่ที่ A แก้จึงถูกเขียนทับกลับ
  it('dialog ส่งวันที่/ค่าใช้จ่ายที่แสดงอยู่มา ไม่ตรงกับในฐานข้อมูล (มีคนแก้ไปก่อน) = 409 ไม่เขียนทับ', async () => {
    const edited = doneRow({ transferCompletedDate: new Date('2026-09-21T00:00:00.000Z'), transferCost: '600' });
    const { service: svc, updateMany, editLogCreate } = service(edited);
    const stale = { ...fix, completedDate: '2026-09-20', cost: '550', expectedCompletedDate: '2026-09-20', expectedCost: '500' };
    expect(await failureOf(svc.correctTransferNotice('v1', stale))).toEqual({ status: 409, error: 'ข้อมูลถูกแก้ไขโดยผู้อื่น - โหลดรายการใหม่' });
    // วันที่ตรงแต่ค่าใช้จ่ายไม่ตรง ก็ 409 เหมือนกัน
    expect((await failureOf(svc.correctTransferNotice('v1', { ...stale, expectedCompletedDate: '2026-09-21' }))).status).toBe(409);
    expect(updateMany).not.toHaveBeenCalled();
    expect(editLogCreate).not.toHaveBeenCalled();
  });

  it('ค่าที่ dialog แสดงตรงกับในฐานข้อมูล (ค่าใช้จ่ายเทียบเป็นตัวเลข ว่าง = null) = บันทึกได้', async () => {
    const { service: svc, updateMany } = service(doneRow());
    await expect(
      svc.correctTransferNotice('v1', { ...fix, expectedCompletedDate: '2026-09-20', expectedCost: '300.00' }),
    ).resolves.toMatchObject({ transferCompletedDate: '2026-09-21' });
    expect(updateMany).toHaveBeenCalledTimes(1);

    const noCost = service(doneRow({ transferCost: null }));
    await expect(noCost.service.correctTransferNotice('v1', { ...fix, expectedCompletedDate: '2026-09-20', expectedCost: null })).resolves.toMatchObject({
      transferCost: '350',
    });
    expect((await failureOf(noCost.service.correctTransferNotice('v1', { ...fix, expectedCompletedDate: 'x' }))).error).toBe(
      'expectedCompletedDate ต้องเป็น ค.ศ. YYYY-MM-DD หรือ null',
    );
  });

  it('มีคนแก้/ส่งตรวจ/ยื่นไปก่อนระหว่างนั้น (บันทึกแบบมีเงื่อนไขไม่โดนแถวไหน) = 409 ไม่เก็บประวัติ', async () => {
    const { service: svc, editLogCreate } = service(doneRow(), { count: 0 });
    expect(await failureOf(svc.correctTransferNotice('v1', fix))).toEqual({ status: 409, error: 'ข้อมูลถูกแก้ไขโดยผู้อื่น - โหลดรายการใหม่' });
    expect(editLogCreate).not.toHaveBeenCalled();
  });
});

// รายการที่ดำเนินการแล้ว: ค้นหา + ทีละ 100 คัน (ผู้ใช้ 2026-09-27: เดิมแสดงแค่ 100 คันล่าสุด คันที่เก่ากว่านั้นหาไม่เจอจึงแก้ไม่ได้)
describe('VehiclesService.findRecentlyCompletedTransferNotice', () => {
  function listService(rows: unknown[]) {
    const findMany = vi.fn().mockResolvedValue(rows);
    const prisma = {
      vehicle: { findMany },
      feeDeregistration: { findMany: vi.fn().mockResolvedValue([]) },
      feeRelocate: { findMany: vi.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    return { service: new VehiclesService(prisma), findMany };
  }
  const listed = (id: string, overrides: Record<string, unknown> = {}) => ({
    ...vehicleRow({ id, transferDone: true, transferCompletedDate: new Date('2026-09-20T00:00:00.000Z'), transferCost: '300' }),
    date: new Date('2026-09-01T00:00:00.000Z'),
    chassis: `CH${id}`,
    registrationProvince: 'กรุงเทพมหานคร',
    inspectionSentDate: null,
    customer: { name: 'ลูกค้า' },
    brand: { name: 'Toyota' },
    ...overrides,
  });

  it('ค้นทั้งฐานข้อมูลด้วย q และบอกว่ายังมีหน้าถัดไป พร้อมสถานะที่ปุ่ม ✎ แก้ ใช้', async () => {
    const { service: svc, findMany } = listService([
      listed('v1', { inspectionSentDate: new Date('2026-09-22T00:00:00.000Z') }),
      listed('v2', { documentSubmissions: [{ id: 's1' }] }),
      listed('v3'),
    ]);
    const result = await svc.findRecentlyCompletedTransferNotice({ q: 'CH', offset: '100', limit: '2' });
    const args = findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ deletedAt: null, transferDone: true });
    expect(args.where.OR).toBeDefined();
    expect(args.skip).toBe(100);
    expect(args.take).toBe(3);
    expect(result.hasMore).toBe(true);
    expect(result.vehicles.map((v) => [v.id, v.inspectionSentDate, v.submitted])).toEqual([
      ['v1', '2026-09-22', false],
      ['v2', null, true],
    ]);
  });
});
