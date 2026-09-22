import { z } from 'zod';

// ผลที่ AI อ่านจากรูปป้ายทะเบียน (Step 6 รับป้ายทะเบียน) - รูปเดียวมีได้หลายแผ่น (วางเรียงบนโต๊ะ/ป้ายหน้า-หลัง)
// AI อ่านแบบไม่เห็นรายชื่อรถที่รออยู่ (ไม่ชี้นำ) แล้วค่อยจับคู่แบบตายตัวด้วย matchPlates() ข้างล่าง
export const PlateReadingSchema = z.object({
  plates: z.array(
    z.object({
      category: z.string().nullable(), // หมวด เช่น "8ขก" / "1กข" (มอเตอร์ไซค์)
      number: z.string().nullable(), // เลข เช่น "3484"
      province: z.string().nullable(),
      uncertain: z.boolean(), // AI ไม่มั่นใจตัวอักษร/ตัวเลขบางตัว
      // ดูจากรูปแบบป้าย (รถยนต์: หมวด+เลขบรรทัดบน จังหวัดล่าง / มอเตอร์ไซค์: 3 บรรทัด เลขอยู่ล่าง) - ใช้เตือนถ่ายผิดแท็บ
      plateType: z.enum(['car', 'motorcycle']).nullable(),
    }),
  ),
});

export type PlateReading = z.infer<typeof PlateReadingSchema>;
export type ReadPlate = PlateReading['plates'][number];

export const PLATE_READING_PROMPT = `รูปนี้ถ่ายป้ายทะเบียนรถของไทยที่เพิ่งได้รับจากกรมการขนส่งทางบก อาจมีป้ายแผ่นเดียวหรือหลายแผ่นในรูปเดียว (วางเรียงกัน ซ้อนกัน หรือป้ายหน้า-หลังของรถคันเดียวกัน)
อ่านป้ายทุกแผ่นที่เห็นในรูป แผ่นละ 1 รายการ ตามที่พิมพ์ไว้จริง:
- category: หมวดทะเบียน อาจมีตัวเลขนำหน้า เช่น "8ขก", "กข", "1กข" อ่านพยัญชนะไทยทีละตัวอย่างระวัง (ข/ช, ค/ด/ต, ฆ/ม, บ/ป, ผ/ฝ, พ/ฟ, ฎ/ฏ)
- number: เลขทะเบียน 1-4 หลัก เช่น "3484"
- province: ชื่อจังหวัดบนป้าย เช่น "กรุงเทพมหานคร" (ไม่เห็นใส่ null)
- uncertain: true ถ้าตัวอักษรหรือตัวเลขบางตัวเลือน ถูกบัง สะท้อนแสง หรือเห็นไม่ชัด
- plateType: "car" ถ้าเป็นป้ายรถยนต์ (แผ่นกว้าง 2 บรรทัด), "motorcycle" ถ้าเป็นป้ายรถจักรยานยนต์ (แผ่นเล็ก 3 บรรทัด), ไม่แน่ใจใส่ null
ป้ายรถยนต์: หมวดและเลขอยู่บรรทัดบน จังหวัดอยู่บรรทัดล่าง ป้ายรถจักรยานยนต์: หมวดอยู่บรรทัดบน จังหวัดตรงกลาง เลขอยู่บรรทัดล่าง
ป้ายที่เห็นไม่ครบจนอ่านหมวดหรือเลขไม่ได้ ให้ใส่ช่องนั้นเป็น null ห้ามเดา ถ้าในรูปไม่มีป้ายทะเบียนเลยให้ตอบ plates เป็นลิสต์ว่าง`;

// หมวดเก็บแบบไม่มีช่องว่าง (Vehicle.plateCategory เช่น "8ขก") เลขเก็บเป็นตัวเลขล้วนไม่มี 0 นำหน้า
export const normCategory = (raw: string | null | undefined) => (raw ?? '').replace(/\s/g, '');
export const normNumber = (raw: string | null | undefined) => {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits ? String(Number(digits)) : '';
};

// ต่างกันได้ไม่เกิน 1 ตำแหน่ง (แทนที่ 1 ตัว ความยาวเท่ากัน) - ใช้หาคันที่ AI อาจอ่านผิดตัวเดียว เช่น ฆ -> ม
export function oneSubstitution(a: string, b: string): boolean {
  const x = [...a];
  const y = [...b];
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i] && ++diff > 1) return false;
  return diff === 1;
}

