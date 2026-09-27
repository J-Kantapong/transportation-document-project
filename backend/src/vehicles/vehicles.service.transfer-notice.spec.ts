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

  it('คันที่ดำเนินการแล้วถูกย้อนเป็นยังไม่เสร็จ (เรียก API ตรง) บันทึกลงประวัติการแก้ไข', async () => {
    const done = vehicleRow({ transferDone: true, transferCompletedDate: new Date('2026-09-25T00:00:00.000Z'), transferCost: '300' });
    const { service: svc, editLogCreate } = service(done);
    await svc.updateTransferNotice('v1', { done: false, completedDate: null, cost: '300', expectedTransferDone: true });
    const log = editLogCreate.mock.calls[0][0].data as { remark: string; changes: string };
    expect(log.remark).toBe('ย้อนสถานะแจ้งย้าย/ตัดบัญชีเป็นยังไม่ดำเนินการ');
    expect(JSON.parse(log.changes)).toEqual({
      transferDone: { from: 'true', to: 'false' },
      transferCompletedDate: { from: '2026-09-25', to: null },
    });
  });

  it('ยื่นเอกสารแล้ว ย้อนกลับมาแก้ไม่ได้', async () => {
    const { service: svc } = service(vehicleRow({ documentSubmissions: [{ id: 'sub1' }] }));
    expect((await failureOf(svc.updateTransferNotice('v1', body))).error).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนแล้ว - ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าไม่ได้',
    );
  });
});
