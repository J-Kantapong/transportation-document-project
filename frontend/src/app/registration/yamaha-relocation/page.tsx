import Link from "next/link";
import { YAMAHA_RELOCATION_SUBTASKS } from "@/lib/categories";

export default function YamahaRelocationPage() {
  return (
    <div className="content">
      <h1>งานแจ้งย้ายยามาฮ่า</h1>
      <div className="registration-tasks">
        {YAMAHA_RELOCATION_SUBTASKS.map((task, index) => (
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
