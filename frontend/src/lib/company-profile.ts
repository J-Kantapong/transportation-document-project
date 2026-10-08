// ข้อมูลผู้ออกบิล (ในนามบริษัท) ที่พิมพ์บนหัวใบวางบิล/ใบแจ้งหนี้ - คัดจากฟอร์มใบวางบิลเดิมของบริษัทใน Google Sheet "Invoice Tradeinter"
// แก้ที่ไฟล์นี้ที่เดียวเมื่อที่อยู่/บัญชีรับเงินเปลี่ยน (ส่วนการออกบิลเข้าบัญชีส่วนตัวยังไม่ได้ทำ - ผู้ใช้จะกำหนดทีหลัง)
export const COMPANY_PROFILE = {
  nameEn: "TRADEINTER CO., LTD.",
  nameTh: "บริษัท เทรดอินเตอร์ จำกัด (สำนักงานใหญ่)",
  taxId: "0115556016801",
  addressLines: ["3/1 ซอย 31 (อักษรลักษณ์ 4) ถนนสุขุมวิท", "ตำบลปากน้ำ อำเภอเมืองสมุทรปราการ จังหวัดสมุทรปราการ 10270"],
  phone: "027028328",
  email: "kj.tradeinter@gmail.com",
  paymentLines: ["โอนเข้าบัญชีธนาคาร: กสิกรไทย สาขา: สมุทรปราการ", "ชื่อบัญชี: บริษัท เทรดอินเตอร์ จำกัด เลขที่บัญชี: 224-2-61888-7"],
} as const;

// หัวใบส่งงาน Delivery (ผู้ใช้พิมพ์ให้ 2026-09-26): โลโก้ + ข้อความชุดนี้ - เบอร์โทรต่างจากหัวใบวางบิล
export const DELIVERY_HEADER = {
  name: COMPANY_PROFILE.nameTh,
  addressLines: COMPANY_PROFILE.addressLines, // 2 บรรทัด ตัดที่ "ตำบล" - บรรทัดเดียวยาวจน 10270 ตกไปบรรทัดใหม่
  taxId: COMPANY_PROFILE.taxId,
  phone: "0655194565",
  email: COMPANY_PROFILE.email,
} as const;

// ผู้ออกบิลฝั่งบัญชีบุคคล (ผู้ใช้ 2026-09-27) - ลูกค้าบัญชีบุคคล เช่น SPI, YMAC: ชื่อตามบัญชีธนาคาร ไม่พิมพ์เลขผู้เสียภาษี
// ที่อยู่ยังไม่ได้ให้ (เว้นว่าง = ไม่พิมพ์) - บิลบัญชีบุคคลไม่มี VAT
export const PERSONAL_PROFILE = {
  name: "น.ส. อารี กรกชชื่นสกุล",
  addressLines: [] as string[],
  paymentLines: ["โอนเข้าบัญชีธนาคาร: กสิกรไทย", "ชื่อบัญชี: น.ส. อารี กรกชชื่นสกุล เลขที่บัญชี: 736-2-51858-4"],
} as const;

// ผู้รับเงินของบิลบัญชีบุคคลที่ตั้งไว้ที่ลูกค้า (ผู้ใช้ 2026-10-08: SPI เข้านายจิรฤทธิ์, YMAC เข้าอารี) - เก็บใน customerSnapshot.payee ของบิล/ใบเสนอราคา
// ไม่มี payee = ผู้รับเงินตั้งต้น (PERSONAL_PROFILE)
export type PersonalPayee = { name: string; bank: string | null; accountNo: string };

export function personalIssuerOf(payee?: PersonalPayee | null): { name: string; addressLines: string[]; paymentLines: string[] } {
  if (!payee) return { name: PERSONAL_PROFILE.name, addressLines: [...PERSONAL_PROFILE.addressLines], paymentLines: [...PERSONAL_PROFILE.paymentLines] };
  return {
    name: payee.name,
    addressLines: [],
    paymentLines: [...(payee.bank ? [`โอนเข้าบัญชีธนาคาร: ${payee.bank}`] : []), `ชื่อบัญชี: ${payee.name} เลขที่บัญชี: ${payee.accountNo}`],
  };
}
