import { vi } from 'vitest';
import { DeliverySheetService } from './delivery-sheet.service.js';
import type { DeliveryService } from './delivery.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';

const asUser = <T>(roles: UserRole[], fn: () => T) => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

const customer = { id: 'c1', name: 'ลูกค้า', company: null, branch: null };
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const slipItem = (overrides: Record<string, unknown> = {}) => ({
  id: 'i1',
  source: 'VEHICLE',
  chassis: 'CH1',
  brandName: 'Lexus',
  vehicleKind: 'car',
  plateText: '8ขง 363',
  ownerName: 'เจ้าของ',
  book: true,
  plate: false,
  cancelledAt: null,
  ...overrides,
});
const slip = (overrides: Record<string, unknown> = {}) => ({
  id: 's1',
  slipNo: 7,
  date: '2026-10-03',
  cancelledAt: null,
  customer,
  items: [slipItem()],
  ...overrides,
});

function build(opts: { slips?: unknown[]; truncated?: boolean; tables?: Partial<Record<string, unknown[]>> } = {}) {
  const tables = opts.tables ?? {};
  const find = (name: string) => vi.fn().mockResolvedValue(tables[name] ?? []);
  const prisma = {
    taxRenewal: { findMany: find('taxRenewal') },
    vehicleUseCancellation: { findMany: find('vehicleUseCancellation') },
    plateCopy: { findMany: find('plateCopy') },
    vehicleTransfer: { findMany: find('vehicleTransfer') },
    vehicleMoveOut: { findMany: find('vehicleMoveOut') },
    yamahaRelocationEntry: { findMany: find('yamahaRelocationEntry') },
    // งานที่ส่งผ่านใบ DL แล้ว (ผู้ใช้ 2026-10-08) - ถูกตัดออกจากส่วนรายประเภท
    deliverySlipItem: { findMany: find('deliverySlipItem') },
  };
  const slips = vi.fn().mockResolvedValue({ slips: opts.slips ?? [], truncated: opts.truncated ?? false });
  const svc = new DeliverySheetService(prisma as unknown as PrismaService, { slips } as unknown as DeliveryService);
  return { svc, prisma, slips };
}

const common = {
  customer,
  chassis: 'CH2',
  plateCategory: '1กก',
  plateNumber: '99',
  brand: 'Honda',
  ownerName: 'เจ้าของรถ',
  updatedAt: new Date('2026-10-04T00:00:00.000Z'),
};

