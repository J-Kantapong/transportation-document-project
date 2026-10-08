// เช็กค่าภาษีรถประจำปีสำหรับลูกค้าในไลน์ (ผู้ใช้ 2026-10-09: "ใส่ฟีเจอร์เช็คค่าภาษี ... อย่าลืมรถไฟฟ้า ... นิติด้วย")
// บอทถามทีละข้อ: ประเภทรถ -> ซีซีหรือน้ำหนัก -> เจ้าของ (เฉพาะรถนั่ง) -> วันจดทะเบียน -> วันภาษีหมดอายุ -> ตอบยอด
// ยอดมาจาก calculateVehicleTax ตัวเดียวกับงานต่อภาษี (อัตราจากตาราง GovernmentTax* ชุดเดียวกัน) จึงไม่มีสูตรซ้ำที่นี่
// แสดงเฉพาะภาษีและเงินเพิ่มของกรมการขนส่ง - ห้ามมีค่าบริการของสำนักงาน และไม่แตะข้อมูลรถ/ลูกค้าในระบบ
// คำตอบระหว่างทางเก็บในหน่วยความจำต่อผู้ใช้ไลน์ (TaxSession) - เซิร์ฟเวอร์เริ่มใหม่ = ลูกค้าเริ่มถามใหม่
import { OwnerType } from '../generated/prisma/enums.js';
import type { LineMessage, QuickReply } from '../secretary/line-client.js';
import {
  calculateVehicleTax,
  VehicleTaxInputError,
  type VehicleTaxResult,
  type VehicleTaxRuleSet,
} from '../tax-renewal/vehicle-tax-calculator.js';
import { cardMessage, type CardButton, type MenuCard } from './customer-menu.js';
import { parseTypedDate, thaiDate, validIso } from './tro-check.js';

export type TaxKind = 'car' | 'ev' | 'pickup' | 'moto' | 'emoto';
export type TaxOwner = 'person' | 'company';

export interface TaxSession {
  kind: TaxKind;
  amount?: number; // ซีซี (car) หรือน้ำหนักรถ กก. (ev, pickup)
  owner?: TaxOwner;
  registered?: string; // YYYY-MM-DD
}

interface KindSpec {
  label: string;
  body: string; // Vehicle.body ที่ส่งให้ตัวคำนวณ
  fuel: string; // Vehicle.fuel ที่ส่งให้ตัวคำนวณ
  measure: 'cc' | 'weight' | null;
  asksOwner: boolean; // ตัวคูณนิติบุคคลมีผลกับ รย.1 เท่านั้น
  button: string;
}

// ไฮบริดคิดตามซีซีอัตราเดียวกับรถน้ำมัน จึงรวมเป็นตัวเลือกเดียว · กระบะ 4 ประตูจดเป็นรถนั่ง (รย.1) คิดตามซีซี
const KINDS: Record<TaxKind, KindSpec> = {
  car: { label: 'รถเก๋ง / รถนั่ง / กระบะ 4 ประตู', body: 'รย.1-เก๋ง 2 ตอน', fuel: 'เบนซิน', measure: 'cc', asksOwner: true, button: 'ภาษี เก๋ง' },
  ev: { label: 'รถยนต์ไฟฟ้า (EV)', body: 'รย.1-เก๋ง 2 ตอน', fuel: 'ไฟฟ้า (BEV)', measure: 'weight', asksOwner: true, button: 'ภาษี รถไฟฟ้า' },
  pickup: { label: 'กระบะ 2 ประตู / แค็บ', body: 'รย.3-กระบะบรรทุก', fuel: 'ดีเซล', measure: 'weight', asksOwner: false, button: 'ภาษี กระบะ' },
  moto: { label: 'มอเตอร์ไซค์', body: 'รย.12-น้อยกว่า 300cc', fuel: 'เบนซิน', measure: null, asksOwner: false, button: 'ภาษี มอเตอร์ไซค์' },
  emoto: { label: 'มอเตอร์ไซค์ไฟฟ้า', body: 'รย.12-น้อยกว่า 300cc', fuel: 'ไฟฟ้า (BEV)', measure: null, asksOwner: false, button: 'ภาษี มอเตอร์ไซค์ไฟฟ้า' },
};

