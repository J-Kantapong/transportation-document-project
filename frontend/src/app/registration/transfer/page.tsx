import Link from "next/link";
import { TRANSFER_TYPES } from "@/lib/categories";

// งานโอน (ผู้ใช้ 2026-10-02): เลือกแบบงานก่อน - โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ
export default function TransferPage() {
  return (
    <div className="content">
      <h1>งานโอน</h1>
      <div className="registration-tasks">
        {TRANSFER_TYPES.map((type, index) => (
          <Link key={type.href} href={type.href} className="registration-task">
            <span className="task-number">{index + 1}</span>
            <strong>{type.title}</strong>
            <span className="task-arrow" aria-hidden="true">
              →
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
