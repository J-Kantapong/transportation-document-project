"use client";

import { useEffect, useState } from "react";
import { fetchRechecks, type ReceiptRecheck, type RecheckJobType } from "@/lib/receipt-recheck";

// กล่องผลตรวจใบเสร็จซ้ำในแถวหน้ารับใบเสร็จ (ผู้ใช้ 2026-11-19) - ยอดใบเสร็จเทียบ Bill + ตัวถัง / ทะเบียนที่ AI อ่าน
// refreshKey = ค่าที่เปลี่ยนเมื่อข้อมูลใบเสร็จเปลี่ยน (ยอด / จำนวนรูป) ให้โหลดผลใหม่ · โหลดไม่ได้ = ไม่แสดง (backend ตรวจตอนยืนยันเสมอ)
const baht = (n: number) => n.toLocaleString("th-TH", { maximumFractionDigits: 2 });

export function ReceiptRecheckBox({ type, id, refreshKey }: { type: RecheckJobType; id: string; refreshKey: string }) {
  const [check, setCheck] = useState<ReceiptRecheck | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchRechecks(type, [id])
      .then((data) => {
        if (!cancelled) setCheck(data.checks[id] ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [type, id, refreshKey]);
  if (!check) return null;
  const ok = check.problems.length === 0;
  return (
    <div
      className="sub"
      role="status"
      style={{ marginTop: 6, padding: "6px 8px", borderRadius: 8, minWidth: 220, background: ok ? "#eaf7f0" : "#fdecec", color: ok ? "#1f6b45" : "#a12a2a", whiteSpace: "normal" }}
    >
      {ok ? (
        <>✓ ตรวจใบเสร็จผ่าน{check.amount.receipt !== null ? ` · ยอด ${baht(check.amount.receipt)} ตรงกับ Bill` : ""}</>
      ) : (
        <>
          <strong>⚠ ตรวจใบเสร็จไม่ผ่าน</strong>
          {check.problems.map((p) => (
            <div key={p}>• {p}</div>
          ))}
        </>
      )}
    </div>
  );
}
