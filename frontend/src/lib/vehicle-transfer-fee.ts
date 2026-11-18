// สำเนาอัตราค่าใช้จ่ายงานโอน (ผู้ใช้ 2026-10-02: มอเตอร์ไซค์ครบ / รถยนต์เฉพาะ No Bill) จาก backend/src/vehicle-transfer/vehicle-transfer-fee.ts
// ใช้แสดงยอดสดในฟอร์ม - ยอดที่บันทึกจริงคิดที่ backend / แก้ตัวเลขให้ตรงกันทั้งสองที่
// ผู้ใช้ 2026-11-18: รถยนต์มีอัตราครบแล้ว - Bill โอนปกติ 105 / โอนขอใช้ 130, ค่าอากร 20 / 40 (รายการเดียวกับมอเตอร์ไซค์) ด่วนเพิ่ม 100
//   โอนย้ายเข้ารถยนต์: Bill 130 + ค่าแผ่นป้าย 200 = 330, ค่าอากร 40, ด่วนเพิ่ม 100 · ลงขันโอนย้ายเข้ากรุงเทพฯ 100 ทั้งสองประเภท (อยู่ในตารางลงขัน)
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
// ค่าปรับโอนล่าช้า (เกิน 15 วันหลังออกใบเสร็จ/ใบกำกับภาษี) คงที่ 200 บาท - ฟอร์มเป็นช่องติ๊ก (ผู้ใช้ 2026-11-18) / สำเนาจาก backend
export const TRANSFER_FINE_AMOUNT = 200;

export const TRANSFER_MOTO_NO_BILL_SHARE: FeeItem = { label: "ลงขัน", amount: 60 };

// ลงขันตามจังหวัดที่ยื่น (ผู้ใช้ 2026-11-18) - ค่าตั้งต้นที่ระบบเติมให้ พนักงานแก้ได้
// อัตราอยู่ในตาราง TransferContributionRate ครบ 77 จังหวัด (GET /api/transfer-contribution-rates) ADMIN กรอก/แก้ที่ /registration/transfer/contribution-rates
// null = จังหวัดนั้นยังไม่ได้ตั้งอัตรา (หรือยังโหลดตารางไม่เสร็จ) -> พนักงานกรอกเอง 0 ได้ / ปล่อยว่างส่งไป backend จะเติมอัตราของตารางให้เอง
export const TRANSFER_DEFAULT_PROVINCE = "กรุงเทพมหานคร";
export const TRANSFER_SHARE_LABEL = "ลงขัน";

export interface TransferContributionRow {
  province: string;
  transferMoto: number | null;
  transferCar: number | null;
  moveInMoto: number | null;
  moveInCar: number | null;
}

export function defaultTransferContribution(
  rates: TransferContributionRow[],
  vehicleClass: "CAR" | "MOTO",
  province: string | null | undefined,
  moveIn = false,
): number | null {
  const row = rates.find((r) => r.province === (province || TRANSFER_DEFAULT_PROVINCE));
  if (!row) return null;
  if (moveIn) return vehicleClass === "CAR" ? row.moveInCar : row.moveInMoto;
  return vehicleClass === "CAR" ? row.transferCar : row.transferMoto;
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
  return calculateTransferFees("MOTO", options);
}

// งานโอนทั้งสองประเภทรถ - Bill และค่าอากรเท่ากัน ต่างที่ลงขันตั้งต้นกับลงขันด่วนเพิ่ม (ผู้ใช้ 2026-11-18)
export function calculateTransferFees(
  vehicleClass: "CAR" | "MOTO",
  options: { useRequest: boolean; urgent: boolean; fine: number; contribution?: number },
): TransferFees {
  const car = vehicleClass === "CAR";
  const billItems: FeeItem[] = [...(options.useRequest ? TRANSFER_MOTO_BILL_USE_REQUEST : TRANSFER_MOTO_BILL_NORMAL)];
  if (options.fine > 0) billItems.push({ label: TRANSFER_FINE_LABEL, amount: options.fine });
  const noBillItems: FeeItem[] = [
    { label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? (car ? TRANSFER_CAR_NO_BILL_SHARE.amount : TRANSFER_MOTO_NO_BILL_SHARE.amount) },
  ];
  if (options.urgent) noBillItems.push(car ? TRANSFER_CAR_URGENT_ITEM : TRANSFER_MOTO_URGENT_ITEM);
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

// ---- โอนย้ายเข้า (MOVE_IN ผู้ใช้ 2026-11-18) - เฉพาะมอเตอร์ไซค์ / สำเนาจาก backend ต้องตรงกัน
// Bill ตามใบเสร็จ: คำขอ 10 (ผู้ใช้ 2026-11-18 แก้จาก 5) + ใบแทนเครื่องหมายภาษีประจำปี 20 + โอนทะเบียนรถ 100 + ค่าแผ่นป้ายทะเบียน 100 = 230 (+ ค่าปรับ + ค่าอากรโอนตามราคารถที่กรอกตอนรับใบเสร็จ)
// ค่าอากรแยก 40 · ลงขันยังไม่มีอัตรา ตั้งต้น 0 ทุกจังหวัด แก้ได้ · ด่วนเพิ่ม 50
export const TRANSFER_MOVE_IN_BILL: FeeItem[] = [
  { label: "คำขอ", amount: 10 },
  { label: "ใบแทนเครื่องหมายภาษีประจำปี", amount: 20 },
  { label: "โอนทะเบียนรถ", amount: 100 },
  { label: "ค่าแผ่นป้ายทะเบียน", amount: 100 },
];
export const TRANSFER_MOVE_IN_CAR_BILL: FeeItem[] = [
  { label: "คำขอ", amount: 10 },
  { label: "ใบแทนเครื่องหมายภาษีประจำปี", amount: 20 },
  { label: "โอนทะเบียนรถ", amount: 100 },
  { label: "ค่าแผ่นป้ายทะเบียน", amount: 200 },
];
export const TRANSFER_MOVE_IN_DUTY = 40;
export const TRANSFER_MOVE_IN_CONTRIBUTION = 0;
export const TRANSFER_STAMP_DUTY_LABEL = "ค่าอากรโอน (ตามราคารถ)";

export function calculateTransferMoveInFees(options: {
  vehicleClass?: "CAR" | "MOTO";
  urgent: boolean;
  fine: number;
  stampDuty: number;
  contribution?: number;
}): TransferFees {
  const car = options.vehicleClass === "CAR";
  const billItems: FeeItem[] = [...(car ? TRANSFER_MOVE_IN_CAR_BILL : TRANSFER_MOVE_IN_BILL)];
  if (options.stampDuty > 0) billItems.push({ label: TRANSFER_STAMP_DUTY_LABEL, amount: options.stampDuty });
  if (options.fine > 0) billItems.push({ label: TRANSFER_FINE_LABEL, amount: options.fine });
  const noBillItems: FeeItem[] = [{ label: TRANSFER_SHARE_LABEL, amount: options.contribution ?? TRANSFER_MOVE_IN_CONTRIBUTION }];
  if (options.urgent) noBillItems.push(car ? TRANSFER_CAR_URGENT_ITEM : TRANSFER_MOTO_URGENT_ITEM);
  const dutyItem: FeeItem = { label: DUTY_LABEL, amount: TRANSFER_MOVE_IN_DUTY };
  const billTotal = sum(billItems);
  const noBillTotal = sum(noBillItems);
  return { billItems, noBillItems, dutyItem, billTotal, noBillTotal, dutyTotal: dutyItem.amount, total: billTotal + noBillTotal };
}
