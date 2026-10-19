import { isoToDisplayDate } from "./date";

// ลงวันที่ใบกำกับย้อนหลัง (ผู้ใช้ 2026-10-19): ก่อนใบล่าสุดได้เฉพาะเดือนเดียวกันและต้องยืนยัน - ข้ามเดือนไม่ได้
// ตรงกับ takeNumber ใน backend/src/billing/tax-invoice.service.ts (backend ตรวจซ้ำ)
export type BackdateCheck = { kind: "ok" } | { kind: "confirm"; message: string } | { kind: "refuse"; message: string };

export function checkBackdate(last: { taxInvoiceNo: string; issueDate: string } | null | undefined, paidIso: string): BackdateCheck {
  if (!last || paidIso >= last.issueDate) return { kind: "ok" };
  const ref = `${last.taxInvoiceNo} (${isoToDisplayDate(last.issueDate)})`;
  if (last.issueDate.slice(0, 7) !== paidIso.slice(0, 7)) {
    return { kind: "refuse", message: `วันที่ต้องไม่ก่อนเดือนของใบกำกับล่าสุด ${ref} - ลงวันที่ย้อนข้ามเดือนไม่ได้` };
  }
  return {
    kind: "confirm",
    message: `ใบกำกับนี้ลงวันที่ ${isoToDisplayDate(paidIso)} ซึ่งก่อนใบล่าสุด ${ref}\n\nเลขใบกำกับจะไม่เรียงตามวันที่ (เช่น ${last.taxInvoiceNo} ลง ${isoToDisplayDate(last.issueDate)} แต่ใบถัดไปลง ${isoToDisplayDate(paidIso)}) ใช้ได้เมื่อวันที่นี้คือวันที่รับเงินจริงและอยู่เดือนเดียวกัน\n\nยืนยันออกใบ?`,
  };
}