const OWNER_LABEL: Record<TaxOwner, string> = { person: 'บุคคลธรรมดา', company: 'นิติบุคคล' };
const MEASURE = {
  cc: { name: 'ขนาดเครื่องยนต์', unit: 'ซีซี', min: 50, max: 10_000, example: '1496' },
  weight: { name: 'น้ำหนักรถ', unit: 'กก.', min: 300, max: 10_000, example: '1750' },
} as const;
const DATE_POSTBACK = 'tax:date';
const NOT_LAPSED = 'ยังไม่ขาด';
// ต่อภาษีล่วงหน้าได้ไม่เกิน 90 วันก่อนวันสิ้นอายุ
const EARLY_RENEWAL_DAYS = 90;

const compact = (text: string | undefined) => (text ?? '').toLowerCase().replace(/\s+/g, '');

// ลูกค้าถามเรื่องค่าภาษีหรือไม่ - "ต่อภาษี" เฉยๆ ไม่ใช่ (นั่นคือรายการเอกสารต่อภาษีในเมนู)
export function isTaxQuestion(text: string | undefined): boolean {
  const typed = compact(text);
  return typed.startsWith('ภาษี') || ['เช็กภาษี', 'เช็คภาษี', 'ค่าภาษี', 'คำนวณภาษี', 'คิดภาษี', 'ภาษีเท่าไ', 'ภาษีกี่บาท'].some((word) => typed.includes(word));
}

export function parseTaxKind(text: string | undefined): TaxKind | null {
  const typed = compact(text);
  const electric = typed.includes('ไฟฟ้า') || typed.includes('ev');
  if (['มอเตอร์ไซ', 'มอไซ', 'จักรยานยนต์', 'จยย'].some((word) => typed.includes(word))) return electric ? 'emoto' : 'moto';
  if (electric) return 'ev';
  if (typed.includes('กระบะ')) return 'pickup';
  if (['เก๋ง', 'รถนั่ง', 'รถยนต์'].some((word) => typed.includes(word))) return 'car';
  return null;
}

export const TAX_KIND_CARD: MenuCard = {
  id: 'tax-kind',
  keywords: [],
  title: 'เช็กค่าภาษีรถประจำปี',
  subtitle: 'ภาษีของกรมการขนส่ง โดยประมาณ',
  body: 'กดเลือกประเภทรถ แล้วตอบคำถามทีละข้อ (เตรียมเล่มทะเบียนไว้ดูข้อมูล)',
  buttons: (Object.keys(KINDS) as TaxKind[]).map((kind) => ({ label: KINDS[kind].label, text: KINDS[kind].button })),
};

const text = (...lines: string[]): LineMessage => ({ type: 'text', text: lines.join('\n') });
const CANCEL_HINT = '(พิมพ์ ยกเลิก เพื่อหยุด)';

function datePicker(label: string, max?: string): QuickReply {
  return { items: [{ type: 'action', action: { type: 'datetimepicker', label, data: DATE_POSTBACK, mode: 'date', ...(max ? { max } : {}) } }] };
}

