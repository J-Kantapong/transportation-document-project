import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { VehicleSearchService } from './vehicle-search.service.js';

// หน้าค้นหารถ (ผู้ใช้ 2026-09-25): สถานะมาจาก waitsFor() ตัวเดียวกับภาพรวม - เทสต์การกรอง/นับ/แบ่งหน้า

const TODAY = '2026-09-25';
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function vehicle(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    date: d('2026-09-01'),
    chassis: `CH${id}`,
    engine: null,
    body: 'รย.1',
    plateCategory: null,
    plateNumber: null,
    transferDone: false,
    transferCompletedDate: null,
    inspectionSentDate: null,
    inspectionResult: null,
    inspectionResultDate: null,
    inspectionFailRemark: null,
    plateReceivedDate: null,
    bookReceivedDate: null,
    deliveredDate: null,
    plateDeliveredDate: null,
    customer: { name: 'ลูกค้า' },
    brand: { name: 'Toyota' },
    documentSubmissions: [] as unknown[],
    plateSwapsAsNew: [] as unknown[],
    invoiceLines: [] as unknown[],
    ...overrides,
  };
}

const finished = (id: string) =>
  vehicle(id, {
    transferDone: true,
    plateReceivedDate: d('2026-09-10'),
    bookReceivedDate: d('2026-09-10'),
    deliveredDate: d('2026-09-11'),
    plateDeliveredDate: d('2026-09-11'),
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED', submitDate: d('2026-09-05'), receiptDate: d('2026-09-05'), receiptReceivedDate: d('2026-09-06'), failRemark: null, receiptCarriedAt: null }],
    invoiceLines: [{ id: 'l1' }],
  });

function service(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const prisma = { vehicle: { findMany } } as unknown as PrismaService;
  return { svc: new VehicleSearchService(prisma), findMany };
}

describe('VehicleSearchService.search', () => {
  it('บอกขั้นที่ค้างและจำนวนวัน - เกินกำหนดนับเป็นมีปัญหา', async () => {
    const { svc } = service([vehicle('late'), vehicle('fresh', { date: d('2026-09-24') })]);
    const result = await svc.search({}, TODAY);
    const late = result.vehicles.find((v) => v.id === 'late')!;
    expect(late.statuses).toMatchObject([{ stage: 'transfer', days: 24, late: true }]);
    expect(late.problem).toBe(true);
    expect(result.vehicles.find((v) => v.id === 'fresh')!.problem).toBe(false);
    expect(result.counts).toMatchObject({ transfer: 2, problem: 1, done: 0 });
  });

  it('รถที่จบงานแล้วไม่มีขั้นค้าง และกรอง done ได้', async () => {
    const { svc } = service([vehicle('a'), finished('b')]);
    const result = await svc.search({ status: 'done' }, TODAY);
    expect(result.vehicles.map((v) => v.id)).toEqual(['b']);
    expect(result.vehicles[0].statuses).toEqual([]);
    expect(result.total).toBe(1);
    expect(result.all).toBe(2);
  });

  it('กรองประเภทรถ - นับสถานะเฉพาะประเภทที่เลือก', async () => {
    const { svc } = service([vehicle('car'), vehicle('moto', { body: 'รย.12-ก' })]);
    const result = await svc.search({ kind: 'moto' }, TODAY);
    expect(result.vehicles.map((v) => v.id)).toEqual(['moto']);
    expect(result.counts.transfer).toBe(1);
  });

  it('แบ่งหน้าทีละ 100 คัน', async () => {
    const { svc } = service(Array.from({ length: 150 }, (_, i) => vehicle(`v${i}`)));
    const first = await svc.search({}, TODAY);
    expect(first.vehicles).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    const second = await svc.search({ offset: '100' }, TODAY);
    expect(second.vehicles).toHaveLength(50);
    expect(second.hasMore).toBe(false);
  });

  it('สถานะหรือประเภทรถที่ไม่รู้จักตอบ 400', async () => {
    const { svc } = service([]);
    await expect(svc.search({ status: 'bogus' }, TODAY)).rejects.toMatchObject({ response: { error: 'สถานะที่เลือกไม่ถูกต้อง' } });
    await expect(svc.search({ kind: 'truck' }, TODAY)).rejects.toMatchObject({ status: 400 });
  });

  it('ส่งคำค้นและช่วงวันที่ไปที่ query และไม่รวมรถที่ถูกลบ', async () => {
    const { svc, findMany } = service([]);
    await svc.search({ q: 'ABC', from: '2026-09-01', to: '2026-09-30' }, TODAY);
    const where = findMany.mock.calls[0][0].where;
    expect(where.deletedAt).toBeNull();
    expect(where.date).toEqual({ gte: d('2026-09-01'), lte: d('2026-09-30') });
    expect(where.OR).toContainEqual({ chassis: { contains: 'ABC', mode: 'insensitive' } });
  });
});
