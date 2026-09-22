import { z } from 'zod';
import { normCategory, normNumber, oneSubstitution } from '../plate-photos/plate-reading.js';

// ผลที่ AI อ่านจากรูปเล่มทะเบียน (Step 7 รับเล่มทะเบียน) - รูปเดียวมีได้หลายเล่ม (วางเรียงบนโต๊ะ)
// เหมือนรูปป้าย: AI อ่านแบบไม่เห็นรายชื่อรถที่รออยู่ (ไม่ชี้นำ) แล้วค่อยจับคู่แบบตายตัวด้วย matchBook() ข้างล่าง
// ต่างจากป้าย: ในเล่มมีเลขตัวรถ (VIN) ซึ่งไม่ซ้ำกันเลย จึงจับคู่ด้วย VIN ก่อน ไม่ต้องแยกแท็บรถยนต์/มอเตอร์ไซค์
export const BookReadingSchema = z.object({
  books: z.array(
    z.object({
      chassis: z.string().nullable(), // เลขตัวรถ (VIN) เช่น "MR0HA3CD100123456"
      category: z.string().nullable(), // หมวดทะเบียน เช่น "8ขก"
      number: z.string().nullable(), // เลขทะเบียน เช่น "3484"
      province: z.string().nullable(),
      uncertain: z.boolean(), // AI ไม่มั่นใจตัวอักษร/ตัวเลขบางตัว
    }),
  ),
});

export type BookReading = z.infer<typeof BookReadingSchema>;
export type ReadBook = BookReading['books'][number];

export const BOOK_READING_PROMPT = `รูปนี้ถ่ายสมุดคู่มือจดทะเบียนรถ (เล่มทะเบียน) ของไทยที่เพิ่งได้รับจากกรมการขนส่งทางบก อาจมีเล่มเดียวหรือหลายเล่มในรูปเดียว
ส่วนใหญ่ถ่ายหน้า "รายการจดทะเบียน" ที่มีเลขทะเบียน จังหวัด และเลขตัวรถ บางรูปอาจเป็นหน้าปกที่เขียน/ติดเลขทะเบียนไว้
อ่านเล่มทุกเล่มที่เห็นในรูป เล่มละ 1 รายการ ตามที่พิมพ์ไว้จริง:
- chassis: เลขตัวรถ (เลขตัวถัง/VIN) ตัวอักษรอังกฤษพิมพ์ใหญ่และตัวเลข ไม่มีช่องว่าง เช่น "MR0HA3CD100123456" อ่านทีละตัวอย่างระวัง (0/O/D, 1/I, 8/B, 5/S, 2/Z) ห้ามสับสนกับเลขเครื่องยนต์
- category: หมวดทะเบียน อาจมีตัวเลขนำหน้า เช่น "8ขก", "กข", "1กข" อ่านพยัญชนะไทยทีละตัวอย่างระวัง (ข/ช, ค/ด/ต, ฆ/ม, บ/ป, ผ/ฝ, พ/ฟ, ฎ/ฏ)
- number: เลขทะเบียน 1-4 หลัก เช่น "3484"
- province: จังหวัดของทะเบียน เช่น "กรุงเทพมหานคร" (ไม่เห็นใส่ null)
- uncertain: true ถ้าตัวอักษรหรือตัวเลขบางตัวเลือน ถูกบัง สะท้อนแสง หรือเห็นไม่ชัด
ช่องที่ไม่เห็นในรูปหรืออ่านไม่ออกให้ใส่ null ห้ามเดา ถ้าในรูปไม่มีเล่มทะเบียนเลยให้ตอบ books เป็นลิสต์ว่าง`;

// Vehicle.chassis เก็บตามที่กรอก - เทียบแบบตัวพิมพ์ใหญ่ ไม่มีช่องว่าง/ขีด
export const normChassis = (raw: string | null | undefined) => (raw ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '');

export interface BookCandidate {
  id: string;
  chassis: string;
  plateCategory: string | null;
  plateNumber: string | null;
  registrationProvince: string | null;
}

// exact = เลขตัวรถตรงกับรถที่รอรับเล่ม 1 คัน หรือ (อ่านเลขตัวรถไม่ได้) ทะเบียนตรง 1 คัน -> ติ๊กให้ (พนักงานยังกดยืนยันเอง)
// close = ต่างกัน 1 ตัว / ทะเบียนตรงแต่เลขตัวรถไม่ตรง / ทะเบียนซ้ำหลายคัน -> เสนอให้พนักงานเลือก ไม่ติ๊กให้
// received = ตรงกับรถที่รับเล่มไปแล้ว · none = ไม่พบรถ · unreadable = อ่านได้ทั้งเลขตัวรถและทะเบียนไม่ครบ
export type BookMatchKind = 'exact' | 'close' | 'received' | 'none' | 'unreadable';

