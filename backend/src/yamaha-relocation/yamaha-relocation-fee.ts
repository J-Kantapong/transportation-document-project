// Fixed per-vehicle rates for งานแจ้งย้ายยามาฮ่า, given directly by the user (not part of
// the vehicleType/brand Fee* matrices): รถเล็ก Bill 5 บาท/คัน, No bill 10 บาท/คัน — รถใหญ่
// Bill 5 บาท/คัน, No bill 20 บาท/คัน.
import { YamahaRelocationSize } from '../generated/prisma/enums.js';

export const YAMAHA_RELOCATION_BILL_RATE = 5;

export const YAMAHA_RELOCATION_NO_BILL_RATE: Record<YamahaRelocationSize, number> = {
  [YamahaRelocationSize.SMALL]: 10,
  [YamahaRelocationSize.LARGE]: 20,
};

export function calculateYamahaRelocationFees(
  size: YamahaRelocationSize,
  count: number,
): { billFee: number; noBillFee: number } {
  return {
    billFee: count * YAMAHA_RELOCATION_BILL_RATE,
    noBillFee: count * YAMAHA_RELOCATION_NO_BILL_RATE[size],
  };
}
