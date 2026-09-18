export interface DocumentSubmissionOptionsDto {
  plateNumberOption: unknown; // NONE | NORMAL | AUCTION
  includePlateFee?: unknown;
  newPlateOption?: unknown; // NONE | BLACKWHITE | AUCTION - รถยนต์เท่านั้น
  relocateAddon?: unknown; // รถยนต์เท่านั้น
  stopUseRelocateOut?: unknown; // มอเตอร์ไซค์เท่านั้น
  urgent?: unknown;
}
