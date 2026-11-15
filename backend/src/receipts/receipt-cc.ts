// เทียบขนาด CC บนใบเสร็จกรมขนส่ง (AI อ่าน) กับ CC ที่พนักงานคีย์ในข้อมูลรถ (ผู้ใช้ 2026-11-09: "ในใบเสร็จมี CC อยู่")
// ราคาวางบิลมอเตอร์ไซค์เลือกแถวจาก CC ที่คีย์ ถ้าคีย์ผิดราคาก็ผิดแถว และใบเสร็จมอเตอร์ไซค์จับไม่ได้จากยอดเงิน (ภาษีคงที่)
// จึงใช้ CC ที่พิมพ์บนใบเสร็จเป็นตัวตรวจ - ฟังก์ชันล้วน ใช้ร่วมกันทั้งหน้ารับใบเสร็จและคิววางบิล
// ใบเสร็จถูกเสมอ แต่ยังต้องให้คนกด (AI อ่านผิดได้) - ไม่แก้ข้อมูลรถเอง

// ต่างกันน้อยกว่า 1 cc ถือว่าตรง (ใบเสร็จอาจพิมพ์ปัดเศษ 149.5 -> 150 หรือกลับกัน) · ต่างตั้งแต่ 1 cc = คีย์ผิด
export const RECEIPT_CC_TOLERANCE = 1;

export interface ReceiptWithReading {
  extraction: unknown;
  createdAt?: Date | string;
}

const ccOfExtraction = (extraction: unknown): number | null => {
  if (!extraction || typeof extraction !== 'object' || !('reading' in extraction)) return null;
  const e = extraction as { reading?: { cc?: unknown } | null; match?: unknown };
  if (e.match === 'chassis-mismatch') return null; // ใบเสร็จของคันอื่นที่แนบผิด - ไม่ใช้
  const cc = e.reading?.cc;
  return typeof cc === 'number' && Number.isFinite(cc) && cc > 0 ? cc : null;
};

// CC จากผลอ่านล่าสุดของรถคันนี้ (รูปที่แนบทีหลังถือว่าถูกกว่า เหมือน latestAi ในหน้ารับใบเสร็จ) - null = ไม่มีใบที่อ่าน CC ได้
export function receiptCcOf(receipts: ReceiptWithReading[]): number | null {
  const time = (r: ReceiptWithReading) => (r.createdAt ? new Date(r.createdAt).getTime() : 0);
  const sorted = [...receipts].sort((a, b) => time(b) - time(a));
  for (const r of sorted) {
    const cc = ccOfExtraction(r.extraction);
    if (cc !== null) return cc;
  }
  return null;
}

export function ccDiffers(vehicleCc: number | string | null | undefined, receiptCc: number | null): boolean {
  if (receiptCc === null) return false;
  const v = vehicleCc === null || vehicleCc === undefined || vehicleCc === '' ? NaN : Number(vehicleCc);
  if (!Number.isFinite(v) || v <= 0) return true; // ไม่มี CC ในระบบแต่ใบเสร็จมี = ต้องเติม
  return Math.abs(v - receiptCc) >= RECEIPT_CC_TOLERANCE;
}

// ข้อความเตือนเมื่อ CC ไม่ตรง - null = ตรงหรือเทียบไม่ได้
export function receiptCcMismatch(vehicleCc: number | string | null | undefined, receiptCc: number | null): string | null {
  if (!ccDiffers(vehicleCc, receiptCc)) return null;
  const v = vehicleCc === null || vehicleCc === undefined || vehicleCc === '' ? null : Number(vehicleCc);
  return `CC ในใบเสร็จ ${receiptCc} ไม่ตรงกับที่คีย์ไว้ ${v === null || !Number.isFinite(v) || v <= 0 ? '(ไม่มี)' : v} - ตรวจกับรูปใบเสร็จ`;
}
