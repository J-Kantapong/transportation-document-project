import {
  addDays,
  agingBuckets,
  bangkokToday,
  billValueOf,
  buildForecast,
  daysBetween,
  inProcessMoney,
  overdueByCustomer,
  paymentBehaviour,
  pctChange,
  type PaidSample,
} from './overview-calculator.js';

describe('วันที่', () => {
  it('เลื่อนและนับวัน', () => {
    expect(addDays('2026-09-24', 7)).toBe('2026-10-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(daysBetween('2026-09-01', '2026-09-24')).toBe(23);
    expect(daysBetween('2026-09-24', '2026-09-01')).toBe(-23);
  });

  it('วันนี้ตามเวลาไทย: 17:30 UTC เป็นวันถัดไปแล้ว', () => {
    expect(bangkokToday(new Date('2026-09-24T16:59:00.000Z'))).toBe('2026-09-24');
    expect(bangkokToday(new Date('2026-09-24T17:30:00.000Z'))).toBe('2026-09-25');
  });
});

describe('pctChange', () => {
  it('คำนวณ % และไม่หลอกเมื่อไม่มีฐานเทียบ', () => {
    expect(pctChange(150, 100)).toBe(50);
    expect(pctChange(50, 100)).toBe(-50);
    expect(pctChange(100, 0)).toBeNull();
  });
});

describe('agingBuckets', () => {
  it('แบ่งตามอายุบิล', () => {
    const b = agingBuckets(
      [
        { date: '2026-09-20', amount: 100 },
        { date: '2026-08-10', amount: 200 }, // 45 วัน
        { date: '2026-07-20', amount: 300 }, // 66 วัน
        { date: '2026-05-01', amount: 400 }, // 146 วัน
      ],
      '2026-09-24',
    );
    expect(b.map((x) => x.amount)).toEqual([100, 200, 300, 400]);
    expect(b.map((x) => x.count)).toEqual([1, 1, 1, 1]);
  });
});

describe('overdueByCustomer (สรุปเช้าของเลขา)', () => {
  const item = (customerId: string, dueDate: string | null, amount: number) => ({ customerId, customerName: `ลูกค้า ${customerId}`, dueDate, amount });

  it('นับเฉพาะบิลที่เลยกำหนด (วันครบกำหนดไม่นับ) และไม่นับบิลที่ไม่มีวันครบกำหนด', () => {
    const r = overdueByCustomer(
      [item('a', '2026-09-23', 100), item('a', '2026-09-24', 999), item('b', null, 999), item('b', '2026-09-25', 999)],
      '2026-09-24',
    );
    expect(r.count).toBe(1);
    expect(r.amount).toBe(100);
    expect(r.customers).toEqual([{ customerId: 'a', customerName: 'ลูกค้า a', count: 1, amount: 100, maxDaysOver: 1 }]);
  });

  it('รวมต่อลูกค้า เรียงเกินกำหนดนานสุดก่อน แล้วยอดมากก่อน', () => {
    const r = overdueByCustomer(
      [item('a', '2026-09-20', 100.5), item('a', '2026-09-23', 200), item('b', '2026-09-10', 50), item('c', '2026-09-20', 900)],
      '2026-09-24',
    );
    expect(r.count).toBe(4);
    expect(r.amount).toBe(1250.5);
    expect(r.customers.map((c) => c.customerId)).toEqual(['b', 'c', 'a']);
    expect(r.customers[2]).toMatchObject({ count: 2, amount: 300.5, maxDaysOver: 4 });
  });

  it('ไม่มีบิลเลยกำหนด', () => {
    expect(overdueByCustomer([], '2026-09-24')).toEqual({ count: 0, amount: 0, customers: [] });
  });
});

describe('billValueOf / inProcessMoney (พบ 2026-09-27)', () => {
  const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
  const sub = (o: Partial<{ status: string; receiptAmount: unknown; submitDate: Date }> = {}) => ({
    status: 'PENDING',
    receiptAmount: null,
    billFeeTotal: 250,
    taxAmount: 2150,
    submitDate: d('2026-09-20'),
    ...o,
  });

  it('ได้ใบเสร็จแล้วใช้ยอดบนใบเสร็จจริง ยังไม่ได้/ไม่ได้กรอกยอดใช้ Bill + ภาษีที่ระบบคำนวณ', () => {
    expect(billValueOf(sub())).toBe(2400);
    expect(billValueOf(sub({ status: 'RECEIPT_RECEIVED', receiptAmount: 2450 }))).toBe(2450);
    expect(billValueOf(sub({ status: 'RECEIPT_RECEIVED', receiptAmount: null }))).toBe(2400);
    expect(billValueOf({ status: 'PENDING', receiptAmount: null, billFeeTotal: 250, taxAmount: null })).toBe(250);
  });

  it('งานคีย์ล่วงหน้า (วันที่ยื่นหลังวันนี้) ไม่นับเป็นเงินที่จ่ายแล้ว - แยกเป็น advance', () => {
    const m = inProcessMoney(
      [
        sub({ submitDate: d('2026-09-27') }), // วันนี้ = จ่ายแล้ว
        sub({ status: 'RECEIPT_RECEIVED', receiptAmount: 2450, submitDate: d('2026-09-20') }),
        sub({ submitDate: d('2026-09-28') }), // พรุ่งนี้ = ยังไม่จ่าย
      ],
      '2026-09-27',
    );
    expect(m.inProcess).toEqual({ amount: 4850, count: 2 });
    expect(m.advance).toEqual({ amount: 2400, count: 1 });
  });
});

describe('paymentBehaviour', () => {
  const sample = (customerId: string, issueDate: string, paidDate: string, firstDeliveredDate: string | null = null): PaidSample => ({
    customerId,
    issueDate,
    paidDate,
    firstDeliveredDate,
  });

  it('ไม่มีประวัติ ใช้ค่าเริ่มต้น', () => {
    const p = paymentBehaviour([]);
    expect(p.avgDaysToPay).toBeNull();
    expect(p.payDaysFor('c1')).toBe(30);
    expect(p.billingLagDays).toBe(7);
  });

  it('ลูกค้าที่มีประวัติครบใช้ค่าเฉลี่ยของตัวเอง ที่เหลือใช้ค่าเฉลี่ยรวม', () => {
    const p = paymentBehaviour([
      sample('a', '2026-08-01', '2026-08-11', '2026-07-28'), // 10 วัน, lag 4
      sample('a', '2026-08-02', '2026-08-12'),
      sample('a', '2026-08-03', '2026-08-13'),
      sample('b', '2026-08-01', '2026-09-30'), // 60 วัน (ลูกค้าเดียว ไม่ถึงเกณฑ์)
    ]);
    expect(p.payDaysFor('a')).toBe(10);
    expect(p.payDaysFor('b')).toBe(23); // (10+10+10+60)/4 = 22.5 -> 23
    expect(p.billingLagDays).toBe(4);
  });
});

describe('buildForecast', () => {
  const base = { today: '2026-09-24', weeks: 4, payDaysFor: () => 30, billingLagDays: 7, avgDailySpend: 1000 };

  it('วางบิลครบกำหนดในสัปดาห์ที่ 2, บิลที่เลยกำหนดเข้าสัปดาห์แรก, บิลเก่าเกิน 90 วันเป็นเงินเสี่ยง', () => {
    const f = buildForecast({
      ...base,
      receivable: [
        { customerId: 'a', issueDate: '2026-08-25', amount: 1000 }, // ครบ 09-24 -> สัปดาห์ 1
        { customerId: 'a', issueDate: '2026-09-01', amount: 2000 }, // ครบ 10-01 -> สัปดาห์ 2
        { customerId: 'a', issueDate: '2026-08-01', amount: 4000 }, // ครบ 08-31 เลยกำหนดแล้ว -> สัปดาห์ 1 (overdue)
        { customerId: 'a', issueDate: '2026-05-01', amount: 8000 }, // เก่าเกิน 90 วัน -> เสี่ยง
      ],
      unbilled: [],
    });
    expect(f.weeks[0].inflow).toBe(5000);
    expect(f.weeks[0].overdueInflow).toBe(4000);
    expect(f.weeks[1].inflow).toBe(2000);
    expect(f.atRiskAmount).toBe(8000);
    expect(f.atRiskCount).toBe(1);
  });

  it('งานส่งแล้วยังไม่วางบิล: วางบิลหลัง lag แล้วรอชำระ - เลยเวลาวางบิลนับเป็นวางบิลวันนี้', () => {
    const f = buildForecast({
      ...base,
      payDaysFor: () => 20,
      receivable: [],
      unbilled: [
        { customerId: 'a', deliveredDate: '2026-09-22', amount: 500 }, // วางบิล 09-29 + 20 = 10-19 (อีก 25 วัน) -> สัปดาห์ที่ 4
        { customerId: 'a', deliveredDate: '2026-08-30', amount: 700 }, // ควรวางบิล 09-06 เลยแล้ว -> วางบิลวันนี้ + 20 = 10-14 (อีก 20 วัน) -> สัปดาห์ที่ 3
        { customerId: 'a', deliveredDate: '2026-01-01', amount: 900 }, // เก่ามาก ข้อมูลค้างสะสม ไม่นับ
      ],
    });
    expect(f.weeks.map((w) => w.inflow)).toEqual([0, 0, 700, 500]);
  });

  it('รายจ่ายคาดการณ์ = ค่าเฉลี่ยต่อวัน x 7 และสะสมสุทธิถูกต้อง', () => {
    const f = buildForecast({ ...base, receivable: [], unbilled: [] });
    expect(f.weeks.map((w) => w.outflow)).toEqual([7000, 7000, 7000, 7000]);
    expect(f.weeks[3].cumulativeNet).toBe(-28000);
    expect(f.weeks[0].weekStart).toBe('2026-09-24');
    expect(f.weeks[0].weekEnd).toBe('2026-09-30');
  });
});
