import { buildSteps } from './portal.service.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'v1',
    date: day('2026-09-01'),
    chassis: 'CH1',
    color: null,
    body: 'รย.1-เก๋ง 4 ตอน',
    registrationProvince: 'กรุงเทพมหานคร',
    plateCategory: '8ขง',
    plateNumber: '363',
    transferDone: true,
    transferCompletedDate: day('2026-09-02'),
    inspectionSentDate: day('2026-09-03'),
    inspectionResult: 'ผ่าน',
    inspectionResultDate: day('2026-09-03'),
    plateReceivedDate: null,
    bookReceivedDate: day('2026-09-15'),
    deliveredDate: day('2026-09-20'),
    plateDeliveredDate: null,
    deliveryConfirmedAt: null,
    createdAt: day('2026-09-01'),
    brand: { name: 'Lexus' },
    documentSubmissions: [{ status: 'RECEIPT_RECEIVED', submitDate: day('2026-09-05'), receiptReceivedDate: day('2026-09-06') }],
    ...overrides,
  };
}

describe('buildSteps (พอร์ทัลลูกค้า)', () => {
  // ใบเสร็จไปพร้อมใบวางบิล ไม่ได้ไปกับงาน (ผู้ใช้ 2026-09-26) - ข้อความต้องไม่บอกลูกค้าว่าได้ใบเสร็จแล้ว (พบ 2026-09-27)
  it('ส่งเล่มแล้ว ป้ายยังค้าง: บอกว่าส่งเล่มแล้ว ไม่พูดถึงใบเสร็จ', () => {
    const delivery = buildSteps(row()).find((s) => s.key === 'delivery')!;
    expect(delivery.state).not.toBe('DONE');
    expect(delivery.note).toBe('ส่งเล่มแล้ว ป้ายจะส่งตามทีหลัง');
  });

  it('ส่งครบแล้ว: ไม่มีหมายเหตุ', () => {
    const delivery = buildSteps(row({ plateReceivedDate: day('2026-09-18'), plateDeliveredDate: day('2026-09-22') })).find((s) => s.key === 'delivery')!;
    expect(delivery).toMatchObject({ state: 'DONE', date: '2026-09-22', note: null });
  });
});
