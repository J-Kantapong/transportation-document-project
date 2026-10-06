// ค่าใช้จ่ายงานย้ายออก - ผู้ใช้กำหนด 2026-10-06 เฉพาะมอเตอร์ไซค์: Bill 25 / No Bill = ลงขัน 80 + ด่วนเพิ่ม 50 (ถ้าด่วน) / ค่าอากร 10
// ค่าอากร "แยกต่างหาก" เหมือนงานยกเลิกการใช้รถ: ไม่รวมใน No Bill และไม่รวมในยอดรวม
// รถยนต์ยังไม่มีข้อมูล (ผู้ใช้ยังไม่ให้) = ทุกยอดเป็น 0 และเลือกงานด่วนไม่ได้ จนกว่าผู้ใช้จะให้อัตรา
// เก็บเป็น snapshot ลงแถวตอนยื่น (billTotal / noBillTotal / dutyAmount) - เปลี่ยนอัตราในอนาคตไม่ทำให้งานเก่าเปลี่ยนตาม
// สำเนาฝั่งหน้าเว็บ: frontend/src/lib/vehicle-move-out-fee.ts (แก้ทั้งสองที่พร้อมกัน)
export const MOVE_OUT_MOTO_BILL_FEE = 25;
export const MOVE_OUT_MOTO_LUNGKAN_FEE = 80;
export const MOVE_OUT_MOTO_URGENT_EXTRA = 50;
export const MOVE_OUT_MOTO_DUTY_FEE = 10;

export interface MoveOutFees {
  billTotal: number;
  noBillTotal: number; // ไม่รวมค่าอากร
  dutyAmount: number;
}

// รถยนต์ยังไม่มีอัตรา - ผู้เรียกต้องกันงานด่วนของรถยนต์เองก่อน (service ตอบ 400)
export const moveOutPricedFor = (vehicleClass: 'CAR' | 'MOTO') => vehicleClass === 'MOTO';

export function calculateMoveOutFees(vehicleClass: 'CAR' | 'MOTO', urgent: boolean): MoveOutFees {
  if (vehicleClass !== 'MOTO') return { billTotal: 0, noBillTotal: 0, dutyAmount: 0 };
  return {
    billTotal: MOVE_OUT_MOTO_BILL_FEE,
    noBillTotal: MOVE_OUT_MOTO_LUNGKAN_FEE + (urgent ? MOVE_OUT_MOTO_URGENT_EXTRA : 0),
    dutyAmount: MOVE_OUT_MOTO_DUTY_FEE,
  };
}
