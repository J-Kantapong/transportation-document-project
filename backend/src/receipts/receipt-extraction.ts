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

const PLATE_CATEGORY = /^\d?[ก-ฮ]{1,2}$/;
const PLATE_NUMBER = /^\d{1,4}$/;

// AI แยกหมวด/เลขทะเบียนผิดที่ (เคสจริง 2026-09-28 รถจักรยานยนต์ 3 ใบ: หมวด "12" เลข "2ฆน 4544") -> ต่อสองช่องแล้วหา
// รูปแบบทะเบียน (เลขนำ 0-1 หลัก + พยัญชนะ 1-2 ตัว + เลข 1-4 หลัก) ใหม่ · ต้องไม่ติดกับอักษรไทย (รวมสระ/วรรณยุกต์) หรือตัวเลข
// ทั้งหน้าและหลัง ไม่งั้นท้ายชื่อจังหวัด ("สมุทรปราการ 8ขก" -> "ร 8") หรือหมวดที่ซ้ำ ("8ขก 8ขก 3484" -> "8ขก 8") ถูกนับเป็นทะเบียน
// เจอแบบเดียวและเลขไม่มีต่อหลังช่องว่าง ("8ขก3 484") = ใช้ค่านั้น ไม่งั้นคงค่าเดิมให้ checkReading เตือน - ค่าผิดที่ดูถูกรูปแบบแย่กว่าไม่แก้
const PLATE_IN_TEXT = /(?<![฀-๿\d])(\d?[ก-ฮ]{1,2}) ?(\d{1,4})(?![฀-๿\d,.])/g;

export function normalizePlate(category: string | null, number: string | null): { plateCategory: string | null; plateNumber: string | null } {
  const cat = category?.replace(/\s+/g, '') || null;
  const num = number?.replace(/\s+/g, '') || null;
  if ((cat === null || PLATE_CATEGORY.test(cat)) && (num === null || PLATE_NUMBER.test(num))) return { plateCategory: cat, plateNumber: num };
  const text = `${category ?? ''} ${number ?? ''}`.replace(/[\s-]+/g, ' ');
  const found = [...text.matchAll(PLATE_IN_TEXT)];
  const only = found.length === 1 ? found[0] : null;
  if (!only || /^ \d/.test(text.slice(only.index + only[0].length))) return { plateCategory: cat, plateNumber: num };
  return { plateCategory: only[1], plateNumber: only[2] };
}

// เลขตัวถังที่ AI อ่าน: ตัวใหญ่ ไม่มีช่องว่าง/ขีด (เทียบกับเลขในระบบได้ตรง) - ไม่แก้ตัวอักษร ให้ checkReading เตือนเองถ้ามี I O Q
export const normalizeChassis = (raw: string | null): string | null => raw?.replace(/[\s-]/g, '').toUpperCase() || null;

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
    plateValid: PLATE_CATEGORY.test(r.plateCategory ?? '') && PLATE_NUMBER.test(r.plateNumber ?? ''),
    itemsSumMatchesTotal: r.total !== null && sum === r.total,
  };
}

// เลขตัวถังที่ AI อ่านเพี้ยนเล็กน้อยแต่น่าจะเป็นรถคันเดียวกัน (ผู้ใช้เลือก 2026-09-24 จากเคส METZT... อ่านจาก MLTZT...)
// - เลขท้าย 6 ตัว (เลขลำดับรถ) ต้องตรงเป๊ะ: รถล็อตเดียวกันเลขตัวถังเรียงกัน (...960, ...961) อ่านผิดตรงนี้ = คนละคัน
// - 11 ตัวแรก (รหัสผู้ผลิต/รุ่น ซึ่งทั้งล็อตเหมือนกัน) ต่างกันได้ไม่เกิน 2 ตัว
// อ่านได้ 16 หรือ 18 ตัว (ผู้ใช้เลือก 2026-09-28 จากเคสจริง 3 ใบ: ...T2002196 อ่านเป็น ...T200196, 11 อ่านเป็น H, ตัวท้ายหาย)
// = ตัวหาย/เกินได้ 1 ตัว (ตรงไหนก็ได้) + 11 ตัวแรกผิดได้อีกไม่เกิน 1 ตัว · ส่วนที่เหลือของเลขท้ายยังต้องตรงเป๊ะ
// ตัวหายทำให้รู้เลขท้ายไม่ครบ (...796 ใกล้ทั้ง ...7960 และ ...7961) ผู้เรียกจึงต้องแนบให้เฉพาะเมื่อใกล้เคียงแค่คันเดียว
export const CHASSIS_SERIAL_LENGTH = 6;
export const CHASSIS_LENGTH = 17;
export const CHASSIS_PREFIX = CHASSIS_LENGTH - CHASSIS_SERIAL_LENGTH;
const CHASSIS_PREFIX_MAX_DIFF = 2;

// เทียบทีละตัว: ต่างกันได้เฉพาะตำแหน่ง (ของเลขในระบบ) ที่อยู่ใน 11 ตัวแรก ไม่เกิน maxDiff ตัว
function prefixOnlyDiff(read: string, actual: string, actualIndex: (i: number) => number, maxDiff: number): boolean {
  let diff = 0;
  for (let i = 0; i < read.length; i++) {
    if (read[i] === actual[i]) continue;
    if (actualIndex(i) >= CHASSIS_PREFIX || ++diff > maxDiff) return false;
  }
  return true;
}

