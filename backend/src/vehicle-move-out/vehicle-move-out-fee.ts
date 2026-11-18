// ค่าใช้จ่ายงานย้ายออก
// มอเตอร์ไซค์ (ผู้ใช้ 2026-10-06): Bill 25 / No Bill = ลงขัน 80 + ด่วนเพิ่ม 50 (ถ้าด่วน) / ค่าอากร 10
// รถยนต์ (ผู้ใช้ 2026-11-18): Bill 55 / No Bill = ลงขัน 100 + ด่วนเพิ่ม 100 (ถ้าด่วน) / ค่าอากร 10
// ค่าอากร "แยกต่างหาก" เหมือนงานยกเลิกการใช้รถ: ไม่รวมใน No Bill และไม่รวมในยอดรวม
// เก็บเป็น snapshot ลงแถวตอนยื่น (billTotal / noBillTotal / dutyAmount) - เปลี่ยนอัตราในอนาคตไม่ทำให้งานเก่าเปลี่ยนตาม
// (งานรถยนต์ที่ยื่นก่อน 2026-11-18 เก็บ 0 ไว้ตามเดิม จนกว่าจะแก้ช่องงานด่วนซึ่งคิด No Bill ใหม่)
// สำเนาฝั่งหน้าเว็บ: frontend/src/lib/vehicle-move-out-fee.ts (แก้ทั้งสองที่พร้อมกัน)
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

// ทั้งสองประเภทมีอัตราแล้ว (รถยนต์ตั้งแต่ 2026-11-18) - คงฟังก์ชันไว้ให้ผู้เรียกเดิมใช้ต่อ
export const moveOutPricedFor = (vehicleClass: 'CAR' | 'MOTO') => vehicleClass === 'MOTO' || vehicleClass === 'CAR';

export function calculateMoveOutFees(vehicleClass: 'CAR' | 'MOTO', urgent: boolean): MoveOutFees {
  if (vehicleClass === 'MOTO') {
    return {
      billTotal: MOVE_OUT_MOTO_BILL_FEE,
      noBillTotal: MOVE_OUT_MOTO_LUNGKAN_FEE + (urgent ? MOVE_OUT_MOTO_URGENT_EXTRA : 0),
      dutyAmount: MOVE_OUT_MOTO_DUTY_FEE,
    };
  }
  return {
    billTotal: MOVE_OUT_CAR_BILL_FEE,
    noBillTotal: MOVE_OUT_CAR_LUNGKAN_FEE + (urgent ? MOVE_OUT_CAR_URGENT_EXTRA : 0),
    dutyAmount: MOVE_OUT_CAR_DUTY_FEE,
  };
}