// คำถามถัดไปของ session - ดูจากข้อที่ยังไม่มีคำตอบ ตามลำดับ: ซีซี/น้ำหนัก -> เจ้าของ -> วันจดทะเบียน -> วันภาษีหมดอายุ
export function taxQuestion(session: TaxSession, today: string): LineMessage {
  const spec = KINDS[session.kind];
  if (spec.measure && session.amount === undefined) {
    const measure = MEASURE[spec.measure];
    return text(
      `${spec.label}`,
      '',
      `พิมพ์${measure.name} (${measure.unit}) เป็นตัวเลข เช่น ${measure.example}`,
      spec.measure === 'cc' ? 'ดูได้จากเล่มทะเบียน ช่อง "ซีซี"' : 'ดูได้จากเล่มทะเบียน ช่อง "น้ำหนักรถ"',
      CANCEL_HINT,
    );
  }
  if (spec.asksOwner && session.owner === undefined) {
    return {
      ...text('เจ้าของรถเป็นบุคคลธรรมดาหรือนิติบุคคล', '', '* รถติดไฟแนนซ์ที่ผู้เช่าซื้อเป็นบุคคลธรรมดา ให้เลือก บุคคลธรรมดา'),
      quickReply: {
        items: (['person', 'company'] as TaxOwner[]).map((owner) => ({
          type: 'action' as const,
          action: { type: 'message' as const, label: OWNER_LABEL[owner], text: OWNER_LABEL[owner] },
        })),
      },
    };
  }
  if (session.registered === undefined) {
    return {
      ...text('วันจดทะเบียนของรถ (ดูจากเล่มทะเบียน)', '', 'พิมพ์เป็น วัน/เดือน/ปี พ.ศ. เช่น 15/03/2562', 'หรือกดปุ่มด้านล่างเพื่อเลือกจากปฏิทิน (ปฏิทินเป็นปี ค.ศ. = พ.ศ. ลบ 543)'),
      quickReply: datePicker('เลือกจากปฏิทิน', today),
    };
  }
  return {
    ...text(
      'ตอนนี้ภาษีขาดต่อหรือยัง',
      '',
      'ยังไม่ขาด: กดปุ่ม ยังไม่ขาด',
      'ขาดแล้ว: พิมพ์วันสิ้นอายุภาษี (ดูจากป้ายภาษี) เป็น วัน/เดือน/ปี พ.ศ. เช่น 15/03/2568 หรือกดเลือกจากปฏิทิน',
    ),
    quickReply: {
      items: [
        { type: 'action', action: { type: 'message', label: NOT_LAPSED, text: NOT_LAPSED } },
        ...datePicker('ขาดแล้ว เลือกวันหมดอายุ').items,
      ],
    },
  };
}

export interface TaxStep {
  session: TaxSession | null; // null = จบแล้ว (ได้ผล หรือคำนวณไม่ได้)
  message: LineMessage;
}

// rules = อัตราภาษี (ถ้ามี): รถที่ไม่ต้องถามซีซี/น้ำหนัก (มอเตอร์ไซค์) ลองคิดก่อนเลย ถ้ายังไม่มีอัตราของรถประเภทนั้น
// (เช่น มอเตอร์ไซค์ไฟฟ้า) จะได้บอกลูกค้าทันที ไม่ต้องให้ตอบคำถามจนจบแล้วค่อยบอกว่าคิดไม่ได้
export function startTax(kind: TaxKind, today: string, rules: VehicleTaxRuleSet | null = null): TaxStep {
  const session: TaxSession = { kind };
  if (rules && !KINDS[kind].measure) {
    const trial = compute({ ...session, registered: today }, null, today, rules);
    if (trial.message.type === 'text') return trial;
  }
  return { session, message: taxQuestion(session, today) };
}

function again(session: TaxSession, today: string, problem: string): TaxStep {
  const question = taxQuestion(session, today);
  return { session, message: question.type === 'text' ? { ...question, text: `${problem}\n\n${question.text}` } : question };
}

function readNumber(typed: string): number | null {
  const match = /\d[\d,]*(?:\.\d+)?/.exec(typed);
  if (!match) return null;
  const value = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

function readOwner(typed: string): TaxOwner | null {
  const value = compact(typed);
  if (value.includes('นิติ') || value.includes('บริษัท') || value.includes('หจก')) return 'company';
  if (value.includes('บุคคล')) return 'person';
  return null;
}

const utcDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const addDaysIso = (iso: string, days: number) => new Date(utcDate(iso).getTime() + days * 86_400_000).toISOString().slice(0, 10);
// ภาษียังไม่ขาด = ถือว่าครบกำหนดในวันครบรอบวันจดทะเบียนครั้งถัดไป (ลูกค้าไม่ต้องหาวันหมดอายุเอง) - 29 ก.พ. ใช้วันสุดท้ายของเดือน
export function nextAnniversary(registered: string, today: string): string {
  const [, month, day] = registered.split('-').map(Number);
  const at = (year: number) => {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCMonth() !== month - 1) date.setUTCDate(0);
    return date.toISOString().slice(0, 10);
  };
  let year = Number(today.slice(0, 4));
  while (at(year) < today || at(year) <= registered) year += 1;
  return at(year);
}

