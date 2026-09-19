// ค่าใช้จ่ายไม่ได้รับจาก client - ผ่าน = ราคาตอนส่งตรวจ, ไม่ผ่าน = 0 (ดู VehiclesService.updateInspectionResult)
export interface UpdateInspectionResultDto {
  result: unknown;
  resultDate: unknown;
  remark: unknown; // เหตุผลที่ตรวจไม่ผ่าน - บังคับกรอกเมื่อ result = 'ไม่ผ่าน'
}
