// ใบต้นทุนต่อคันของงานแต่ละแบบ (ผู้ใช้ 2026-11-18 "อยากได้สรุปต้นทุนงานแต่ละแบบว่าคันละเท่าไหร่ พวก bill nobill เพื่อเสนอลูกค้า
// เช่น สลับเลข มีอะไรบ้างราคาเท่าไหร่") - คำสั่ง "ต้นทุน <งาน>" ของเลขาไลน์
// ตัวเลขทุกตัวอ่านจากไฟล์อัตราของงานนั้นเอง (*-fee.ts) ไม่พิมพ์ซ้ำที่นี่ แก้อัตราที่ไฟล์เดิม ข้อความนี้เปลี่ยนตาม
// Bill = ค่าธรรมเนียมตามใบเสร็จกรมขนส่ง (เก็บลูกค้าเท่าจริง) · No Bill = ลงขัน ไม่มีใบเสร็จ · ค่าอากรแยกบรรทัด
import { PLATE_COPY_CAR_URGENT_FEE, PLATE_COPY_DUTY_FEE, PLATE_COPY_MOTO_NO_BILL_FEE, PLATE_COPY_MOTO_URGENT_FEE, PLATE_COPY_NO_BILL_FEE, PLATE_COPY_PLATE_FEES, PLATE_COPY_REQUEST_FEE } from '../plate-copy/plate-copy-fee.js';
import {
  DUTY_LABEL,
  PLATE_SWAP_CAR_BASE_ITEMS,
  PLATE_SWAP_CAR_NO_BILL_ITEMS,
  PLATE_SWAP_CAR_NUMBER_ITEMS,
  PLATE_SWAP_MOTO_BASE_ITEMS,
  PLATE_SWAP_MOTO_NO_BILL_ITEMS,
  PLATE_SWAP_MOTO_NUMBER_ITEM,
  PLATE_SWAP_MOTO_PLATE_ITEM,
  PLATE_SWAP_MOTO_URGENT_ITEM,
  type FeeItem,
} from '../plate-swap/plate-swap-fee.js';
import { TAX_RENEWAL_CONTRIBUTION_CAR, TAX_RENEWAL_CONTRIBUTION_MOTO, TAX_RENEWAL_CONTRIBUTION_TRANSPORT, TAX_RENEWAL_INSPECTION_FEE_TRANSPORT } from '../tax-renewal/tax-renewal-fee.js';
import { MOVE_OUT_MOTO_BILL_FEE, MOVE_OUT_MOTO_DUTY_FEE, MOVE_OUT_MOTO_LUNGKAN_FEE, MOVE_OUT_MOTO_URGENT_EXTRA } from '../vehicle-move-out/vehicle-move-out-fee.js';
import {
  TRANSFER_CAR_NO_BILL_SHARE,
  TRANSFER_CAR_URGENT_ITEM,
  TRANSFER_FINE_AMOUNT,
  TRANSFER_FINE_LABEL,
  TRANSFER_MOTO_BILL_NORMAL,
  TRANSFER_MOTO_BILL_USE_REQUEST,
  TRANSFER_MOTO_DUTY_NORMAL,
  TRANSFER_MOTO_DUTY_USE_REQUEST,
  TRANSFER_MOTO_NO_BILL_SHARE,
  TRANSFER_MOTO_URGENT_ITEM,
  TRANSFER_MOVE_IN_BILL,
  TRANSFER_MOVE_IN_CONTRIBUTION,
  TRANSFER_MOVE_IN_DUTY,
  TRANSFER_STAMP_DUTY_LABEL,
} from '../vehicle-transfer/vehicle-transfer-fee.js';
import { VEHICLE_USE_CANCEL_BILL_FEE, VEHICLE_USE_CANCEL_DUTY_FEE, VEHICLE_USE_CANCEL_NO_BILL_FEE } from '../vehicle-use-cancellation/vehicle-use-cancellation-fee.js';
import { YAMAHA_RELOCATION_BILL_RATE, YAMAHA_RELOCATION_NO_BILL_RATE } from '../yamaha-relocation/yamaha-relocation-fee.js';
import type { LineMessage, QuickReply } from './line-client.js';

// แบบหนึ่งของงาน (เช่น สลับเลขรถยนต์ - เลขสงวน): รายการที่ต้องจ่ายเสมอ + รายการที่เพิ่มเมื่อเลือก (ป้าย / ด่วน / ค่าปรับ)
export interface CostVariant {
  title: string;
  bill: FeeItem[];
  billOptional?: FeeItem[];
  noBill: FeeItem[];
  noBillOptional?: FeeItem[];
  duty?: number; // ค่าอากร
  notes?: string[];
}

