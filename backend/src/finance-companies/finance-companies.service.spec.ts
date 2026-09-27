import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { FinanceCompaniesService } from './finance-companies.service.js';

// เพิ่มไฟแนนซ์: ชื่อซ้ำต่างตัวพิมพ์ = ไฟแนนซ์เดิม (พบ 2026-09-27)

function service(existing: unknown) {
  const findFirst = vi.fn().mockResolvedValue(existing);
  const upsert = vi.fn().mockImplementation(async ({ create }: { create: { name: string } }) => ({ id: 'new', name: create.name }));
  const prisma = { financeCompany: { findFirst, upsert } } as unknown as PrismaService;
  return { service: new FinanceCompaniesService(prisma), findFirst, upsert };
}

describe('FinanceCompaniesService.create', () => {
  it('มีไฟแนนซ์ชื่อเดียวกันต่างตัวพิมพ์อยู่แล้ว คืนแถวเดิม ไม่สร้างใหม่', async () => {
    const { service: svc, findFirst, upsert } = service({ id: 'f1', name: 'Toyota Leasing' });
    await expect(svc.create({ name: 'toyota leasing' })).resolves.toEqual({ financeCompany: { id: 'f1', name: 'Toyota Leasing' } });
    expect(findFirst.mock.calls[0][0].where).toEqual({ name: { equals: 'toyota leasing', mode: 'insensitive' } });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('ชื่อใหม่ สร้างไฟแนนซ์ใหม่', async () => {
    const { service: svc, upsert } = service(null);
    await expect(svc.create({ name: 'Krungsri Auto' })).resolves.toEqual({ financeCompany: { id: 'new', name: 'Krungsri Auto' } });
    expect(upsert).toHaveBeenCalledTimes(1);
  });
});
