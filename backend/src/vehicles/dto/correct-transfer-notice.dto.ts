// แก้/ยกเลิกสถานะแจ้งย้าย/ตัดบัญชีที่ดำเนินการแล้ว (ผู้ใช้ 2026-09-27) - ดู VehiclesService.correctTransferNotice
// ยกเลิกสถานะ (done = false) ได้เฉพาะก่อนส่งตรวจ, แก้วันที่เสร็จ/ค่าใช้จ่ายได้จนกว่าจะยื่นเอกสาร
export interface CorrectTransferNoticeDto {
  done: unknown; // true = ยังดำเนินการแล้ว (แก้วันที่/ค่าใช้จ่าย) / false = ยกเลิกสถานะ รถกลับเข้าคิวต้องดำเนินการ
  completedDate: unknown; // ค.ศ. YYYY-MM-DD - บังคับเมื่อ done = true
  cost: unknown; // ค่าใช้จ่าย (ตัวเลขตั้งแต่ 0) ว่างได้
  remark: unknown; // เหตุผลที่แก้ - บังคับกรอกทุกครั้ง (เก็บใน VehicleEditLog)
  // ค่าที่ dialog แสดงตอนเปิด ✎ แก้ (ผู้ใช้ 2026-09-27 รอบตรวจ) - ไม่ตรงกับในฐานข้อมูล = มีคนแก้ไปก่อน ตอบ 409 ไม่เขียนทับ
  // ไม่ส่งมา (undefined) = ไม่ตรวจ (เรียก API ตรง) - หน้าแจ้งย้าย/ตัดบัญชีส่งทุกครั้ง
  expectedCompletedDate?: unknown; // ค.ศ. YYYY-MM-DD หรือ null (ยังไม่มีวันที่)
  expectedCost?: unknown; // ค่าใช้จ่าย (ตัวเลข) หรือ null - เทียบเป็นตัวเลข ("300" = "300.00")
}
