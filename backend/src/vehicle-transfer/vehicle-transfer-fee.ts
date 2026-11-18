// ค่าใช้จ่ายงานโอน - ผู้ใช้กำหนด 2026-10-02: มอเตอร์ไซค์ครบทั้ง Bill / No Bill / รถยนต์ให้เฉพาะ No Bill (ลงขัน 100 + ด่วน 100) ส่วน Bill รถยนต์ยังไม่มีอัตรา พนักงานกรอกเอง
// รถยนต์ไม่มีค่าอากร (ผู้ใช้ไม่ได้ให้) และชื่อรายการ "ลงขัน" เป็นการตั้งของ Claude ตามชื่อของมอเตอร์ไซค์
// ใช้กับงานโอนทั้งสองแบบ (โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ) เหมือนกัน - ผู้ใช้ไม่ได้แยกอัตราตามแบบงาน
// ประเภท: โอนปกติ / โอนขอใช้ (ผู้ใช้เลือกในฟอร์ม ค่าอากรออโต้ตามประเภทที่เลือก)
// Bill: โอนปกติ = คำขอ 5 + โอนทะเบียนรถ 100 / โอนขอใช้ = คำขอ 10 + โอนทะเบียนรถ 100 + ค่าธรรมเนียมอื่นๆ 20
//   ค่าปรับ (ถ้าเกิน 15 วันหลังออกใบเสร็จรับเงิน/ใบกำกับภาษี) มีได้ทั้งสองประเภท ยอดไม่แน่นอน พนักงานกรอกเอง รวมใน Bill
// No Bill: ลงขันตามจังหวัดที่ยื่น (ตาราง TransferContributionRate - ดู transfer-contribution-rates.service.ts ผู้ใช้ 2026-11-18) + ลงขันด่วนเพิ่ม 50 เมื่อเป็นงานด่วน / ค่าอากรแยก: โอนปกติ 20 / โอนขอใช้ 40 (ออโต้ตามประเภทที่เลือก)
// ค่าอากรแยกต่างหาก (ผู้ใช้ 2026-10-02) ไม่รวมใน No Bill และไม่รวมในยอดรวม - เก็บแยกที่ dutyAmount แสดงเป็นบรรทัดของตัวเอง (แบบเดียวกับยกเลิกการใช้รถ)
// เก็บเป็น snapshot ลงแถวตอนยื่น (billTotal / noBillTotal / dutyAmount) - เปลี่ยนอัตราในอนาคตไม่ทำให้งานเก่าเปลี่ยนตาม
// สำเนาฝั่งหน้าเว็บ: frontend/src/lib/vehicle-transfer-fee.ts (แก้ทั้งสองที่พร้อมกัน)
import { DUTY_LABEL, type FeeItem } from '../plate-swap/plate-swap-fee.js';

export const TRANSFER_MOTO_BILL_NORMAL: FeeItem[] = [
  { label: 'คำขอ', amount: 5 },
  { label: 'โอนทะเบียนรถ', amount: 100 },
];

export const TRANSFER_MOTO_BILL_USE_REQUEST: FeeItem[] = [
  { label: 'คำขอ', amount: 10 },
  { label: 'โอนทะเบียนรถ', amount: 100 },
  { label: 'ค่าธรรมเนียมอื่นๆ', amount: 20 },
];

export const TRANSFER_FINE_LABEL = 'ค่าปรับ';

export const TRANSFER_MOTO_NO_BILL_SHARE: FeeItem = { label: 'ลงขัน', amount: 60 };

// ลงขันตามจังหวัดที่ยื่น (ผู้ใช้ 2026-11-18: แต่ละจังหวัดราคาไม่เท่ากัน บางทีไม่เสีย) - ค่าตั้งต้นที่ระบบเติมให้ พนักงานแก้ได้
// อัตราอยู่ในตาราง TransferContributionRate ครบ 77 จังหวัด ADMIN กรอก/แก้จากหน้าจอ (ตั้งต้นจาก migration: กรุงเทพฯ มอเตอร์ไซค์ 60 / รถยนต์ 100 · สมุทรปราการ 100 / 100)
// จังหวัดที่ช่องยังว่าง: พนักงานต้องกรอกเอง (0 ได้ = ไม่เสียลงขัน) ยกเว้นโอนย้ายเข้าใช้ 0 · ไม่ระบุจังหวัด (งานเก่า) = กรุงเทพฯ
export const TRANSFER_DEFAULT_PROVINCE = 'กรุงเทพมหานคร';
export const TRANSFER_SHARE_LABEL = 'ลงขัน';

export function transferUrgentAmount(vehicleClass: 'CAR' | 'MOTO', urgent: boolean): number {
  if (!urgent) return 0;
  return vehicleClass === 'MOTO' ? TRANSFER_MOTO_URGENT_ITEM.amount : TRANSFER_CAR_URGENT_ITEM.amount;
}
export const TRANSFER_MOTO_DUTY_NORMAL = 20;
export const TRANSFER_MOTO_DUTY_USE_REQUEST = 40;
export const TRANSFER_MOTO_URGENT_ITEM: FeeItem = { label: 'ลงขันด่วนเพิ่ม', amount: 50 };

export interface TransferMotoFeeOptions {
  useRequest: boolean; // โอนขอใช้ (false = โอนปกติ)
  urgent: boolean; // งานด่วน +50 (No Bill)
  fine: number; // ค่าปรับ (Bill) - 0 = ไม่มี
  contribution?: number; // ลงขัน (No Bill) - ไม่ส่ง = อัตรากรุงเทพฯ 60
}

