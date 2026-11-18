// ค่าใช้จ่ายยกเลิกการใช้รถ - ผู้ใช้กำหนดตายตัว 2026-10-02: Bill 25 บาท / No Bill 100 บาท / ค่าอากร 10 บาท ต่อคัน
// (ทั้งรถยนต์และมอเตอร์ไซค์) ค่าอากร "แยกต่างหาก" ไม่รวมใน No Bill และไม่รวมในยอดรวม (ผู้ใช้ 2026-10-02) -
// ต่างจากงานสลับเลขที่เอาค่าอากรไว้ใน No Bill: ที่นี่ No Bill = 100, รวม Bill + No Bill = 125, ค่าอากร 10 แสดงแยกอีกบรรทัด
// เก็บเป็น snapshot ลงแถวตอนยื่น (billTotal / noBillTotal / dutyAmount) - เปลี่ยนอัตราในอนาคตไม่ทำให้งานเก่าเปลี่ยนตาม
// สำเนาฝั่งหน้าเว็บ: frontend/src/lib/vehicle-use-cancel-fee.ts (แก้ทั้งสองที่พร้อมกัน)
export const VEHICLE_USE_CANCEL_BILL_FEE = 25;
export const VEHICLE_USE_CANCEL_NO_BILL_FEE = 100;
export const VEHICLE_USE_CANCEL_DUTY_FEE = 10;

// งานด่วน (ผู้ใช้ 2026-11-18): ลงขันด่วนเพิ่มใน No Bill - รถยนต์ +100 / มอเตอร์ไซค์ +50
export const VEHICLE_USE_CANCEL_CAR_URGENT_EXTRA = 100;
export const VEHICLE_USE_CANCEL_MOTO_URGENT_EXTRA = 50;

export const cancelUseUrgentExtra = (vehicleClass: 'CAR' | 'MOTO') =>
  vehicleClass === 'MOTO' ? VEHICLE_USE_CANCEL_MOTO_URGENT_EXTRA : VEHICLE_USE_CANCEL_CAR_URGENT_EXTRA;

export const cancelUseNoBillTotal = (vehicleClass: 'CAR' | 'MOTO', urgent: boolean) =>
  VEHICLE_USE_CANCEL_NO_BILL_FEE + (urgent ? cancelUseUrgentExtra(vehicleClass) : 0);
