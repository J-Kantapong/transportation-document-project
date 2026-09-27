import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehiclesService } from './vehicles.service.js';

// ลบข้อมูลรถจดใหม่ (ผู้ใช้ 2026-09-23): ต้องมีเหตุผลทุกครั้ง และลบได้เฉพาะรถที่ยังไม่เลยขั้นยื่นเอกสาร

function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'MR0FZ29G001234567',
    deletedAt: null,
    deletedReason: null,
    documentSubmissions: [] as unknown[],
    invoiceLines: [] as unknown[],
    ...overrides,
  };
}

const chassisConflict = Object.assign(new Error('Unique constraint failed'), {
  code: 'P2002',
  meta: { target: 'Vehicle_chassis_active_key' },
});

function service(
  found: unknown,
  options: { plateSwap?: unknown; activeWithSameChassis?: unknown; deleteCount?: number; reread?: unknown; writeError?: unknown } = {},
) {
  const update = vi.fn().mockImplementation(async () => {
    if (options.writeError) throw options.writeError;
    return { id: 'v1' };
  });
  // ลบใช้ updateMany แบบมีเงื่อนไข (count 0 = มีคนยื่น/วางบิลรถคันนี้ระหว่างที่กำลังลบ)
  const updateMany = vi.fn().mockResolvedValue({ count: options.deleteCount ?? 1 });
  const editLogCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const findFirst = vi.fn().mockResolvedValue(options.activeWithSameChassis ?? null);
  const lockRow = vi.fn().mockResolvedValue([{ id: 'v1' }]);
  const tx = { vehicle: { update, updateMany }, vehicleEditLog: { create: editLogCreate }, $queryRaw: lockRow };
  const prisma = {
    vehicle: {
      // ครั้งแรก = ตอนตรวจก่อนลบ ครั้งถัดไป = อ่านใหม่หลังลบไม่สำเร็จ
      findUnique: vi.fn().mockResolvedValueOnce(found).mockResolvedValue(options.reread ?? found),
      findFirst,
      update,
    },
    plateSwap: { findFirst: vi.fn().mockResolvedValue(options.plateSwap ?? null) },
    vehicleEditLog: { create: editLogCreate },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma), update, updateMany, editLogCreate, findFirst, lockRow };
}

async function errorOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return '';
  } catch (e) {
    return (e as { response?: { error?: string } }).response?.error ?? '';
  }
}

