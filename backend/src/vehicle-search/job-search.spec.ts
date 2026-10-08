import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { searchJobs } from './job-search.js';

// ค้นงานอื่นๆ ในหน้าค้นหารถ (ผู้ใช้ 2026-10-08): ทะเบียน "ตค 8772" ต้องหางานยกเลิกการใช้รถเจอ (พบ: หน้าค้นหารถเดิมค้นเฉพาะรถจดใหม่)

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function fakePrisma(cancels: unknown[] = []) {
  const empty = vi.fn().mockResolvedValue([]);
  const cancelFind = vi.fn().mockResolvedValue(cancels);
  const prisma = {
    plateSwap: { findMany: empty },
    vehicleUseCancellation: { findMany: cancelFind },
    vehicleMoveOut: { findMany: empty },
    plateCopy: { findMany: empty },
    vehicleTransfer: { findMany: empty },
    taxRenewal: { findMany: empty },
  };
  return { prisma: prisma as unknown as PrismaService, cancelFind };
}

describe('searchJobs', () => {
  it('ไม่มีคำค้น = ไม่ค้น (ไม่ query ฐานข้อมูล)', async () => {
    const { prisma, cancelFind } = fakePrisma();
    const result = await searchJobs(prisma, { q: '  ' });
    expect(result).toEqual({ jobs: [], truncated: false, allowed: true });
    expect(cancelFind).not.toHaveBeenCalled();
  });

  it('ทะเบียนพิมพ์มีเว้นวรรคถูกแยกเป็นหมวด + เลข และผลถูกแปลงเป็นแถวพร้อมสถานะ/ลิงก์', async () => {
    const { prisma, cancelFind } = fakePrisma([
      {
        id: 'u1',
        vehicleClass: 'CAR',
        submitDate: d('2026-10-01'),
        ownerName: 'สมชาย',
        chassis: 'JTH123',
        engine: 'E1',
        brand: 'Lexus',
        plateCategory: 'ตค',
        plateNumber: '8772',
        returnedDate: null,
        cancelledAt: null,
        customer: { name: 'Lexus Auto City' },
      },
    ]);
    const result = await searchJobs(prisma, { q: 'ตค 8772' });

    const where = cancelFind.mock.calls[0][0].where;
    expect(where.OR).toContainEqual({ plateCategory: { contains: 'ตค', mode: 'insensitive' }, plateNumber: '8772' });
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      type: 'USE_CANCEL',
      typeLabel: 'ยกเลิกการใช้รถ',
      plate: 'ตค 8772',
      status: 'รอรับใบเสร็จ',
      done: false,
      href: '/registration/other/cancel-use/car/return',
      date: '2026-10-01',
    });
  });

  it('ตัวกรองประเภทรถ moto ไม่ค้นรถยนต์', async () => {
    const { prisma, cancelFind } = fakePrisma();
    await searchJobs(prisma, { q: 'abc', kind: 'moto' });
    expect(cancelFind.mock.calls[0][0].where.vehicleClass).toEqual({ in: ['MOTO'] });
  });
});
