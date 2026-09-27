import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../prisma/prisma.service.js';
import { OverviewService } from './overview.service.js';

// ภาพรวมผู้บริหาร (พบ 2026-09-27): ประมาณการใช้ค่าเฉลี่ยถึงวันนี้แม้ดูวันย้อนหลัง, งานคีย์ล่วงหน้าไม่นับเป็นเงินที่จ่ายแล้ว,
// งานที่ได้ใบเสร็จแล้วใช้ยอดบนใบเสร็จ และรายการรถติดขัดตัดทีละประเภทรถ

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

const sub = (submitDate: string, o: Record<string, unknown> = {}) => ({
  submitDate: d(submitDate),
  status: 'PENDING',
  receiptAmount: null,
  billFeeTotal: 250,
  taxAmount: 2150,
  noBillTotal: 0,
  vehicle: { body: 'รย.1-เก๋ง 2 ตอน' },
  ...o,
});

// รถที่ยังไม่แจ้งย้าย รับเข้าระบบมานาน = ติดขัดที่ขั้นแจ้งย้าย
const openVehicle = (id: string, body: string, date: string) => ({
  id,
  date: d(date),
  chassis: `CH${id}`,
  body,
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
  documentSubmissions: [],
  plateSwapsAsNew: [],
  invoiceLines: [],
});

type Where = Record<string, unknown> & { status?: { not?: string; in?: string[] }; OR?: Array<Record<string, unknown>> };

function service(o: { spendSubs?: unknown[]; inProcessSubs?: unknown[]; openVehicles?: unknown[] } = {}) {
  const subFind = vi.fn(async ({ where }: { where: Where }) => {
    if (where.status?.not === 'FAILED') return o.spendSubs ?? [];
    if (where.status?.in) return o.inProcessSubs ?? [];
    return [];
  });
  const vehicleFind = vi.fn(async ({ where }: { where: Where }) =>
    where.OR?.some((c) => 'plateDeliveredDate' in c && c.plateDeliveredDate === null) ? (o.openVehicles ?? []) : [],
  );
  const empty = () => ({ findMany: vi.fn().mockResolvedValue([]) });
  const prisma = {
    documentSubmission: { findMany: subFind },
    vehicle: { findMany: vehicleFind },
    plateSwap: empty(),
    taxRenewal: empty(),
    yamahaRelocationEntry: empty(),
    invoice: empty(),
    invoiceLine: empty(),
    user: { count: vi.fn().mockResolvedValue(0) },
  } as unknown as PrismaService;
  return { svc: new OverviewService(prisma), subFind };
}

