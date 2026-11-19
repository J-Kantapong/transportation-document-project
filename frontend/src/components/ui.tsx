// ชิ้นส่วนหน้าจอกลางของทั้งแอป (ผู้ใช้ 2026-11-19: ทุกหน้าต้องจัดวาง/ทิศทาง/แจ้งเตือนแบบเดียวกัน
// คนใช้เดาได้ว่าต้องไปทางไหนต่อ) - กติกาเต็มอยู่ใน docs/claude/ui-patterns.md
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";

// ลิงก์ย้อนกลับ: บนซ้ายเหนือหัวข้อเสมอ ข้อความ = ชื่อหน้าแม่ (ไม่ใช่ "กลับไปหน้า..." / "ก่อนหน้า")
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="back-link">
      <Icon name="arrow-left" />
      {/* ผู้เรียกบางที่ยังส่ง "← ..." มา - ตัดลูกศรตัวอักษรออก ไม่ให้ซ้ำกับไอคอน */}
      {label.replace(/^←\s*/, "")}
    </Link>
  );
}

// หัวหน้า: [ลิงก์ย้อนกลับ] / หัวข้อ + คำอธิบาย (ซ้าย) · ปุ่มของหน้า (ขวา, ปุ่มหลักอยู่ขวาสุด)
export function PageHeader({
  title,
  subtitle,
  back,
  actions,
  titleFocus,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  actions?: ReactNode;
  // หน้าที่ย้ายโฟกัสไปหัวข้อหลังโหลด (h1 tabIndex=-1)
  titleFocus?: boolean;
}) {
  return (
    <>
      {back && <BackLink href={back.href} label={back.label} />}
      <div className="heading">
        <div className="heading-text">
          <h1 tabIndex={titleFocus ? -1 : undefined}>{title}</h1>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {actions && <div className="heading-actions">{actions}</div>}
      </div>
    </>
  );
}

type Tone = "error" | "success" | "warn" | "info";
const TONE_ICON: Record<Tone, IconName> = {
  error: "alert-circle",
  success: "check-circle",
  warn: "alert-triangle",
  info: "info",
};

// กล่องแจ้งในหน้า: error = ผิดพลาด (ค้างไว้จนแก้), warn = ควรระวัง, info = ข้อมูล, success = สำเร็จที่ต้องอยู่ถาวร
// (บันทึกสำเร็จทั่วไปใช้ toast จาก lib/toast.ts แทน) · children ว่าง = ไม่แสดงอะไร
export function Notice({
  tone,
  children,
  action,
  className,
}: {
  tone: Tone;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  if (children === undefined || children === null || children === false || children === "") return null;
  return (
    <div
      className={`notice notice--${tone}${className ? ` ${className}` : ""}`}
      role={tone === "error" ? "alert" : "status"}
    >
      <Icon name={TONE_ICON[tone]} />
      <div className="notice-body">{children}</div>
      {action && <div className="notice-action">{action}</div>}
    </div>
  );
}

// กำลังโหลด: ข้อความเดียวทั้งแอป "กำลังโหลด…" (ระบุของได้ เช่น "กำลังโหลดใบวางบิล…")
export function LoadingState({ label = "กำลังโหลด…", inline }: { label?: string; inline?: boolean }) {
  return (
    <div className={inline ? "loading-state loading-state--inline" : "loading-state"} role="status">
      <Icon name="loader" className="spin" />
      {label}
    </div>
  );
}

// ไม่มีข้อมูล: ข้อความกลางกล่อง + ปุ่มทำต่อ (ถ้ามี)
export function EmptyState({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-customers">
      <div>{children}</div>
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

// เครื่องหมายช่องบังคับ ใส่ท้ายป้ายชื่อช่อง: <label className="field">เลขตัวถัง <Req /> <input required/></label>
export function Req() {
  return (
    <span className="req" aria-hidden="true">
      *
    </span>
  );
}
