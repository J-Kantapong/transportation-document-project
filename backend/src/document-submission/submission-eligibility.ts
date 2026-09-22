// กฎว่ารถคันไหนยื่นเอกสารจดทะเบียน (Step 4) ได้ - ผู้ใช้กำหนดเอง ห้ามผ่อนปรน:
// - ทำ Step 1 -> 4 ตามลำดับเท่านั้น: ต้องแจ้งย้าย/ตัดบัญชีเสร็จ (transferDone) และตรวจรถผ่านแล้ว
// - ผลตรวจผ่านมีอายุ 90 วัน (นับจาก inspectionResultDate ถึงวันที่ยื่น) ครบ 90 วันแล้วยังไม่ยื่น = ต้องกลับไป
//   ตรวจรถใหม่ก่อน (รถกลับเข้าคิวส่งตรวจเอง - ดู isReinspectionDue ใน vehicles.service.ts)
// - ได้รับใบเสร็จแล้ว (RECEIPT_RECEIVED) = จดทะเบียนสำเร็จ ยื่นซ้ำไม่ได้เด็ดขาด
// - ยื่นแล้วรอใบเสร็จ (PENDING) ยื่นซ้ำไม่ได้ - ยื่นไม่สำเร็จ (FAILED) ยื่นใหม่ได้ถ้าผลตรวจยังไม่หมดอายุ

export const INSPECTION_VALID_DAYS = 90;

// สถานะที่ถือว่ารถคันนั้นยื่นเอกสารไปแล้ว (ยื่นซ้ำไม่ได้ และไม่ต้องตรวจรถใหม่แม้ผลตรวจจะเกิน 90 วัน)
export const ACTIVE_SUBMISSION_STATUSES = ['PENDING', 'RECEIPT_RECEIVED'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SubmissionEligibilityInput {
  transferDone: boolean;
  inspectionSentDate: Date | null;
  inspectionResult: string | null;
  inspectionResultDate: Date | null;
  // สถานะของ DocumentSubmission ที่ยัง active (PENDING/RECEIPT_RECEIVED) - ไม่มี = null
  activeSubmissionStatus: string | null;
  // งานสลับเลขที่รถคันนี้รอรับเลขอยู่ (ผู้ใช้ 2026-09-23) - ต้องยืนยันรับเอกสารกลับของงานสลับเลขก่อนจึงยื่นได้
  // ไม่มีงานสลับเลข = undefined/null (รถทั่วไปไม่กระทบ)
  plateSwap?: { returnedDate: Date | string | null } | null;
}

export const PLATE_SWAP_PENDING_REASON = 'รถคันนี้รับเลขจากงานสลับเลข - ต้องยืนยันรับเอกสารกลับในหน้างานสลับเลขก่อนจึงจะยื่นเอกสารได้';

// วันสุดท้ายที่ยังยื่นได้ (ค.ศ. YYYY-MM-DD) = วันที่ตรวจผ่าน + 89 วัน
export function inspectionValidUntil(resultDate: Date): string {
  return new Date(resultDate.getTime() + (INSPECTION_VALID_DAYS - 1) * DAY_MS).toISOString().slice(0, 10);
}

// null = ยื่นได้ - submitDate ต้องเป็นเที่ยงคืน UTC ของวันที่ยื่น (แบบเดียวกับ parseSubmitDate)
export function getSubmitBlockReason(vehicle: SubmissionEligibilityInput, submitDate: Date): string | null {
  if (vehicle.activeSubmissionStatus === 'RECEIPT_RECEIVED') {
    return 'รถคันนี้จดทะเบียนสำเร็จแล้ว (ได้รับใบเสร็จแล้ว) - ยื่นซ้ำไม่ได้';
  }
  if (vehicle.activeSubmissionStatus === 'PENDING') {
    return 'รถคันนี้ยื่นเอกสารไปแล้วและยังรอใบเสร็จอยู่ - ยื่นซ้ำไม่ได้จนกว่าจะได้รับใบเสร็จหรือยื่นไม่สำเร็จ';
  }
  if (!vehicle.transferDone) {
    return 'ยังไม่ผ่านขั้นตอนแจ้งย้าย/ตัดบัญชี';
  }
  if (vehicle.plateSwap && !vehicle.plateSwap.returnedDate) {
    return PLATE_SWAP_PENDING_REASON;
  }
  if (vehicle.inspectionResult !== 'ผ่าน' || !vehicle.inspectionResultDate) {
    if (vehicle.inspectionResult === 'ไม่ผ่าน') return 'ตรวจรถไม่ผ่าน - ต้องส่งตรวจใหม่ให้ผ่านก่อน';
    if (vehicle.inspectionSentDate) return 'ส่งตรวจรถแล้ว ยังรอผลตรวจ';
    return 'ยังไม่ได้ตรวจรถ';
  }
  const days = Math.floor((submitDate.getTime() - vehicle.inspectionResultDate.getTime()) / DAY_MS);
  if (days < 0) {
    return 'วันที่ยื่นเอกสารอยู่ก่อนวันที่ตรวจรถผ่าน';
  }
  if (days >= INSPECTION_VALID_DAYS) {
    return `ผลตรวจรถหมดอายุแล้ว (ตรวจผ่านครบ ${INSPECTION_VALID_DAYS} วัน) - ต้องกลับไปตรวจรถใหม่ก่อน`;
  }
  return null;
}
