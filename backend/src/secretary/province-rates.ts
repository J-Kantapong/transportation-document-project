// เรทจดทะเบียนต่างจังหวัดในไลน์เลขา (ผู้ใช้ 2026-11-17 "ทำตารางเรททุกจังหวัด แล้วเอาใส่ไลน์เลขาส่วนตัว ระบุว่าต้องเอารถไปตรวจ
// ด้วยรึเปล่า พร้อมต้นทุนซับ") - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล (SecretaryService อ่าน SupplierProvinceRate แล้วส่งเข้ามา)
//   "เรทจังหวัด" / "ตารางเรท"      = ตารางทุกจังหวัด
//   "เรท ภูเก็ต" / "จดอุบล" / "โคราช" = จังหวัดเดียว: เรทเสนอลูกค้า + ต้องนำรถไปตรวจไหม + ต้นทุนซับ
// เรทเสนอ = ค่าจดก่อน VAT ไม่รวมแจ้งย้ายและค่าธรรมเนียมตามใบเสร็จ - เป็นราคาแนะนำไว้ตอบลูกค้า ไม่ได้ใช้คิดเงินในระบบ
// (ราคาขายจริงยังเป็น ServiceFeeRate ของลูกค้าแต่ละราย) · ต้นทุนซับอ่านจากตารางราคาซับสดทุกครั้ง
import { isSupplierProvince } from '../document-submission/supplier-route.js';
import { PROVINCES } from '../vehicles/vehicle-reference-data.js';

export const TRANSFER_NOTICE_QUOTE = 200; // ค่าแจ้งย้ายที่เสนอลูกค้าแยกจากค่าจด
const MAX_TEXT = 4500; // LINE รับข้อความละไม่เกิน 5,000 ตัวอักษร
const MAX_MESSAGES = 5;

// จัดชั้นตามระยะทางจากกรุงเทพฯ โดยประมาณ (ผู้ใช้ 2026-11-17 "ผมมองเป็นระยะทางมากกว่า") และยึดราคาที่เคยเสนอลูกค้าไว้แล้ว:
// นนทบุรี/ชลบุรี 3,000 · อยุธยา/ฉะเชิงเทรา/เพชรบุรี 3,200 · ระยอง 3,500 · นครสวรรค์/นครราชสีมา/ภูเก็ต 4,000 · สมุทรปราการ 3,500
// จังหวัดที่ไม่อยู่ในชั้นไหน = ชั้นไกล (FAR_PRICE) · แก้เรทแก้ที่ตารางนี้ที่เดียว
export const FAR_PRICE = 4000;
export const QUOTE_TIERS: Array<{ price: number; label: string; provinces: string[] }> = [
  { price: 3000, label: 'ปริมณฑลและใกล้', provinces: ['นนทบุรี', 'ปทุมธานี', 'นครปฐม', 'สมุทรสาคร', 'ชลบุรี', 'นครนายก'] },
  {
    price: 3200,
    label: 'ราว 70-150 กม.',
    provinces: ['พระนครศรีอยุธยา', 'ฉะเชิงเทรา', 'เพชรบุรี', 'สมุทรสงคราม', 'ราชบุรี', 'กาญจนบุรี', 'สุพรรณบุรี', 'อ่างทอง', 'สิงห์บุรี', 'สระบุรี', 'ลพบุรี', 'ปราจีนบุรี'],
  },
  { price: 3500, label: 'ราว 150-300 กม. ตะวันออกและกลางตอนบน', provinces: ['ระยอง', 'จันทบุรี', 'สระแก้ว', 'ชัยนาท', 'อุทัยธานี', 'ประจวบคีรีขันธ์'] },
  { price: 4500, label: 'สามจังหวัดชายแดนใต้', provinces: ['ยะลา', 'ปัตตานี', 'นราธิวาส'] },
];
// ออฟฟิศจดเอง (ไม่ผ่านซับ): สมุทรปราการเสนอ 3,500 ไม่ต้องนำรถไป · กรุงเทพฯ ใช้เรทปกติของลูกค้า
const SAMUT_PRAKAN_PRICE = 3500;

