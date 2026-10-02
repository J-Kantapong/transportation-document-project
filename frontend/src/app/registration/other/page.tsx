"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { OTHER_SUBTASKS } from "@/lib/categories";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";

// แสดงเฉพาะงานที่บทบาทเข้าได้ (กันกดแล้ว proxy.ts เด้งกลับเงียบๆ เหมือนเมนูสลับเลข)
export default function OtherRegistrationPage() {
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  const tasks = OTHER_SUBTASKS.filter((task) => roles === null || canAccessPage(task.href, roles));

  return (
    <div className="content">
      <h1>อื่นๆ</h1>
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
