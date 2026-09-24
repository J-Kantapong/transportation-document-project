import type { ReceiptDuplicate } from "@/lib/api";
import { isoToDisplayDate } from "@/lib/date";

// ข้อความเตือนใบเสร็จซ้ำ (จากข้อมูลที่ AI อ่าน - เตือนอย่างเดียว เพราะ AI อ่านผิดได้) ดู ReceiptsService.findDuplicate
export function receiptDuplicateText(d: ReceiptDuplicate): string {
  const received = d.receivedDate ? ` · รับใบเสร็จแล้ว ${isoToDisplayDate(d.receivedDate)}` : "";
  if (d.by === "receiptNo") {
    return `ใบเสร็จเลขที่ ${d.receiptNo} อัพโหลดไปแล้ว${d.chassis ? ` (รถ ${d.chassis})` : ""}${received} - ถ้าเป็นใบเดิมให้ลบรูปนี้`;
  }
  return `รถ ${d.chassis} มีใบเสร็จแล้ว${d.receiptNo ? ` (เลขที่ ${d.receiptNo})` : ""}${received} - ถ้าเป็นใบเดิมให้ลบรูปนี้`;
}
