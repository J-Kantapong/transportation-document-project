import Link from "next/link";

const SUBMIT_HREF = "/registration/new-vehicle/submit-documents/submit";
const RECORDS_HREF = "/registration/new-vehicle/submit-documents/records";

// เมนูของขั้นตอนยื่นเอกสาร - ผู้ใช้ 2026-09-22: ปุ่ม "ยื่นเอกสารจดทะเบียนรถ" และ "ดูข้อมูลที่ยื่นแล้ว" ต้องเป็นการเข้าหน้าถัดไป
// (คนละ URL) ให้กด back ของเบราว์เซอร์กลับมาหน้านี้ได้ จึงเป็น Link แทนการสลับ phase ในหน้าเดียว
// ไม่มีร่างที่บันทึกค้างในเครื่องแล้ว (ผู้ใช้ 2026-09-25) - รายการที่เลือกอยู่ระหว่าง 3 ขั้นของการยื่นเท่านั้น
export default function SubmitDocumentsMenuPage() {
  return (
    <section className="content">
      <Link href="/registration/new-vehicle" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← จดทะเบียนรถใหม่
      </Link>
      <h1 tabIndex={-1}>ยื่นเอกสารจดทะเบียนรถใหม่</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        เลือกรถจากคิวที่แจ้งย้าย/ตัดบัญชีและตรวจรถผ่านแล้ว (ผลตรวจมีอายุ 90 วัน) ตรวจทานตัวเลือกและค่าใช้จ่าย แล้วยืนยันยื่นเอกสาร
      </p>

      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={SUBMIT_HREF}>
            <strong>ยื่นเอกสารจดทะเบียนรถ</strong>
            <div className="muted">เลือกรถ → ตรวจทานและตั้งค่า → ยืนยันยื่น</div>
          </Link>
          <Link href={RECORDS_HREF}>
            <strong>ดูข้อมูลที่ยื่นแล้ว</strong>
            <div className="muted">ดูรายการที่ยื่นแล้ว แยกรถยนต์ / มอเตอร์ไซค์ ตามแบบใบส่งงาน และพิมพ์ใบส่งงาน</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
