// ค่าใช้จ่ายคัดแผ่นป้ายทะเบียน - ผู้ใช้กำหนดตายตัว (รถยนต์ 2026-10-02 / มอเตอร์ไซค์ 2026-10-09)
// รถยนต์: Bill ตามชนิดการคัดป้าย (คัดคู่ปกติ 205) / No Bill ลงขัน 100 (+ ลงขันด่วนเพิ่มเมื่องานด่วน) / ค่าอากร 10 บาทต่อคัน
// มอเตอร์ไซค์: Bill 105 (คำขอ 5 + แผ่นป้าย 100 - มีป้ายใบเดียว) / No Bill ลงขัน 60 (+ ลงขันด่วนเพิ่ม 50 เมื่องานด่วน) / ค่าอากร 10
// ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่รวมในยอดรวม (เหมือนงานยกเลิกการใช้รถ)
// สำเนาของ backend/src/plate-copy/plate-copy-fee.ts (แก้ทั้งสองที่พร้อมกัน)
export type PlateCopyVehicleClass = 'CAR' | 'MOTO';

export const PLATE_COPY_NO_BILL_FEE = 100; // ลงขันรถยนต์
export const PLATE_COPY_CAR_URGENT_FEE = 100; // ลงขันด่วนเพิ่มของรถยนต์ (ผู้ใช้ยืนยัน 2026-10-09: รถยนต์ทำด่วนได้ เพิ่ม 100)
export const PLATE_COPY_MOTO_NO_BILL_FEE = 60; // ลงขันมอเตอร์ไซค์ (ผู้ใช้ 2026-10-09)
export const PLATE_COPY_MOTO_URGENT_FEE = 50; // ลงขันด่วนเพิ่มของมอเตอร์ไซค์ (ผู้ใช้ 2026-10-09)
export const PLATE_COPY_DUTY_FEE = 10;

// ชนิดการคัดป้าย (ผู้ใช้ 2026-10-08): Bill = ค่าคำขอ 5 + ค่าแผ่นป้าย
// ใบเดียว: ขาวดำปกติ 100 / ประมูล 600 - คัดคู่: ปกติ 200 / ประมูล 1,200 (BOTH = คัดคู่ปกติ คงชื่อเดิมไว้ ยอด 205 เท่าเดิม)
// No Bill และค่าอากรเท่าเดิมทุกชนิด (Claude choice, ผู้ใช้ให้มาแต่ค่าแผ่นป้าย)
export type PlateCopyType = 'BOTH' | 'SINGLE_NORMAL' | 'BOTH_AUCTION' | 'SINGLE_AUCTION';
export const PLATE_COPY_TYPES: PlateCopyType[] = ['BOTH', 'SINGLE_NORMAL', 'BOTH_AUCTION', 'SINGLE_AUCTION'];
export const PLATE_COPY_REQUEST_FEE = 5;
export const PLATE_COPY_PLATE_FEES: Record<PlateCopyType, number> = {
  SINGLE_NORMAL: 100,
  BOTH: 200,
  SINGLE_AUCTION: 600,
  BOTH_AUCTION: 1200,
};
export const plateCopyPlateFee = (type: PlateCopyType): number => PLATE_COPY_PLATE_FEES[type];
export const plateCopyBillFee = (type: PlateCopyType): number => PLATE_COPY_REQUEST_FEE + PLATE_COPY_PLATE_FEES[type];

// มอเตอร์ไซค์มีป้ายใบเดียว - ชนิดการคัดป้ายเป็นใบเดียวเลขปกติเสมอ (Bill 105) ไม่ให้เลือกชนิดอื่น
export const PLATE_COPY_MOTO_TYPE: PlateCopyType = 'SINGLE_NORMAL';

export const plateCopyBaseNoBillFee = (vehicleClass: PlateCopyVehicleClass): number =>
  vehicleClass === 'MOTO' ? PLATE_COPY_MOTO_NO_BILL_FEE : PLATE_COPY_NO_BILL_FEE;
export const plateCopyUrgentFee = (vehicleClass: PlateCopyVehicleClass): number =>
  vehicleClass === 'MOTO' ? PLATE_COPY_MOTO_URGENT_FEE : PLATE_COPY_CAR_URGENT_FEE;
// No Bill = ลงขัน + ลงขันด่วนเพิ่ม (เมื่องานด่วน) - ไม่รวมค่าอากร
export const plateCopyNoBillFee = (vehicleClass: PlateCopyVehicleClass, urgent: boolean): number =>
  plateCopyBaseNoBillFee(vehicleClass) + (urgent ? plateCopyUrgentFee(vehicleClass) : 0);

// ยอดที่ backend เก็บลงแถวตอนยื่น - มอเตอร์ไซค์ไม่สนชนิดการคัดป้าย (ใบเดียวเลขปกติเสมอ)
export function calculatePlateCopyFees(vehicleClass: PlateCopyVehicleClass, copyType: PlateCopyType, urgent: boolean) {
  return {
    billTotal: plateCopyBillFee(vehicleClass === 'MOTO' ? PLATE_COPY_MOTO_TYPE : copyType),
    noBillTotal: plateCopyNoBillFee(vehicleClass, urgent),
    dutyAmount: PLATE_COPY_DUTY_FEE,
  };
}

// ปกติป้ายออกภายใน 15 (วัน) นับจากวันที่ยื่น (ผู้ใช้ 2026-10-02) - ใช้บอกวันที่คาดว่าจะได้ป้ายและเตือนเมื่อเกิน ไม่ได้บังคับขั้นตอนใด
export const PLATE_COPY_EXPECTED_DAYS = 15;
