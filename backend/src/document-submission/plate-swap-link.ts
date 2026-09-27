// งานสลับเลข (รถเก่า กับ รถใหม่) กับรถใหม่ที่รับเลข - กฎเดียวที่ใช้ทุกที่ (ผู้ใช้ 2026-09-27):
// - งานที่ "ยังเปิดอยู่" = ยังไม่ได้ยืนยันรับเอกสารกลับ และไม่ได้ยกเลิก รถใหม่ที่มีงานแบบนี้อย่างน้อย 1 งานยื่นเอกสาร (Step 4)
//   ไม่ได้ (เดิมคิวยื่น/การยื่นดูแค่งานล่าสุด แต่ค้นหารถ/ภาพรวมดูทุกงาน สองหน้าบอกสถานะไม่ตรงกัน) - ดู OPEN_PLATE_SWAP_WHERE
//   ใน submission-eligibility.ts
// - ผูกรถใหม่กับงานสลับเลขไม่ได้ถ้ารถคันนั้นยื่นเอกสารแล้ว (รอใบเสร็จ/ได้ใบเสร็จ) หรือเป็นรถใหม่ของงานอื่นที่ยังเปิดอยู่
//   (เดิมผูกได้ทุกคัน เลขจากงานสลับเลขไม่ถึงรถที่ยื่นไปแล้ว และรถคันเดียวผูกได้หลายงาน)
// - รถใหม่รับ "ทะเบียนเก่า" ของรถเก่า (oldPlate*) ส่วน newPlate* คือทะเบียนใหม่ที่รถเก่าได้ (ผู้ใช้ยืนยัน 2026-09-27)
// กฎอยู่ที่ newVehicleLinkBlockReason + ACTIVE_SUBMISSION_STATUSES + OPEN_PLATE_SWAP_WHERE ชุดเดียว ส่วนการอ่านจากฐานข้อมูลอยู่ที่
// PlateSwapService (linkStatusSelect ใช้ค่าคงที่ชุดนี้ และอ่านรายละเอียดงานอื่นไปใส่ในข้อความ) - เดิมมี query ซ้ำอีกชุดที่นี่แต่ไม่มีใครเรียก
// เลยลบทิ้ง ไม่ให้สองชุดเพี้ยนจากกัน (พบ 2026-09-27)
import { ACTIVE_SUBMISSION_STATUSES, OPEN_PLATE_SWAP_WHERE } from './submission-eligibility.js';

export { OPEN_PLATE_SWAP_WHERE };

export const NEW_VEHICLE_SUBMITTED_ERROR =
  'รถคันนี้ยื่นเอกสารจดทะเบียนไปแล้ว - ผูกกับงานสลับเลขไม่ได้ ถ้าจะใช้เลขจากงานสลับเลขต้องยกเลิกการยื่นก่อน';
export const NEW_VEHICLE_LINKED_ERROR = 'รถคันนี้ผูกกับงานสลับเลขอื่นที่ยังไม่ได้รับเอกสารกลับอยู่แล้ว';

// เหตุผลที่ผูกรถคันนี้เป็นรถใหม่ของงานสลับเลขไม่ได้ (null = ผูกได้)
export function newVehicleLinkBlockReason(input: { activeSubmissionStatus: string | null | undefined; hasOtherOpenSwap: boolean }): string | null {
  if (input.activeSubmissionStatus && ACTIVE_SUBMISSION_STATUSES.includes(input.activeSubmissionStatus)) return NEW_VEHICLE_SUBMITTED_ERROR;
  if (input.hasOtherOpenSwap) return NEW_VEHICLE_LINKED_ERROR;
  return null;
}

const plateText = (category: string | null | undefined, number: string | null | undefined) =>
  category && number ? `${category}${number}`.replace(/\s/g, '').toUpperCase() : null;

// รถใหม่ที่ทะเบียนที่บันทึกไว้ตรงกับ "ทะเบียนใหม่ของรถเก่า" แทน "ทะเบียนเก่า" - ก่อน 2026-09-27 ขั้นยื่นเอกสารเติมเลขผิดฝั่ง
// หน้างานสลับเลขใช้ติดธงให้พนักงานตรวจ (ไม่แก้ข้อมูลเอง)
export function hasWrongSwapPlate(
  swap: { oldPlateCategory: string; oldPlateNumber: string; newPlateCategory: string | null; newPlateNumber: string | null },
  vehicle: { plateCategory: string | null; plateNumber: string | null },
): boolean {
  const saved = plateText(vehicle.plateCategory, vehicle.plateNumber);
  const swapNew = plateText(swap.newPlateCategory, swap.newPlateNumber);
  return saved !== null && swapNew !== null && saved === swapNew && swapNew !== plateText(swap.oldPlateCategory, swap.oldPlateNumber);
}