describe('DeliverySheetService.sheet', () => {
  it('รวมใบ DL (รถจดใหม่ + สลับเลข) กับงานอีก 5 ประเภทเป็นรายการเดียว เรียงวันที่ล่าสุดก่อน', async () => {
    const { svc } = build({
      slips: [slip({ items: [slipItem(), slipItem({ id: 'i2', source: 'PLATE_SWAP', chassis: 'SW1' })] })],
      tables: {
        taxRenewal: [{ ...common, id: 't1', deliveredDate: day('2026-10-04'), vehicleType: 'รย.1-เก๋ง' }],
        vehicleUseCancellation: [{ ...common, id: 'u1', deliveredDate: day('2026-10-01'), vehicleClass: 'CAR' }],
        plateCopy: [{ ...common, id: 'p1', deliveredDate: day('2026-10-02') }],
        vehicleTransfer: [{ ...common, id: 'x1', deliveredDate: day('2026-10-03'), vehicleClass: 'MOTO', transferType: 'INSPECTION', transfereeName: 'ผู้รับ' }],
        vehicleMoveOut: [{ ...common, id: 'm1', deliveredDate: day('2026-10-02'), vehicleClass: 'MOTO' }],
        yamahaRelocationEntry: [{ id: 'y1', date: day('2026-10-03'), size: 'SMALL', count: 12 }],
      },
    });
    const { rows, truncated } = await svc.sheet({ from: '2026-10-01', to: '2026-10-31' });
    expect(truncated).toBe(false);
    expect(rows.map((r) => `${r.date} ${r.source}`)).toEqual([
      '2026-10-04 TAX_RENEWAL',
      '2026-10-03 VEHICLE',
      '2026-10-03 PLATE_SWAP',
      '2026-10-03 TRANSFER',
      '2026-10-03 YAMAHA',
      '2026-10-02 PLATE_COPY',
      '2026-10-02 MOVE_OUT',
      '2026-10-01 USE_CANCEL',
    ]);
    const transfer = rows.find((r) => r.source === 'TRANSFER')!;
    expect(transfer).toMatchObject({ kind: 'moto', detail: 'โอนตรวจรถ', ownerName: 'ผู้รับ', plateText: '1กก 99' });
    expect(rows.find((r) => r.source === 'YAMAHA')).toMatchObject({ detail: 'รถเล็ก 12 คัน', customer: { id: 'YAMAHA' } });
    expect(rows.find((r) => r.source === 'VEHICLE')).toMatchObject({ slipId: 's1', slipNo: 7, detail: 'เล่ม' });
  });

  it('ข้ามใบและรายการ DL ที่ยกเลิกแล้ว', async () => {
    const { svc } = build({
      slips: [
        slip({ id: 's-cancelled', cancelledAt: new Date() }),
        slip({ items: [slipItem({ id: 'live', book: true, plate: true }), slipItem({ id: 'gone', cancelledAt: new Date() })] }),
      ],
    });
    const { rows } = await svc.sheet({});
    expect(rows.map((r) => r.key)).toEqual(['VEHICLE:live']);
    expect(rows[0].detail).toBe('เล่ม + ป้าย');
  });

  it('เลือกเจ้าของงานเฉพาะราย: ส่ง customerId ไปทุกตาราง และไม่เอายามาฮ่า (ไม่มีเจ้าของงานในข้อมูล)', async () => {
    const { svc, prisma, slips } = build();
    await svc.sheet({ from: '2026-10-01', to: '2026-10-31', customerId: 'c1' });
    expect(slips).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'c1' }));
    for (const table of ['taxRenewal', 'vehicleUseCancellation', 'plateCopy', 'vehicleTransfer', 'vehicleMoveOut'] as const) {
      expect(prisma[table].findMany.mock.calls[0][0].where).toMatchObject({ customerId: 'c1', cancelledAt: null });
    }
    expect(prisma.yamahaRelocationEntry.findMany).not.toHaveBeenCalled();
  });

  it('ช่วงวันที่ใช้กับวันที่ของแต่ละประเภท (คืนลูกค้า / รับเอกสารกลับ / วันแจ้งย้าย) รวมวันสุดท้าย', async () => {
    const { svc, prisma } = build();
    await svc.sheet({ from: '2026-10-01', to: '2026-10-31' });
    const range = { gte: day('2026-10-01'), lte: day('2026-10-31') };
    expect(prisma.taxRenewal.findMany.mock.calls[0][0].where.deliveredDate).toEqual(range);
    expect(prisma.vehicleUseCancellation.findMany.mock.calls[0][0].where.deliveredDate).toEqual(range);
    expect(prisma.plateCopy.findMany.mock.calls[0][0].where.deliveredDate).toEqual(range);
    expect(prisma.vehicleTransfer.findMany.mock.calls[0][0].where.deliveredDate).toEqual(range);
    expect(prisma.vehicleMoveOut.findMany.mock.calls[0][0].where.deliveredDate).toEqual(range);
    expect(prisma.yamahaRelocationEntry.findMany.mock.calls[0][0].where.date).toEqual(range);
  });

  it('ไม่ใส่ช่วงวันที่ = เฉพาะงานที่มีวันที่แล้ว (ยังไม่ส่ง/ยังไม่รับกลับไม่ติดมา)', async () => {
    const { svc, prisma } = build();
    await svc.sheet({});
    expect(prisma.taxRenewal.findMany.mock.calls[0][0].where.deliveredDate).toEqual({ not: null });
    expect(prisma.vehicleTransfer.findMany.mock.calls[0][0].where.deliveredDate).toEqual({ not: null });
  });

  // ผู้ใช้ 2026-10-08: งานอื่นส่งผ่านใบ DL - แถวจากใบ DL ขึ้นแล้ว ส่วนรายประเภทต้องไม่ขึ้นซ้ำ เหลือเฉพาะงานที่ส่งก่อนมีใบ (แก้วันที่ไม่ได้)
  it('งานที่ส่งผ่านใบ DL แล้วไม่ขึ้นซ้ำในส่วนรายประเภท งานเก่าที่ไม่มีใบยังขึ้นด้วยวันที่ส่ง', async () => {
    const { svc } = build({
      slips: [slip({ items: [slipItem({ id: 'j1', source: 'TRANSFER', chassis: 'TR-IN-SLIP', jobType: 'TRANSFER', jobId: 'x1', book: false, plate: false })] })],
      tables: {
        vehicleTransfer: [
          { ...common, id: 'x1', deliveredDate: day('2026-10-03'), vehicleClass: 'CAR', transferType: 'OWNER', transfereeName: 'ก' },
          { ...common, id: 'x2', chassis: 'LEGACY', deliveredDate: day('2026-10-02'), vehicleClass: 'CAR', transferType: 'OWNER', transfereeName: 'ข' },
        ],
        deliverySlipItem: [{ jobType: 'TRANSFER', jobId: 'x1' }],
      },
    });
    const { rows } = await svc.sheet({});
    expect(rows.map((r) => r.key)).toEqual(['TRANSFER:j1', 'TRANSFER:x2']);
    expect(rows[1].dateLabel).toContain('แก้ไม่ได้');
  });

  it('STAFF_MOTO เห็นเฉพาะมอเตอร์ไซค์ (รวมคัดป้ายมอเตอร์ไซค์)', async () => {
    const { svc, prisma } = build();
    await asUser(['STAFF_MOTO'], () => svc.sheet({}));
    expect(prisma.vehicleUseCancellation.findMany.mock.calls[0][0].where.vehicleClass).toBe('MOTO');
    expect(prisma.vehicleTransfer.findMany.mock.calls[0][0].where.vehicleClass).toBe('MOTO');
    expect(prisma.taxRenewal.findMany.mock.calls[0][0].where.OR).toEqual([{ vehicleType: { startsWith: 'รย.12-' } }, { vehicleType: { startsWith: 'รย.17-' } }]);
    expect(prisma.plateCopy.findMany.mock.calls[0][0].where.vehicleClass).toBe('MOTO');
  });

  it('STAFF_CAR เห็นเฉพาะรถยนต์', async () => {
    const { svc, prisma } = build();
    await asUser(['STAFF_CAR'], () => svc.sheet({}));
    expect(prisma.vehicleUseCancellation.findMany.mock.calls[0][0].where.vehicleClass).toBe('CAR');
    expect(prisma.taxRenewal.findMany.mock.calls[0][0].where.NOT).toEqual({ OR: [{ vehicleType: { startsWith: 'รย.12-' } }, { vehicleType: { startsWith: 'รย.17-' } }] });
    expect(prisma.plateCopy.findMany.mock.calls[0][0].where.vehicleClass).toBe('CAR');
  });

  it('DELIVERY เห็นเฉพาะใบ DL ไม่เห็นงานประเภทอื่น', async () => {
    const { svc, prisma } = build({ slips: [slip()] });
    const { rows } = await asUser(['DELIVERY'], () => svc.sheet({}));
    expect(rows).toHaveLength(1);
    expect(prisma.taxRenewal.findMany).not.toHaveBeenCalled();
    expect(prisma.yamahaRelocationEntry.findMany).not.toHaveBeenCalled();
  });

  it('truncated เมื่อใบ DL หรือตารางใดเกินเพดาน', async () => {
    expect((await build({ truncated: true }).svc.sheet({})).truncated).toBe(true);
    const many = Array.from({ length: 1001 }, (_, i) => ({ ...common, id: `t${i}`, deliveredDate: day('2026-10-01'), vehicleType: 'รย.1-เก๋ง' }));
    const { rows, truncated } = await build({ tables: { taxRenewal: many } }).svc.sheet({});
    expect(truncated).toBe(true);
    expect(rows).toHaveLength(1000);
  });

  it('วันที่ไม่ถูกต้อง / เริ่มหลังสิ้นสุด = 400', async () => {
    const { svc } = build();
    await expect(svc.sheet({ from: '01/10/2026' })).rejects.toThrow();
    await expect(svc.sheet({ from: '2026-10-05', to: '2026-10-01' })).rejects.toThrow();
  });
});
