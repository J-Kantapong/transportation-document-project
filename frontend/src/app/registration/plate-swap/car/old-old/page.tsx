import Link from "next/link";

const SUBMIT_HREF = "/registration/plate-swap/car/old-old/submit";
const RECEIVE_RECEIPT_HREF = "/registration/plate-swap/car/old-old/receive-receipt";
const RECEIVE_PLATE_HREF = "/registration/plate-swap/car/old-old/receive-plate";
const RECEIVE_BOOK_HREF = "/registration/plate-swap/car/old-old/receive-book";

// เมนูงานสลับเลข รถเก่า กับ รถเก่า (รถยนต์) - ผู้ใช้ให้กฎ 2026-09-28: โครงเดียวกับเคสรถเก่า-รถใหม่
// ต่างกันที่หน้ายื่นกรอก 2 คันในหน้าเดียว (ไม่ลิงก์ฐานข้อมูลรถจดใหม่ เพราะทั้งคู่เป็นรถเก่า)
// แล้วระบบแยกเก็บเป็น 2 งาน คันละงาน ซึ่งเดินขั้นรับใบเสร็จ/รับป้าย/รับเล่ม ของตัวเองแยกกัน
export default function PlateSwapOldOldMenuPage() {
  return (
    <section className="content">
      <Link href="/registration/plate-swap/car" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข · รถยนต์
      </Link>
      <h1>รถเก่า กับ รถเก่า (รถยนต์)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        กรอกรถทั้ง 2 คันในหน้าเดียว ระบบสลับทะเบียนให้และแยกเป็น 2 งาน
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={SUBMIT_HREF}>
            <strong>ยื่นงานสลับเลข</strong>
            <div className="muted">กรอกรถ 2 คัน เลือกค่าใช้จ่าย แล้วบันทึกวันที่ยื่น (ได้ 2 งาน)</div>
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
