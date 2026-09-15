import Link from "next/link";

interface EmptyWorkPageProps {
  title: string;
  backHref?: string;
  backLabel?: string;
}

// The prototype leaves these subtasks/categories with a title only, waiting for the user
// to specify the workflow — do not invent fields here.
export function EmptyWorkPage({ title, backHref, backLabel }: EmptyWorkPageProps) {
  return (
    <div className="content">
      {backHref && (
        <Link href={backHref} className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
          ← {backLabel}
        </Link>
      )}
      <h1>{title}</h1>
      <div className="empty-page">ยังไม่มีข้อมูลสำหรับหัวข้อนี้ รอรายละเอียดเพิ่มเติมจากผู้ใช้</div>
    </div>
  );
}
