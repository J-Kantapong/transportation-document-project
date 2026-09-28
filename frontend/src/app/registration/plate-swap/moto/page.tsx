import Link from "next/link";
import { plateSwapSubtasks } from "@/lib/categories";

// รถจักรยานยนต์ - ใช้ระบบเดียวกับรถยนต์ทั้ง 2 เคส ต่างที่อัตราค่าใช้จ่ายและค้นรถใหม่เฉพาะ รย.12 (ผู้ใช้ให้อัตรา 2026-09-28)
export default function PlateSwapMotoPage() {
  const tasks = plateSwapSubtasks("moto");

  return (
    <div className="content">
      <Link href="/registration/plate-swap" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข
      </Link>
      <h1>การสลับเลข · รถจักรยานยนต์</h1>
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
