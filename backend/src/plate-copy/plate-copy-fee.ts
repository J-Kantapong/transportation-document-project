// ค่าใช้จ่ายคัดแผ่นป้ายทะเบียน (รถยนต์) - ผู้ใช้กำหนดตายตัว 2026-10-02: Bill 205 / No Bill 100 / ค่าอากร 10 บาทต่อคัน
// ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่รวมในยอดรวม (เหมือนงานยกเลิกการใช้รถ): No Bill = 100, รวม Bill + No Bill = 305
// เก็บเป็น snapshot ลงแถวตอนยื่น (billTotal / noBillTotal / dutyAmount) - เปลี่ยนอัตราในอนาคตไม่ทำให้งานเก่าเปลี่ยนตาม
// สำเนาฝั่งหน้าเว็บ: frontend/src/lib/plate-copy-fee.ts (แก้ทั้งสองที่พร้อมกัน)
export const PLATE_COPY_NO_BILL_FEE = 100;
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

// ปกติป้ายออกภายใน 15 (วัน) นับจากวันที่ยื่น (ผู้ใช้ 2026-10-02) - ใช้บอกวันที่คาดว่าจะได้ป้ายและเตือนเมื่อเกิน ไม่ได้บังคับขั้นตอนใด
export const PLATE_COPY_EXPECTED_DAYS = 15;