describe('OverviewService.overview', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-27T05:00:00.000Z')); // วันนี้ = 2026-09-27 ตามเวลาไทย
  });
  afterEach(() => vi.useRealTimers());

  it('ดูวันย้อนหลัง: ประมาณการใช้ค่าเฉลี่ยใช้เงิน 28 วันถึงวันนี้ ไม่ใช่ถึงวันที่เลือก', async () => {
    const { svc, subFind } = service({
      spendSubs: [sub('2026-09-26', { billFeeTotal: 2800, taxAmount: 0 }), sub('2026-06-30', { billFeeTotal: 5600, taxAmount: 0 })],
    });
    const result = await svc.overview('2026-06-30');
    expect(result.spend.today.total).toBe(5600); // ตัวเลขของวันที่เลือกยังเป็นของวันนั้น
    expect(result.forecast.avgDailySpend).toBe(100); // 2,800 / 28 วันถึงวันนี้
    expect(result.forecast.weeks[0].weekStart).toBe('2026-09-27');
    // ดึงช่วง 28 วันถึงวันนี้มาด้วย นอกจาก 60 วันถึงวันที่เลือก
    const where = subFind.mock.calls.find(([a]) => a.where.status?.not === 'FAILED')![0].where;
    expect(where.OR).toContainEqual({ submitDate: { gte: d('2026-08-31'), lte: d('2026-09-27') } });
    expect(where.OR).toContainEqual({ submitDate: { gte: d('2026-05-02'), lte: d('2026-06-30') } });
  });

  it('ดูวันนี้: ดึงช่วงเดียว (28 วันอยู่ใน 60 วันแล้ว)', async () => {
    const { svc, subFind } = service({ spendSubs: [sub('2026-09-27', { billFeeTotal: 2800, taxAmount: 0 })] });
    const result = await svc.overview();
    expect(result.forecast.avgDailySpend).toBe(100);
    const where = subFind.mock.calls.find(([a]) => a.where.status?.not === 'FAILED')![0].where;
    expect(where.OR).toEqual([{ submitDate: { gte: d('2026-07-30'), lte: d('2026-09-27') } }]);
  });

  it('ใช้เงิน: งานที่ได้ใบเสร็จแล้วใช้ยอดบนใบเสร็จจริงแทน Bill ที่ระบบคำนวณ', async () => {
    const { svc } = service({
      spendSubs: [sub('2026-09-27', { status: 'RECEIPT_RECEIVED', receiptAmount: 2450, noBillTotal: 200 }), sub('2026-09-27')],
    });
    const result = await svc.overview();
    expect(result.spend.today).toMatchObject({ bill: 4850, noBill: 200, total: 5050 });
  });

  it('จ่ายแล้วระหว่างดำเนินการ: ไม่นับงานที่คีย์ล่วงหน้า และใช้ยอดใบเสร็จจริงเมื่อมี', async () => {
    const { svc } = service({
      inProcessSubs: [
        sub('2026-09-20', { status: 'RECEIPT_RECEIVED', receiptAmount: 2450 }),
        sub('2026-09-27'),
        sub('2026-09-28'), // ยื่นพรุ่งนี้ ยังไม่ได้จ่าย
      ],
    });
    const result = await svc.overview();
    expect(result.workingCapital.inProcess).toEqual({ amount: 4850, count: 2 });
    expect(result.workingCapital.advance).toEqual({ amount: 2400, count: 1 });
    expect(result.workingCapital.total).toBe(4850);
  });

  it('ยื่นแล้วแต่คำนวณภาษีไม่ได้: แจ้งจำนวนคัน (ได้ใบเสร็จแล้วใช้ยอดจริง ไม่นับ, งานคีย์ล่วงหน้าไม่นับ)', async () => {
    const { svc } = service({
      inProcessSubs: [
        sub('2026-09-20', { taxAmount: null }),
        sub('2026-09-21', { status: 'RECEIPT_RECEIVED', receiptAmount: 400, taxAmount: null }),
        sub('2026-09-22'),
        sub('2026-09-28', { taxAmount: null }), // ยื่นพรุ่งนี้ อยู่ในคีย์ล่วงหน้า ไม่ใช่ยอดจ่ายแล้วระหว่างดำเนินการ
      ],
    });
    const result = await svc.overview();
    expect(result.alerts.find((a) => a.key === 'tax-missing')?.detail).toMatch(/^1 คัน/);
    const { svc: none } = service({ inProcessSubs: [sub('2026-09-22')] });
    expect((await none.overview()).alerts.some((a) => a.key === 'tax-missing')).toBe(false);
    const { svc: advanceOnly } = service({ inProcessSubs: [sub('2026-09-28', { taxAmount: null })] });
    expect((await advanceOnly.overview()).alerts.some((a) => a.key === 'tax-missing')).toBe(false);
  });

  it('รถติดขัด: ตัดทีละประเภทรถ จักรยานยนต์ที่นับบนปุ่มจึงมีในรายการเสมอ', async () => {
    const cars = Array.from({ length: 101 }, (_, i) => openVehicle(`c${i}`, 'รย.1-เก๋ง 2 ตอน', '2026-08-01'));
    const { svc } = service({ openVehicles: [...cars, openVehicle('m1', 'รย.12-จักรยานยนต์', '2026-09-20')] });
    const result = await svc.overview();
    expect(result.stuck.total).toBe(102);
    expect(result.stuck.byKind).toEqual({ car: 101, moto: 1 });
    expect(result.stuck.limit).toBe(100);
    expect(result.stuck.items).toHaveLength(101); // รถยนต์ 100 คันที่ด่วนสุด + จักรยานยนต์ 1 คัน
    expect(result.stuck.items.filter((i) => i.kind === 'moto').map((i) => i.id)).toEqual(['m1']);
  });
});