const PRICE_BY_PROVINCE = new Map<string, number>(QUOTE_TIERS.flatMap((t) => t.provinces.map((p) => [p, t.price] as [string, number])));

// เรทเสนอของจังหวัด - null = กรุงเทพฯ (ไม่มีเรทต่างจังหวัด)
export function quotePriceOf(province: string): number | null {
  if (province === 'กรุงเทพมหานคร') return null;
  if (province === 'สมุทรปราการ') return SAMUT_PRAKAN_PRICE;
  return PRICE_BY_PROVINCE.get(province) ?? FAR_PRICE;
}

// ต้องนำรถเข้าตรวจที่จังหวัดที่จดหรือไม่: ทุกจังหวัดที่ส่งซับ = ต้อง (ซับตอบแบบนี้ทุกจังหวัดที่เคยถาม และใบราคาซับคิด
// "นำรถเข้าตรวจสภาพ" ทุกจังหวัด) · กรุงเทพฯ/สมุทรปราการ ออฟฟิศจดเอง = ไม่ต้อง
export function needsCarAtProvince(province: string): boolean {
  return isSupplierProvince(province);
}

// ชื่อเรียกสั้นที่ไม่ได้ขึ้นต้นเหมือนชื่อเต็ม (ชื่อย่อที่เป็นส่วนต้นของชื่อเต็ม เช่น "อุบล" "ปทุม" จับได้เองจาก startsWith)
const ALIASES: Record<string, string> = {
  กทม: 'กรุงเทพมหานคร',
  'กทม.': 'กรุงเทพมหานคร',
  กรุงเทพ: 'กรุงเทพมหานคร',
  กรุงเทพฯ: 'กรุงเทพมหานคร',
  โคราช: 'นครราชสีมา',
  อยุธยา: 'พระนครศรีอยุธยา',
  แปดริ้ว: 'ฉะเชิงเทรา',
  ปากน้ำ: 'สมุทรปราการ',
  นนท์: 'นนทบุรี',
  นครศรี: 'นครศรีธรรมราช',
  สุราษฎร์: 'สุราษฎร์ธานี',
  สุราษ: 'สุราษฎร์ธานี',
  ประจวบ: 'ประจวบคีรีขันธ์',
  กาญ: 'กาญจนบุรี',
  กาญจน์: 'กาญจนบุรี',
};

export type ProvinceRateCommand = { kind: 'all' } | { kind: 'province'; province: string } | { kind: 'ambiguous'; candidates: string[] };

// หาจังหวัดจากข้อความ: ตรงชื่อ > ชื่อเรียกสั้น > ส่วนต้นของชื่อ (อย่างน้อย 3 ตัวอักษร) - หลายจังหวัดเข้าเกณฑ์ = ให้เลือก
function resolveProvince(name: string): ProvinceRateCommand | null {
  if ((PROVINCES as readonly string[]).includes(name)) return { kind: 'province', province: name };
  if (ALIASES[name]) return { kind: 'province', province: ALIASES[name] };
  if (name.length < 3) return null;
  const matches = PROVINCES.filter((p) => p.startsWith(name));
  if (matches.length === 1) return { kind: 'province', province: matches[0] };
  return matches.length > 1 ? { kind: 'ambiguous', candidates: [...matches] } : null;
}

