"use client";

import type { Checks } from "./SubmitFlowContext";
import { formatMoney } from "./shared";

// ยอดรวมทั้งชุด + สิ่งที่ยังขาด ในแถบล่างของขั้นตั้งค่าและขั้นตรวจทาน
export function ChecksNote({ checks, count }: { checks: Checks; count: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span>
        {count} คัน · รวม (ยังไม่รวมค่าอากร) <strong style={{ color: "#2854d9" }}>{formatMoney(checks.grandTotal)} บาท</strong>
        <span className="muted"> · ค่าอากรแยกต่างหาก {formatMoney(checks.dutyTotal)} บาท</span>
      </span>
      {checks.problemIds.size > 0 ? (
        <span className="field-error">
          ยังกรอกไม่ครบ {checks.problemIds.size} คัน
          {checks.ownerMissingIds.length > 0 ? ` · เจ้าของรถ ${checks.ownerMissingIds.length}` : ""}
          {checks.plateMissingIds.length > 0 ? ` · เลขทะเบียน ${checks.plateMissingIds.length}` : ""}
          {checks.errorIds.length > 0 ? ` · คำนวณไม่ได้ ${checks.errorIds.length}` : ""}
        </span>
      ) : checks.pendingCount > 0 ? (
        <span className="muted">กำลังคำนวณ {checks.pendingCount} คัน…</span>
      ) : (
        checks.taxPendingCount > 0 && (
          <span style={{ color: "#bb8527", fontSize: 13 }}>
            {checks.taxPendingCount} คันยังคำนวณภาษีไม่ได้ - ยอดรวมยังไม่รวมภาษีของคันเหล่านี้
          </span>
        )
      )}
    </div>
  );
}
