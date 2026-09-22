import { calculatePlateSwapCarFees } from './plate-swap-fee.js';

describe('calculatePlateSwapCarFees', () => {
  it('เลขไม่เคยออก ไม่ซื้อป้าย = 5+20+50+500 Bill, ลงขัน 200 No Bill', () => {
    const fees = calculatePlateSwapCarFees({ numberSource: 'NEW_UNUSED', buyNormalPlate: false, buyAuctionPlate: false });
    expect(fees.billItems.map((i) => i.amount)).toEqual([5, 20, 50, 500]);
    expect(fees.billTotal).toBe(575);
    expect(fees.noBillItems).toEqual([{ label: 'ลงขัน', amount: 200 }]);
    expect(fees.noBillTotal).toBe(200);
    expect(fees.total).toBe(775);
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
    expect(both.total).toBe(3175);
  });
});
