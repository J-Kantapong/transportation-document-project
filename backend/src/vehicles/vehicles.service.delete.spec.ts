import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TaxService } from '../tax/tax.service.js';
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

function service(found: unknown, options: { plateSwap?: unknown; activeWithSameChassis?: unknown } = {}) {
  const update = vi.fn().mockResolvedValue({ id: 'v1' });
  const editLogCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const tx = { vehicle: { update }, vehicleEditLog: { create: editLogCreate } };
  const prisma = {
    vehicle: {
      findUnique: vi.fn().mockResolvedValue(found),
      findFirst: vi.fn().mockResolvedValue(options.activeWithSameChassis ?? null),
      update,
    },
    plateSwap: { findFirst: vi.fn().mockResolvedValue(options.plateSwap ?? null) },
    vehicleEditLog: { create: editLogCreate },
    $transaction: vi.fn().mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { service: new VehiclesService(prisma, {} as TaxService), update, editLogCreate };
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
    const { service: svc, update } = service(vehicleRow());
    expect(await errorOf(svc.deleteVehicle('v1', { remark: '   ' }))).toBe('กรุณาระบุเหตุผลที่ลบ (Remark)');
    expect(update).not.toHaveBeenCalled();
  });

  it('ลบสำเร็จ: ตั้ง deletedAt + เก็บเหตุผล และบันทึกลงประวัติการแก้ไข', async () => {
    const { service: svc, update, editLogCreate } = service(vehicleRow());
    await expect(svc.deleteVehicle('v1', { remark: 'คีย์ผิดคัน' })).resolves.toEqual({ id: 'v1', deleted: true });
    const data = update.mock.calls[0][0].data as { deletedAt: Date; deletedReason: string };
    expect(data.deletedAt).toBeInstanceOf(Date);
    expect(data.deletedReason).toBe('คีย์ผิดคัน');
    expect(editLogCreate).toHaveBeenCalledTimes(1);
    expect(editLogCreate.mock.calls[0][0].data.remark).toBe('คีย์ผิดคัน');
  });

  it('รถที่ถูกลบไปแล้ว ลบซ้ำไม่ได้', async () => {
    const { service: svc } = service(vehicleRow({ deletedAt: new Date('2026-09-23T00:00:00.000Z') }));
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ลบซ้ำ' }))).toBe('รถคันนี้ถูกลบไปแล้ว');
  });

  it('ยื่นเอกสารจดทะเบียนไปแล้ว ลบไม่ได้ (รวมถึงครั้งที่ยื่นไม่สำเร็จ)', async () => {
    const { service: svc, update } = service(vehicleRow({ documentSubmissions: [{ id: 'sub1' }] }));
    expect(await errorOf(svc.deleteVehicle('v1', { remark: 'ขอลบ' }))).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนไปแล้ว - ลบไม่ได้ ถ้าข้อมูลผิดให้ใช้ปุ่มแก้ไขแทน',
    );
    expect(update).not.toHaveBeenCalled();
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

  it('เลขตัวถังเดิมถูกคีย์เข้ามาใหม่แล้ว กู้คืนไม่ได้', async () => {
    const deleted = vehicleRow({ deletedAt: new Date('2026-09-23T00:00:00.000Z') });
    const { service: svc, update } = service(deleted, { activeWithSameChassis: { id: 'v2' } });
    expect(await errorOf(svc.restoreVehicle('v1'))).toBe('เลขตัวถัง MR0FZ29G001234567 ถูกบันทึกเข้ามาใหม่แล้ว - กู้คืนคันนี้ไม่ได้');
    expect(update).not.toHaveBeenCalled();
  });
});
