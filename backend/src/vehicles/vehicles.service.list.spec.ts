import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import type { TaxService } from '../tax/tax.service.js';
import { VehiclesService } from './vehicles.service.js';

// รายการรถในหน้าเพิ่มข้อมูลรถจดใหม่: ทีละ 100 คัน + ค้นหา + กรองช่วงวันที่ (ผู้ใช้ 2026-09-25)

function service(rowCount: number) {
  const findMany = vi.fn().mockResolvedValue(Array.from({ length: rowCount }, (_, i) => ({ id: `v${i}` })));
  const prisma = { vehicle: { findMany } } as unknown as PrismaService;
  const svc = new VehiclesService(prisma, {} as TaxService);
  // mapVehicleFull ต้องใช้ include ครบทุกความสัมพันธ์ - ในเทสต์นี้สนใจแค่ query ที่ส่งไป
  vi.spyOn(svc as unknown as { mapVehicleFull: (v: unknown) => unknown }, 'mapVehicleFull').mockImplementation((v) => v);
  return { svc, findMany };
}

describe('VehiclesService.findAll', () => {
  it('ค่าเริ่มต้น 100 คันล่าสุด และบอกว่ายังมีหน้าถัดไป', async () => {
    const { svc, findMany } = service(101);
    const result = await svc.findAll();
    expect(result.vehicles).toHaveLength(100);
    expect(result.hasMore).toBe(true);
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { deletedAt: null }, skip: 0, take: 101 });
  });

  it('โหลดเพิ่มด้วย offset และหน้าสุดท้าย hasMore = false', async () => {
    const { svc, findMany } = service(20);
    const result = await svc.findAll({ offset: '100' });
    expect(result.hasMore).toBe(false);
    expect(findMany.mock.calls[0][0]).toMatchObject({ skip: 100, take: 101 });
  });

  it('กรองช่วงวันที่รวมวันปลายทั้งสองด้าน', async () => {
    const { svc, findMany } = service(0);
    await svc.findAll({ from: '2026-09-01', to: '2026-09-22' });
    expect(findMany.mock.calls[0][0].where.date).toEqual({
      gte: new Date('2026-09-01T00:00:00.000Z'),
      lte: new Date('2026-09-22T00:00:00.000Z'),
    });
  });

  it('วันที่ผิดรูปแบบตอบ 400', async () => {
    const { svc } = service(0);
    await expect(svc.findAll({ from: '2026-13-01' })).rejects.toMatchObject({ response: { error: expect.stringContaining('from') } });
  });

  it('ทะเบียนพิมพ์ติดกันค้นเป็นหมวด + เลขท้าย', async () => {
    const { svc, findMany } = service(0);
    await svc.findAll({ q: '4กข 4444' });
    expect(findMany.mock.calls[0][0].where.OR).toContainEqual({
      plateCategory: { contains: '4กข', mode: 'insensitive' },
      plateNumber: '4444',
    });
  });

  it('limit สูงสุด 1,000', async () => {
    const { svc, findMany } = service(0);
    await svc.findAll({ limit: '5000' });
    expect(findMany.mock.calls[0][0].take).toBe(1001);
  });
});
