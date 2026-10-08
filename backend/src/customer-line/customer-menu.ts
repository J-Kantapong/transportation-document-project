// เมนูเอกสารของบัญชีไลน์ลูกค้า (ผู้ใช้ 2026-10-09: "แถบเมนูด้านล่างพร้อมการ์ดปุ่มกด") - ลูกค้ากดปุ่มแทนการพิมพ์คำ
// แถบเมนูด้านล่าง (rich-menu.ts) และปุ่มในการ์ดส่งคำสำคัญเข้าแชตเหมือนลูกค้าพิมพ์เอง แล้วบอทตอบเป็นการ์ดของเรื่องนั้น
// จึงไม่ต้องจำสถานะการคุย และลูกค้าที่พิมพ์คำเองก็ได้คำตอบเดียวกัน
// รายการเอกสารเป็นแนวปฏิบัติของสำนักงานที่ผู้ใช้ยืนยันแล้ว (ต้นฉบับ: ข้อความตอบกลับอัตโนมัติชุดเดิมใน LINE Manager)
// ห้ามมีราคาของสำนักงานและห้ามอ่านข้อมูลรถ/ลูกค้าของระบบ เพราะบอทตอบทุกคนที่ทักเข้ามา
import type { LineMessage } from '../secretary/line-client.js';

export type CardButton = { label: string; text: string } | { label: string; uri: string };

export interface MenuCard {
  id: string;
  keywords: string[];
  title: string;
  subtitle?: string;
  body: string;
  buttons: CardButton[];
}

// เบอร์ที่ลูกค้าโทรหาเจ้าหน้าที่ (ผู้ใช้ยืนยัน 2026-10-09) - เบอร์เดียวกับหัวใบส่งงาน (DELIVERY_HEADER ใน frontend/src/lib/company-profile.ts)
export const CONTACT_PHONE = '0655194565';

const DRIVE = (id: string) => `https://drive.google.com/file/d/${id}/view`;
const FORM_REGISTER = DRIVE('16lt_NzmvHE44V3d98aqmd-IeMBjR5gYz');
const FORM_TRANSFER = DRIVE('12cgcGkrtY9hhCZNvgG8z9gWl83Bd6WL5');
const FORM_POWER_OF_ATTORNEY = DRIVE('1cTfcFpcfJpJZ7cEkRH3EFWuwt-gdxEGz');
const FORM_SWAP_CONSENT_CAR = DRIVE('1i4D2PJ4egrsSbAs3Qg3-VE0xa0t5bJoC');
const FORM_SWAP_CONSENT_MOTO = DRIVE('1nQ737TNI9OYeZivRmInOmFWLDNoM5ZF-');
const SWAP_GUIDE = DRIVE('1MpMPVL6bflaxL28a7tdU4-bMtroMWCfD');