export interface CostSheet {
  key: string;
  title: string; // ชื่องาน
  keywords: string[]; // คำที่พิมพ์หลัง "ต้นทุน" (มีคำนี้อยู่ในข้อความ = งานนี้)
  variants: CostVariant[];
  notes?: string[];
}

const item = (label: string, amount: number): FeeItem => ({ label, amount });
const dutyOf = (items: FeeItem[]) => items.filter((i) => i.label === DUTY_LABEL).reduce((s, i) => s + i.amount, 0);
const withoutDuty = (items: FeeItem[]) => items.filter((i) => i.label !== DUTY_LABEL);

const swapCar = (title: string, source: keyof typeof PLATE_SWAP_CAR_NUMBER_ITEMS): CostVariant => {
  const n = PLATE_SWAP_CAR_NUMBER_ITEMS[source];
  return {
    title,
    bill: [...PLATE_SWAP_CAR_BASE_ITEMS, n.number],
    billOptional: [n.normalPlate, ...(n.auctionPlate ? [n.auctionPlate] : [])],
    noBill: withoutDuty(PLATE_SWAP_CAR_NO_BILL_ITEMS),
    duty: dutyOf(PLATE_SWAP_CAR_NO_BILL_ITEMS),
  };
};

const copyCar = (title: string, type: keyof typeof PLATE_COPY_PLATE_FEES): CostVariant => ({
  title,
  bill: [item('คำขอ', PLATE_COPY_REQUEST_FEE), item('ค่าแผ่นป้าย', PLATE_COPY_PLATE_FEES[type])],
  noBill: [item('ลงขัน', PLATE_COPY_NO_BILL_FEE)],
  noBillOptional: [item('ลงขันด่วนเพิ่ม', PLATE_COPY_CAR_URGENT_FEE)],
  duty: PLATE_COPY_DUTY_FEE,
});

const PROVINCE_NOTE = 'ลงขันเป็นอัตรากรุงเทพฯ จังหวัดอื่นตามตารางลงขันงานโอนรายจังหวัด';

