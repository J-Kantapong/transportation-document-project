import Link from "next/link";

const SUBMIT_HREF = "/registration/plate-swap/old-new/submit";
const RETURN_HREF = "/registration/plate-swap/old-new/return";

// เมนูงานสลับเลข รถเก่า กับ รถใหม่ (รถยนต์) - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนหน้ายื่นเอกสารรถใหม่)
export default function PlateSwapOldNewMenuPage() {
  return (
    <section className="content">
      <Link href="/registration/plate-swap" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← การสลับเลข
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
          <Link href={RETURN_HREF}>
            <strong>รับเอกสารกลับ</strong>
            <div className="muted">ถ่ายรูปใบเสร็จแนบ แล้วบันทึกวันที่รับเอกสารกลับ</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
