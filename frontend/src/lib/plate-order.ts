// เรียงทะเบียนแบบที่ห้องรับป้ายใช้ (ผู้ใช้ 2026-09-21): กก 1, กก 2 … กก 9999 แล้วต่อ กข 1 … กข 9999
// หมวดที่มีเลขนำหน้า (เช่น 8ขก) มาหลังหมวดที่ไม่มี เพราะออกหลังชุดตัวอักษรล้วนหมดแล้ว - เรียงตามเลขนำหน้าก่อน
// ตัวอักษรไทย ก-ฮ เรียงตาม code point ได้ตรงลำดับพยัญชนะ; เลขทะเบียนเทียบเป็นตัวเลข (ไม่ใช่ข้อความ 10 < 9)
// รถที่ยังไม่มีทะเบียนไปอยู่ท้ายสุด
export function comparePlate(
  a: { plateCategory: string | null; plateNumber: string | null },
  b: { plateCategory: string | null; plateNumber: string | null },
): number {
  const ka = plateKey(a.plateCategory, a.plateNumber);
  const kb = plateKey(b.plateCategory, b.plateNumber);
  if (!ka || !kb) return ka ? -1 : kb ? 1 : 0;
  return ka.prefix - kb.prefix || (ka.letters < kb.letters ? -1 : ka.letters > kb.letters ? 1 : 0) || ka.number - kb.number;
}

function plateKey(category: string | null, number: string | null) {
  const cat = category?.replace(/\s/g, "") ?? "";
  if (!cat || !number) return null;
  const m = /^(\d*)(.*)$/.exec(cat)!;
  return { prefix: m[1] ? Number(m[1]) : 0, letters: m[2], number: Number(number) || 0 };
}
