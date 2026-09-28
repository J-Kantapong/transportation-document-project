// คำนวณยอดใบวางบิลในนามบริษัท - ฟังก์ชันล้วน ไม่แตะฐานข้อมูล
// กติกา (ผู้ใช้ 2026-09-21, ตรวจกับบิลจริงใน Google Sheet "Invoice Tradeinter" แล้วตรงทุกสตางค์):
// - ค่าใบเสร็จกรมขนส่ง = เงินทดรองจ่าย ไม่คิด VAT ไม่หัก ณ ที่จ่าย
// - ทุกอย่างที่ไม่ใช่ค่าใบเสร็จ (ค่าดำเนินการ + ค่าใช้จ่ายอื่นๆ) คิด VAT 7% และเป็นฐานหัก ณ ที่จ่าย (ก่อน VAT)
// - "จำนวนเงินทั้งสิ้น" บนบิล = ค่าใบเสร็จ + ค่าดำเนินการ + VAT - หัก ณ ที่จ่าย
// VAT/หัก ณ ที่จ่าย ปัดเศษจากยอดรวมทั้งบิล ไม่ได้ปัดรายคันแล้วรวม (IV2026-104: 34,962.73 -> VAT 2,447.39, หัก 3% 1,048.88)

export const VAT_RATE = 7;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface BillingTerms {
  vat: boolean;
  whtRate: number; // % อัตราปกติ
  whtSpecialRate: number | null; // % อัตราพิเศษชั่วคราว
  whtSpecialUntil: string | null; // ISO YYYY-MM-DD วันสุดท้ายที่ใช้อัตราพิเศษ
}

// อัตราหัก ณ ที่จ่ายที่ใช้กับบิลที่ออกวันที่ issueDate - อัตราพิเศษใช้ถึงสิ้นวัน whtSpecialUntil (รวมวันนั้น)
export function effectiveWhtRate(terms: BillingTerms, issueDate: string): number {
  if (terms.whtSpecialRate !== null && terms.whtSpecialUntil && issueDate <= terms.whtSpecialUntil) return terms.whtSpecialRate;
  return terms.whtRate;
}

export interface RateRow {
  id: string;
  label: string;
  vehicleKind: string; // CAR | MOTO | ANY
  ccMin: number | null;
  ccMax: number | null;
  chassisPrefix: string | null; // ราคาแยกตามรุ่น/ยี่ห้อผู้ผลิตที่ CC ทับซ้อนกัน (ผู้ใช้ 2026-09-28, MC Superbike)
  amount: number;
  vatInclusive: boolean;
  includesReceipt: boolean; // ราคาเหมารวมค่าใบเสร็จแล้ว (YMAC)
  kind: string; // RATE_KINDS
  sortOrder: number;
}

// ราคาหลัก 1 แถวต่อคัน + ค่าเพิ่มที่บวกให้เองตามการยื่นของรถคันนั้น (ผู้ใช้ 2026-09-28, TWE: ขอใช้ +100, ด่วน +100 - "ขอใช้" = ขอใช้จังหวัดอื่น)
// PLATE_REQUEST (ผู้ใช้ 2026-09-28, Spac EV: "ขอใช้เลข" +98.13 แยกจาก "ขอใช้" ทางจังหวัด) = ขอใช้เลขทะเบียน (requestsPlateNumber)
// - คนละเรื่องกับช่องหักยอด "ลูกค้าชำระค่าขอใช้เลขเอง" (PLATE_REQUEST_DEDUCTION ในหน้าจอ) ซึ่งหักยอดที่คิดไปแล้ว ไม่ใช่การเสนอราคา
// TRANSFER_NOTICE (ผู้ใช้ 2026-09-28, Spac EV: "แจ้งย้าย" +182.24) = เฉพาะรถที่ Step 2 เข้าเงื่อนไข "แจ้งย้าย" จริง
// (registrationProvince ไม่ใช่กรุงเทพมหานคร ดู getTransferStatus ใน vehicles.service.ts) - ไม่ใช่ทุกคันและไม่ใช่ otherProvince
// PLATE_SWAP (ผู้ใช้ 2026-09-28, Spac EV: "สลับเลข" 1,720 รวม VAT เฉพาะรถยนต์) = รถคันนี้เป็น "รถใหม่" ของงานสลับเลข
// คิดเพิ่มจากค่าจดทะเบียนปกติ ส่วนค่าใบเสร็จกรมฯ ของรถเก่าเก็บแยกอีกยอด (InvoiceLine.swapReceiptAmount)
export const RATE_KINDS = ['BASE', 'OTHER_PROVINCE', 'URGENT', 'PLATE_REQUEST', 'TRANSFER_NOTICE', 'PLATE_SWAP'] as const;

