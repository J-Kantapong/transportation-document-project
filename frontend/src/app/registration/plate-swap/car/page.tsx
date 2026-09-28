"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { plateSwapSubtasks } from "@/lib/categories";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";

// ผู้ใช้ 2026-09-22: แบ่งงานสลับเลขเป็น รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า (ย้ายมาจาก /registration/plate-swap/page.tsx เดิม
// 2026-09-28 หลังแยกรถยนต์/มอเตอร์ไซค์เป็นชั้นบนสุด)
// แสดงเฉพาะงานที่บทบาทเข้าได้ (พบ 2026-09-27: STAFF_ENTRY / STAFF_MOTO กด รถเก่า กับ รถใหม่ แล้ว proxy.ts เด้งกลับเงียบๆ)
export default function PlateSwapCarPage() {
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  const tasks = plateSwapSubtasks("car").filter((task) => roles === null || canAccessPage(task.href, roles));

  return (
    <div className="content">
      <Link href="/registration/plate-swap" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข
      </Link>
      <h1>การสลับเลข · รถยนต์</h1>
      <div className="registration-tasks">
        {tasks.map((task, index) => (
          <Link key={task.href} href={task.href} className="registration-task">
            <span className="task-number">{index + 1}</span>
            <strong>{task.title}</strong>
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