export const COST_SHEETS: CostSheet[] = [
  {
    key: 'plateSwap',
    title: 'สลับเลข',
    keywords: ['สลับ'],
    variants: [
      swapCar('รถยนต์ - เลขที่ไม่เคยออกให้รถคันอื่น', 'NEW_UNUSED'),
      swapCar('รถยนต์ - เลขสงวน / เลขประมูล', 'AUCTION_RESERVED'),
      {
        title: 'จักรยานยนต์',
        bill: [...PLATE_SWAP_MOTO_BASE_ITEMS, PLATE_SWAP_MOTO_NUMBER_ITEM],
        billOptional: [PLATE_SWAP_MOTO_PLATE_ITEM],
        noBill: withoutDuty(PLATE_SWAP_MOTO_NO_BILL_ITEMS),
        noBillOptional: [PLATE_SWAP_MOTO_URGENT_ITEM],
        duty: dutyOf(PLATE_SWAP_MOTO_NO_BILL_ITEMS),
      },
    ],
    notes: ['เป็นค่าใช้จ่ายฝั่งรถเก่าที่ให้เลข · ฝั่งรถใหม่คิดตามงานจดทะเบียน'],
  },
  {
    key: 'transfer',
    title: 'งานโอน',
    keywords: ['โอน'],
    variants: [
      {
        title: 'จักรยานยนต์ - โอนปกติ',
        bill: TRANSFER_MOTO_BILL_NORMAL,
        billOptional: [item(`${TRANSFER_FINE_LABEL} (เกิน 15 วัน)`, TRANSFER_FINE_AMOUNT)],
        noBill: [TRANSFER_MOTO_NO_BILL_SHARE],
        noBillOptional: [TRANSFER_MOTO_URGENT_ITEM],
        duty: TRANSFER_MOTO_DUTY_NORMAL,
      },
      {
        title: 'จักรยานยนต์ - โอนขอใช้',
        bill: TRANSFER_MOTO_BILL_USE_REQUEST,
        billOptional: [item(`${TRANSFER_FINE_LABEL} (เกิน 15 วัน)`, TRANSFER_FINE_AMOUNT)],
        noBill: [TRANSFER_MOTO_NO_BILL_SHARE],
        noBillOptional: [TRANSFER_MOTO_URGENT_ITEM],
        duty: TRANSFER_MOTO_DUTY_USE_REQUEST,
      },
      {
        title: 'จักรยานยนต์ - โอนย้ายเข้า',
        bill: TRANSFER_MOVE_IN_BILL,
        billOptional: [item(`${TRANSFER_FINE_LABEL} (เกิน 15 วัน)`, TRANSFER_FINE_AMOUNT)],
        noBill: [item('ลงขัน (ยังไม่มีอัตรา)', TRANSFER_MOVE_IN_CONTRIBUTION)],
        noBillOptional: [TRANSFER_MOTO_URGENT_ITEM],
        duty: TRANSFER_MOVE_IN_DUTY,
        notes: [`+ ${TRANSFER_STAMP_DUTY_LABEL} ใน Bill รู้ยอดเมื่อใบเสร็จออก`],
      },
      {
        title: 'รถยนต์',
        bill: [],
        noBill: [TRANSFER_CAR_NO_BILL_SHARE],
        noBillOptional: [TRANSFER_CAR_URGENT_ITEM],
        notes: ['Bill รถยนต์ยังไม่มีอัตราในระบบ (พนักงานกรอกตามใบเสร็จ) · ไม่มีค่าอากร'],
      },
    ],
    notes: [PROVINCE_NOTE, 'งานโอนตรวจรถมีค่าตรวจรถเพิ่มตามที่จ่ายจริง'],
  },
  {
    key: 'plateCopy',
    title: 'คัดแผ่นป้ายทะเบียน',
    keywords: ['คัด'],
    variants: [
      copyCar('รถยนต์ - คัดคู่ ป้ายปกติ', 'BOTH'),
      copyCar('รถยนต์ - ใบเดียว ป้ายปกติ', 'SINGLE_NORMAL'),
      copyCar('รถยนต์ - คัดคู่ ป้ายประมูล', 'BOTH_AUCTION'),
      copyCar('รถยนต์ - ใบเดียว ป้ายประมูล', 'SINGLE_AUCTION'),
      {
        title: 'จักรยานยนต์',
        bill: [item('คำขอ', PLATE_COPY_REQUEST_FEE), item('ค่าแผ่นป้าย', PLATE_COPY_PLATE_FEES.SINGLE_NORMAL)],
        noBill: [item('ลงขัน', PLATE_COPY_MOTO_NO_BILL_FEE)],
        noBillOptional: [item('ลงขันด่วนเพิ่ม', PLATE_COPY_MOTO_URGENT_FEE)],
        duty: PLATE_COPY_DUTY_FEE,
      },
    ],
  },
  {
    key: 'useCancel',
    title: 'ยกเลิกการใช้รถ',
    keywords: ['ยกเลิก'],
    variants: [
      {
        title: 'รถยนต์ / จักรยานยนต์',
        bill: [item('ค่าธรรมเนียม', VEHICLE_USE_CANCEL_BILL_FEE)],
        noBill: [item('ลงขัน', VEHICLE_USE_CANCEL_NO_BILL_FEE)],
        duty: VEHICLE_USE_CANCEL_DUTY_FEE,
      },
    ],
  },
  {
    key: 'moveOut',
    title: 'ย้ายออก',
    keywords: ['ย้ายออก'],
    variants: [
      {
        title: 'จักรยานยนต์',
        bill: [item('ค่าธรรมเนียม', MOVE_OUT_MOTO_BILL_FEE)],
        noBill: [item('ลงขัน', MOVE_OUT_MOTO_LUNGKAN_FEE)],
        noBillOptional: [item('ลงขันด่วนเพิ่ม', MOVE_OUT_MOTO_URGENT_EXTRA)],
        duty: MOVE_OUT_MOTO_DUTY_FEE,
      },
    ],
    notes: ['รถยนต์ยังไม่มีอัตราในระบบ'],
  },
  {
    key: 'taxRenewal',
    title: 'ต่อภาษี',
    keywords: ['ภาษี'],
    variants: [
      { title: 'รถยนต์', bill: [], noBill: [item('ลงขัน', TAX_RENEWAL_CONTRIBUTION_CAR)] },
      { title: 'จักรยานยนต์', bill: [], noBill: [item('ลงขัน', TAX_RENEWAL_CONTRIBUTION_MOTO)] },
      { title: 'รถตาม พ.ร.บ.ขนส่ง (ขส.)', bill: [], noBill: [item('ค่าตรวจสภาพรถ', TAX_RENEWAL_INSPECTION_FEE_TRANSPORT), item('ลงขัน', TAX_RENEWAL_CONTRIBUTION_TRANSPORT)] },
    ],
    notes: ['Bill = ภาษีประจำปี + เงินเพิ่มกรณีล่าช้า ตามรถแต่ละคัน (ไม่ใช่ราคาตายตัว)'],
  },
  {
    key: 'yamaha',
    title: 'แจ้งย้ายยามาฮ่า',
    keywords: ['ยามาฮ่า', 'แจ้งย้าย'],
    variants: [
      { title: 'รถเล็ก', bill: [item('ค่าธรรมเนียม', YAMAHA_RELOCATION_BILL_RATE)], noBill: [item('ลงขัน', YAMAHA_RELOCATION_NO_BILL_RATE.SMALL)] },
      { title: 'รถใหญ่', bill: [item('ค่าธรรมเนียม', YAMAHA_RELOCATION_BILL_RATE)], noBill: [item('ลงขัน', YAMAHA_RELOCATION_NO_BILL_RATE.LARGE)] },
    ],
  },
];

