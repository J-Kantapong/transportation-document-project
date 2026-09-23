import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TaxService } from '../tax/tax.service.js';
import { VehiclesService } from './vehicles.service.js';

// แก้ไขผลตรวจที่บันทึกไปแล้ว (ผู้ใช้ 2026-09-23): เช่น บันทึกว่า "ผ่าน" ไปแล้ว แต่จริงๆ ตรวจไม่ผ่านเพราะเลขตัวรถผิด
// ต้องระบุเหตุผลที่แก้ทุกครั้ง และค่าใช้จ่ายคิดใหม่ตามผลตรวจใหม่ (ไม่ผ่าน = 0 ได้เงินคืน)

function vehicleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    chassis: 'MR2A79BF604099182',
    deletedAt: null,
    inspectionRound: 1,
    inspectionSentDate: new Date('2026-09-23T00:00:00.000Z'),
    inspectionSentCost: '300',
    inspectionSentBillCost: null,
    inspectionResult: 'ผ่าน',
    inspectionResultDate: new Date('2026-09-24T00:00:00.000Z'),
    inspectionResultCost: '300',
    inspectionResultBillCost: null,
    inspectionFailRemark: null,
    documentSubmissions: [] as unknown[],
    ...overrides,
  };
}

function service(found: unknown) {
  const update = vi.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 'v1', ...data }));
  const editLogCreate = vi.fn().mockResolvedValue({ id: 'log1' });
  const prisma = {
    vehicle: { findFirst: vi.fn().mockResolvedValue(found), update },
    vehicleEditLog: { create: editLogCreate },
    $transaction: vi.fn().mockImplementation((ops: unknown[]) => Promise.all(ops)),
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

const base = { result: 'ไม่ผ่าน', resultDate: '2026-09-24', failRemark: 'เลขตัวรถผิด', remark: 'บันทึกผลตรวจผิด' };

describe('VehiclesService.correctInspectionResult', () => {
  it('แก้จากผ่านเป็นไม่ผ่าน: ค่าตรวจเป็น 0 เก็บ Remark และบันทึกประวัติการแก้ไข', async () => {
    const { service: svc, update, editLogCreate } = service(vehicleRow());
    await expect(svc.correctInspectionResult('v1', base)).resolves.toMatchObject({
      inspectionResult: 'ไม่ผ่าน',
      inspectionResultDate: '2026-09-24',
      inspectionResultCost: '0',
      inspectionFailRemark: 'เลขตัวรถผิด',
    });
    expect(update.mock.calls[0][0].data.inspectionResultBillCost).toBeNull();
    expect(editLogCreate).toHaveBeenCalledTimes(1);
    const log = editLogCreate.mock.calls[0][0].data as { remark: string; changes: string };
    expect(log.remark).toBe('แก้ไขผลตรวจ (ผ่าน → ไม่ผ่าน): บันทึกผลตรวจผิด');
    expect(JSON.parse(log.changes)).toMatchObject({
      inspectionResult: { from: 'ผ่าน', to: 'ไม่ผ่าน' },
      inspectionResultCost: { from: '300', to: '0' },
      inspectionFailRemark: { from: null, to: 'เลขตัวรถผิด' },
    });
  });

  it('แก้กลับเป็นผ่าน: ค่าตรวจกลับไปเท่าราคาตอนส่งตรวจ และล้าง Remark เดิมทิ้ง', async () => {
    const failed = vehicleRow({ inspectionResult: 'ไม่ผ่าน', inspectionResultCost: '0', inspectionFailRemark: 'เลขตัวรถผิด' });
    const { service: svc } = service(failed);
    await expect(svc.correctInspectionResult('v1', { ...base, result: 'ผ่าน', failRemark: null })).resolves.toMatchObject({
      inspectionResult: 'ผ่าน',
      inspectionResultCost: '300',
      inspectionFailRemark: null,
    });
  });

  it('รอบ 2: ค่าตรวจรถ (Bill) คิดตามผลตรวจใหม่เหมือน No bill', async () => {
    const round2 = vehicleRow({ inspectionRound: 2, inspectionSentBillCost: '50', inspectionResultBillCost: '50' });
    const { service: svc } = service(round2);
    await expect(svc.correctInspectionResult('v1', base)).resolves.toMatchObject({ inspectionResultBillCost: '0' });
  });

  it('ไม่ใส่เหตุผลที่แก้ไข แก้ไม่ได้', async () => {
    const { service: svc, update } = service(vehicleRow());
    expect(await errorOf(svc.correctInspectionResult('v1', { ...base, remark: '  ' }))).toBe('กรุณาระบุเหตุผลที่แก้ไขผลตรวจ');
    expect(update).not.toHaveBeenCalled();
  });

  it('แก้เป็นไม่ผ่านโดยไม่ระบุ Remark แก้ไม่ได้', async () => {
    const { service: svc } = service(vehicleRow());
    expect(await errorOf(svc.correctInspectionResult('v1', { ...base, failRemark: '' }))).toBe('กรุณาระบุ Remark เมื่อตรวจไม่ผ่าน');
  });

  it('ผลตรวจต้องเป็นผ่าน/ไม่ผ่านเท่านั้น (ล้างผลตรวจทิ้งไม่ได้)', async () => {
    const { service: svc } = service(vehicleRow());
    expect(await errorOf(svc.correctInspectionResult('v1', { ...base, result: '' }))).toBe('ผลตรวจไม่ถูกต้อง');
  });

  it('วันที่ผิดรูปแบบ แก้ไม่ได้', async () => {
    const { service: svc } = service(vehicleRow());
    expect(await errorOf(svc.correctInspectionResult('v1', { ...base, resultDate: '24/09/2026' }))).toBe(
      'วันที่ต้องเป็น ค.ศ. YYYY-MM-DD ที่ถูกต้อง',
    );
  });

  it('รถที่ยังไม่มีผลตรวจ ใช้หน้าแก้ไขไม่ได้', async () => {
    const { service: svc } = service(vehicleRow({ inspectionResult: null, inspectionResultDate: null, inspectionResultCost: null }));
    expect(await errorOf(svc.correctInspectionResult('v1', base))).toBe('รถคันนี้ยังไม่มีผลตรวจที่บันทึกไว้ - ใช้หน้าบันทึกผลตรวจแทน');
  });

  it('ยื่นเอกสารจดทะเบียนไปแล้ว ย้อนกลับมาแก้ผลตรวจไม่ได้', async () => {
    const { service: svc, update } = service(vehicleRow({ documentSubmissions: [{ id: 'sub1' }] }));
    expect(await errorOf(svc.correctInspectionResult('v1', base))).toBe(
      'รถคันนี้ยื่นเอกสารจดทะเบียนแล้ว - ย้อนกลับไปแก้ไขขั้นตอนก่อนหน้าไม่ได้',
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('ไม่พบรถ (หรือถูกลบไปแล้ว)', async () => {
    const { service: svc } = service(null);
    expect(await errorOf(svc.correctInspectionResult('v1', base))).toBe('ไม่พบข้อมูลรถ');
  });
});
