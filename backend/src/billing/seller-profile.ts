// ข้อมูลผู้ขายที่ฝังในใบกำกับภาษีตอนออกใบ (ผู้ใช้ 2026-10-06: เตรียมไว้สำหรับ e-Tax ปี 2027 - ใบที่ออกแล้วต้องไม่เปลี่ยนตามที่อยู่ใหม่)
// สำเนาของ COMPANY_PROFILE ใน frontend/src/lib/company-profile.ts (ชื่อ / เลขผู้เสียภาษี / ที่อยู่ / ติดต่อ) - เปลี่ยนข้อมูลบริษัทต้องแก้ทั้งสองที่
// บัญชีรับเงิน (paymentLines) ไม่เก็บในใบ เพราะไม่ใช่ข้อมูลระบุตัวผู้ขายตามกฎหมาย
// type alias (ไม่ใช่ interface) เพื่อให้ Prisma ยอมเก็บเป็น JSON
export type SellerSnapshot = {
  nameTh: string;
  nameEn: string;
  taxId: string;
  branch: string; // สำนักงานใหญ่ หรือสาขาที่ ...
  addressLines: string[];
  phone: string;
  email: string;
};

export const SELLER_PROFILE: SellerSnapshot = {
  nameTh: 'บริษัท เทรดอินเตอร์ จำกัด (สำนักงานใหญ่)',
  nameEn: 'TRADEINTER CO., LTD.',
  taxId: '0115556016801',
  branch: 'สำนักงานใหญ่',
  addressLines: ['3/1 ซอย 31 (อักษรลักษณ์ 4) ถนนสุขุมวิท', 'ตำบลปากน้ำ อำเภอเมืองสมุทรปราการ จังหวัดสมุทรปราการ 10270'],
  phone: '027028328',
  email: 'kj.tradeinter@gmail.com',
};
