// ยกเลิกการส่งตรวจของรถที่ยังรอผล - รถกลับเข้าคิวส่งตรวจ (ดู VehiclesService.cancelInspectionSent)
export interface CancelInspectionSentDto {
  remark: unknown; // เหตุผลที่ยกเลิก - บังคับกรอกทุกครั้ง (เก็บใน VehicleEditLog)
}
