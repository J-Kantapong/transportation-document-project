// รถที่ "ไม่ซื้อป้าย" (ผู้ใช้ 2026-11-18): ขอใช้เลขทะเบียน (NORMAL / AUCTION) แล้วไม่ติ๊ก "รวมค่าแผ่นป้าย" ตอนยื่น และไม่ได้สั่งทำ
// แผ่นป้ายใหม่ (ขาวดำ / ประมูล) = ไม่มีแผ่นป้ายให้รับจากกรมฯ -> ไม่ต้องรับป้าย ไม่ต้องแนบรูปป้าย ส่งเล่มแล้วจบงาน
// กฎเดียวกับ includePlate ใน document-submission/document-fee-calculator.ts (ไม่ขอเลข / เลขจากงานสลับเลข คิดค่าแผ่นป้ายเสมอ)
// ดูจากการยื่นครั้งล่าสุดของรถเสมอ - ทุกจุดที่ถามว่า "รอป้ายไหม" ต้องเรียกฟังก์ชันนี้ ไม่เช็คเอง

export const PLATE_OPTION_SELECT = { plateNumberOption: true, newPlateOption: true, includePlateFee: true } as const;

export interface PlateOptionFields {
  plateNumberOption?: string | null;
  newPlateOption?: string | null;
  includePlateFee?: boolean | null;
}

export function plateNotRequired(sub: PlateOptionFields | null | undefined): boolean {
  if (!sub) return false;
  const requested = sub.plateNumberOption === 'NORMAL' || sub.plateNumberOption === 'AUCTION';
  const newPlate = !!sub.newPlateOption && sub.newPlateOption !== 'NONE';
  return requested && sub.includePlateFee === false && !newPlate;
}