// ค่าเพิ่มที่ใช้กับรถคันนี้: แถว OTHER_PROVINCE เมื่อเป็นรถขอใช้ (จดจังหวัดอื่น เช่น กรุงเทพฯ - ใบเสร็จมีค่าธรรมเนียมอื่นๆ 20 + ค่าคำขอ 10
// แทน 5, ผู้ใช้ 2026-09-28: ไม่ใช่ขอใช้เลขทะเบียน), URGENT เมื่อยื่นด่วน, PLATE_REQUEST เมื่อยื่นแบบขอใช้เลขทะเบียน (ชนิดรถต้องตรงหรือ ANY),
// TRANSFER_NOTICE เมื่อรถทำ "แจ้งย้าย" จริง (transferNotice)
export function suggestAddOns(
  rates: RateRow[],
  vehicle: { isMoto: boolean; otherProvince: boolean; urgent: boolean; requestedPlateNumber: boolean; transferNotice: boolean; plateSwap: boolean },
): RateRow[] {
  const kind = vehicle.isMoto ? 'MOTO' : 'CAR';
  return [...rates]
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .filter((r) => r.vehicleKind === 'ANY' || r.vehicleKind === kind)
    .filter(
      (r) =>
        (r.kind === 'OTHER_PROVINCE' && vehicle.otherProvince) ||
        (r.kind === 'URGENT' && vehicle.urgent) ||
        (r.kind === 'PLATE_REQUEST' && vehicle.requestedPlateNumber) ||
        (r.kind === 'TRANSFER_NOTICE' && vehicle.transferNotice) ||
        (r.kind === 'PLATE_SWAP' && vehicle.plateSwap),
    );
}

// ค่าดำเนินการ (ก่อน VAT) ที่เสนอจากแถวราคา - ราคาเหมารวมใบเสร็จ (ผู้ใช้ 2026-09-27): ค่าดำเนินการ = ราคา - ค่าใบเสร็จจริงของคันนั้น
// (650 - 340 = 310) ถ้ารวม VAT ด้วยถอด VAT จากส่วนที่เหลือ · ยังไม่รู้ค่าใบเสร็จ / ใบเสร็จแพงกว่าราคา = ไม่เสนอ ให้บัญชีกรอกเอง
export function serviceFeeFromRate(rate: Pick<RateRow, 'amount' | 'vatInclusive' | 'includesReceipt'>, receiptAmount: number | null): number | null {
  if (!rate.includesReceipt) return rateAmountExVat(rate);
  if (receiptAmount === null) return null;
  const rest = round2(rate.amount - receiptAmount);
  if (rest < 0) return null;
  return rateAmountExVat({ amount: rest, vatInclusive: rate.vatInclusive });
}

// ราคาก่อน VAT ของแถวราคา - ลูกค้าบางรายตกลงราคาแบบรวม VAT (1,045 -> 976.64)
export function rateAmountExVat(rate: Pick<RateRow, 'amount' | 'vatInclusive'>): number {
  return rate.vatInclusive ? round2(rate.amount / (1 + VAT_RATE / 100)) : round2(rate.amount);
}

