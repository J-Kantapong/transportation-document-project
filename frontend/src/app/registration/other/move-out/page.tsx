"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MOVE_OUT_VEHICLE_KINDS } from "@/lib/categories";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";

// ย้ายออก (ผู้ใช้ 2026-10-06): แยกรถยนต์/รถจักรยานยนต์ก่อน เหมือนการสลับเลข
// แสดงเฉพาะประเภทรถที่บทบาทเข้าได้ (กันกดแล้ว proxy.ts เด้งกลับเงียบๆ)
export default function MoveOutKindPage() {
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  const kinds = MOVE_OUT_VEHICLE_KINDS.filter((kind) => roles === null || canAccessPage(kind.href, roles));

  return (
    <div className="content">
      <Link href="/registration/other" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← อื่นๆ
      </Link>
      <h1>ย้ายออก</h1>
      <div className="registration-tasks">
        {kinds.map((kind, index) => (
          <Link key={kind.href} href={kind.href} className="registration-task">
            <span className="task-number">{index + 1}</span>
            <strong>{kind.title}</strong>
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