const TO_DOCUMENTS: CardButton = { label: 'เมนูเอกสาร', text: 'เอกสาร' };
const TO_FORMS: CardButton = { label: 'ดาวน์โหลดแบบฟอร์ม', text: 'แบบฟอร์ม' };
const TO_INSPECTION_GUIDE: CardButton = { label: 'วิธีตรวจนอก', text: 'ตรวจนอก' };
const TO_STAFF: CardButton = { label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' };

const COPY_NOTE = '* สำเนาทุกใบเซ็นรับรองสำเนาถูกต้อง';
const SEAL_NOTE = '* กรรมการเซ็นตามเงื่อนไขในหนังสือรับรอง และประทับตราบริษัท ถ้าหนังสือรับรองระบุไว้';
const NEW_REGISTRATION = 'เอกสารจดทะเบียนรถใหม่';

const lines = (...text: string[]) => text.join('\n');

// การ์ดแรก: ทักทาย / พิมพ์อะไรที่บอทไม่รู้จัก
export const WELCOME_CARD: MenuCard = {
  id: 'welcome',
  keywords: ['เมนู', 'menu', 'สวัสดี', 'สวัสดีครับ', 'สวัสดีค่ะ'],
  title: 'Jitkusol Auto',
  subtitle: 'ทุกเรื่องรถ จบง่าย ในที่เดียว',
  body: lines('ขอบคุณที่ติดต่อเราครับ', 'กดเลือกเรื่องที่ต้องการได้เลย'),
  buttons: [
    { label: 'เอกสารแต่ละงาน', text: 'เอกสาร' },
    TO_FORMS,
    { label: 'เช็กค่าภาษี / ตรอ.', text: 'เช็ก' },
    TO_STAFF,
  ],
};

export const MENU_CARDS: MenuCard[] = [
  WELCOME_CARD,
  {
    id: 'documents',
    keywords: ['เอกสาร', 'เมนูเอกสาร', 'รายการเอกสาร'],
    title: 'เอกสารแต่ละงาน',
    body: 'กดเลือกงานที่ต้องการดูรายการเอกสาร',
    buttons: [
      { label: 'จดทะเบียนรถใหม่', text: 'จดใหม่' },
      { label: 'โอนรถ', text: 'โอนรถ' },
      { label: 'สลับเลขทะเบียน', text: 'สลับเลข' },
      { label: 'เปลี่ยนสีรถ', text: 'เปลี่ยนสี' },
      { label: 'ต่อภาษี', text: 'ต่อภาษี' },
      { label: 'คัดป้ายทะเบียน', text: 'คัดป้าย' },
    ],
  },
  {
    id: 'new',
    keywords: ['จดใหม่', 'จดทะเบียน', 'จดทะเบียนใหม่', 'จดทะเบียนรถใหม่'],
    title: NEW_REGISTRATION,
    body: 'กดเลือกกรณีของท่าน',
    buttons: [
      { label: 'บุคคลธรรมดา ซื้อสด', text: 'บุคคลสด' },
      { label: 'นิติบุคคล ซื้อสด', text: 'บริษัทสด' },
      { label: 'บุคคลธรรมดา ผ่อนไฟแนนซ์', text: 'บุคคลไฟแนนซ์' },
      { label: 'นิติบุคคล ผ่อนไฟแนนซ์', text: 'บริษัทไฟแนนซ์' },
    ],
  },
  {
    id: 'new-person-cash',
    keywords: ['บุคคลสด', 'จดใหม่ บุคคลสด'],
    title: NEW_REGISTRATION,
    subtitle: 'บุคคลธรรมดา ซื้อสด',
    body: lines(
      '1. ใบแจ้งจำหน่าย และใบเสร็จ/ใบกำกับภาษี',
      '2. พ.ร.บ.',
      '3. สำเนาบัตรประชาชนเจ้าของรถ',
      '4. หนังสือมอบอำนาจ (เซ็นแล้ว)',
      '5. ลอกลายเลขตัวถัง 2 ชุด (ใช้เทปกระดาษ Nitto No.720)',
      '',
      COPY_NOTE,
    ),
    buttons: [TO_FORMS, { label: 'เลือกกรณีอื่น', text: 'จดใหม่' }],
  },
  {
    id: 'new-company-cash',
    keywords: ['บริษัทสด', 'จดใหม่ บริษัทสด', 'นิติบุคคลสด'],
    title: NEW_REGISTRATION,
    subtitle: 'นิติบุคคล ซื้อสด',
    body: lines(
      '1. ใบแจ้งจำหน่าย และใบเสร็จ/ใบกำกับภาษี',
      '2. พ.ร.บ.',
      '3. หนังสือรับรองบริษัท (อายุไม่เกิน 1 ปี)',
      '4. สำเนาบัตรประชาชนกรรมการผู้มีอำนาจ',
      '5. หนังสือมอบอำนาจ',
      '6. ลอกลายเลขตัวถัง 2 ชุด (ใช้เทปกระดาษ Nitto No.720)',
      '',
      COPY_NOTE,
      SEAL_NOTE,
    ),
    buttons: [TO_FORMS, { label: 'เลือกกรณีอื่น', text: 'จดใหม่' }],
  },
  {
    id: 'new-person-finance',
    keywords: ['บุคคลไฟแนนซ์', 'จดใหม่ บุคคลไฟแนนซ์'],
    title: NEW_REGISTRATION,
    subtitle: 'บุคคลธรรมดา ผ่อนไฟแนนซ์',
    body: lines(
      '1. ใบแจ้งจำหน่าย และใบเสร็จ/ใบกำกับภาษี',
      '2. พ.ร.บ.',
      '3. ชุดเอกสารจากไฟแนนซ์ (หนังสือรับรอง + หนังสือมอบอำนาจของไฟแนนซ์)',
      '4. สัญญาเช่าซื้อ',
      '5. สำเนาบัตรประชาชนผู้เช่าซื้อ',
      '6. ลอกลายเลขตัวถัง 2 ชุด (ใช้เทปกระดาษ Nitto No.720)',
      '',
      COPY_NOTE,
    ),
    buttons: [TO_FORMS, { label: 'เลือกกรณีอื่น', text: 'จดใหม่' }],
  },
  {
    id: 'new-company-finance',
    keywords: ['บริษัทไฟแนนซ์', 'จดใหม่ บริษัทไฟแนนซ์', 'นิติบุคคลไฟแนนซ์'],
    title: NEW_REGISTRATION,
    subtitle: 'นิติบุคคล ผ่อนไฟแนนซ์',
    body: lines(
      '1. ใบแจ้งจำหน่าย และใบเสร็จ/ใบกำกับภาษี',
      '2. พ.ร.บ.',
      '3. ชุดเอกสารจากไฟแนนซ์ (หนังสือรับรอง + หนังสือมอบอำนาจของไฟแนนซ์)',
      '4. สัญญาเช่าซื้อ',
      '5. หนังสือรับรองบริษัทผู้เช่าซื้อ (อายุไม่เกิน 1 ปี)',
      '6. สำเนาบัตรประชาชนกรรมการผู้มีอำนาจ',
      '7. ลอกลายเลขตัวถัง 2 ชุด (ใช้เทปกระดาษ Nitto No.720)',
      '',
      COPY_NOTE,
      SEAL_NOTE,
    ),
    buttons: [TO_FORMS, { label: 'เลือกกรณีอื่น', text: 'จดใหม่' }],
  },
  {
    id: 'transfer',
    keywords: ['โอนรถ', 'โอน', 'โอนทะเบียน', 'โอนกรรมสิทธิ์'],
    title: 'เอกสารโอนรถ',
    body: lines(
      '1. เล่มทะเบียนตัวจริง',
      '2. สัญญาซื้อขาย หรือใบเสร็จรับเงิน',
      '3. เอกสารผู้โอนและผู้รับโอน ฝ่ายละ 1 ชุด',
      '- บุคคล: สำเนาบัตรประชาชน',
      '- นิติบุคคล: หนังสือรับรองบริษัท (ไม่เกิน 1 ปี) + สำเนาบัตรกรรมการ',
      '4. หนังสือมอบอำนาจของทั้งสองฝ่าย',
      '',
      'ตรวจรถ เลือกได้ 2 แบบ',
      '- นำรถเข้าตรวจที่ขนส่ง',
      '- ตรวจนอก (กดปุ่มด้านล่างเพื่อดูวิธี)',
      '',
      'ผ่อนไฟแนนซ์ครบแล้ว: เพิ่มชุดโอนจากไฟแนนซ์',
      '',
      '* แจ้งโอนภายใน 15 วัน',
      '* นิติบุคคลเซ็นและประทับตราตามหนังสือรับรอง',
    ),
    buttons: [TO_INSPECTION_GUIDE, TO_FORMS, TO_DOCUMENTS],
  },
  {
    id: 'plate-swap',
    keywords: ['สลับเลข', 'สลับทะเบียน', 'สลับเลขทะเบียน'],
    title: 'เอกสารสลับเลขทะเบียน',
    subtitle: 'คัน A = รถที่ให้เลข / คัน B = รถที่รับเลข',
    body: lines(
      '1. เล่มทะเบียนตัวจริงทั้ง 2 คัน',
      '2. เอกสารเจ้าของรถ คัน A 2 ชุด คัน B 1 ชุด',
      '- บุคคล: สำเนาบัตรประชาชน + หนังสือมอบอำนาจ',
      '- นิติบุคคล: หนังสือรับรองบริษัท (ไม่เกิน 1 ปี) + สำเนาบัตรกรรมการ + หนังสือมอบอำนาจ',
      '3. เจ้าของคนละคน: หนังสือยินยอมการขอใช้เลขทะเบียน',
      '',
      'รถติดไฟแนนซ์: เพิ่มชุดเอกสารจากไฟแนนซ์',
    ),
    buttons: [{ label: 'คู่มือแยกทุกกรณี', uri: SWAP_GUIDE }, TO_FORMS, TO_DOCUMENTS],
  },
  {
    id: 'colour',
    keywords: ['เปลี่ยนสี', 'เปลี่ยนสีรถ', 'แจ้งเปลี่ยนสี'],
    title: 'เอกสารแจ้งเปลี่ยนสีรถ',
    body: lines(
      '1. เล่มทะเบียนตัวจริง',
      '2. ใบเสร็จค่าทำสี (ไม่มีก็ทำได้ แจ้งเจ้าหน้าที่)',
      '3. เอกสารเจ้าของรถ 1 ชุด',
      '- บุคคล: สำเนาบัตรประชาชน',
      '- นิติบุคคล: หนังสือรับรองบริษัท (ไม่เกิน 1 ปี) + สำเนาบัตรกรรมการ',
      '4. หนังสือมอบอำนาจ',
      '',
      'ตรวจรถ เลือกได้ 2 แบบ',
      '- นำรถเข้าตรวจที่ขนส่ง',
      '- ตรวจนอก (กดปุ่มด้านล่างเพื่อดูวิธี)',
      '',
      'รถติดไฟแนนซ์: เพิ่มชุดเอกสารจากไฟแนนซ์ (เล่มทะเบียนมาพร้อมชุดนี้)',
      '',
      '* ควรแจ้งภายใน 7 วันหลังเปลี่ยนสี',
    ),
    buttons: [TO_INSPECTION_GUIDE, TO_FORMS, TO_DOCUMENTS],
  },
  {
    id: 'tax',
    keywords: ['ต่อภาษี', 'ต่อทะเบียน', 'ต่อภาษีรถ'],
    title: 'เอกสารต่อภาษีรถประจำปี',
    body: lines(
      '1. เล่มทะเบียน (ตัวจริงหรือสำเนา)',
      '2. พ.ร.บ. ที่ยังไม่หมดอายุ (ยังไม่มี ติดต่อเจ้าหน้าที่ได้)',
      '3. ใบตรวจสภาพรถ (ตรอ.) เฉพาะ',
      '- รถยนต์อายุครบ 7 ปีขึ้นไป',
      '- มอเตอร์ไซค์อายุครบ 5 ปีขึ้นไป',
      '- รถที่ขาดต่อภาษีเกิน 1 ปี',
      '(ลูกค้านำรถไปตรวจที่ ตรอ. เอง)',
      '',
      'รถติดแก๊ส: เพิ่มใบตรวจและทดสอบถังแก๊ส',
      '',
      '* ไม่ต้องใช้สำเนาบัตรประชาชนและหนังสือมอบอำนาจ',
      '* รถขาดต่อภาษีเกิน 3 ปี กรุณาสอบถามเจ้าหน้าที่',
    ),
    buttons: [{ label: 'เช็กค่าภาษีรถ', text: 'เช็กภาษี' }, { label: 'เช็กว่าต้องตรวจ ตรอ. ไหม', text: 'ตรอ' }, TO_DOCUMENTS],
  },
  {
    id: 'plate-copy',
    keywords: ['คัดป้าย', 'ป้ายหาย', 'ป้ายชำรุด', 'คัดป้ายทะเบียน'],
    title: 'เอกสารคัดป้ายทะเบียน',
    subtitle: 'ป้ายหายหรือชำรุด รับทั้งรถยนต์และมอเตอร์ไซค์',
    body: lines(
      '1. เล่มทะเบียนตัวจริง',
      '2. เอกสารเจ้าของรถ 1 ชุด',
      '- บุคคล: สำเนาบัตรประชาชน',
      '- นิติบุคคล: หนังสือรับรองบริษัท (ไม่เกิน 1 ปี) + สำเนาบัตรกรรมการ',
      '3. หนังสือมอบอำนาจ',
      '4. ป้ายเดิมที่ชำรุด ต้องส่งมาด้วย',
      '',
      'รถติดไฟแนนซ์: เพิ่มชุดเอกสารจากไฟแนนซ์ (เล่มทะเบียนมาพร้อมชุดนี้)',
      '',
      '* ป้ายหาย ไม่ต้องใช้ใบแจ้งความ',
      '* รอป้ายประมาณ 15 วันทำการ',
    ),
    buttons: [TO_FORMS, TO_DOCUMENTS],
  },
  {
    id: 'outside-inspection',
    keywords: ['ตรวจนอก', 'ถ่ายรูปรถ', 'ลอกลาย'],
    title: 'ตรวจนอก',
    subtitle: 'ลูกค้าเตรียม 2 อย่าง',
    body: lines(
      '1. รูปถ่าย 6 รูป',
      '- รถ 4 มุม: หน้าซ้าย หน้าขวา หลังซ้าย หลังขวา (เห็นรถทั้งคันและป้ายทะเบียน)',
      '- เลขเครื่องยนต์',
      '- เลขตัวถัง',
      '',
      '2. ลอกลายเลขตัวถัง 2 ชุด',
      'ใช้เทปกระดาษ Nitto No.720 ติดทับเลขตัวถัง ใช้ดินสอฝนจนเลขขึ้นชัด แล้วลอกมาติดบนกระดาษขาว',
      '',
      '* ลอกเฉพาะเลขตัวถัง ไม่ต้องลอกเลขเครื่อง',
    ),
    buttons: [TO_DOCUMENTS],
  },
  {
    id: 'forms',
    keywords: ['แบบฟอร์ม', 'ดาวน์โหลด', 'ฟอร์ม'],
    title: 'ดาวน์โหลดแบบฟอร์ม',
    body: 'กดปุ่มเพื่อเปิดไฟล์',
    buttons: [
      { label: 'แบบคำขอจดทะเบียน', uri: FORM_REGISTER },
      { label: 'แบบคำขอโอน', uri: FORM_TRANSFER },
      { label: 'หนังสือมอบอำนาจ', uri: FORM_POWER_OF_ATTORNEY },
      { label: 'ยินยอมสลับเลข (รถยนต์)', uri: FORM_SWAP_CONSENT_CAR },
      { label: 'ยินยอมสลับเลข (จยย.)', uri: FORM_SWAP_CONSENT_MOTO },
      { label: 'คู่มือสลับเลขทะเบียน', uri: SWAP_GUIDE },
    ],
  },
  {
    id: 'check',
    keywords: ['เช็ก', 'เช็ค', 'ตรวจสอบ'],
    title: 'เช็กค่าภาษี / ตรอ.',
    body: lines('เช็กค่าภาษี = ยอดภาษีประจำปีของรถโดยประมาณ (บอกผล ตรอ. ให้ด้วย)', 'เช็ก ตรอ. = ดูแค่ว่ารถต้องตรวจสภาพแล้วหรือยัง'),
    buttons: [
      { label: 'เช็กค่าภาษีรถ', text: 'เช็กภาษี' },
      { label: 'เช็กว่าต้องตรวจ ตรอ. ไหม', text: 'ตรอ' },
    ],
  },
  {
    id: 'staff',
    keywords: ['ติดต่อเจ้าหน้าที่', 'เจ้าหน้าที่', 'ติดต่อ', 'เบอร์โทร', 'โทร'],
    title: 'ติดต่อเจ้าหน้าที่',
    body: lines(`โทร ${CONTACT_PHONE.slice(0, 3)}-${CONTACT_PHONE.slice(3, 6)}-${CONTACT_PHONE.slice(6)}`, 'กดปุ่มด้านล่างเพื่อโทรออกได้เลย'),
    buttons: [{ label: 'โทรหาเจ้าหน้าที่', uri: `tel:${CONTACT_PHONE}` }, TO_DOCUMENTS],
  },
];

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, '');
// คำสั้น (เช่น "โอน" "โทร") ต้องพิมพ์มาตรงตัวเท่านั้น ไม่งั้น "โอนเงินแล้วครับ" จะได้รายการเอกสารโอนรถ
const MIN_CONTAINED_KEYWORD = 4;