const baht = (amount: number) => amount.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const RESULT_BUTTONS: CardButton[] = [
  { label: 'เอกสารต่อภาษี', text: 'ต่อภาษี' },
  { label: 'เช็กคันอื่น', text: 'เช็กภาษี' },
  { label: 'ติดต่อเจ้าหน้าที่', text: 'ติดต่อเจ้าหน้าที่' },
];

export function taxResultCard(
  session: TaxSession & { registered: string },
  expiry: string | null, // null = ลูกค้าตอบว่ายังไม่ขาดต่อ
  result: VehicleTaxResult,
  today: string,
): MenuCard {
  const spec = KINDS[session.kind];
  const measure = spec.measure ? MEASURE[spec.measure] : null;
  const lines = [
    measure && session.amount !== undefined ? `${spec.label} ${session.amount.toLocaleString('th-TH')} ${measure.unit}` : spec.label,
    ...(session.owner ? [`เจ้าของ: ${OWNER_LABEL[session.owner]}`] : []),
    `จดทะเบียน ${thaiDate(session.registered)}`,
    expiry ? `ภาษีหมดอายุ ${thaiDate(expiry)}` : `ภาษียังไม่ขาด (ครบกำหนดครั้งถัดไปประมาณ ${thaiDate(nextAnniversary(session.registered, today))})`,
    '',
  ];

  if (result.taxCycleCount > 1) {
    lines.push(`ค้างภาษี ${result.taxCycleCount} ปี`);
    for (const cycle of result.cycles) {
      const due = thaiDate(cycle.dueDate.toISOString().slice(0, 10));
      lines.push(`- งวด ${due}: ภาษี ${baht(cycle.annualVehicleTax)} + เงินเพิ่ม ${baht(cycle.lateFee)}`);
    }
    lines.push('', `ภาษีรวม ${baht(result.annualVehicleTax)} บาท`, `เงินเพิ่มรวม ${baht(result.lateFee)} บาท`);
  } else {
    const discount = result.ageDiscountRate > 0 ? ` (รถปีที่ ${result.vehicleYear} ลด ${Math.round(result.ageDiscountRate * 100)}% แล้ว)` : '';
    lines.push(`ภาษีประจำปี ${baht(result.annualVehicleTax)} บาท${discount}`);
    if (result.lateFee > 0) lines.push(`เงินเพิ่มล่าช้า ${result.lateMonths} เดือน ${baht(result.lateFee)} บาท`);
  }
  lines.push(`รวมชำระกรมการขนส่ง ${baht(result.annualVehicleTax + result.lateFee)} บาท`, '');
  lines.push(result.inspectionRequired ? 'ตรอ.: ต้องตรวจสภาพก่อนต่อภาษี' : 'ตรอ.: ยังไม่ต้องตรวจสภาพ', '');

  lines.push('* เป็นยอดโดยประมาณจากข้อมูลที่ให้มา ยังไม่รวม พ.ร.บ. ค่าตรวจสภาพ และค่าบริการ');
  if (result.companyMultiplier > 1) lines.push('* รถนั่งของนิติบุคคล ภาษีเป็นสองเท่าของบุคคลธรรมดา');
  if (spec.measure === 'cc') lines.push('* รถติดแก๊ส NGV/LPG ยอดจริงอาจต่างจากนี้');
  if (session.kind === 'pickup') lines.push('* กระบะไฟฟ้า กรุณาสอบถามเจ้าหน้าที่');
  if (expiry && expiry > addDaysIso(today, EARLY_RENEWAL_DAYS)) lines.push(`* ต่อภาษีล่วงหน้าได้ไม่เกิน ${EARLY_RENEWAL_DAYS} วันก่อนวันสิ้นอายุ`);
  if (result.taxCycleCount > 3) lines.push('* ค้างภาษีเกิน 3 ปี ทะเบียนอาจถูกระงับ กรุณาสอบถามเจ้าหน้าที่ก่อน');

  return { id: 'tax-result', keywords: [], title: 'ค่าภาษีรถโดยประมาณ', subtitle: 'ภาษีของกรมการขนส่ง', body: lines.join('\n'), buttons: RESULT_BUTTONS };
}

