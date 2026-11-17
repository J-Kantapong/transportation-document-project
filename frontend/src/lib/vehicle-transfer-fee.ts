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

// ลงขันตามจังหวัดที่ยื่น (ผู้ใช้ 2026-11-18) - ค่าตั้งต้นที่ระบบเติมให้ พนักงานแก้ได้ / สำเนาจาก backend ต้องตรงกัน
// กรุงเทพฯ: มอเตอร์ไซค์ 60 / รถยนต์ 100 · สมุทรปราการ: มอเตอร์ไซค์ 100 / รถยนต์ 100 · จังหวัดอื่น = null (กรอกเอง 0 ได้)
export const TRANSFER_DEFAULT_PROVINCE = "กรุงเทพมหานคร";
const TRANSFER_SAMUT_PRAKAN = "สมุทรปราการ";
export const TRANSFER_SHARE_LABEL = "ลงขัน";

export function defaultTransferContribution(vehicleClass: "CAR" | "MOTO", province: string | null | undefined): number | null {
  const where = province || TRANSFER_DEFAULT_PROVINCE;
  if (where !== TRANSFER_DEFAULT_PROVINCE && where !== TRANSFER_SAMUT_PRAKAN) return null;
  if (vehicleClass === "CAR") return 100;
  return where === TRANSFER_SAMUT_PRAKAN ? 100 : 60;
}

export function transferUrgentAmount(vehicleClass: "CAR" | "MOTO", urgent: boolean): number {
  if (!urgent) return 0;
  return vehicleClass === "MOTO" ? TRANSFER_MOTO_URGENT_ITEM.amount : TRANSFER_CAR_URGENT_ITEM.amount;
}
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

export function calculateTransferMotoFees(options: { useRequest: boolean; urgent: boolean; fine: number; contribution?: number }): TransferFees {
  const billItems: FeeItem[] = [...(options.useRequest ? TRANSFER_MOTO_BILL_USE_REQUEST : TRANSFER_MOTO_BILL_NORMAL)];
  if (options.fine > 0) billItems.push({ label: TRANSFER_FINE_LABEL, amount: options.fine });
  const noBillItems: FeeItem[] = [{ label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? TRANSFER_MOTO_NO_BILL_SHARE.amount }];
  if (options.urgent) noBillItems.push(TRANSFER_MOTO_URGENT_ITEM);
  const dutyItem: FeeItem = { label: DUTY_LABEL, amount: options.useRequest ? TRANSFER_MOTO_DUTY_USE_REQUEST : TRANSFER_MOTO_DUTY_NORMAL };
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, dutyItem, billTotal, noBillTotal, dutyTotal: dutyItem.amount, total: billTotal + noBillTotal };
}

export const TRANSFER_CAR_NO_BILL_SHARE: FeeItem = { label: "ลงขัน", amount: 100 };
export const TRANSFER_CAR_URGENT_ITEM: FeeItem = { label: "ลงขันด่วนเพิ่ม", amount: 100 };

// No Bill ของรถยนต์ (Bill พนักงานกรอกเอง) - ไม่มีค่าอากร
export function calculateTransferCarNoBill(options: { urgent: boolean; contribution?: number }): { noBillItems: FeeItem[]; noBillTotal: number } {
  const noBillItems: FeeItem[] = [{ label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? TRANSFER_CAR_NO_BILL_SHARE.amount }];
  if (options.urgent) noBillItems.push(TRANSFER_CAR_URGENT_ITEM);
  return { noBillItems, noBillTotal: sum(noBillItems) };
}
