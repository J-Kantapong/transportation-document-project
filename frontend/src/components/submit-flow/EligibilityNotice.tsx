"use client";

import { isoToDisplayDate } from "@/lib/date";
import { useSubmitFlow } from "./SubmitFlowContext";

// แจ้งคันที่ยื่นไม่ได้ ณ วันที่ยื่นที่ตั้งไว้ และกรณีตรวจสิทธิ์ยื่นไม่สำเร็จ (ผู้ใช้ 2026-09-27) - ขั้นตั้งค่าและขั้นตรวจทาน
// ยื่นไม่ได้เพราะวันที่: เปลี่ยนวันที่ยื่น (เช่น กลับไปใช้วันที่ยื่นเดิม) หรือเอาคันนั้นออก - backend ตรวจซ้ำตอนยื่นเสมอ
export function EligibilityNotice() {
  const { checks, eligibilityError, retryEligibility, submitDate } = useSubmitFlow();
  return (
    <>
      {eligibilityError && (
        <p className="customer-message error" role="alert" style={{ marginBottom: 12 }}>
          ตรวจสิทธิ์ยื่นตามวันที่ยื่นไม่สำเร็จ: {eligibilityError} ·{" "}
          <button type="button" className="text-button" onClick={retryEligibility}>
            ลองใหม่
          </button>
        </p>
      )}
      {checks.dateBlockedIds.length > 0 && (
        <p className="customer-message error" role="alert" style={{ marginBottom: 12 }}>
          ยื่นไม่ได้ ณ วันที่ยื่น {isoToDisplayDate(submitDate)} จำนวน {checks.dateBlockedIds.length} คัน (แถวสีแดง) - เปลี่ยนวันที่ยื่น
          หรือเอาคันนั้นออก
        </p>
      )}
    </>
  );
}
