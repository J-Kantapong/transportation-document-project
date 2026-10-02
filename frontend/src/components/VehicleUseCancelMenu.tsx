import Link from "next/link";
import type { CancellationVehicleClass } from "@/lib/vehicle-use-cancel-api";

const CLASS_SEGMENT: Record<CancellationVehicleClass, string> = { CAR: "car", MOTO: "moto" };
const CLASS_LABEL: Record<CancellationVehicleClass, string> = { CAR: "รถยนต์", MOTO: "รถจักรยานยนต์" };

// เมนูงานยกเลิกการใช้รถของประเภทรถหนึ่ง - แยก URL ให้กด back ของเบราว์เซอร์ได้ (เหมือนเมนูสลับเลข)
export function VehicleUseCancelMenu({ vehicleClass }: { vehicleClass: CancellationVehicleClass }) {
  const base = `/registration/other/cancel-use/${CLASS_SEGMENT[vehicleClass]}`;
  return (
    <section className="content">
      <Link href="/registration/other/cancel-use" className="text-button" style={{ marginBottom: 18, display: "inline-block" }}>
        ← ยกเลิกการใช้รถ
      </Link>
      <h1>ยกเลิกการใช้รถ ({CLASS_LABEL[vehicleClass]})</h1>
      <p className="muted" style={{ marginBottom: 20 }}>
        กรอกข้อมูลรถเหมือนงานสลับเลข (ไม่มีทะเบียนใหม่) ค่าใช้จ่ายตายตัว Bill 25 บาท / No Bill 100 บาท / ค่าอากร 10 บาท (แยกต่างหาก)
      </p>
      <section className="panel">
        <div className="choices" style={{ padding: 22 }}>
          <Link href={`${base}/submit`}>
            <strong>ยื่นงานยกเลิกการใช้รถ</strong>
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