const money = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const sum = (items: FeeItem[]) => items.reduce((s, i) => s + i.amount, 0);
const norm = (s: string) => s.replace(/\s+/g, '');

export function findCostSheet(term: string): CostSheet | null {
  const key = norm(term);
  return key ? (COST_SHEETS.find((s) => s.keywords.some((k) => key.includes(k))) ?? null) : null;
}

function variantLines(v: CostVariant): string[] {
  const lines = [`▸ ${v.title}`];
  const part = (name: string, items: FeeItem[], optional: FeeItem[] = []) => {
    if (items.length === 0 && optional.length === 0) return;
    lines.push(`${name}${items.length ? ` รวม ${money(sum(items))}` : ''}`);
    for (const i of items) lines.push(`• ${i.label} ${money(i.amount)}`);
    for (const i of optional) lines.push(`◦ ถ้ามี: ${i.label} +${money(i.amount)}`);
  };
  part('Bill', v.bill, v.billOptional);
  part('No Bill', v.noBill, v.noBillOptional);
  if (v.duty) lines.push(`ค่าอากร ${money(v.duty)}`);
  const bill = sum(v.bill);
  const cost = sum(v.noBill) + (v.duty ?? 0);
  // ต้นทุนของเรา = No Bill + ค่าอากร (Bill เก็บลูกค้าเท่าใบเสร็จ) - ผู้ใช้ 2026-10-06
  lines.push(bill > 0 ? `= จ่ายจริง ${money(bill + cost)} (Bill ${money(bill)} + ต้นทุนเรา ${money(cost)})` : `= ต้นทุนเรา ${money(cost)}`);
  for (const n of v.notes ?? []) lines.push(`(${n})`);
  return lines;
}

export function costSheetText(sheet: CostSheet): string {
  const lines = [`ต้นทุน ${sheet.title} (ต่อคัน)`];
  for (const v of sheet.variants) lines.push('', ...variantLines(v));
  if (sheet.notes?.length) lines.push('', ...sheet.notes.map((n) => `หมายเหตุ: ${n}`));
  return lines.join('\n');
}

// --- จดทะเบียนรถใหม่: อัตราอยู่ในตาราง Fee*Param ของฐานข้อมูล (ไม่ใช่ค่าคงที่ในโค้ด) -----------------
export interface FeeParam {
  key: string;
  amount: number | null;
}

export function registrationCostText(kind: 'car' | 'moto', bill: FeeParam[], noBill: FeeParam[]): string {
  const rows = (items: FeeParam[]) => items.map((r) => `• ${r.key} ${r.amount === null ? '?' : money(r.amount)}`);
  return [
    `ต้นทุน จดทะเบียน${kind === 'moto' ? 'รถจักรยานยนต์' : 'รถยนต์'}ใหม่ (ต่อคัน)`,
    'เลือกเฉพาะรายการที่ตรงกับงาน ไม่ได้จ่ายทุกบรรทัด',
    '',
    'Bill (ใบเสร็จกรมขนส่ง ไม่รวมภาษีประจำปี)',
    ...rows(bill),
    '',
    'No Bill',
    ...rows(noBill),
    '',
    'หมายเหตุ: จดจังหวัดอื่นนอกจากกรุงเทพฯ / สมุทรปราการ ส่งซับ ดู "ต้นทุน <จังหวัด>" · แจ้งย้ายและตรวจรถนอกคิดเพิ่มตามที่จ่ายจริง',
  ].join('\n');
}

// "ต้นทุน" เฉยๆ = รายการงานให้เลือก (ปุ่มลัดไม่เกิน 13 ปุ่ม)
export function costIndexMessage(): LineMessage {
  const choices = [
    ...COST_SHEETS.map((s) => ({ label: s.title, text: `ต้นทุน ${s.title}` })),
    { label: 'จดรถยนต์ใหม่', text: 'ต้นทุน จดรถยนต์' },
    { label: 'จดจักรยานยนต์ใหม่', text: 'ต้นทุน จดจักรยานยนต์' },
    { label: 'ต้นทุนเฉลี่ยจากงานจริง', text: 'ต้นทุน เฉลี่ย' },
  ];
  const quickReply: QuickReply = { items: choices.map((c) => ({ type: 'action' as const, action: { type: 'message' as const, label: c.label.slice(0, 20), text: c.text } })) };
  return {
    type: 'text',
    text: ['ต้นทุนต่อคันของงานไหน (กดปุ่มด้านล่าง หรือพิมพ์ "ต้นทุน <งาน>")', ...choices.map((c) => `• ${c.text}`), '• ต้นทุน <จังหวัด> (ราคาซับจดต่างจังหวัด)'].join('\n'),
    quickReply,
  };
}
