import Link from "next/link";
import { TRANSFER_TYPES } from "@/lib/categories";

// งานโอน (ผู้ใช้ 2026-10-02): เลือกแบบงานก่อน - โอนตามผู้ถือกรรมสิทธิ์ / โอนตรวจรถ / โอนย้ายเข้า (2026-11-18)
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
      {/* ลงขันรายจังหวัด (ผู้ใช้ 2026-11-18) - ค่าตั้งต้นของช่องลงขันในฟอร์มงานโอน ADMIN กรอก/แก้ คนอื่นดูได้ */}
      <p style={{ marginTop: 22 }}>
        <Link href="/registration/transfer/contribution-rates" className="text-button">
          ⚙ ลงขันงานโอนรายจังหวัด (77 จังหวัด)
        </Link>
      </p>
    </div>
  );
}