const KEYWORDS = MENU_CARDS.flatMap((card) => card.keywords.map((keyword) => ({ keyword: normalize(keyword), card })));

// หาการ์ดจากข้อความที่ลูกค้าพิมพ์หรือกดปุ่ม: ตรงตัวก่อน ไม่ตรงค่อยดูว่ามีคำสำคัญอยู่ในประโยค (เอาคำที่ยาวที่สุด
// เช่น "ขอเอกสารจดใหม่ บุคคลไฟแนนซ์" = การ์ดบุคคลไฟแนนซ์ ไม่ใช่เมนูจดใหม่)
export function findMenuCard(text: string | undefined, exactOnly = false): MenuCard | null {
  const typed = normalize(text ?? '');
  if (!typed) return null;
  const exact = KEYWORDS.find((entry) => entry.keyword === typed);
  if (exact || exactOnly) return exact?.card ?? null;

  let best: (typeof KEYWORDS)[number] | null = null;
  for (const entry of KEYWORDS) {
    if (entry.keyword.length < MIN_CONTAINED_KEYWORD || !typed.includes(entry.keyword)) continue;
    if (!best || entry.keyword.length > best.keyword.length) best = entry;
  }
  return best?.card ?? null;
}

const BRAND_GREEN = '#123D30';
const BRAND_GOLD = '#D9C08A';

