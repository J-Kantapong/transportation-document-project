// แก้ประเภท/วันที่ส่งตรวจของรถที่ส่งแล้วแต่ยังรอผล (ตาราง "รถที่เพิ่งส่งตรวจ (รอผลตรวจ)") - ต้องระบุเหตุผลที่แก้ทุกครั้ง
// ค่าใช้จ่ายไม่ได้รับจาก client - คิดใหม่จากตารางราคา (ดู VehiclesService.correctInspectionSent)
export interface CorrectInspectionSentDto {
  sentType: unknown; // ส่งตรวจนอก / เอารถมาตรวจเอง
  sentDate: unknown; // วันที่ส่งตรวจ (ค.ศ. YYYY-MM-DD)
  remark: unknown; // เหตุผลที่แก้ - บังคับกรอกทุกครั้ง (เก็บใน VehicleEditLog)
}
