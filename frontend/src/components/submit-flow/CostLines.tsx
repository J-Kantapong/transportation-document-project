"use client";

import type { FeePreview, TaxBreakdown } from "@/lib/api";
import { dutyAmount, formatMoney, grandTotalExcludingDuty } from "./shared";

// ค่าใช้จ่ายรายบรรทัดของแต่ละคัน (ผู้ใช้ 2026-09-25: แสดงเต็ม ไม่ซ่อน) - Bill | No bill | สรุป
export function CostLines({ fee, tax, ownerMissing }: { fee: FeePreview; tax: TaxBreakdown | undefined; ownerMissing: boolean }) {
  const taxAmount = tax?.amount ?? null;
  return (
    <div className="cost-lines">
      <div>
        <div className="cost-head">Bill</div>
        {fee.billItems.map((item, i) => (
          <div key={i} className="cost-row">
            <span>{item.label}</span>
            <span>{formatMoney(item.amount)}</span>
          </div>
        ))}
        <div className="cost-row cost-sum">
          <span>รวมค่าธรรมเนียม</span>
          <span>{formatMoney(fee.billTotal)}</span>
        </div>
        <div className="cost-row">
          <span>
            ค่าภาษี
            {tax && taxAmount !== null && tax.juristicMultiplier > 1 ? <span className="muted"> ({tax.juristicReason})</span> : null}
          </span>
          {taxAmount !== null ? (
            <span>{formatMoney(taxAmount)}</span>
          ) : (
            <span className="field-error">{ownerMissing ? "เลือกเจ้าของรถก่อน" : `คำนวณไม่ได้${tax?.reason ? ` - ${tax.reason}` : ""}`}</span>
          )}
        </div>
        <div className="cost-row cost-sum">
          <span>รวมค่า Bill ทั้งหมด</span>
          <span>{formatMoney(fee.billTotal + (taxAmount ?? 0))}</span>
        </div>
      </div>
      <div>
        <div className="cost-head">No bill</div>
        {fee.noBillItems.map((item, i) => (
          <div key={i} className="cost-row">
            <span>{item.label}</span>
            <span>{formatMoney(item.amount)}</span>
          </div>
        ))}
        <div className="cost-row cost-sum">
          <span>รวม No bill</span>
          <span>{formatMoney(fee.noBillTotal)}</span>
        </div>
      </div>
      <div>
        <div className="cost-head">สรุป</div>
        <div className="cost-row cost-sum">
          <span>รวมทั้งหมด (ยังไม่รวมค่าอากร)</span>
          <span style={{ color: "#2854d9" }}>{formatMoney(grandTotalExcludingDuty(fee, taxAmount))}</span>
        </div>
        <div className="cost-row muted">
          <span>ค่าอากร (แยกต่างหาก)</span>
          <span>{formatMoney(dutyAmount(fee))}</span>
        </div>
      </div>
    </div>
  );
}
