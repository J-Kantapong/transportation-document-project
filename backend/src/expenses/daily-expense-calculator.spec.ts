import {
  collectExpenseItems,
  ruleForDay,
  type DailyExpenseRuleInput,
  type ExpenseVehicleInput,
} from './daily-expense-calculator.js';

const INSPECTION_FEE: DailyExpenseRuleInput = {
  code: 'INSPECTION_REQUEST_FEE',
  label: 'ค่าคำขอตรวจรถ',
  trigger: 'INSPECTION_DAY',
  amount: '25',
  effectiveFrom: '2000-01-01',
  active: true,
};

function vehicle(overrides: Partial<ExpenseVehicleInput> = {}): ExpenseVehicleInput {
  return {
    id: 'v1',
    chassis: 'CH1',
    customerName: 'ลูกค้า',
    brandName: 'Toyota',
    transferDone: false,
    transferCompletedDate: null,
    transferCost: null,
    inspectionSentType: null,
    inspectionSentDate: null,
    inspectionSentCost: null,
    inspectionResult: null,
    inspectionResultDate: null,
    inspectionResultCost: null,
    inspectionRound2Done: false,
    inspectionRound2Date: null,
    inspectionRound2Cost: null,
    ...overrides,
  };
}

function collect(vehicles: ExpenseVehicleInput[], rules = [INSPECTION_FEE], from = '2026-09-19', to = from) {
  return collectExpenseItems({ vehicles, yamahaEntries: [], rules, from, to });
}

describe('collectExpenseItems - ค่าคำขอตรวจรถ 25 บาทต่อวัน', () => {
  it('คิด 25 บาทครั้งเดียวต่อวัน ไม่ว่าวันนั้นจะตรวจกี่คัน', () => {
    const items = collect([
      vehicle({ id: 'a', inspectionSentType: 'ส่งตรวจนอก', inspectionSentDate: '2026-09-19', inspectionSentCost: '300' }),
      vehicle({ id: 'b', inspectionSentType: 'ส่งตรวจนอก', inspectionSentDate: '2026-09-19', inspectionSentCost: '300' }),
      vehicle({ id: 'c', inspectionRound2Done: true, inspectionRound2Date: '2026-09-19', inspectionRound2Cost: '100' }),
    ]);

    const ruleItems = items.filter((i) => i.category === 'DAILY_RULE');
    expect(ruleItems).toHaveLength(1);
    expect(ruleItems[0].amountSatang).toBe(2500);
    expect(ruleItems[0].detail).toContain('3 คัน');
  });

  it('วันที่ไม่มีการตรวจรถ ไม่มีค่าคำขอ', () => {
    const items = collect([
      vehicle({ transferDone: true, transferCompletedDate: '2026-09-19', transferCost: '150' }),
    ]);
    expect(items.map((i) => i.category)).toEqual(['TRANSFER_NOTICE']);
  });

  it('เอารถมาตรวจเอง (0 บาท) ยังนับเป็นวันตรวจรถ แต่ไม่แสดงรายการ 0 บาท', () => {
    const items = collect([
      vehicle({ inspectionSentType: 'เอารถมาตรวจเอง', inspectionSentDate: '2026-09-19', inspectionSentCost: '0' }),
    ]);
    expect(items.map((i) => [i.category, i.amountSatang])).toEqual([['DAILY_RULE', 2500]]);
  });

  it('ตรวจหลายวันในช่วงเดียวกัน ได้ค่าคำขอแยกทุกวัน', () => {
    const items = collect(
      [
        vehicle({ id: 'a', inspectionSentDate: '2026-09-18' }),
        vehicle({ id: 'b', inspectionSentDate: '2026-09-19' }),
      ],
      [INSPECTION_FEE],
      '2026-09-18',
      '2026-09-19',
    );
    expect(items.filter((i) => i.category === 'DAILY_RULE').map((i) => i.date)).toEqual(['2026-09-18', '2026-09-19']);
  });
});

describe('collectExpenseItems - ค่าตรวจรถไม่นับซ้ำ', () => {
  it('บันทึกผลตรวจแล้ว ใช้ค่าใช้จ่ายผลตรวจแทนค่าส่งตรวจ', () => {
    const items = collect(
      [
        vehicle({
          inspectionSentType: 'ส่งตรวจนอก',
          inspectionSentDate: '2026-09-19',
          inspectionSentCost: '300',
          inspectionResult: 'ผ่าน',
          inspectionResultDate: '2026-09-19',
          inspectionResultCost: '350',
        }),
      ],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0].amountSatang).toBe(35000);
  });

  it('ยังไม่บันทึกผล ใช้ค่าส่งตรวจ ณ วันที่ส่งตรวจ', () => {
    const items = collect(
      [vehicle({ inspectionSentType: 'ส่งตรวจนอก', inspectionSentDate: '2026-09-19', inspectionSentCost: '300.50' })],
      [],
    );
    expect(items.map((i) => [i.label, i.amountSatang])).toEqual([['ค่าส่งตรวจ (ส่งตรวจนอก)', 30050]]);
  });
});

describe('ruleForDay', () => {
  const newRate: DailyExpenseRuleInput = { ...INSPECTION_FEE, amount: '30', effectiveFrom: '2026-10-01' };

  it('ใช้อัตราที่ effectiveFrom ล่าสุดที่ไม่เกินวันนั้น', () => {
    expect(ruleForDay([INSPECTION_FEE, newRate], 'INSPECTION_REQUEST_FEE', '2026-09-30')?.amount).toBe('25');
    expect(ruleForDay([INSPECTION_FEE, newRate], 'INSPECTION_REQUEST_FEE', '2026-10-01')?.amount).toBe('30');
  });

  it('แถวล่าสุดที่ active = false ปิดเงื่อนไขตั้งแต่วันนั้น', () => {
    const off = { ...newRate, active: false };
    expect(ruleForDay([INSPECTION_FEE, off], 'INSPECTION_REQUEST_FEE', '2026-10-05')).toBeNull();
  });
});