export function isNearChassis(read: string, actual: string): boolean {
  const a = read.trim().toUpperCase();
  const b = actual.trim().toUpperCase();
  if (b.length !== CHASSIS_LENGTH || a === b) return false;
  if (a.length === CHASSIS_LENGTH) return prefixOnlyDiff(a, b, (i) => i, CHASSIS_PREFIX_MAX_DIFF);
  // ตัวหาย 1 ตัว: ลองตัดทีละตำแหน่งของเลขในระบบ
  if (a.length === CHASSIS_LENGTH - 1) {
    for (let k = 0; k < CHASSIS_LENGTH; k++) {
      if (prefixOnlyDiff(a, b.slice(0, k) + b.slice(k + 1), (i) => (i < k ? i : i + 1), CHASSIS_PREFIX_MAX_DIFF - 1)) return true;
    }
    return false;
  }
  // ตัวเกิน 1 ตัว: ลองตัดทีละตำแหน่งของที่อ่านได้
  if (a.length === CHASSIS_LENGTH + 1) {
    for (let k = 0; k <= CHASSIS_LENGTH; k++) {
      if (prefixOnlyDiff(a.slice(0, k) + a.slice(k + 1), b, (i) => i, CHASSIS_PREFIX_MAX_DIFF - 1)) return true;
    }
  }
  return false;
}

export const RECEIPT_READING_PROMPT = `รูปนี้คือใบเสร็จรับเงินของกรมการขนส่งทางบก (รถ 1 คันต่อ 1 ใบ) อ่านข้อมูลตามที่พิมพ์ไว้จริง:
- receiptNo: เลขหลังคำว่า "เลขที่" มุมขวาบน (รูปแบบเช่น 69/0035358) ไม่ใช่เลขตัวใหญ่ที่ขึ้นต้นด้วย C มุมซ้ายบน
- date: วันที่หลังคำว่า "วันที่" แปลงจาก พ.ศ. เป็น ค.ศ. (ลบ 543) รูปแบบ YYYY-MM-DD
- plateCategory / plateNumber: ค่าหลัง "เลขทะเบียน" แยกเป็น 2 ช่อง
  - plateCategory = หมวด: เลขนำหน้า 1 หลัก (ถ้ามี) ตามด้วยพยัญชนะไทย 1-2 ตัว เช่น 8ขก, 2ฆน, กข
  - plateNumber = ตัวเลขล้วน 1-4 หลัก เช่น 3484
  - รถจักรยานยนต์ใช้รูปแบบเดียวกัน เช่น 2ฆน 4544 -> plateCategory "2ฆน", plateNumber "4544"
  - ห้ามใส่ตัวเลขอื่นที่พิมพ์อยู่หน้าทะเบียน (เช่น 12) ชื่อจังหวัด หรือช่องว่าง และห้ามรวมหมวดไว้ใน plateNumber
  - อ่านพยัญชนะไทยทีละตัวอย่างระวัง โดยเฉพาะตัวที่หน้าตาคล้ายกัน: ฆ ฒ ฌ, ข ช ซ, ค ด ต, ถ ภ, บ ป ษ, พ ฟ, ผ ฝ, ม น, ศ ส
- chassis: เลขตัวถัง 17 ตัวอักษร พิมพ์ใกล้ท้ายใบ บรรทัดเดียวกับเวลา (เช่น 08:47:25) อ่านทุกตัวอย่างระวัง
  - นับจำนวนตัว ถ้าได้ 16 หรือ 18 ให้อ่านใหม่ทีละตัว ตัวที่มักหายหรือเกินคือเลขที่ซ้ำติดกัน (เช่น 00, 11, 22) และ 11 ที่ดูเหมือนตัว H
  - อ่านใหม่แล้วยังไม่ครบ 17 ให้ตอบตามที่เห็นจริงแล้วใส่ chassis ใน uncertainFields ห้ามเติมหรือตัดตัวอักษรเองเพื่อให้ครบ 17
  - เลขตัวถังไม่มีตัว I O Q ระวังตัวที่คล้ายกัน เช่น 0 D, 1 I, 8 B, 5 S, 2 Z, T F, L E
  - ถ้าไม่มั่นใจแม้แต่ตัวเดียว ให้ใส่ chassis ใน uncertainFields
- weightKg: ตัวเลขหลัง "น้ำหนักรถ"
- items: ทุกรายการค่าใช้จ่ายระหว่างข้อมูลรถกับยอดรวม ตามลำดับที่พิมพ์
- total: ยอดหลัง "รวมเป็นเงินทั้งสิ้น"
ช่องไหนอ่านไม่ออกให้ใส่ null ห้ามเดา ช่องไหนอ่านได้แต่ไม่มั่นใจ (ตัวอักษรเลือน/ถูกตราประทับหรือลายเซ็นทับ) ให้ใส่ชื่อช่องใน uncertainFields โดยใช้ชื่อจากลิสต์นี้เท่านั้น: receiptNo, date, plate, chassis, weightKg, items, total (ทะเบียนไม่ว่าหมวดหรือตัวเลขใช้ plate)`;