// คืน null = ไม่ใช่คำสั่งเรทจังหวัด (ให้ไปจับเป็นคำสั่งอื่นต่อ) - ทั้งข้อความต้องเป็นคำนำ (เรท/ราคา/ค่า/จด) กับชื่อจังหวัดเท่านั้น
export function parseProvinceRateCommand(input: string): ProvinceRateCommand | null {
  const text = input.replace(/\s+/g, '');
  if (/^(?:ตาราง)?(?:เรท|ราคา)(?:จด(?:ทะเบียน)?)?(?:ต่างจังหวัด|ทุกจังหวัด|จังหวัด|ซับ|ทั้งหมด)?$/.test(text) && text !== 'ราคา') return { kind: 'all' };
  const m = /^(?:เช็[คก])?(?:เรท|ราคา|ค่า)?(?:จด(?:ทะเบียน)?)?(?:จังหวัด|จ\.)?(.+)$/.exec(text);
  return m ? resolveProvince(m[1]) : null;
}

// แถวราคาซับจากฐานข้อมูล (SupplierProvinceRate) - ตัวเลขแปลงเป็น number แล้ว
export interface SupplierCostRow {
  province: string;
  accepts: boolean;
  serviceFee: number | null;
  channelFee: number | null;
  inspectionFee: number | null;
  plateSwapFee: number | null;
  plateSwapNote: string | null;
}

const money = (amount: number) => amount.toLocaleString('en-US', { maximumFractionDigits: 2 });

// ค่าจ้างซับต่อคัน = 3 ช่องรวมกัน - null = ไม่มีแถว / ซับไม่รับ / ราคายังไม่ครบ (กติกาเดียวกับ SupplierRatesService.findAll)
export function supplierCostTotal(row: SupplierCostRow | undefined): number | null {
  if (!row || !row.accepts) return null;
  const fees = [row.serviceFee, row.channelFee, row.inspectionFee];
  return fees.every((f) => f !== null) ? fees.reduce<number>((sum, f) => sum + (f ?? 0), 0) : null;
}

export function provinceRateText(province: string, row: SupplierCostRow | undefined): string {
  if (province === 'กรุงเทพมหานคร') {
    return ['จดทะเบียนกรุงเทพมหานคร', 'ออฟฟิศจดเอง ไม่ผ่านซับ ไม่มีแจ้งย้าย', 'เรท: ใช้ค่าบริการปกติของลูกค้าแต่ละราย', 'ตรวจรถ: ไม่ต้องนำรถไปต่างจังหวัด'].join('\n');
  }
  const price = quotePriceOf(province)!;
  const quote = `เรทเสนอ: ${money(price)} + แจ้งย้าย ${money(TRANSFER_NOTICE_QUOTE)} + จากใบเสร็จ (ยังไม่รวม VAT)`;
  if (!needsCarAtProvince(province)) {
    return [`จดทะเบียนจังหวัด${province}`, quote, 'ตรวจรถ: ไม่ต้องนำรถไป', 'ต้นทุนซับ: ไม่มี (ออฟฟิศจดเอง ไม่ผ่านซับ)'].join('\n');
  }
  const head = `จดทะเบียนจังหวัด${province} (ส่งซับ)`;
  const inspection = `ตรวจรถ: ต้องนำรถเข้าตรวจที่${province}`;
  if (row && !row.accepts) return [head, 'ซับไม่รับจดจังหวัดนี้ - ยังเสนอราคาลูกค้าไม่ได้'].join('\n');
  const total = supplierCostTotal(row);
  if (!row || total === null) {
    return [head, quote, inspection, `ต้นทุนซับ: ${row ? 'ราคาซับในระบบยังไม่ครบ' : 'ยังไม่มีราคาซับในระบบ'} - ถามซับก่อนเสนอราคา`].join('\n');
  }
  const lines = [
    head,
    quote,
    inspection,
    `ต้นทุนซับ: ${money(total)} (ค่าดำเนินการ ${money(row.serviceFee!)} · ค่าช่อง ${money(row.channelFee!)} · นำรถเข้าตรวจ ${money(row.inspectionFee!)})`,
    `เหลือหลังหักค่าซับ: ${money(price - total)} (ยังไม่หักภาษี)`,
  ];
  if (row.plateSwapFee !== null || row.plateSwapNote) {
    const swap = [row.plateSwapFee !== null ? `ซับคิดเพิ่ม ${money(row.plateSwapFee)}` : '', row.plateSwapNote ?? ''].filter(Boolean).join(' · ');
    lines.push(`สลับป้าย: ${swap} (ไม่รวมในเรทเสนอ)`);
  }
  return lines.join('\n');
}

