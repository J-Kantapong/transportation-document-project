import Link from "next/link";

const SUBMIT_HREF = "/registration/plate-swap/car/old-new/submit";
const RECEIVE_RECEIPT_HREF = "/registration/plate-swap/car/old-new/receive-receipt";
const RECEIVE_PLATE_HREF = "/registration/plate-swap/car/old-new/receive-plate";
const RECEIVE_BOOK_HREF = "/registration/plate-swap/car/old-new/receive-book";

// เมนูงานสลับเลข รถเก่า กับ รถใหม่ (รถยนต์) - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนหน้ายื่นเอกสารรถใหม่)
// ผู้ใช้ 2026-09-28: แยก "รับเอกสารกลับ" เดิมเป็น 3 ขั้นเหมือนฝั่งรถจดใหม่ - รับใบเสร็จ (OCR จริง) / รับป้าย / รับเล่ม
// (ไม่มีขั้นไหนผูกกับกันเอง "งานเสร็จ" ยังตัดสินด้วยรับใบเสร็จอย่างเดียวเหมือนเดิม)
export default function PlateSwapOldNewMenuPage() {
  return (
    <section className="content">
      <Link href="/registration/plate-swap/car" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข · รถยนต์
      </Link>
      <h1>รถเก่า กับ รถใหม่ (รถยนต์)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        รถเก่ากรอกข้อมูลเอง รถใหม่ลิงก์จากฐานข้อมูลรถจดใหม่ด้วยเลขตัวถัง
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={SUBMIT_HREF}>
            <strong>ยื่นงานสลับเลข</strong>
            <div className="muted">กรอกรถเก่า ลิงก์รถใหม่ เลือกค่าใช้จ่าย แล้วบันทึกวันที่ยื่น</div>
          </Link>
          <Link href={RECEIVE_RECEIPT_HREF}>
            <strong>รับใบเสร็จ</strong>
            <div className="muted">ถ่ายรูปใบเสร็จแนบ (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ) แล้วยืนยันรับเอกสารกลับ</div>
          </Link>
          <Link href={RECEIVE_PLATE_HREF}>
            <strong>รับป้าย</strong>
            <div className="muted">แนบรูปป้ายทะเบียนที่ได้รับ</div>
          </Link>
          <Link href={RECEIVE_BOOK_HREF}>
            <strong>รับเล่ม</strong>
            <div className="muted">แนบรูปเล่มทะเบียนที่ได้รับ</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
