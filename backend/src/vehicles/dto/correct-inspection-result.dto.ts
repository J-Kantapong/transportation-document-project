// แก้ไขผลตรวจที่บันทึกไปแล้ว (รายการในตาราง "รายการรถที่ตรวจเสร็จเรียบร้อย") - ต้องระบุเหตุผลที่แก้ทุกครั้ง
// ค่าใช้จ่ายไม่ได้รับจาก client - ผ่าน = ราคาตอนส่งตรวจ, ไม่ผ่าน = 0 (ดู VehiclesService.correctInspectionResult)
export interface CorrectInspectionResultDto {
  result: unknown; // ผลตรวจใหม่ - ผ่าน / ไม่ผ่าน (ล้างผลตรวจทิ้งไม่ได้)
  resultDate: unknown; // วันที่ทราบผล (ค.ศ. YYYY-MM-DD)
  failRemark: unknown; // เหตุผลที่ตรวจไม่ผ่าน - บังคับกรอกเมื่อ result = 'ไม่ผ่าน'
  remark: unknown; // เหตุผลที่แก้ไข - บังคับกรอกทุกครั้ง (เก็บใน VehicleEditLog)
}
