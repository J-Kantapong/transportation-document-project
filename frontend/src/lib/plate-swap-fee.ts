// สำเนาอัตราค่าใช้จ่ายงานสลับเลข (รถยนต์) จาก backend/src/plate-swap/plate-swap-fee.ts - ใช้แสดงยอดสดในฟอร์ม
// ยอดที่บันทึกจริงคิดที่ backend - แก้ตัวเลขให้ตรงกันทั้งสองที่ (ผู้ใช้ 2026-09-22)

export type PlateSwapNumberSource = "NEW_UNUSED" | "AUCTION_RESERVED";

export interface FeeItem {
  label: string;
  amount: number;
}

export const PLATE_SWAP_CAR_BASE_ITEMS: FeeItem[] = [
  { label: "คำขอ", amount: 5 },
  { label: "ใบแทนเครื่องหมายการเสียภาษีประจำปี", amount: 20 },
  { label: "ค่าขอแก้ไขเพิ่มเติมรายการในทะเบียนและใบคู่มือจดทะเบียน", amount: 50 },
];

export const PLATE_SWAP_CAR_NUMBER_ITEMS: Record<
  PlateSwapNumberSource,
  { title: string; number: FeeItem; normalPlate: FeeItem; auctionPlate: FeeItem | null }
> = {
  NEW_UNUSED: {
    title: "เลขที่ไม่เคยออกให้รถคันอื่น",
    number: { label: "ขอใช้เลขทะเบียนที่ไม่เคยออกให้รถคันอื่น", amount: 500 },
    normalPlate: { label: "ค่าแผ่นป้ายทะเบียนรถยนต์ออกใหม่ รับปกติ", amount: 200 },
    auctionPlate: null,
  },
  AUCTION_RESERVED: {
    title: "เลขประมูลหรือชุดสงวน",
    number: { label: "ขอใช้เลขทะเบียนสงวน", amount: 1500 },
    normalPlate: { label: "ค่าแผ่นป้ายทะเบียนขาว-ดำปกติ", amount: 200 },
    auctionPlate: { label: "ค่าแผ่นป้ายประมูล", amount: 1200 },
  },
};

// ลงขัน 200 + ค่าอากรของรถเก่า 10 บาท (ผู้ใช้ 2026-09-23) - ค่าอากรแยกรายการ ไม่อยู่ในใบเสร็จ แต่นับรวมในยอด No Bill
export const PLATE_SWAP_CAR_NO_BILL_ITEMS: FeeItem[] = [
  { label: "ลงขัน", amount: 200 },
  { label: "ค่าอากร", amount: 10 },
];

export interface PlateSwapFees {
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: number;
  noBillTotal: number; // รวมค่าอากรด้วย
  dutyTotal: number; // ค่าอากรที่แยกออกจากยอดรวม
  total: number; // Bill + No Bill โดยไม่นับค่าอากร (ผู้ใช้ 2026-09-23)
}

const sum = (items: FeeItem[]) => items.reduce((acc, item) => acc + item.amount, 0);

export const DUTY_LABEL = "ค่าอากร";

// ค่าอากรของงานหนึ่ง - อ่านจาก snapshot รายการ No Bill ที่บันทึกไว้ ใช้ได้กับงานเก่าแม้อัตราเปลี่ยน
export const dutyAmountOf = (noBillItems: FeeItem[]) => sum(noBillItems.filter((i) => i.label === DUTY_LABEL));

export function calculatePlateSwapCarFees(options: {
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
}): PlateSwapFees {
  const numberItems = PLATE_SWAP_CAR_NUMBER_ITEMS[options.numberSource];
  const billItems: FeeItem[] = [...PLATE_SWAP_CAR_BASE_ITEMS, numberItems.number];
  if (options.buyNormalPlate) billItems.push(numberItems.normalPlate);
  if (options.buyAuctionPlate && numberItems.auctionPlate) billItems.push(numberItems.auctionPlate);
  const noBillItems = [...PLATE_SWAP_CAR_NO_BILL_ITEMS];
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  const dutyTotal = dutyAmountOf(noBillItems);
  return { billItems, noBillItems, billTotal, noBillTotal, dutyTotal, total: billTotal + noBillTotal - dutyTotal };
}

export const formatBaht = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });
