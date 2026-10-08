// เช็กว่าต้องตรวจสภาพ (ตรอ.) แล้วหรือยัง สำหรับลูกค้าในไลน์ (ผู้ใช้ 2026-10-09: บอทถามตอบในแชต เช็กแค่ ตรอ.
// รถยนต์กับมอเตอร์ไซค์จำนวนปีไม่เท่ากัน) - ไม่แตะฐานข้อมูล ไม่มีราคา คำนวณจากวันจดทะเบียนที่ลูกค้าเลือกเท่านั้น
// ลำดับ: ลูกค้าพิมพ์คำที่มี "ตรอ" -> บอทถามประเภทรถ (ปุ่ม 2 ปุ่ม กดแล้วเปิดปฏิทินเลือกวันจดทะเบียน) -> บอทตอบผล
// หรือพิมพ์รวดเดียว "ตรอ รถยนต์ 15/03/2562" (วันที่เป็น พ.ศ. ได้) -> บอทตอบผลเลย ไม่บอกประเภทรถ = ตอบทั้งสองประเภท
// ไม่ต้องจำสถานะการคุย: ทุกอย่างที่ต้องใช้อยู่ในข้อความหรือ postback เดียว
import { requiresInspection } from '../tax-renewal/vehicle-tax-calculator.js';
import type { LineMessage } from '../secretary/line-client.js';

export type TroKind = 'car' | 'moto';

const KIND_LABEL: Record<TroKind, string> = { car: 'รถยนต์', moto: 'มอเตอร์ไซค์' };
// รหัสประเภทรถที่ใช้ถามกฎเดียวกับงานต่อภาษี (requiresInspection) - กฎมีที่เดียว แก้ที่นั่นแล้วที่นี่ตามเอง
const KIND_CODE: Record<TroKind, string> = { car: 'รย.1', moto: 'รย.12' };
const POSTBACK_PREFIX = 'tro:';
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

// จำนวนปีที่ครบแล้วต้องตรวจ อ่านจากกฎของงานต่อภาษี (รถยนต์ 7 ปี มอเตอร์ไซค์ 5 ปี ณ 2026-10-09)
export function inspectionAgeYears(kind: TroKind): number {
  for (let years = 1; years <= 30; years += 1) {
    if (requiresInspection(KIND_CODE[kind], years, 0)) return years;
  }
  throw new Error(`ไม่พบจำนวนปีที่ต้องตรวจสภาพของ ${KIND_LABEL[kind]}`);
}

// ข้อความที่ลูกค้าพิมพ์ถามเรื่อง ตรอ. หรือไม่ (ตัดช่องว่างและจุดก่อนเทียบ เช่น "เช็ค ตรอ." "ตรวจ ต.ร.อ")
export function isTroQuestion(text: string | undefined): boolean {
  return (text ?? '').replace(/[\s.]/g, '').includes('ตรอ');
}

export function parseTroPostback(data: string | undefined): TroKind | null {
  if (!data?.startsWith(POSTBACK_PREFIX)) return null;
  const kind = data.slice(POSTBACK_PREFIX.length);
  return kind === 'car' || kind === 'moto' ? kind : null;
}

function validIso(iso: string): boolean {
  const match = ISO_DATE.exec(iso);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === iso;
}

// เลื่อนไปอีก n ปีแบบ date-to-date - 29 ก.พ. ถูกหนีบไว้ที่วันสุดท้ายของเดือน (เหมือน addYears ของงานต่อภาษี)
function addYearsIso(iso: string, years: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const shifted = new Date(Date.UTC(year + years, month - 1, day));
  if (shifted.getUTCMonth() !== month - 1) shifted.setUTCDate(0);
  return shifted.toISOString().slice(0, 10);
}

const CAR_WORDS = ['รถยนต์', 'เก๋ง', 'กระบะ', 'รถตู้'];
const MOTO_WORDS = ['มอเตอร์ไซ', 'มอไซ', 'จักรยานยนต์', 'จยย'];
const TYPED_DATE = /(\d{1,2})\s*[/\-.]\s*(\d{1,2})\s*[/\-.]\s*(\d{1,4})(?!\d)/;

// ปีที่ลูกค้าพิมพ์ -> ค.ศ.: 4 หลักตั้งแต่ 2400 ถือเป็น พ.ศ. · 4 หลักต่ำกว่านั้นเป็น ค.ศ. · 2 หลักถือเป็น พ.ศ. 25xx (เช่น 62 = 2562)
function typedYear(text: string): number | null {
  const year = Number(text);
  if (text.length === 2) return 2500 + year - 543;
  if (text.length !== 4) return null;
  return year >= 2400 ? year - 543 : year;
}

export interface TypedTro {
  kind: TroKind | null; // null = ลูกค้าไม่ได้บอกประเภทรถ (หรือบอกทั้งสอง)
  date: string | null; // null = ไม่มีวันที่ในข้อความ · '' = มีแต่อ่านไม่ได้/ไม่มีจริง
}

