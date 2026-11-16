export interface DocumentSubmissionOptionsDto {
  plateNumberOption: unknown; // NONE | NORMAL | AUCTION | SWAP_NORMAL | SWAP_AUCTION (มีคนทำสลับเลขมาให้ - รถยนต์เท่านั้น)
  includePlateFee?: unknown;
  newPlateOption?: unknown; // NONE | BLACKWHITE | AUCTION - รถยนต์เท่านั้น
  relocateAddon?: unknown; // รถยนต์เท่านั้น
  stopUseRelocateOut?: unknown; // มอเตอร์ไซค์เท่านั้น
  urgent?: unknown;
  taxExempt?: unknown; // รถยกเว้นภาษี - ไม่มีค่าคำขอ/ค่าตรวจสภาพ/ค่าคู่มือ ภาษี 0
  supplierInspection?: unknown; // รถส่งซับ: false = ซับไม่ได้นำรถเข้าตรวจ (ค่านำรถเข้าตรวจ 0) ไม่ส่ง = true
}