function buttonAction(button: CardButton) {
  return 'uri' in button
    ? { type: 'uri', label: button.label, uri: button.uri }
    : { type: 'message', label: button.label, text: button.text };
}

// ปุ่มกลับเมนู (ปุ่มสุดท้ายที่พาไปเมนูเอกสาร) เป็นปุ่มโปร่ง ปุ่มอื่นเป็นปุ่มทึบสีแบรนด์
function isBackButton(button: CardButton, card: MenuCard): boolean {
  return button === TO_DOCUMENTS && card.buttons.length > 1;
}

// ข้อความล้วนสำรองของการ์ดแต่ละใบ - ผู้ส่งใช้ตอบแทนเมื่อ LINE ไม่รับการ์ด ลูกค้าจะได้ไม่เงียบ
const FALLBACKS = new WeakMap<LineMessage, LineMessage>();
export const fallbackOf = (message: LineMessage): LineMessage | null => FALLBACKS.get(message) ?? null;

export function cardMessage(card: MenuCard): LineMessage {
  const message = buildCardMessage(card);
  FALLBACKS.set(message, cardTextMessage(card));
  return message;
}

function buildCardMessage(card: MenuCard): LineMessage {
  const header = [
    { type: 'text', text: card.title, color: '#FFFFFF', weight: 'bold', size: 'lg', wrap: true },
    ...(card.subtitle ? [{ type: 'text', text: card.subtitle, color: BRAND_GOLD, size: 'sm', wrap: true, margin: 'sm' }] : []),
  ];
  return {
    type: 'flex',
    altText: card.subtitle ? `${card.title} (${card.subtitle})` : card.title,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: BRAND_GREEN, paddingAll: '16px', contents: header },
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'text', text: card.body, wrap: true, size: 'sm', color: '#222222' }],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: card.buttons.map((button) =>
          isBackButton(button, card)
            ? { type: 'button', style: 'link', height: 'sm', color: BRAND_GREEN, action: buttonAction(button) }
            : { type: 'button', style: 'primary', height: 'sm', color: BRAND_GREEN, action: buttonAction(button) },
        ),
      },
    },
  };
}

export function cardTextMessage(card: MenuCard): LineMessage {
  const buttons = card.buttons.map((button) => ('uri' in button ? `${button.label}\n${button.uri}` : `พิมพ์ ${button.text} = ${button.label}`));
  return {
    type: 'text',
    text: [card.title, ...(card.subtitle ? [`(${card.subtitle})`] : []), '', card.body, '', ...buttons].join('\n'),
  };
}
