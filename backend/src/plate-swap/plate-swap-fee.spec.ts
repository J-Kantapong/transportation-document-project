import { calculatePlateSwapCarFees, calculatePlateSwapMotoFees } from './plate-swap-fee.js';

describe('calculatePlateSwapCarFees', () => {
  it('เลขไม่เคยออก ไม่ซื้อป้าย = 5+20+50+500 Bill, No Bill = ลงขัน 200 + ค่าอากร 10', () => {
    const fees = calculatePlateSwapCarFees({ numberSource: 'NEW_UNUSED', buyNormalPlate: false, buyAuctionPlate: false });
    expect(fees.billItems.map((i) => i.amount)).toEqual([5, 20, 50, 500]);
    expect(fees.billTotal).toBe(575);
    expect(fees.noBillItems).toEqual([
      { label: 'ลงขัน', amount: 200 },
      { label: 'ค่าอากร', amount: 10 },
    ]);
    expect(fees.noBillTotal).toBe(210);
    expect(fees.dutyTotal).toBe(10);
    expect(fees.total).toBe(775); // ยอดรวมไม่นับค่าอากร
  });

  it('เลขไม่เคยออก ซื้อป้ายรับปกติ 200', () => {
    const fees = calculatePlateSwapCarFees({ numberSource: 'NEW_UNUSED', buyNormalPlate: true, buyAuctionPlate: false });
    expect(fees.billItems.at(-1)).toEqual({ label: 'ค่าแผ่นป้ายทะเบียนรถยนต์ออกใหม่ รับปกติ', amount: 200 });
    expect(fees.billTotal).toBe(775);
  });

  it('เลขไม่เคยออก ไม่มีรายการป้ายประมูลให้ซื้อ - ติ๊กมาก็ไม่คิด', () => {
    const fees = calculatePlateSwapCarFees({ numberSource: 'NEW_UNUSED', buyNormalPlate: false, buyAuctionPlate: true });
    expect(fees.billTotal).toBe(575);
  });

  it('เลขประมูล/ชุดสงวน = 5+20+50+1500 และป้ายขาว-ดำ 200 + ป้ายประมูล 1200 ตามที่ติ๊ก', () => {
    const none = calculatePlateSwapCarFees({ numberSource: 'AUCTION_RESERVED', buyNormalPlate: false, buyAuctionPlate: false });
    expect(none.billTotal).toBe(1575);
    const both = calculatePlateSwapCarFees({ numberSource: 'AUCTION_RESERVED', buyNormalPlate: true, buyAuctionPlate: true });
    expect(both.billItems.slice(4)).toEqual([
      { label: 'ค่าแผ่นป้ายทะเบียนขาว-ดำปกติ', amount: 200 },
      { label: 'ค่าแผ่นป้ายประมูล', amount: 1200 },
    ]);
    expect(both.billTotal).toBe(2975);
    expect(both.total).toBe(3175); // 2975 Bill + 200 ลงขัน (ไม่นับค่าอากร 10)
  });
});

// อัตรารถจักรยานยนต์จากผู้ใช้ 2026-09-28 - ต่างจากรถยนต์ที่ค่าขอแก้ไขฯ 10, ป้าย 100, ลงขัน 100
// และไม่มีตัวเลือกเลขประมูล/ชุดสงวน แต่มีงานด่วน +50
describe('calculatePlateSwapMotoFees', () => {
  it('ไม่ซื้อป้าย ไม่ด่วน = Bill 5+20+10+500 / No Bill 100+10', () => {
    const fees = calculatePlateSwapMotoFees({ buyNormalPlate: false, urgent: false });
    expect(fees.billTotal).toBe(535);
    expect(fees.noBillTotal).toBe(110);
    expect(fees.dutyTotal).toBe(10);
    expect(fees.total).toBe(635); // 535 + 100 ลงขัน (ไม่นับค่าอากร)
  });

  it('ซื้อแผ่นป้ายมอเตอร์ไซค์ = +100 (คนละราคากับรถยนต์ที่ 200)', () => {
    const fees = calculatePlateSwapMotoFees({ buyNormalPlate: true, urgent: false });
    expect(fees.billItems.at(-1)).toEqual({ label: 'ค่าแผ่นป้ายทะเบียนรถจักรยานยนต์', amount: 100 });
    expect(fees.billTotal).toBe(635);
  });

  it('งานด่วน = +50 ฝั่ง No Bill (ชื่อรายการเดียวกับงานจดรถใหม่)', () => {
    const fees = calculatePlateSwapMotoFees({ buyNormalPlate: false, urgent: true });
    expect(fees.noBillItems.at(-1)).toEqual({ label: 'ลงขันด่วนเพิ่ม', amount: 50 });
    expect(fees.noBillTotal).toBe(160);
    expect(fees.total).toBe(685);
  });
});
