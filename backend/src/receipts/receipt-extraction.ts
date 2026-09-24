import { z } from 'zod';

// ข้อมูลที่ AI อ่านจากใบเสร็จรับเงินกรมการขนส่งทางบก - รูปแบบจากใบเสร็จจริงของผู้ใช้ (2026-09-20)
// เก็บใน ReceiptImage.extraction พร้อม checks (ตรวจอัตโนมัติแบบตายตัว ไม่ใช้ AI) ให้หน้าเว็บเน้นช่องที่ต้องให้คนเช็ก
export const RECEIPT_FIELDS = ['receiptNo', 'date', 'plate', 'chassis', 'weightKg', 'items', 'total'] as const;
export type ReceiptField = (typeof RECEIPT_FIELDS)[number];

export const ReceiptReadingSchema = z.object({
  receiptNo: z.string().nullable(),
  date: z.string().nullable(), // ค.ศ. YYYY-MM-DD (ใบเสร็จพิมพ์เป็น พ.ศ.)
  plateCategory: z.string().nullable(), // หมวด เช่น "8ขก"
  plateNumber: z.string().nullable(), // เลข เช่น "3484"
  chassis: z.string().nullable(),
  weightKg: z.number().nullable(),
  items: z.array(z.object({ label: z.string(), amount: z.number() })),
  total: z.number().nullable(),
  // ช่องที่ AI เองไม่มั่นใจ - รับเป็นข้อความอิสระแล้วค่อยกรองด้วย normalizeUncertainFields
  // เคยใช้ z.enum(RECEIPT_FIELDS) แล้วพบว่า AI ตอบชื่อช่องตาม schema (plateCategory/plateNumber) ซึ่งไม่อยู่ในลิสต์
  // ทำให้ผลทั้งใบถูกทิ้งทั้งที่ช่องอื่นอ่านถูกหมด - ชื่อช่องที่ไม่รู้จักไม่ควรทำให้เสียทั้งใบ
  uncertainFields: z.array(z.string()),
});

export type ReceiptReading = z.infer<typeof ReceiptReadingSchema>;

// ชื่อที่ AI เรียกไม่ตรงกับที่หน้าเว็บใช้ -> จับคู่ให้; ชื่อที่ไม่รู้จักทิ้งไป
const UNCERTAIN_ALIASES: Record<string, ReceiptField> = {
  platecategory: 'plate',
  platenumber: 'plate',
  licenseplate: 'plate',
  receiptnumber: 'receiptNo',
  chassisnumber: 'chassis',
  vin: 'chassis',
  weight: 'weightKg',
  item: 'items',
};

// เหลือเฉพาะชื่อช่องที่ needsCheck() ในหน้าเว็บรู้จัก (plate / total / items / chassis / ...) ไม่ซ้ำ
export function normalizeUncertainFields(raw: string[]): ReceiptField[] {
  const out = new Set<ReceiptField>();
  for (const value of raw) {
    const key = value.trim().toLowerCase();
    const known = RECEIPT_FIELDS.find((f) => f.toLowerCase() === key) ?? UNCERTAIN_ALIASES[key];
    if (known) out.add(known);
  }
  return [...out];
}

// ใบเสร็จกรมขนส่งพิมพ์วันที่เป็น พ.ศ. (เช่น 23 กันยายน 2569) - prompt สั่งให้ AI แปลงเป็น ค.ศ. แล้ว
// แต่กันไว้อีกชั้น: ปีตั้งแต่ 2400 ถือเป็น พ.ศ. ลบ 543 · รูปแบบผิดหรือวันที่ไม่มีจริง = null (ให้คนกรอกตามรูป)
export function normalizeReceiptDate(raw: string | null): string | null {
  const match = raw ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim()) : null;
  if (!match) return null;
  const year = Number(match[1]) >= 2400 ? Number(match[1]) - 543 : Number(match[1]);
  const iso = `${year}-${match[2]}-${match[3]}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

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

// เลขตัวถังที่ AI อ่านเพี้ยนเล็กน้อยแต่น่าจะเป็นรถคันเดียวกัน (ผู้ใช้เลือก 2026-09-24 จากเคส METZT... อ่านจาก MLTZT...)
// - เลขท้าย 6 ตัว (เลขลำดับรถ) ต้องตรงเป๊ะ: รถล็อตเดียวกันเลขตัวถังเรียงกัน (...960, ...961) อ่านผิดตรงนี้ = คนละคัน
// - 11 ตัวแรก (รหัสผู้ผลิต/รุ่น ซึ่งทั้งล็อตเหมือนกัน) ต่างกันได้ไม่เกิน 2 ตัว
export const CHASSIS_SERIAL_LENGTH = 6;
const CHASSIS_PREFIX_MAX_DIFF = 2;

export function isNearChassis(read: string, actual: string): boolean {
  const a = read.trim().toUpperCase();
  const b = actual.trim().toUpperCase();
  if (a.length !== 17 || b.length !== 17 || a === b) return false;
  const prefix = 17 - CHASSIS_SERIAL_LENGTH;
  if (a.slice(prefix) !== b.slice(prefix)) return false;
  let diff = 0;
  for (let i = 0; i < prefix; i++) if (a[i] !== b[i]) diff++;
  return diff <= CHASSIS_PREFIX_MAX_DIFF;
}

export const RECEIPT_READING_PROMPT = `รูปนี้คือใบเสร็จรับเงินของกรมการขนส่งทางบก (รถ 1 คันต่อ 1 ใบ) อ่านข้อมูลตามที่พิมพ์ไว้จริง:
- receiptNo: เลขหลังคำว่า "เลขที่" มุมขวาบน (รูปแบบเช่น 69/0035358) ไม่ใช่เลขตัวใหญ่ที่ขึ้นต้นด้วย C มุมซ้ายบน
- date: วันที่หลังคำว่า "วันที่" แปลงจาก พ.ศ. เป็น ค.ศ. (ลบ 543) รูปแบบ YYYY-MM-DD
- plateCategory / plateNumber: ค่าหลัง "เลขทะเบียน" แยกหมวด (เช่น 8ขก) กับตัวเลข (เช่น 3484) อ่านพยัญชนะไทยทีละตัวอย่างระวัง
- chassis: เลขตัวถัง 17 ตัวอักษร พิมพ์ใกล้ท้ายใบ บรรทัดเดียวกับเวลา (เช่น 08:47:25) อ่านทุกตัวอย่างระวัง โดยเฉพาะเลข 0
- weightKg: ตัวเลขหลัง "น้ำหนักรถ"
- items: ทุกรายการค่าใช้จ่ายระหว่างข้อมูลรถกับยอดรวม ตามลำดับที่พิมพ์
- total: ยอดหลัง "รวมเป็นเงินทั้งสิ้น"
ช่องไหนอ่านไม่ออกให้ใส่ null ห้ามเดา ช่องไหนอ่านได้แต่ไม่มั่นใจ (ตัวอักษรเลือน/ถูกตราประทับหรือลายเซ็นทับ) ให้ใส่ชื่อช่องใน uncertainFields โดยใช้ชื่อจากลิสต์นี้เท่านั้น: receiptNo, date, plate, chassis, weightKg, items, total (ทะเบียนไม่ว่าหมวดหรือตัวเลขใช้ plate)`;