export interface TransferFees {
  billItems: FeeItem[];
  noBillItems: FeeItem[]; // ไม่มีค่าอากร
  dutyItem: FeeItem; // ค่าอากร - แยกต่างหาก
  billTotal: number;
  noBillTotal: number; // ไม่รวมค่าอากร
  dutyTotal: number;
  total: number; // Bill + No Bill (ไม่นับค่าอากร)
}

const sum = (items: FeeItem[]) => items.reduce((acc, item) => acc + item.amount, 0);

export function calculateTransferMotoFees(options: TransferMotoFeeOptions): TransferFees {
  const billItems: FeeItem[] = [...(options.useRequest ? TRANSFER_MOTO_BILL_USE_REQUEST : TRANSFER_MOTO_BILL_NORMAL)];
  if (options.fine > 0) billItems.push({ label: TRANSFER_FINE_LABEL, amount: options.fine });
  const noBillItems: FeeItem[] = [{ label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? TRANSFER_MOTO_NO_BILL_SHARE.amount }];
  if (options.urgent) noBillItems.push(TRANSFER_MOTO_URGENT_ITEM);
  const dutyItem: FeeItem = { label: DUTY_LABEL, amount: options.useRequest ? TRANSFER_MOTO_DUTY_USE_REQUEST : TRANSFER_MOTO_DUTY_NORMAL };
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, dutyItem, billTotal, noBillTotal, dutyTotal: dutyItem.amount, total: billTotal + noBillTotal };
}

export const TRANSFER_CAR_NO_BILL_SHARE: FeeItem = { label: 'ลงขัน', amount: 100 };
export const TRANSFER_CAR_URGENT_ITEM: FeeItem = { label: 'ลงขันด่วนเพิ่ม', amount: 100 };

// No Bill ของรถยนต์ (Bill พนักงานกรอกเอง จึงไม่มีฟังก์ชันคิดทั้งชุด)
export function calculateTransferCarNoBill(options: { urgent: boolean; contribution?: number }): { noBillItems: FeeItem[]; noBillTotal: number } {
  const noBillItems: FeeItem[] = [{ label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? TRANSFER_CAR_NO_BILL_SHARE.amount }];
  if (options.urgent) noBillItems.push(TRANSFER_CAR_URGENT_ITEM);
  return { noBillItems, noBillTotal: sum(noBillItems) };
}

// ---- โอนย้ายเข้า (MOVE_IN ผู้ใช้ 2026-11-18) - เฉพาะมอเตอร์ไซค์ รถย้ายออกจากจังหวัดเดิมแล้วมาย้ายเข้าพร้อมโอน ป้ายเปลี่ยนเป็นจังหวัดใหม่
// Bill ตามใบเสร็จ: คำขอ 5 + ใบแทนเครื่องหมายภาษีประจำปี 20 + โอนทะเบียนรถ 100 + ค่าแผ่นป้ายทะเบียน 100 = 225
//   + ค่าปรับ (เกิน 15 วันหลังออกใบกำกับภาษี พนักงานกรอก) + ค่าอากรโอน (ตามราคารถ รู้เมื่อใบเสร็จออก พนักงานกรอกตอนรับใบเสร็จ - งานยกเว้นภาษี/มีใบกำกับภาษีไม่มี)
// ค่าอากรแยก 40 (ไม่รวมใน No Bill ไม่นับในยอดรวม) · ลงขัน: ยังไม่มีอัตรา (ผู้ใช้ไปทำเอง) ตั้งต้น 0 ทุกจังหวัด พนักงานแก้ได้ · ด่วนเพิ่ม 50 เหมือนงานโอนมอเตอร์ไซค์
export const TRANSFER_MOVE_IN_BILL: FeeItem[] = [
  { label: 'คำขอ', amount: 5 },
  { label: 'ใบแทนเครื่องหมายภาษีประจำปี', amount: 20 },
  { label: 'โอนทะเบียนรถ', amount: 100 },
  { label: 'ค่าแผ่นป้ายทะเบียน', amount: 100 },
];
export const TRANSFER_MOVE_IN_DUTY = 40;
export const TRANSFER_MOVE_IN_CONTRIBUTION = 0;
export const TRANSFER_STAMP_DUTY_LABEL = 'ค่าอากรโอน (ตามราคารถ)';

export interface TransferMoveInFeeOptions {
  urgent: boolean;
  fine: number; // ค่าปรับ (Bill) - 0 = ไม่มี
  stampDuty: number; // ค่าอากรโอน (Bill) - 0 = ไม่มี/ยังไม่รู้
  contribution?: number; // ลงขัน (No Bill) - ไม่ส่ง = 0
}

export function calculateTransferMoveInFees(options: TransferMoveInFeeOptions): TransferFees {
  const billItems: FeeItem[] = [...TRANSFER_MOVE_IN_BILL];
  if (options.stampDuty > 0) billItems.push({ label: TRANSFER_STAMP_DUTY_LABEL, amount: options.stampDuty });
  if (options.fine > 0) billItems.push({ label: TRANSFER_FINE_LABEL, amount: options.fine });
  const noBillItems: FeeItem[] = [{ label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? TRANSFER_MOVE_IN_CONTRIBUTION }];
  if (options.urgent) noBillItems.push(TRANSFER_MOTO_URGENT_ITEM);
  const dutyItem: FeeItem = { label: DUTY_LABEL, amount: TRANSFER_MOVE_IN_DUTY };
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, dutyItem, billTotal, noBillTotal, dutyTotal: dutyItem.amount, total: billTotal + noBillTotal };
}
