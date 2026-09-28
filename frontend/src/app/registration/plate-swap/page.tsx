import Link from "next/link";

// ผู้ใช้ 2026-09-28: แยกรถยนต์/รถจักรยานยนต์ก่อน แล้วค่อยแตกเป็น รถเก่า กับ รถใหม่ / รถเก่า กับ รถเก่า ในแต่ละประเภท
// (เดิมหน้านี้เป็นเมนู 2 ช่องของรถยนต์ตรงๆ - ย้ายไปที่ /registration/plate-swap/car)
export default function PlateSwapPage() {
  return (
    <div className="content">
      <h1>การสลับเลข</h1>
      <div className="registration-tasks">
        <Link href="/registration/plate-swap/car" className="registration-task">
          <span className="task-number">1</span>
          <strong>รถยนต์</strong>
          <span className="task-arrow" aria-hidden="true">
            →
          </span>
        </Link>
        <Link href="/registration/plate-swap/moto" className="registration-task">
          <span className="task-number">2</span>
          <strong>รถจักรยานยนต์</strong>
          <span className="task-arrow" aria-hidden="true">
            →
          </span>
        </Link>
      </div>
    </div>
  );
}