// แถวราคาแรก (เรียงตาม sortOrder) ที่ชนิดรถ ช่วง CC และเลขตัวถังขึ้นต้นตรงกับรถ - ccMin <= cc < ccMax
// แถวที่กำหนดช่วง CC จะไม่จับคู่กับรถที่ไม่มีข้อมูล CC (ให้บัญชีเลือกเอง ดีกว่าเดาราคาผิด)
// chassisPrefix (ผู้ใช้ 2026-09-28, MC Superbike: ML=885/JH=2685 ทับซ้อนกันในช่วง 300-799cc) เทียบไม่สนตัวพิมพ์ใหญ่เล็ก
export function suggestRate(rates: RateRow[], vehicle: { isMoto: boolean; cc: number | null; chassis?: string | null }): RateRow | null {
  const kind = vehicle.isMoto ? 'MOTO' : 'CAR';
  const chassis = (vehicle.chassis ?? '').toUpperCase();
  const sorted = [...rates].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const r of sorted) {
    if (r.kind !== 'BASE') continue; // ค่าเพิ่มไม่ใช่ราคาหลัก
    if (r.vehicleKind !== 'ANY' && r.vehicleKind !== kind) continue;
    if (r.ccMin !== null || r.ccMax !== null) {
      if (vehicle.cc === null) continue;
      if (r.ccMin !== null && vehicle.cc < r.ccMin) continue;
      if (r.ccMax !== null && vehicle.cc >= r.ccMax) continue;
    }
    if (r.chassisPrefix && !chassis.startsWith(r.chassisPrefix.toUpperCase())) continue;
    return r;
  }
  return null;
}

export interface InvoiceTotals {
  feeTotal: number;
  serviceTotal: number;
  goodsTotal: number;
  vatRate: number;
  vatAmount: number;
  whtRate: number;
  whtAmount: number;
  grossTotal: number;
  netTotal: number;
}

// บรรทัดกำหนดเอง (ผู้ใช้ 2026-09-29): FEE = ค่าธรรมเนียมราชการ ไม่มี VAT ไม่หัก · SERVICE = ค่าบริการ VAT + หัก · GOODS = ขายสินค้า VAT ไม่หัก
export const ITEM_KINDS = ['FEE', 'SERVICE', 'GOODS'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export function computeInvoiceTotals(input: {
  // swapReceiptAmount = ค่าใบเสร็จกรมฯ ของรถเก่าในงานสลับเลข เก็บแยกแต่รวมอยู่ในยอดค่าธรรมเนียม (ผู้ใช้ 2026-09-28)
  lines: Array<{ receiptAmount: number; serviceFee: number; swapReceiptAmount?: number | null }>;
  extras: Array<{ amount: number }>;
  items?: Array<{ kind: string; amount: number }>;
  terms: BillingTerms;
  issueDate: string;
}): InvoiceTotals {
  const items = input.items ?? [];
  const itemSum = (kind: ItemKind) => items.filter((i) => i.kind === kind).reduce((s, i) => s + i.amount, 0);
  const feeTotal = round2(input.lines.reduce((s, l) => s + l.receiptAmount + (l.swapReceiptAmount ?? 0), 0) + itemSum('FEE'));
  const serviceTotal = round2(input.lines.reduce((s, l) => s + l.serviceFee, 0) + input.extras.reduce((s, e) => s + e.amount, 0) + itemSum('SERVICE'));
  const goodsTotal = round2(itemSum('GOODS'));
  const vatRate = input.terms.vat ? VAT_RATE : 0;
  const whtRate = effectiveWhtRate(input.terms, input.issueDate);
  const vatAmount = round2(((serviceTotal + goodsTotal) * vatRate) / 100);
  const whtAmount = round2((serviceTotal * whtRate) / 100);
  const grossTotal = round2(feeTotal + serviceTotal + goodsTotal + vatAmount);
  return { feeTotal, serviceTotal, goodsTotal, vatRate, vatAmount, whtRate, whtAmount, grossTotal, netTotal: round2(grossTotal - whtAmount) };
}

// เลขที่บิลถัดไปที่เสนอให้ = เพิ่มเลขท้ายของเลขล่าสุด คงจำนวนหลักเดิม (IV2026-120 -> IV2026-121)
export function nextInvoiceNo(last: string | null): string {
  if (!last) return '';
  const m = /^(.*?)(\d+)$/.exec(last);
  if (!m) return '';
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}
