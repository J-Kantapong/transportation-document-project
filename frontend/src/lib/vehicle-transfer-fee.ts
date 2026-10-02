// สำเนาอัตราค่าใช้จ่ายงานโอน (ผู้ใช้ 2026-10-02: มอเตอร์ไซค์ครบ / รถยนต์เฉพาะ No Bill) จาก backend/src/vehicle-transfer/vehicle-transfer-fee.ts
// ใช้แสดงยอดสดในฟอร์ม - ยอดที่บันทึกจริงคิดที่ backend / แก้ตัวเลขให้ตรงกันทั้งสองที่
import { DUTY_LABEL, type FeeItem } from "@/lib/plate-swap-fee";

export const TRANSFER_MOTO_BILL_NORMAL: FeeItem[] = [
  { label: "คำขอ", amount: 5 },
  { label: "โอนทะเบียนรถ", amount: 100 },
];

export const TRANSFER_MOTO_BILL_USE_REQUEST: FeeItem[] = [
  { label: "คำขอ", amount: 10 },
  { label: "โอนทะเบียนรถ", amount: 100 },
  { label: "ค่าธรรมเนียมอื่นๆ", amount: 20 },
];

export const TRANSFER_FINE_LABEL = "ค่าปรับ";

export const TRANSFER_MOTO_NO_BILL_SHARE: FeeItem = { label: "ลงขัน", amount: 60 };
export const TRANSFER_MOTO_DUTY_NORMAL = 20;
export const TRANSFER_MOTO_DUTY_USE_REQUEST = 40;
export const TRANSFER_MOTO_URGENT_ITEM: FeeItem = { label: "ลงขันด่วนเพิ่ม", amount: 50 };

export interface TransferFees {
  billItems: FeeItem[];
  noBillItems: FeeItem[]; // ไม่มีค่าอากร
  dutyItem: FeeItem; // ค่าอากร - แยกต่างหาก ไม่รวมใน No Bill และยอดรวม (ผู้ใช้ 2026-10-02)
  billTotal: number;
  noBillTotal: number; // ไม่รวมค่าอากร
  dutyTotal: number;
  total: number; // Bill + No Bill (ไม่นับค่าอากร)
}

const sum = (items: FeeItem[]) => items.reduce((acc, item) => acc + item.amount, 0);

export function calculateTransferMotoFees(options: { useRequest: boolean; urgent: boolean; fine: number }): TransferFees {
  const billItems: FeeItem[] = [...(options.useRequest ? TRANSFER_MOTO_BILL_USE_REQUEST : TRANSFER_MOTO_BILL_NORMAL)];
  if (options.fine > 0) billItems.push({ label: TRANSFER_FINE_LABEL, amount: options.fine });
  const noBillItems: FeeItem[] = [TRANSFER_MOTO_NO_BILL_SHARE];
  if (options.urgent) noBillItems.push(TRANSFER_MOTO_URGENT_ITEM);
  const dutyItem: FeeItem = { label: DUTY_LABEL, amount: options.useRequest ? TRANSFER_MOTO_DUTY_USE_REQUEST : TRANSFER_MOTO_DUTY_NORMAL };
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, dutyItem, billTotal, noBillTotal, dutyTotal: dutyItem.amount, total: billTotal + noBillTotal };
}

export const TRANSFER_CAR_NO_BILL_SHARE: FeeItem = { label: "ลงขัน", amount: 100 };
export const TRANSFER_CAR_URGENT_ITEM: FeeItem = { label: "ลงขันด่วนเพิ่ม", amount: 100 };

// No Bill ของรถยนต์ (Bill พนักงานกรอกเอง) - ไม่มีค่าอากร
export function calculateTransferCarNoBill(options: { urgent: boolean }): { noBillItems: FeeItem[]; noBillTotal: number } {
  const noBillItems: FeeItem[] = [TRANSFER_CAR_NO_BILL_SHARE];
  if (options.urgent) noBillItems.push(TRANSFER_CAR_URGENT_ITEM);
  return { noBillItems, noBillTotal: sum(noBillItems) };
}
