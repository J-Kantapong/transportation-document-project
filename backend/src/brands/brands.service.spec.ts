import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { BrandsService } from './brands.service.js';

// เพิ่มยี่ห้อ: ชื่อซ้ำต่างตัวพิมพ์ = ยี่ห้อเดิม (พบ 2026-09-27: "BENZ" เคยกลายเป็นยี่ห้อที่สองข้าง "Benz")

function service(existing: unknown) {
  const findFirst = vi.fn().mockResolvedValue(existing);
  const upsert = vi.fn().mockImplementation(async ({ create }: { create: { name: string } }) => ({ id: 'new', name: create.name }));
  const prisma = { brand: { findFirst, upsert } } as unknown as PrismaService;
  return { service: new BrandsService(prisma), findFirst, upsert };
}

describe('BrandsService.create', () => {
  it('มียี่ห้อชื่อเดียวกันต่างตัวพิมพ์อยู่แล้ว คืนยี่ห้อเดิม ไม่สร้างใหม่', async () => {
    const { service: svc, findFirst, upsert } = service({ id: 'b1', name: 'Benz' });
    await expect(svc.create({ name: ' BENZ ' })).resolves.toEqual({ brand: { id: 'b1', name: 'Benz' } });
    expect(findFirst.mock.calls[0][0].where).toEqual({ name: { equals: 'BENZ', mode: 'insensitive' } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('ชื่อใหม่ สร้างยี่ห้อใหม่', async () => {
    const { service: svc, upsert } = service(null);
    await expect(svc.create({ name: 'Deepal' })).resolves.toEqual({ brand: { id: 'new', name: 'Deepal' } });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
