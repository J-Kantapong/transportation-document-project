// ค่าใช้จ่ายงานโอน - ผู้ใช้กำหนด 2026-10-02: มอเตอร์ไซค์ครบทั้ง Bill / No Bill / รถยนต์ให้เฉพาะ No Bill (ลงขัน 100 + ด่วน 100) ส่วน Bill รถยนต์ยังไม่มีอัตรา พนักงานกรอกเอง
// รถยนต์ไม่มีค่าอากร (ผู้ใช้ไม่ได้ให้) และชื่อรายการ "ลงขัน" เป็นการตั้งของ Claude ตามชื่อของมอเตอร์ไซค์
// ใช้กับงานโอนทั้งสองแบบ (โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ) เหมือนกัน - ผู้ใช้ไม่ได้แยกอัตราตามแบบงาน
// ประเภท: โอนปกติ / โอนขอใช้ (ผู้ใช้เลือกในฟอร์ม ค่าอากรออโต้ตามประเภทที่เลือก)
// Bill: โอนปกติ = คำขอ 5 + โอนทะเบียนรถ 100 / โอนขอใช้ = คำขอ 10 + โอนทะเบียนรถ 100 + ค่าธรรมเนียมอื่นๆ 20
//   ค่าปรับ (ถ้าเกิน 15 วันหลังออกใบเสร็จรับเงิน/ใบกำกับภาษี) มีได้ทั้งสองประเภท ยอดไม่แน่นอน พนักงานกรอกเอง รวมใน Bill
// No Bill: ลงขัน 60 + ลงขันด่วนเพิ่ม 50 เมื่อเป็นงานด่วน / ค่าอากรแยก: โอนปกติ 20 / โอนขอใช้ 40 (ออโต้ตามประเภทที่เลือก)
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
export const TRANSFER_MOTO_DUTY_NORMAL = 20;
export const TRANSFER_MOTO_DUTY_USE_REQUEST = 40;
export const TRANSFER_MOTO_URGENT_ITEM: FeeItem = { label: 'ลงขันด่วนเพิ่ม', amount: 50 };

export interface TransferMotoFeeOptions {
  useRequest: boolean; // โอนขอใช้ (false = โอนปกติ)
  urgent: boolean; // งานด่วน +50 (No Bill)
  fine: number; // ค่าปรับ (Bill) - 0 = ไม่มี
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
  const noBillItems: FeeItem[] = [TRANSFER_MOTO_NO_BILL_SHARE];
  if (options.urgent) noBillItems.push(TRANSFER_MOTO_URGENT_ITEM);
  const dutyItem: FeeItem = { label: DUTY_LABEL, amount: options.useRequest ? TRANSFER_MOTO_DUTY_USE_REQUEST : TRANSFER_MOTO_DUTY_NORMAL };
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, dutyItem, billTotal, noBillTotal, dutyTotal: dutyItem.amount, total: billTotal + noBillTotal };
}

export const TRANSFER_CAR_NO_BILL_SHARE: FeeItem = { label: 'ลงขัน', amount: 100 };
export const TRANSFER_CAR_URGENT_ITEM: FeeItem = { label: 'ลงขันด่วนเพิ่ม', amount: 100 };

// No Bill ของรถยนต์ (Bill พนักงานกรอกเอง จึงไม่มีฟังก์ชันคิดทั้งชุด)
export function calculateTransferCarNoBill(options: { urgent: boolean }): { noBillItems: FeeItem[]; noBillTotal: number } {
  const noBillItems: FeeItem[] = [TRANSFER_CAR_NO_BILL_SHARE];
  if (options.urgent) noBillItems.push(TRANSFER_CAR_URGENT_ITEM);
  return { noBillItems, noBillTotal: sum(noBillItems) };
}
