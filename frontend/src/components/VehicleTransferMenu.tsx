import Link from "next/link";
import { TRANSFER_TYPE_LABEL, transferHasInspection, transferHome, type TransferType } from "@/lib/vehicle-transfer-api";

// เมนูงานโอนของแบบงานหนึ่ง - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนเมนูยกเลิกการใช้รถ)
// โอนตรวจรถมีขั้นตรวจรถคั่นระหว่างยื่นกับรับใบเสร็จ / โอนตามผู้ถือกรรมสิทธิ์ไม่มี
export function VehicleTransferMenu({ transferType }: { transferType: TransferType }) {
  const base = transferHome(transferType);
  return (
    <section className="content">
      <Link href="/registration/transfer" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← งานโอน
      </Link>
      <h1>{TRANSFER_TYPE_LABEL[transferType]}</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        {transferType === "MOVE_IN"
          ? "รถที่ย้ายออกจากจังหวัดเดิมแล้ว มาย้ายเข้าพร้อมโอนและตรวจรถ ป้ายเปลี่ยนเป็นของจังหวัดใหม่ - ตอนนี้มีอัตราเฉพาะรถจักรยานยนต์"
          : "รถยนต์และรถจักรยานยนต์ใช้หน้าเดียวกัน (เลือกประเภทรถในฟอร์ม) ระบุผู้ถือกรรมสิทธิ์ผู้โอนและผู้รับโอนทุกงาน"}
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={`${base}/submit`}>
            <strong>ยื่นงานโอน</strong>
            <div className="muted">
              {transferType === "MOVE_IN" ? "เลือกงานย้ายออกที่ทำไว้ (หรือกรอกเอง) ระบุจังหวัดที่ย้ายเข้า ผู้โอน ผู้รับโอน แล้วบันทึกวันที่ยื่น" : "กรอกเจ้าของงาน ผู้โอน ผู้รับโอน ข้อมูลรถ แล้วบันทึกวันที่ยื่น"}
            </div>
          </Link>
          {transferHasInspection(transferType) && (
            <Link href={`${base}/inspect`}>
              <strong>ตรวจรถ</strong>
              <div className="muted">บันทึกวันที่ส่งตรวจและผลตรวจ (ตรวจผ่านแล้วถึงรับใบเสร็จได้)</div>
            </Link>
          )}
          <Link href={`${base}/return`}>
            <strong>รับใบเสร็จ</strong>
            <div className="muted">
              ถ่ายรูปใบเสร็จแนบ (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ) {transferType === "MOVE_IN" ? "กรอกทะเบียนใหม่และค่าอากรโอน (ถ้ามี) " : ""}แล้วยืนยันรับเอกสารกลับ
            </div>
          </Link>
        </div>
      </section>
    </section>
  );
}
