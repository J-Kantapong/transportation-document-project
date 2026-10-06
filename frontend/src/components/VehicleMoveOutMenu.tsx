import Link from "next/link";
import type { MoveOutVehicleClass } from "@/lib/vehicle-move-out-api";

const CLASS_SEGMENT: Record<MoveOutVehicleClass, string> = { CAR: "car", MOTO: "moto" };
const CLASS_LABEL: Record<MoveOutVehicleClass, string> = { CAR: "รถยนต์", MOTO: "รถจักรยานยนต์" };

// เมนูงานย้ายออกของประเภทรถหนึ่ง - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนเมนูสลับเลข)
export function VehicleMoveOutMenu({ vehicleClass }: { vehicleClass: MoveOutVehicleClass }) {
  const base = `/registration/other/move-out/${CLASS_SEGMENT[vehicleClass]}`;
  return (
    <section className="content">
      <Link href="/registration/other/move-out" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ย้ายออก
      </Link>
      <h1>ย้ายออก ({CLASS_LABEL[vehicleClass]})</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        เก็บข้อมูลรถเหมือนงานยกเลิกการใช้รถ (ไม่มีทะเบียนใหม่) · มอเตอร์ไซค์: Bill 25 / No Bill ลงขัน 80 (ด่วนเพิ่ม 50) / ค่าอากร 10 (แยกต่างหาก) · รถยนต์ยังไม่มีอัตรา
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={`${base}/submit`}>
            <strong>ยื่นงานย้ายออก</strong>
            <div className="muted">กรอกเจ้าของงาน ข้อมูลรถ แล้วบันทึกวันที่ยื่น</div>
          </Link>
          <Link href={`${base}/return`}>
            <strong>รับใบเสร็จ</strong>
            <div className="muted">ถ่ายรูปใบเสร็จแนบ (อ่านเลขที่/วันที่/ยอดเงินให้อัตโนมัติ) แล้วยืนยันรับเอกสารกลับ</div>
          </Link>
        </div>
      </section>
    </section>
  );
}
