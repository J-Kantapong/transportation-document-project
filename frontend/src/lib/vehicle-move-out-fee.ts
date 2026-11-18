// ค่าใช้จ่ายงานย้ายออก - มอเตอร์ไซค์ (ผู้ใช้ 2026-10-06): Bill 25 / No Bill = ลงขัน 80 + ด่วนเพิ่ม 50 (ถ้าด่วน) / ค่าอากร 10
// รถยนต์ (ผู้ใช้ 2026-11-18): Bill 55 / No Bill = ลงขัน 100 + ด่วนเพิ่ม 100 (ถ้าด่วน) / ค่าอากร 10
// ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่รวมในยอดรวม
// สำเนาของ backend/src/vehicle-move-out/vehicle-move-out-fee.ts (แก้ทั้งสองที่พร้อมกัน) - backend เป็นผู้คิดยอดจริงตอนบันทึก
export const MOVE_OUT_MOTO_BILL_FEE = 25;
export const MOVE_OUT_MOTO_LUNGKAN_FEE = 80;
export const MOVE_OUT_MOTO_URGENT_EXTRA = 50;
export const MOVE_OUT_MOTO_DUTY_FEE = 10;

export const MOVE_OUT_CAR_BILL_FEE = 55;
export const MOVE_OUT_CAR_LUNGKAN_FEE = 100;
export const MOVE_OUT_CAR_URGENT_EXTRA = 100;
export const MOVE_OUT_CAR_DUTY_FEE = 10;

export interface MoveOutFees {
  billTotal: number;
  noBillTotal: number; // ไม่รวมค่าอากร
  dutyAmount: number;
}

// อัตราแยกรายการของแต่ละประเภทรถ - ใช้แสดงในฟอร์ม
export const moveOutRates = (vehicleClass: "CAR" | "MOTO") =>
  vehicleClass === "MOTO"
    ? { bill: MOVE_OUT_MOTO_BILL_FEE, share: MOVE_OUT_MOTO_LUNGKAN_FEE, urgentExtra: MOVE_OUT_MOTO_URGENT_EXTRA, duty: MOVE_OUT_MOTO_DUTY_FEE }
    : { bill: MOVE_OUT_CAR_BILL_FEE, share: MOVE_OUT_CAR_LUNGKAN_FEE, urgentExtra: MOVE_OUT_CAR_URGENT_EXTRA, duty: MOVE_OUT_CAR_DUTY_FEE };

export function calculateMoveOutFees(vehicleClass: "CAR" | "MOTO", urgent: boolean): MoveOutFees {
  const r = moveOutRates(vehicleClass);
  return { billTotal: r.bill, noBillTotal: r.share + (urgent ? r.urgentExtra : 0), dutyAmount: r.duty };
}
