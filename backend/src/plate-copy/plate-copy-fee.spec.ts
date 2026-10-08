import { calculatePlateCopyFees, plateCopyBillFee, plateCopyNoBillFee, plateCopyUrgentFee } from './plate-copy-fee.js';

describe('plate-copy-fee', () => {
  it('รถยนต์: Bill ตามชนิดการคัดป้าย / ลงขัน 100 / ค่าอากร 10 แยก (เท่าเดิม)', () => {
    expect(calculatePlateCopyFees('CAR', 'BOTH', false)).toEqual({ billTotal: 205, noBillTotal: 100, dutyAmount: 10 });
    expect(calculatePlateCopyFees('CAR', 'SINGLE_NORMAL', false)).toEqual({ billTotal: 105, noBillTotal: 100, dutyAmount: 10 });
    expect(calculatePlateCopyFees('CAR', 'BOTH_AUCTION', false)).toEqual({ billTotal: 1205, noBillTotal: 100, dutyAmount: 10 });
    expect(calculatePlateCopyFees('CAR', 'SINGLE_AUCTION', false)).toEqual({ billTotal: 605, noBillTotal: 100, dutyAmount: 10 });
    expect(plateCopyBillFee('BOTH')).toBe(205);
  });

  it('รถยนต์งานด่วน: ลงขัน 100 + ลงขันด่วนเพิ่ม 100', () => {
    expect(calculatePlateCopyFees('CAR', 'BOTH', true)).toEqual({ billTotal: 205, noBillTotal: 200, dutyAmount: 10 });
    expect(plateCopyUrgentFee('CAR')).toBe(100);
  });

  it('มอเตอร์ไซค์: Bill 105 (คำขอ 5 + แผ่นป้าย 100) / ลงขัน 60 / ค่าอากร 10 - ไม่สนชนิดการคัดป้ายที่ส่งมา', () => {
    expect(calculatePlateCopyFees('MOTO', 'SINGLE_NORMAL', false)).toEqual({ billTotal: 105, noBillTotal: 60, dutyAmount: 10 });
    expect(calculatePlateCopyFees('MOTO', 'BOTH_AUCTION', false)).toEqual({ billTotal: 105, noBillTotal: 60, dutyAmount: 10 });
  });

  it('มอเตอร์ไซค์งานด่วน: ลงขัน 60 + ลงขันด่วนเพิ่ม 50 = 110', () => {
    expect(calculatePlateCopyFees('MOTO', 'SINGLE_NORMAL', true)).toEqual({ billTotal: 105, noBillTotal: 110, dutyAmount: 10 });
    expect(plateCopyNoBillFee('MOTO', true)).toBe(110);
    expect(plateCopyUrgentFee('MOTO')).toBe(50);
  });
});
