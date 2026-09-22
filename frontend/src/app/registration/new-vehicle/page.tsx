import Link from "next/link";
import { NEW_VEHICLE_SUBTASKS } from "@/lib/categories";

export default function NewVehicleRegistrationPage() {
  return (
    <div className="content">
      <h1>จดทะเบียนรถใหม่</h1>
      <div className="registration-tasks">
        {NEW_VEHICLE_SUBTASKS.map((task, index) => (
          <Link key={task.href} href={task.href} className="registration-task">
            <span className="task-number">{index + 1}</span>
            <strong>{task.title}</strong>
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
      {/* เครื่องมือค้นรูป (ไม่ใช่ขั้นตอนงาน) - ผู้ใช้ 2026-09-22: ค้นใบเสร็จ/ป้าย/เล่ม ของรถด้วยเลขตัวถังในระบบ */}
      <p style={{ marginTop: 18 }}>
        <Link href="/registration/new-vehicle/photos" className="text-button">
          ค้นหารูปตามเลขตัวถัง →
        </Link>
      </p>
    </div>
  );
}