// อ่านข้อความที่พิมพ์รวดเดียว เช่น "ตรอ มอไซค์ 5/3/62" - วันที่เป็น วัน/เดือน/ปี คั่นด้วย / - หรือ .
export function parseTypedTro(text: string): TypedTro {
  const car = CAR_WORDS.some((word) => text.includes(word));
  const moto = MOTO_WORDS.some((word) => text.includes(word));
  const kind = car === moto ? null : car ? 'car' : 'moto';

  const match = TYPED_DATE.exec(text);
  if (!match) return { kind, date: null };
  const year = typedYear(match[3]);
  const iso = year === null ? '' : `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return { kind, date: validIso(iso) ? iso : '' };
}

// วัน/เดือน/ปี พ.ศ. - ลูกค้าอ่านวันที่จากเล่มทะเบียนเป็น พ.ศ.
function thaiDate(iso: string): string {
  const [year, month, day] = iso.split('-');
  return `${day}/${month}/${Number(year) + 543}`;
}

export interface TroResult {
  kind: TroKind;
  ageYears: number;
  required: boolean;
  requiredFrom: string; // วันที่รถอายุครบเกณฑ์ (ต่อภาษีตั้งแต่วันนี้เป็นต้นไปต้องมีใบตรวจ)
}

// อายุรถนับ date-to-date จากวันจดทะเบียน ครบเกณฑ์ในวันครบรอบพอดีถือว่าต้องตรวจแล้ว (กฎเดียวกับงานต่อภาษี)
export function checkTro(kind: TroKind, registrationDate: string, today: string): TroResult | null {
  if (!validIso(registrationDate) || !validIso(today) || registrationDate > today) return null;
  const ageYears = inspectionAgeYears(kind);
  const requiredFrom = addYearsIso(registrationDate, ageYears);
  return { kind, ageYears, required: today >= requiredFrom, requiredFrom };
}

// คำถามแรก: ปุ่มประเภทรถ กดแล้วเปิดปฏิทินให้เลือกวันจดทะเบียน (ปฏิทินของ LINE เป็น ค.ศ. เลือกได้ไม่เกินวันนี้)
export function troQuestionMessage(today: string): LineMessage {
  const button = (kind: TroKind) => ({
    type: 'action' as const,
    action: { type: 'datetimepicker' as const, label: KIND_LABEL[kind], data: `${POSTBACK_PREFIX}${kind}`, mode: 'date' as const, max: today },
  });
  return {
    type: 'text',
    text: [
      'เช็กว่ารถต้องตรวจสภาพ (ตรอ.) ก่อนต่อภาษีแล้วหรือยัง',
      '',
      'กดเลือกประเภทรถด้านล่าง แล้วเลือกวันจดทะเบียนของรถ (ดูได้จากเล่มทะเบียน)',
      '',
      '* ปฏิทินเป็นปี ค.ศ. ให้นำปี พ.ศ. ลบ 543 เช่น 2562 = 2019',
      '',
      'หรือพิมพ์วันที่เป็น พ.ศ. เองได้ เช่น',
      'ตรอ รถยนต์ 15/03/2562',
      'ตรอ มอเตอร์ไซค์ 15/03/2562',
    ].join('\n'),
    quickReply: { items: [button('car'), button('moto')] },
  };
}

const TRO_NOTES = [
  '* รถที่ขาดต่อภาษีเกิน 1 ปี ต้องตรวจ ตรอ. ทุกคัน',
  '* เป็นผลเบื้องต้นจากวันที่ที่ให้มา หากไม่แน่ใจสอบถามเจ้าหน้าที่ได้',
];

function resultDetail(result: TroResult): string {
  return result.required
    ? `(รถอายุครบ ${result.ageYears} ปีแล้ว ตั้งแต่วันที่ ${thaiDate(result.requiredFrom)})`
    : `จะเริ่มต้องตรวจเมื่อต่อภาษีตั้งแต่วันที่ ${thaiDate(result.requiredFrom)} เป็นต้นไป (รถอายุครบ ${result.ageYears} ปี)`;
}

export function troResultMessage(result: TroResult, registrationDate: string): LineMessage {
  const lines = [
    `${KIND_LABEL[result.kind]} จดทะเบียนวันที่ ${thaiDate(registrationDate)}`,
    '',
    result.required ? 'ผล: ต้องตรวจ ตรอ. ก่อนต่อภาษี' : 'ผล: ยังไม่ต้องตรวจ ตรอ.',
    resultDetail(result),
    '',
    `เกณฑ์: รถยนต์ครบ ${inspectionAgeYears('car')} ปี มอเตอร์ไซค์ครบ ${inspectionAgeYears('moto')} ปี นับจากวันจดทะเบียน`,
    ...TRO_NOTES,
  ];
  return { type: 'text', text: lines.join('\n') };
}

// ลูกค้าพิมพ์วันที่มาแต่ไม่ได้บอกประเภทรถ = ตอบทั้งสองประเภท เพราะจำนวนปีไม่เท่ากัน
export function troBothResultMessage(results: TroResult[], registrationDate: string): LineMessage {
  const lines = [`จดทะเบียนวันที่ ${thaiDate(registrationDate)}`];
  for (const result of results) {
    lines.push('', `ถ้าเป็น${KIND_LABEL[result.kind]}: ${result.required ? 'ต้องตรวจ ตรอ. ก่อนต่อภาษี' : 'ยังไม่ต้องตรวจ ตรอ.'}`, resultDetail(result));
  }
  lines.push('', ...TRO_NOTES);
  return { type: 'text', text: lines.join('\n') };
}

export function troInvalidDateMessage(): LineMessage {
  return {
    type: 'text',
    text: 'วันจดทะเบียนไม่ถูกต้อง (ต้องเป็น วัน/เดือน/ปี และไม่เกินวันนี้)\nตัวอย่าง: ตรอ รถยนต์ 15/03/2562\nหรือพิมพ์ "ตรอ" เพื่อเลือกจากปฏิทิน',
  };
}
