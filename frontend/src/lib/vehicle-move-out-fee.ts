// ค่าใช้จ่ายงานย้ายออก - ผู้ใช้กำหนด 2026-10-06 เฉพาะมอเตอร์ไซค์: Bill 25 / No Bill = ลงขัน 80 + ด่วนเพิ่ม 50 (ถ้าด่วน) / ค่าอากร 10
// ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่รวมในยอดรวม · รถยนต์ยังไม่มีอัตรา (ทุกยอด 0 และเลือกงานด่วนไม่ได้)
// สำเนาของ backend/src/vehicle-move-out/vehicle-move-out-fee.ts (แก้ทั้งสองที่พร้อมกัน) - backend เป็นผู้คิดยอดจริงตอนบันทึก
export const MOVE_OUT_MOTO_BILL_FEE = 25;
export const MOVE_OUT_MOTO_LUNGKAN_FEE = 80;
export const MOVE_OUT_MOTO_URGENT_EXTRA = 50;
export const MOVE_OUT_MOTO_DUTY_FEE = 10;

export interface MoveOutFees {
  billTotal: number;
  noBillTotal: number; // ไม่รวมค่าอากร
  dutyAmount: number;
}

export const moveOutPricedFor = (vehicleClass: "CAR" | "MOTO") => vehicleClass === "MOTO";

export function calculateMoveOutFees(vehicleClass: "CAR" | "MOTO", urgent: boolean): MoveOutFees {
  if (vehicleClass !== "MOTO") return { billTotal: 0, noBillTotal: 0, dutyAmount: 0 };
  return {
    billTotal: MOVE_OUT_MOTO_BILL_FEE,
    noBillTotal: MOVE_OUT_MOTO_LUNGKAN_FEE + (urgent ? MOVE_OUT_MOTO_URGENT_EXTRA : 0),
    dutyAmount: MOVE_OUT_MOTO_DUTY_FEE,
  };
}