function compute(session: TaxSession & { registered: string }, typedExpiry: string | null, today: string, rules: VehicleTaxRuleSet): TaxStep {
  const spec = KINDS[session.kind];
  const expiry = typedExpiry ?? nextAnniversary(session.registered, today);
  try {
    const result = calculateVehicleTax(
      {
        vehicleType: spec.body,
        fuel: spec.fuel,
        engineCc: spec.measure === 'cc' ? session.amount : null,
        vehicleWeightKg: spec.measure === 'weight' ? session.amount : null,
        firstRegistrationDate: utcDate(session.registered),
        taxExpiryDate: utcDate(expiry),
        paymentDate: utcDate(today),
        owner: {
          ownerType: session.owner === 'company' ? OwnerType.JURISTIC : OwnerType.INDIVIDUAL,
          isHirePurchaseBusiness: false,
          hirerType: null,
        },
        // ใบ ตรอ. เป็นเรื่องของลูกค้า - ไม่ต้องให้ตัวคำนวณเตือนว่ายังไม่ได้ติ๊ก
        inspectionCertificateConfirmed: true,
      },
      rules,
    );
    return { session: null, message: cardMessage(taxResultCard(session, typedExpiry, result, today)) };
  } catch (error) {
    if (!(error instanceof VehicleTaxInputError)) throw error;
    // ข้อความของตัวคำนวณเขียนไว้ให้พนักงานอ่าน - ลูกค้าได้คำตอบกลางๆ แทน
    return {
      session: null,
      message: text(`ขออภัยครับ ระบบยังคำนวณภาษีของ${spec.label}จากข้อมูลนี้ไม่ได้`, 'กรุณาติดต่อเจ้าหน้าที่ (พิมพ์ ติดต่อเจ้าหน้าที่)'),
    };
  }
}

// คำตอบของลูกค้าต่อคำถามปัจจุบัน - typed = ข้อความที่พิมพ์ · pickedDate = วันที่จากปฏิทิน (postback)
export function answerTax(
  session: TaxSession,
  input: { typed?: string; pickedDate?: string },
  today: string,
  rules: VehicleTaxRuleSet,
): TaxStep {
  const spec = KINDS[session.kind];
  const typed = input.typed ?? '';

  if (spec.measure && session.amount === undefined) {
    const measure = MEASURE[spec.measure];
    const value = readNumber(typed);
    if (value === null || value < measure.min || value > measure.max) {
      return again(session, today, `อ่าน${measure.name}ไม่ได้ ต้องเป็นตัวเลข ${measure.min.toLocaleString('th-TH')} ถึง ${measure.max.toLocaleString('th-TH')} ${measure.unit}`);
    }
    const next = { ...session, amount: value };
    return { session: next, message: taxQuestion(next, today) };
  }

  if (spec.asksOwner && session.owner === undefined) {
    const owner = readOwner(typed);
    if (!owner) return again(session, today, 'กรุณากดเลือก บุคคลธรรมดา หรือ นิติบุคคล');
    const next = { ...session, owner };
    return { session: next, message: taxQuestion(next, today) };
  }

  if (session.registered !== undefined && compact(typed).includes('ไม่ขาด')) return compute({ ...session, registered: session.registered }, null, today, rules);

  const date = input.pickedDate ?? parseTypedDate(typed);
  if (!date || !validIso(date)) return again(session, today, 'อ่านวันที่ไม่ได้ ต้องเป็น วัน/เดือน/ปี เช่น 15/03/2562');

  if (session.registered === undefined) {
    if (date > today) return again(session, today, 'วันจดทะเบียนต้องไม่เกินวันนี้');
    const next = { ...session, registered: date };
    return { session: next, message: taxQuestion(next, today) };
  }

  const registered = session.registered;
  if (date <= registered) return again(session, today, 'วันสิ้นอายุภาษีต้องอยู่หลังวันจดทะเบียน');
  if (date > addDaysIso(today, 366 + EARLY_RENEWAL_DAYS)) return again(session, today, 'วันสิ้นอายุภาษีไกลเกินไป กรุณาตรวจสอบอีกครั้ง');
  return compute({ ...session, registered }, date, today, rules);
}

export function isTaxDatePostback(data: string | undefined): boolean {
  return data === DATE_POSTBACK;
}

export function isCancel(text: string | undefined): boolean {
  return ['ยกเลิก', 'cancel', 'หยุด'].includes(compact(text));
}
