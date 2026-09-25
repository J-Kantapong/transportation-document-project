"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { isoToDisplayDate } from "@/lib/date";
import { useSubmitFlow } from "./SubmitFlowContext";
import { DONE_HREF, MENU_HREF, PICK_HREF, REVIEW_HREF, SETTINGS_HREF } from "./shared";

// หัวของทุกขั้น: ลิงก์กลับเมนู + แถบ 4 ขั้น (กดย้อนกลับไปแก้ขั้นก่อนหน้าได้เสมอ) + วันที่ยื่น (กรอกในขั้นตั้งค่า
// ขั้น 3-4 แสดงอย่างเดียว)
export function SubmitFlowHeader() {
  const pathname = usePathname();
  const { submitDate, selected, checks, result } = useSubmitFlow();
  const step = pathname.startsWith(DONE_HREF) ? 4 : pathname.startsWith(REVIEW_HREF) ? 3 : pathname.startsWith(SETTINGS_HREF) ? 2 : 1;

  const steps = [
    { n: 1, label: "เลือกรถ", href: PICK_HREF, enabled: true },
    { n: 2, label: "ตั้งค่า", href: SETTINGS_HREF, enabled: selected.length > 0 },
    { n: 3, label: "ตรวจทาน", href: REVIEW_HREF, enabled: checks.ready },
    { n: 4, label: "ยื่นแล้ว · ปริ้นใบส่งงาน", href: DONE_HREF, enabled: result !== null },
  ];

  return (
    <>
      <Link href={MENU_HREF} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ยื่นเอกสารจดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ยื่นเอกสารจดทะเบียนรถใหม่</h1>

      <nav className="submit-steps" aria-label="ขั้นตอนยื่นเอกสาร">
        {steps.map((s, i) => (
          <span key={s.n} style={{ display: "contents" }}>
            {i > 0 && (
              <span className="submit-steps-sep" aria-hidden="true">
                ›
              </span>
            )}
            {s.n === step || !s.enabled ? (
              <span className={`submit-step${s.n === step ? " current" : ""}`} aria-current={s.n === step ? "step" : undefined}>
                {s.n} {s.label}
              </span>
            ) : (
              <Link className="submit-step" href={s.href}>
                {s.n} {s.label}
              </Link>
            )}
          </span>
        ))}
      </nav>

      {/* ช่องกรอกวันที่ยื่นอยู่ขั้นตั้งค่า (ผู้ใช้ 2026-09-25) - ขั้นตรวจทาน/ยื่นแล้วแสดงวันที่ให้เห็นอย่างเดียว */}
      {step >= 3 && (
        <div className="submit-date">
          <span className="muted">
            วันที่ยื่นเอกสาร {isoToDisplayDate(step === 4 && result ? result.submitDate : submitDate) || "—"}
            {step === 3 && (
              <>
                {" · "}
                <Link href={SETTINGS_HREF} className="text-button">
                  เปลี่ยนวันที่
                </Link>
              </>
            )}
          </span>
        </div>
      )}
    </>
  );
}
