import Link from "next/link";
import { PageHeader } from "@/components/ui";

const BASE = "/registration/other/plate-copy";

// เมนูงานคัดแผ่นป้ายทะเบียน (รถยนต์ + มอเตอร์ไซค์ในหน้าเดียวกัน ผู้ใช้ 2026-10-09) - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนเมนูสลับเลข / ยกเลิกการใช้รถ)
export function PlateCopyMenu() {
  return (
    <section className="content">
      <PageHeader
        back={{ href: "/registration/other", label: "อื่นๆ" }}
        title="คัดแผ่นป้ายทะเบียน"
        subtitle="รถยนต์และมอเตอร์ไซค์ กรอกข้อมูลรถเหมือนงานยกเลิกการใช้รถ ค่าใช้จ่ายตายตัวตามประเภทรถ (รถยนต์คัดคู่ปกติ Bill 205 / No Bill 100 · มอเตอร์ไซค์ Bill 105 / No Bill 60 · ค่าอากร 10 บาทแยกต่างหาก) แล้วรับป้ายกลับมาด้วย"
      />
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
            <div className="muted">ถ่ายรูปป้ายที่ได้รับในแถวของงาน (ปกติป้ายออกภายใน 15 วัน)</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
