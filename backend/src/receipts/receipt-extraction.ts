import { z } from 'zod';

// ข้อมูลที่ AI อ่านจากใบเสร็จรับเงินกรมการขนส่งทางบก - รูปแบบจากใบเสร็จจริงของผู้ใช้ (2026-09-20)
// เก็บใน ReceiptImage.extraction พร้อม checks (ตรวจอัตโนมัติแบบตายตัว ไม่ใช้ AI) ให้หน้าเว็บเน้นช่องที่ต้องให้คนเช็ก
export const RECEIPT_FIELDS = ['receiptNo', 'date', 'plate', 'chassis', 'weightKg', 'items', 'total'] as const;

export const ReceiptReadingSchema = z.object({
  receiptNo: z.string().nullable(),
  date: z.string().nullable(), // ค.ศ. YYYY-MM-DD (ใบเสร็จพิมพ์เป็น พ.ศ.)
  plateCategory: z.string().nullable(), // หมวด เช่น "8ขก"
  plateNumber: z.string().nullable(), // เลข เช่น "3484"
  chassis: z.string().nullable(),
  weightKg: z.number().nullable(),
  items: z.array(z.object({ label: z.string(), amount: z.number() })),
  total: z.number().nullable(),
  uncertainFields: z.array(z.enum(RECEIPT_FIELDS)), // ช่องที่ AI เองไม่มั่นใจ
});

export type ReceiptReading = z.infer<typeof ReceiptReadingSchema>;

export interface ReceiptChecks {
  chassisValid: boolean; // VIN 17 ตัว ไม่มี I O Q
  receiptNoValid: boolean; // ตัวเลข/ตัวเลข - ไม่ล็อกว่าขึ้นต้น 69 (ผู้ใช้: น่าจะเป็นปี พ.ศ. เปลี่ยนทุกปี)
  plateValid: boolean;
  itemsSumMatchesTotal: boolean;
}

export function checkReading(r: ReceiptReading): ReceiptChecks {
  const sum = Math.round(r.items.reduce((s, it) => s + it.amount, 0) * 100) / 100;
  return {
    chassisValid: /^[A-HJ-NPR-Z0-9]{17}$/.test(r.chassis ?? ''),
    receiptNoValid: /^\d+\/\d+$/.test(r.receiptNo ?? ''),
    plateValid: /^\d?[ก-ฮ]{1,2}$/.test(r.plateCategory ?? '') && /^\d{1,4}$/.test(r.plateNumber ?? ''),
    itemsSumMatchesTotal: r.total !== null && sum === r.total,
  };
}

export const RECEIPT_READING_PROMPT = `รูปนี้คือใบเสร็จรับเงินของกรมการขนส่งทางบก (รถ 1 คันต่อ 1 ใบ) อ่านข้อมูลตามที่พิมพ์ไว้จริง:
- receiptNo: เลขหลังคำว่า "เลขที่" มุมขวาบน (รูปแบบเช่น 69/0035358) ไม่ใช่เลขตัวใหญ่ที่ขึ้นต้นด้วย C มุมซ้ายบน
- date: วันที่หลังคำว่า "วันที่" แปลงจาก พ.ศ. เป็น ค.ศ. (ลบ 543) รูปแบบ YYYY-MM-DD
- plateCategory / plateNumber: ค่าหลัง "เลขทะเบียน" แยกหมวด (เช่น 8ขก) กับตัวเลข (เช่น 3484) อ่านพยัญชนะไทยทีละตัวอย่างระวัง
- chassis: เลขตัวถัง 17 ตัวอักษร พิมพ์ใกล้ท้ายใบ บรรทัดเดียวกับเวลา (เช่น 08:47:25) อ่านทุกตัวอย่างระวัง โดยเฉพาะเลข 0
- weightKg: ตัวเลขหลัง "น้ำหนักรถ"
- items: ทุกรายการค่าใช้จ่ายระหว่างข้อมูลรถกับยอดรวม ตามลำดับที่พิมพ์
- total: ยอดหลัง "รวมเป็นเงินทั้งสิ้น"
ช่องไหนอ่านไม่ออกให้ใส่ null ห้ามเดา ช่องไหนอ่านได้แต่ไม่มั่นใจ (ตัวอักษรเลือน/ถูกตราประทับหรือลายเซ็นทับ) ให้ใส่ชื่อช่องใน uncertainFields`;
