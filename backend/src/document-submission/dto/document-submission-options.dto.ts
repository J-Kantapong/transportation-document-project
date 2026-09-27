export interface DocumentSubmissionOptionsDto {
  plateNumberOption: unknown; // NONE | NORMAL | AUCTION | SWAP_NORMAL | SWAP_AUCTION (มีคนทำสลับเลขมาให้ - รถยนต์เท่านั้น)
  includePlateFee?: unknown;
  newPlateOption?: unknown; // NONE | BLACKWHITE | AUCTION - รถยนต์เท่านั้น
  relocateAddon?: unknown; // รถยนต์เท่านั้น
  stopUseRelocateOut?: unknown; // มอเตอร์ไซค์เท่านั้น
  urgent?: unknown;
}
