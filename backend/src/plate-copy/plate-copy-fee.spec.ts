import { calculatePlateCopyFees, plateCopyBillFee, plateCopyDueDate, plateCopyNoBillFee, plateCopyUrgentFee } from './plate-copy-fee.js';

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

  it('วันที่คาดว่าได้ป้าย = 15 วันทำการ ข้ามเสาร์อาทิตย์', () => {
    expect(plateCopyDueDate('2026-10-09')).toBe('2026-10-30'); // ยื่นวันศุกร์ -> ศุกร์อีก 3 สัปดาห์ (21 วันปฏิทิน)
    expect(plateCopyDueDate('2026-10-05')).toBe('2026-10-26'); // ยื่นวันจันทร์ -> จันทร์
    expect(plateCopyDueDate('2026-10-10')).toBe('2026-10-30'); // ยื่นวันเสาร์ (ไม่ควรเกิด) เริ่มนับจากวันจันทร์
    expect(plateCopyDueDate('2026-12-21')).toBe('2027-01-11'); // ข้ามปี
  });
});
