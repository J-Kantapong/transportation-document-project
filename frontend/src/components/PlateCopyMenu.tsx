import Link from "next/link";

const BASE = "/registration/other/plate-copy";

// เมนูงานคัดแผ่นป้ายทะเบียน (รถยนต์) - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนเมนูสลับเลข / ยกเลิกการใช้รถ)
export function PlateCopyMenu() {
  return (
    <section className="content">
      <Link href="/registration/other" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← อื่นๆ
      </Link>
      <h1>คัดแผ่นป้ายทะเบียน (รถยนต์)</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        กรอกข้อมูลรถเหมือนงานยกเลิกการใช้รถ ค่าใช้จ่ายตายตัว Bill 205 บาท / No Bill 100 บาท / ค่าอากร 10 บาท (แยกต่างหาก) แล้วรับป้ายกลับมาด้วย
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={`${BASE}/submit`}>
            <strong>ยื่นงานคัดแผ่นป้ายทะเบียน</strong>
            <div className="muted">กรอกเจ้าของงาน ข้อมูลรถ แล้วบันทึกวันที่ยื่น</div>
          </Link>
          <Link href={`${BASE}/return`}>
            <strong>รับใบเสร็จ</strong>
            <div className="muted">ถ่ายรูปใบเสร็จแนบ (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ) แล้วยืนยันรับเอกสารกลับ</div>
          </Link>
          <Link href={`${BASE}/receive-plate`}>
            <strong>รับป้าย</strong>
            <div className="muted">ถ่ายรูปป้ายที่ได้รับในการ์ดยืนยันรับป้าย (ปกติป้ายออกภายใน 15 วัน)</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
