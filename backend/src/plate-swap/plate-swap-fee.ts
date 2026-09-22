// ค่าใช้จ่ายงานสลับเลข "รถเก่า <-> รถใหม่" ของรถยนต์ - ตัวเลขจากผู้ใช้ 2026-09-22 (ยังไม่มีอัตราจักรยานยนต์)
// frontend/src/lib/plate-swap-fee.ts มีสำเนาไว้แสดงยอดสดในฟอร์ม - แก้ให้ตรงกันทั้งสองที่
// Bill (ใบเสร็จกรมขนส่ง): รายการพื้นฐาน 3 รายการ + รายการตามที่มาของเลขทะเบียนใหม่ (numberSource) + แผ่นป้ายที่ติ๊กซื้อ
// No Bill: ลงขัน 200 บาท เสมอ
import { PlateSwapNumberSource } from '../generated/prisma/enums.js';

export interface FeeItem {
  label: string;
  amount: number;
}

export const PLATE_SWAP_CAR_BASE_ITEMS: FeeItem[] = [
  { label: 'คำขอ', amount: 5 },
  { label: 'ใบแทนเครื่องหมายการเสียภาษีประจำปี', amount: 20 },
  { label: 'ค่าขอแก้ไขเพิ่มเติมรายการในทะเบียนและใบคู่มือจดทะเบียน', amount: 50 },
];

// รายการตามที่มาของเลข: ค่าขอใช้เลขบังคับ / แผ่นป้ายเลือกซื้อได้ (ติ๊ก) - ป้ายประมูลมีเฉพาะเลขประมูล/ชุดสงวน
export const PLATE_SWAP_CAR_NUMBER_ITEMS: Record<
  PlateSwapNumberSource,
  { number: FeeItem; normalPlate: FeeItem; auctionPlate: FeeItem | null }
> = {
  [PlateSwapNumberSource.NEW_UNUSED]: {
    number: { label: 'ขอใช้เลขทะเบียนที่ไม่เคยออกให้รถคันอื่น', amount: 500 },
    normalPlate: { label: 'ค่าแผ่นป้ายทะเบียนรถยนต์ออกใหม่ รับปกติ', amount: 200 },
    auctionPlate: null,
  },
  [PlateSwapNumberSource.AUCTION_RESERVED]: {
    number: { label: 'ขอใช้เลขทะเบียนสงวน', amount: 1500 },
    normalPlate: { label: 'ค่าแผ่นป้ายทะเบียนขาว-ดำปกติ', amount: 200 },
    auctionPlate: { label: 'ค่าแผ่นป้ายประมูล', amount: 1200 },
  },
};

export const PLATE_SWAP_CAR_NO_BILL_ITEMS: FeeItem[] = [{ label: 'ลงขัน', amount: 200 }];

export interface PlateSwapFeeOptions {
  numberSource: PlateSwapNumberSource;
  buyNormalPlate: boolean;
  buyAuctionPlate: boolean;
}

export interface PlateSwapFees {
  billItems: FeeItem[];
  noBillItems: FeeItem[];
  billTotal: number;
  noBillTotal: number;
  total: number;
}

const sum = (items: FeeItem[]) => items.reduce((acc, item) => acc + item.amount, 0);

export function calculatePlateSwapCarFees(options: PlateSwapFeeOptions): PlateSwapFees {
  const numberItems = PLATE_SWAP_CAR_NUMBER_ITEMS[options.numberSource];
  const billItems: FeeItem[] = [...PLATE_SWAP_CAR_BASE_ITEMS, numberItems.number];
  if (options.buyNormalPlate) billItems.push(numberItems.normalPlate);
  // ติ๊กป้ายประมูลกับเลขไม่เคยออก = ไม่มีรายการนี้ให้ซื้อ -> ไม่คิด (service ปฏิเสธไว้ก่อนแล้ว)
  if (options.buyAuctionPlate && numberItems.auctionPlate) billItems.push(numberItems.auctionPlate);
  const noBillItems = [...PLATE_SWAP_CAR_NO_BILL_ITEMS];
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, billTotal, noBillTotal, total: billTotal + noBillTotal };
}
