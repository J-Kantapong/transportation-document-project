import Link from "next/link";
import { PageHeader } from "@/components/ui";

const SUBMIT_HREF = "/registration/plate-swap/moto/old-new/submit";
const RECEIVE_RECEIPT_HREF = "/registration/plate-swap/moto/old-new/receive-receipt";
const RECEIVE_PLATE_HREF = "/registration/plate-swap/moto/old-new/receive-plate";
const RECEIVE_BOOK_HREF = "/registration/plate-swap/moto/old-new/receive-book";

// เมนูงานสลับเลข รถเก่า กับ รถใหม่ (มอเตอร์ไซค์) - ผู้ใช้ให้อัตรา 2026-09-28 แล้วสั่งว่า
// "ล้อระบบเหมือนสลับเลขของรถยนต์เลย ... แต่แค่เปลี่ยนเป็นลิงก์ข้อมูลเป็นรถจักรยานยนต์แทน"
export default function PlateSwapMotoOldNewMenuPage() {
  return (
    <section className="content">
      <PageHeader
        back={{ href: "/registration/plate-swap/moto", label: "การสลับเลข · มอเตอร์ไซค์" }}
        title="รถเก่า กับ รถใหม่ (มอเตอร์ไซค์)"
        subtitle="รถเก่ากรอกข้อมูลเอง รถใหม่ลิงก์จากฐานข้อมูลรถจดใหม่ด้วยเลขตัวถัง (เฉพาะมอเตอร์ไซค์)"
      />
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