export interface PlateCandidate {
  id: string;
  plateCategory: string | null;
  plateNumber: string | null;
  registrationProvince: string | null;
}

// exact = หมวด+เลขตรงเป๊ะกับรถที่รอรับป้าย 1 คัน -> ติ๊กให้เลย (พนักงานยังกดยืนยันเอง)
// close = ไม่มีคันที่ตรงเป๊ะ แต่มีคันที่ต่างกัน 1 ตัว (AI อาจอ่านผิด) -> เสนอให้พนักงานเลือก ไม่ติ๊กให้
// received = ตรงกับรถที่รับป้ายไปแล้ว (ถ่ายซ้ำ) · none = ไม่พบรถ · unreadable = อ่านหมวด/เลขไม่ได้
export type PlateMatchKind = 'exact' | 'close' | 'received' | 'none' | 'unreadable';

export interface PlateMatch {
  kind: PlateMatchKind;
  vehicleIds: string[]; // exact/received = 1 คัน, close = ตัวเลือก (อาจหลายคัน)
  provinceMismatch: boolean; // จังหวัดบนป้ายไม่ตรงกับจังหวัดที่จดทะเบียนของรถ (exact เท่านั้น) - เตือนอย่างเดียว
  // AI ว่าเป็นป้ายอีกประเภทกับแท็บที่ถ่าย (เช่น ป้ายมอเตอร์ไซค์ในแท็บรถยนต์) - เตือน และหน้าเว็บไม่ติ๊กให้
  typeMismatch: boolean;
}

export type PlateKind = 'car' | 'moto';

// pending/received ต้องกรองให้เหลือเฉพาะรถประเภทเดียวกับ kind มาแล้ว (ป้ายรถยนต์กับมอเตอร์ไซค์เลขซ้ำกันได้)
export function matchPlate(plate: ReadPlate, pending: PlateCandidate[], received: PlateCandidate[], kind: PlateKind = 'car'): PlateMatch {
  const typeMismatch = plate.plateType !== null && plate.plateType !== undefined && (plate.plateType === 'motorcycle') !== (kind === 'moto');
  return { ...matchPlateInKind(plate, pending, received), typeMismatch };
}

function matchPlateInKind(plate: ReadPlate, pending: PlateCandidate[], received: PlateCandidate[]): Omit<PlateMatch, 'typeMismatch'> {
  const cat = normCategory(plate.category);
  const num = normNumber(plate.number);
  if (!cat || !num) return { kind: 'unreadable', vehicleIds: [], provinceMismatch: false };
  const same = (v: PlateCandidate) => normCategory(v.plateCategory) === cat && normNumber(v.plateNumber) === num;

  const plateProvince = plate.province?.replace(/\s/g, '');
  let exact = pending.filter(same);
  // ทะเบียนเดียวกันคนละจังหวัด - ใช้จังหวัดบนป้ายแยก
  if (exact.length > 1 && plateProvince) {
    const byProvince = exact.filter((v) => v.registrationProvince?.replace(/\s/g, '') === plateProvince);
    if (byProvince.length) exact = byProvince;
  }
  if (exact.length === 1) {
    const [v] = exact;
    const provinceMismatch = Boolean(plateProvince && v.registrationProvince && plateProvince !== v.registrationProvince.replace(/\s/g, ''));
    return { kind: 'exact', vehicleIds: [v.id], provinceMismatch };
  }
  // ทะเบียนซ้ำกันในคิว (คนละจังหวัด) - ให้พนักงานเลือกเอง
  if (exact.length > 1) return { kind: 'close', vehicleIds: exact.map((v) => v.id), provinceMismatch: false };

  const close = pending.filter((v) => {
    const vCat = normCategory(v.plateCategory);
    const vNum = normNumber(v.plateNumber);
    return (vNum === num && oneSubstitution(vCat, cat)) || (vCat === cat && oneSubstitution(vNum, num));
  });
  if (close.length) return { kind: 'close', vehicleIds: close.map((v) => v.id), provinceMismatch: false };

  const done = received.find(same);
  if (done) return { kind: 'received', vehicleIds: [done.id], provinceMismatch: false };
  return { kind: 'none', vehicleIds: [], provinceMismatch: false };
}