export interface BookMatch {
  kind: BookMatchKind;
  vehicleIds: string[]; // exact/received = 1 คัน, close = ตัวเลือก (อาจหลายคัน)
  by: 'chassis' | 'plate' | null; // จับคู่ได้ด้วยอะไร
  // ทะเบียนในเล่มไม่ตรงกับที่บันทึกไว้ตอนรับใบเสร็จ (exact ด้วยเลขตัวรถ) - เตือน และหน้าเว็บไม่ติ๊กให้
  plateMismatch: boolean;
  provinceMismatch: boolean; // จังหวัดในเล่มไม่ตรงกับจังหวัดที่จดทะเบียนของรถ - เตือนอย่างเดียว
}

const noMatch = (kind: BookMatchKind, vehicleIds: string[] = [], by: BookMatch['by'] = null): BookMatch => ({
  kind,
  vehicleIds,
  by,
  plateMismatch: false,
  provinceMismatch: false,
});

// pending = รถที่รอรับเล่ม (ทั้งรถยนต์และมอเตอร์ไซค์), received = รถที่รับเล่มไปแล้วที่อาจตรงกับเล่มนี้
export function matchBook(book: ReadBook, pending: BookCandidate[], received: BookCandidate[]): BookMatch {
  const vin = normChassis(book.chassis);
  const cat = normCategory(book.category);
  const num = normNumber(book.number);
  const hasPlate = Boolean(cat && num);
  if (!vin && !hasPlate) return noMatch('unreadable');

  const bookProvince = book.province?.replace(/\s/g, '');
  const provinceMismatch = (v: BookCandidate) =>
    Boolean(bookProvince && v.registrationProvince && bookProvince !== v.registrationProvince.replace(/\s/g, ''));
  const samePlate = (v: BookCandidate) => hasPlate && normCategory(v.plateCategory) === cat && normNumber(v.plateNumber) === num;
  const sameVin = (v: BookCandidate) => Boolean(vin) && normChassis(v.chassis) === vin;

  // 1) เลขตัวรถตรงเป๊ะ - chassis ไม่ซ้ำกันในระบบ
  const byVin = pending.find(sameVin);
  if (byVin) {
    const plateMismatch = hasPlate && Boolean(byVin.plateNumber) && !samePlate(byVin);
    return { kind: 'exact', vehicleIds: [byVin.id], by: 'chassis', plateMismatch, provinceMismatch: provinceMismatch(byVin) };
  }

  // 2) ทะเบียนตรง - ใช้ได้เต็มที่เฉพาะเมื่ออ่านเลขตัวรถไม่ได้ (อ่านได้แต่ไม่ตรง = น่าสงสัย ให้พนักงานดูเอง)
  let byPlate = pending.filter(samePlate);
  if (byPlate.length > 1 && bookProvince) {
    const sameProvince = byPlate.filter((v) => v.registrationProvince?.replace(/\s/g, '') === bookProvince);
    if (sameProvince.length) byPlate = sameProvince;
  }
  if (byPlate.length === 1 && !vin) {
    const [v] = byPlate;
    return { kind: 'exact', vehicleIds: [v.id], by: 'plate', plateMismatch: false, provinceMismatch: provinceMismatch(v) };
  }

  // 3) ใกล้เคียง: เลขตัวรถต่าง 1 ตัว (AI อ่านผิด) / ทะเบียนตรงแต่เลขตัวรถไม่ตรง / ทะเบียนซ้ำหลายคัน / ทะเบียนต่าง 1 ตัว
  const close = new Set<string>();
  if (vin) pending.filter((v) => oneSubstitution(normChassis(v.chassis), vin)).forEach((v) => close.add(v.id));
  byPlate.forEach((v) => close.add(v.id));
  if (hasPlate) {
    pending
      .filter((v) => {
        const vCat = normCategory(v.plateCategory);
        const vNum = normNumber(v.plateNumber);
        return (vNum === num && oneSubstitution(vCat, cat)) || (vCat === cat && oneSubstitution(vNum, num));
      })
      .forEach((v) => close.add(v.id));
  }
  if (close.size) return noMatch('close', [...close], null);

  const done = received.find(sameVin) ?? received.find(samePlate);
  if (done) return noMatch('received', [done.id], sameVin(done) ? 'chassis' : 'plate');
  return noMatch('none');
}
