// ป้ายวันคาดรับเงินของบิลรอรับเงิน (ผู้ใช้ 2026-10-31 / 2026-11-01: ใช้ทั้งหน้าวางบิลและหน้าใบกำกับภาษี)
// เลยวันคาดรับเงิน (Invoice.dueDate จากรอบจ่าย / เครดิตของลูกค้า) = แดง "น่าจะได้แล้ว เช็กแล้วกดรับเงิน", วันนี้ / ภายใน 7 วัน = เหลือง
export function invoiceDueDays(dueDate: string | null | undefined, today: string): number | null {
  if (!dueDate) return null;
  return Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

export function InvoiceDueBadge({ status, dueDate, today }: { status: string; dueDate: string | null | undefined; today: string }) {
  if (status !== "ISSUED") return null;
  const days = invoiceDueDays(dueDate, today);
  if (days === null) return null;
  if (days < 0) {
    return (
      <span className="badge" style={{ background: "#fde8e8", color: "#b43434" }} title="เลยวันที่ลูกค้าปกติจ่ายแล้ว - เช็ก statement ว่าได้รับแล้วแต่ยังไม่ลง หรือตามลูกค้า">
        เลยวันคาดรับเงิน {-days} วัน - เช็กว่าได้รับแล้ว?
      </span>
    );
  }
  if (days === 0) return <span className="badge warn">คาดรับเงินวันนี้</span>;
  if (days <= 7) return <span className="badge warn">คาดรับเงินใน {days} วัน</span>;
  return null;
}
