import { inspectionValidUntil } from '../document-submission/submission-eligibility.js';

// รถที่ยกเลิกการยื่น/ยื่นไม่สำเร็จ ยื่นใหม่ด้วยวันที่ยื่นเดิมได้ (ผู้ใช้ 2026-09-27 F19) แม้วันนี้ผลตรวจจะครบ 90 วันแล้ว
// รถคันนั้นจึงขึ้นในคิวส่งตรวจรอบ 2 ด้วย ถ้าส่งตรวจรอบ 2 ไปก่อน ผลตรวจผ่านเดิมถูกล้าง ยื่นด้วยวันที่เดิมไม่ได้อีก + เสียค่าตรวจรอบ 2
// -> หน้าตรวจสภาพบอกไว้ในคิวส่งตรวจ ให้ถามฝ่ายยื่นก่อน (เฉพาะครั้งที่ยื่นหลังผลตรวจผ่านปัจจุบัน และยังอยู่ในอายุผลตรวจนั้น)

export interface SubmitAttempt {
  submitDate: string; // YYYY-MM-DD
  reason: 'FAILED' | 'CANCELLED';
}

export interface ResubmitWindow extends SubmitAttempt {
  validUntil: string; // วันสุดท้ายที่ยื่นด้วยผลตรวจเดิมได้ (ตรวจผ่าน + 89 วัน)
}

// วันที่ยื่นของรายการที่ยกเลิก อ่านจาก snapshot ที่ DocumentSubmissionService.cancel เขียนลง VehicleEditLog
// ({ "submission.cancelled": { from: "ยื่น YYYY-MM-DD ..." } }) - อ่านไม่ได้ = null (ไม่นับ)
export function cancelledSubmitDate(changesJson: string): string | null {
  try {
    const changes = JSON.parse(changesJson) as Record<string, { from?: unknown } | undefined>;
    const from = changes['submission.cancelled']?.from;
    const match = typeof from === 'string' ? /^ยื่น (\d{4}-\d{2}-\d{2})/.exec(from) : null;
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

// ครั้งล่าสุดที่ยื่นด้วยผลตรวจผ่านปัจจุบัน (วันที่ยื่นอยู่ระหว่างวันที่ตรวจผ่านถึงวันสุดท้ายที่ยื่นได้) - ไม่มี = null
export function resubmitWindow(passDate: Date, attempts: SubmitAttempt[]): ResubmitWindow | null {
  const passIso = passDate.toISOString().slice(0, 10);
  const validUntil = inspectionValidUntil(passDate);
  const latest = attempts
    .filter((a) => a.submitDate >= passIso && a.submitDate <= validUntil)
    .sort((a, b) => b.submitDate.localeCompare(a.submitDate))[0];
  return latest ? { ...latest, validUntil } : null;
}
