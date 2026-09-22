"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { NEW_VEHICLE_SUBTASKS } from "@/lib/categories";
import { type UserRole, canAccessPage, getCachedUser } from "@/lib/auth";

// แสดงเฉพาะขั้นตอนที่บทบาทเข้าได้ (ผู้ใช้ 2026-09-22: STAFF_ENTRY ขั้น 1-3 / STAFF_CAR, STAFF_MOTO ขั้น 4-8) - กฎอยู่ใน lib/auth.ts
export default function NewVehicleRegistrationPage() {
  const [roles, setRoles] = useState<UserRole[] | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- อ่าน localStorage หลัง mount
    setRoles(getCachedUser()?.roles ?? []);
  }, []);

  const tasks = NEW_VEHICLE_SUBTASKS.map((task, index) => ({ ...task, number: index + 1 })).filter(
    (task) => roles === null || canAccessPage(task.href, roles),
  );

  return (
    <div className="content">
      <h1>จดทะเบียนรถใหม่</h1>
      <div className="registration-tasks">
        {tasks.map((task) => (
          <Link key={task.href} href={task.href} className="registration-task">
            <span className="task-number">{task.number}</span>
            <strong>{task.title}</strong>
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
      {/* เครื่องมือค้นรูป (ไม่ใช่ขั้นตอนงาน) - ผู้ใช้ 2026-09-22: ค้นใบเสร็จ/ป้าย/เล่ม ของรถด้วยเลขตัวถังในระบบ */}
      {(roles === null || canAccessPage("/registration/new-vehicle/receive-receipt", roles)) && (
        <p style={{ marginTop: 18 }}>
          <Link href="/registration/new-vehicle/photos" className="text-button">
            ค้นหารูปตามเลขตัวถัง →
          </Link>
        </p>
      )}
    </div>
  );
}
