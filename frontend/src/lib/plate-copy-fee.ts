// ค่าใช้จ่ายคัดแผ่นป้ายทะเบียน (รถยนต์) - ผู้ใช้กำหนดตายตัว 2026-10-02: Bill 205 / No Bill 100 / ค่าอากร 10 บาทต่อคัน
// ค่าอากรแยกต่างหาก ไม่รวมใน No Bill และไม่รวมในยอดรวม (เหมือนงานยกเลิกการใช้รถ)
// สำเนาของ backend/src/plate-copy/plate-copy-fee.ts (แก้ทั้งสองที่พร้อมกัน)
export const PLATE_COPY_BILL_FEE = 205;
export const PLATE_COPY_NO_BILL_FEE = 100;
export const PLATE_COPY_DUTY_FEE = 10;

// คัดป้ายแค่ใบเดียว (ผู้ใช้ 2026-10-08): เลขขาวดำปกติ Bill 100 / ประมูล Bill 600 - No Bill และค่าอากรเท่าเดิม (Claude choice, ผู้ใช้ให้มาแค่ยอดเดียว)
export type PlateCopyType = 'BOTH' | 'SINGLE_NORMAL' | 'SINGLE_AUCTION';
export const PLATE_COPY_TYPES: PlateCopyType[] = ['BOTH', 'SINGLE_NORMAL', 'SINGLE_AUCTION'];
export const PLATE_COPY_SINGLE_NORMAL_BILL_FEE = 100;
export const PLATE_COPY_SINGLE_AUCTION_BILL_FEE = 600;
export const plateCopyBillFee = (type: PlateCopyType): number =>
  type === 'SINGLE_NORMAL' ? PLATE_COPY_SINGLE_NORMAL_BILL_FEE : type === 'SINGLE_AUCTION' ? PLATE_COPY_SINGLE_AUCTION_BILL_FEE : PLATE_COPY_BILL_FEE;

// ปกติป้ายออกภายใน 15 (วัน) นับจากวันที่ยื่น (ผู้ใช้ 2026-10-02) - ใช้บอกวันที่คาดว่าจะได้ป้ายและเตือนเมื่อเกิน ไม่ได้บังคับขั้นตอนใด
export const PLATE_COPY_EXPECTED_DAYS = 15;
