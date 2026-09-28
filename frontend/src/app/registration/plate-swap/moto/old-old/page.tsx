import Link from "next/link";

const SUBMIT_HREF = "/registration/plate-swap/moto/old-old/submit";
const RECEIVE_RECEIPT_HREF = "/registration/plate-swap/moto/old-old/receive-receipt";
const RECEIVE_PLATE_HREF = "/registration/plate-swap/moto/old-old/receive-plate";
const RECEIVE_BOOK_HREF = "/registration/plate-swap/moto/old-old/receive-book";

// เมนูงานสลับเลข รถเก่า กับ รถเก่า (มอเตอร์ไซค์) - โครงเดียวกับฝั่งรถยนต์ทุกอย่าง ต่างที่อัตราค่าใช้จ่าย (ผู้ใช้ 2026-09-28)
export default function PlateSwapMotoOldOldMenuPage() {
  return (
    <section className="content">
      <Link href="/registration/plate-swap/moto" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข · มอเตอร์ไซค์
      </Link>
      <h1>รถเก่า กับ รถเก่า (มอเตอร์ไซค์)</h1>
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
