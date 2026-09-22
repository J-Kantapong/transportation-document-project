import Link from "next/link";
import { PLATE_SWAP_SUBTASKS } from "@/lib/categories";

// ผู้ใช้ 2026-09-22: แบ่งงานสลับเลขเป็น รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า - ตอนนี้เป็นรถยนต์ก่อน
export default function PlateSwapPage() {
  return (
    <div className="content">
      <h1>การสลับเลข</h1>
      <p className="muted">ตอนนี้รองรับรถยนต์ก่อน รถจักรยานยนต์จะเพิ่มภายหลัง</p>
      <div className="registration-tasks">
        {PLATE_SWAP_SUBTASKS.map((task, index) => (
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