describe('VehiclesService.deleteVehicle', () => {
  it('ไม่ใส่เหตุผลที่ลบ (remark) ลบไม่ได้', async () => {
    const { service: svc, updateMany } = service(vehicleRow());
    expect(await errorOf(svc.deleteVehicle('v1', { remark: '   ' }))).toBe('กรุณาระบุเหตุผลที่ลบ (Remark)');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('ลบสำเร็จ: ตั้ง deletedAt + เก็บเหตุผล และบันทึกลงประวัติการแก้ไข', async () => {
    const { service: svc, updateMany, editLogCreate } = service(vehicleRow());
    await expect(svc.deleteVehicle('v1', { remark: 'คีย์ผิดคัน' })).resolves.toEqual({ id: 'v1', deleted: true });
    const data = updateMany.mock.calls[0][0].data as { deletedAt: Date; deletedReason: string };
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.deletedReason).toBe('คีย์ผิดคัน');
    expect(editLogCreate).toHaveBeenCalledTimes(1);
    expect(editLogCreate.mock.calls[0][0].data.remark).toBe('คีย์ผิดคัน');
  });

  it('ลบแบบมีเงื่อนไขในคำสั่งเดียว: ยังไม่ถูกลบ ไม่มีรายการยื่น และไม่มีบิล (พบ 2026-09-27)', async () => {
    const { service: svc, updateMany, lockRow } = service(vehicleRow());
    await svc.deleteVehicle('v1', { remark: 'คีย์ผิดคัน' });
    // ล็อกแถวรถก่อนลบ ให้ต่อคิวกับการยื่นเอกสาร/วางบิลที่ล็อกแถวเดียวกัน
    expect(String(lockRow.mock.calls[0][0])).toContain('FOR UPDATE');
    expect(lockRow.mock.invocationCallOrder[0]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
    expect(updateMany.mock.calls[0][0].where).toEqual({
      id: 'v1',
      deletedAt: null,
      documentSubmissions: { none: {} },
      invoiceLines: { none: {} },
    });
  });

  it('มีคนยื่นเอกสารระหว่างที่กำลังลบ: ไม่ลบ ไม่บันทึกประวัติ และบอกเหตุผล', async () => {
    const { service: svc, editLogCreate } = service(vehicleRow(), {
      deleteCount: 0,
      reread: vehicleRow({ documentSubmissions: [{ id: 'sub1' }] }),
    });
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ขอลบ' }))).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนไปแล้ว - ลบไม่ได้ ถ้าข้อมูลผิดให้ใช้ปุ่มแก้ไขแทน',
    );
    expect(editLogCreate).not.toHaveBeenCalled();
  });

  it('มีคนลบไปก่อนระหว่างนั้น: บอกว่าถูกลบไปแล้ว', async () => {
    const { service: svc } = service(vehicleRow(), {
      deleteCount: 0,
      reread: vehicleRow({ deletedAt: new Date('2026-09-27T00:00:00.000Z') }),
    });
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ขอลบ' }))).toBe('รถคันนี้ถูกลบไปแล้ว');
  });

  it('รถที่ถูกลบไปแล้ว ลบซ้ำไม่ได้', async () => {
    const { service: svc } = service(vehicleRow({ deletedAt: new Date('2026-09-23T00:00:00.000Z') }));
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ลบซ้ำ' }))).toBe('รถคันนี้ถูกลบไปแล้ว');
  });

  it('ยื่นเอกสารจดทะเบียนไปแล้ว ลบไม่ได้ (รวมถึงครั้งที่ยื่นไม่สำเร็จ)', async () => {
    const { service: svc, updateMany } = service(vehicleRow({ documentSubmissions: [{ id: 'sub1' }] }));
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ขอลบ' }))).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนไปแล้ว - ลบไม่ได้ ถ้าข้อมูลผิดให้ใช้ปุ่มแก้ไขแทน',
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('วางบิลแล้ว ลบไม่ได้', async () => {
    const { service: svc } = service(vehicleRow({ invoiceLines: [{ id: 'line1' }] }));
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ขอลบ' }))).toBe('รถคันนี้ถูกวางบิลแล้ว - ลบไม่ได้');
  });

  it('ถูกผูกเป็นรถใหม่ของงานสลับเลข ลบไม่ได้', async () => {
    const { service: svc } = service(vehicleRow(), { plateSwap: { id: 's1' } });
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ขอลบ' }))).toBe(
      'รถคันนี้ถูกผูกเป็นรถใหม่ของงานสลับเลข - ต้องไปแก้งานสลับเลขให้ผูกคันอื่นก่อนจึงจะลบได้',
    );
  });
});

describe('VehiclesService.restoreVehicle', () => {
  it('กู้คืนสำเร็จ: ล้าง deletedAt และบันทึกประวัติ', async () => {
    const deleted = vehicleRow({ deletedAt: new Date('2026-09-23T00:00:00.000Z'), deletedReason: 'คีย์ผิดคัน' });
    const { service: svc, update, editLogCreate } = service(deleted);
    await expect(svc.restoreVehicle('v1')).resolves.toEqual({ id: 'v1', deleted: false });
    expect(update.mock.calls[0][0].data).toEqual({ deletedAt: null, deletedReason: null, deletedById: null });
    expect(editLogCreate.mock.calls[0][0].data.remark).toContain('คีย์ผิดคัน');
  });

  it('รถที่ไม่ได้ถูกลบ กู้คืนไม่ได้', async () => {
    const { service: svc } = service(vehicleRow());
    expect(await errorOf(svc.restoreVehicle('v1'))).toBe('รถคันนี้ไม่ได้ถูกลบอยู่');
  });

  it('เลขตัวถังเดิมถูกคีย์เข้ามาใหม่แล้ว กู้คืนไม่ได้ (เทียบแบบไม่สนตัวพิมพ์)', async () => {
    const deleted = vehicleRow({ deletedAt: new Date('2026-09-23T00:00:00.000Z') });
    const { service: svc, update, findFirst } = service(deleted, { activeWithSameChassis: { id: 'v2' } });
    expect(await errorOf(svc.restoreVehicle('v1'))).toBe('เลขตัวถัง MR0FZ29G001234567 ถูกบันทึกเข้ามาใหม่แล้ว - กู้คืนคันนี้ไม่ได้');
    expect(update).not.toHaveBeenCalled();
    expect(findFirst.mock.calls[0][0].where).toMatchObject({
      deletedAt: null,
      chassis: { equals: 'MR0FZ29G001234567', mode: 'insensitive' },
    });
  });

  it('มีคนคีย์เลขตัวถังเดิมเข้ามาระหว่างกู้คืน (unique index) ตอบ 409 แทน 500 (พบ 2026-09-27)', async () => {
    const deleted = vehicleRow({ deletedAt: new Date('2026-09-23T00:00:00.000Z') });
    const { service: svc } = service(deleted, { writeError: chassisConflict });
    await expect(svc.restoreVehicle('v1')).rejects.toMatchObject({
      status: 409,
      response: { error: 'เลขตัวถัง MR0FZ29G001234567 ถูกบันทึกเข้ามาใหม่แล้ว - กู้คืนคันนี้ไม่ได้' },
    });
  });
});
