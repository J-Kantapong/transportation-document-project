import Link from "next/link";

const BASE = "/registration/plate-swap/moto/change";

// เมนูงานเปลี่ยนเลขทะเบียน (รถจักรยานยนต์) - ผู้ใช้ 2026-11-18: ลูกค้าจองเลขในระบบกรมขนส่งแล้วเอามาลงกับรถ 1 คัน
// ทำงานเหมือนสลับเลขแต่ไม่มีรถคู่ ขั้นตอนเดียวกัน: ยื่น -> รับใบเสร็จ -> รับป้าย -> รับเล่ม (แยก URL ให้กด back ได้)
export default function PlateChangeMenuPage() {
  return (
    <section className="content">
      <Link href="/registration/plate-swap/moto" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข · รถจักรยานยนต์
      </Link>
      <h1>เปลี่ยนเลขทะเบียน (รถจักรยานยนต์)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        รถคันเดียวรับเลขที่ลูกค้าจองไว้ ซื้อแผ่นป้ายใหม่ทุกครั้ง
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={`${BASE}/submit`}>
            <strong>ยื่นงานเปลี่ยนเลขทะเบียน</strong>
            <div className="muted">กรอกข้อมูลรถ เลขที่จองไว้ แล้วบันทึกวันที่ยื่น</div>
          </Link>
          <Link href={`${BASE}/receive-receipt`}>
            <strong>รับใบเสร็จ</strong>
            <div className="muted">ถ่ายรูปใบเสร็จแนบ (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ) แล้วยืนยันรับเอกสารกลับ</div>
          </Link>
          <Link href={`${BASE}/receive-plate`}>
            <strong>รับป้าย</strong>
            <div className="muted">แนบรูปป้ายทะเบียนที่ได้รับ</div>
          </Link>
          <Link href={`${BASE}/receive-book`}>
            <strong>รับเล่ม</strong>
            <div className="muted">แนบรูปเล่มทะเบียนที่ได้รับ</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
