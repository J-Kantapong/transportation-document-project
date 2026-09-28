import { PlateSwapReturnPage } from "@/components/PlateSwapPages";

// แทนที่หน้า "รับเอกสารกลับ" เดิม (.../old-new/return) - เปลี่ยนชื่อเมนูเป็น "รับใบเสร็จ" (ผู้ใช้ 2026-09-28)
// เนื้อหาหน้าเดิมทุกอย่าง (รูปแบบยืนยันรับเอกสารกลับ) บวกช่องเลขที่ใบเสร็จ/วันที่/ยอดเงินที่อ่าน OCR ให้อัตโนมัติ
export default function PlateSwapReceiveReceiptPage() {
  return <PlateSwapReturnPage />;
}
