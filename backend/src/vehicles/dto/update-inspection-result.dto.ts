export interface UpdateInspectionResultDto {
  result: unknown;
  resultDate: unknown;
  cost: unknown;
  remark: unknown; // เหตุผลที่ตรวจไม่ผ่าน - บังคับกรอกเมื่อ result = 'ไม่ผ่าน'
}