export function ambiguousProvinceText(candidates: string[]): string {
  return ['มีหลายจังหวัดที่ขึ้นต้นแบบนี้ พิมพ์ชื่อให้ยาวขึ้น:', ...candidates.map((p) => `• ${p}`)].join('\n');
}

const thaiSort = (a: string, b: string) => a.localeCompare(b, 'th');

// ตารางทุกจังหวัด: แยกตามเรทเสนอ แล้วรวมจังหวัดที่ต้นทุนซับเท่ากันไว้บรรทัดเดียว (77 จังหวัดอยู่ในข้อความเดียว)
export function provinceRateTableTexts(rows: SupplierCostRow[]): string[] {
  const byProvince = new Map(rows.map((r) => [r.province, r]));
  const supplierProvinces = PROVINCES.filter((p) => needsCarAtProvince(p));
  const refused = supplierProvinces.filter((p) => byProvince.get(p)?.accepts === false).sort(thaiSort);
  const priced = supplierProvinces.filter((p) => !refused.includes(p));

  const blocks: string[] = [
    [
      'เรทจดต่างจังหวัด (ค่าจดก่อน VAT)',
      `ทุกจังหวัดบวกแจ้งย้าย ${money(TRANSFER_NOTICE_QUOTE)} + จากใบเสร็จ`,
      'ทุกจังหวัดที่ส่งซับ ต้องนำรถเข้าตรวจที่จังหวัดนั้น',
      'พิมพ์ "เรท ภูเก็ต" เพื่อดูรายละเอียดจังหวัดเดียว',
    ].join('\n'),
  ];
  const prices = [...new Set(priced.map((p) => quotePriceOf(p)!))].sort((a, b) => a - b);
  for (const price of prices) {
    const provinces = priced.filter((p) => quotePriceOf(p) === price);
    const byCost = new Map<number | null, string[]>();
    for (const p of provinces) {
      const cost = supplierCostTotal(byProvince.get(p));
      byCost.set(cost, [...(byCost.get(cost) ?? []), p]);
    }
    const costs = [...byCost.keys()].sort((a, b) => (a ?? Infinity) - (b ?? Infinity));
    const label = QUOTE_TIERS.find((t) => t.price === price)?.label ?? 'จังหวัดไกล';
    blocks.push(
      [
        `▸ เรท ${money(price)} (${label})`,
        ...costs.map((cost) => `${cost === null ? 'ยังไม่มีราคาซับ' : `ซับ ${money(cost)}`}: ${byCost.get(cost)!.sort(thaiSort).join(', ')}`),
      ].join('\n'),
    );
  }
  if (refused.length) blocks.push(`▸ ซับไม่รับจด: ${refused.join(', ')}`);
  blocks.push(`▸ ออฟฟิศจดเอง ไม่ต้องนำรถไป\nสมุทรปราการ ${money(SAMUT_PRAKAN_PRICE)} · กรุงเทพมหานคร ใช้เรทปกติของลูกค้า`);

  // รวมบล็อกเป็นข้อความ ไม่ให้เกินความยาวต่อข้อความของ LINE
  const texts: string[] = [];
  for (const block of blocks) {
    const last = texts[texts.length - 1];
    if (last !== undefined && last.length + block.length + 2 <= MAX_TEXT) texts[texts.length - 1] = `${last}\n\n${block}`;
    else texts.push(block.slice(0, MAX_TEXT));
  }
  return texts.slice(0, MAX_MESSAGES);
}
