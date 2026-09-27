"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { PLATE_SWAP_SUBTASKS } from "@/lib/categories";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";

// ผู้ใช้ 2026-09-22: แบ่งงานสลับเลขเป็น รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า - ตอนนี้เป็นรถยนต์ก่อน
// แสดงเฉพาะงานที่บทบาทเข้าได้ (พบ 2026-09-27: STAFF_ENTRY / STAFF_MOTO กด รถเก่า กับ รถใหม่ แล้ว proxy.ts เด้งกลับเงียบๆ)
export default function PlateSwapPage() {
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  const tasks = PLATE_SWAP_SUBTASKS.filter((task) => roles === null || canAccessPage(task.href, roles));

  return (
    <div className="content">
      <h1>การสลับเลข</h1>
      <p className="muted">ตอนนี้รองรับรถยนต์ก่อน รถจักรยานยนต์จะเพิ่มภายหลัง</p>
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
