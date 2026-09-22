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
  amount: number;
  vatInclusive: boolean;
  sortOrder: number;
}

// ราคาก่อน VAT ของแถวราคา - ลูกค้าบางรายตกลงราคาแบบรวม VAT (1,045 -> 976.64)
export function rateAmountExVat(rate: Pick<RateRow, 'amount' | 'vatInclusive'>): number {
  return rate.vatInclusive ? round2(rate.amount / (1 + VAT_RATE / 100)) : round2(rate.amount);
}

// แถวราคาแรก (เรียงตาม sortOrder) ที่ชนิดรถและช่วง CC ตรงกับรถ - ccMin <= cc < ccMax
// แถวที่กำหนดช่วง CC จะไม่จับคู่กับรถที่ไม่มีข้อมูล CC (ให้บัญชีเลือกเอง ดีกว่าเดาราคาผิด)
export function suggestRate(rates: RateRow[], vehicle: { isMoto: boolean; cc: number | null }): RateRow | null {
  const kind = vehicle.isMoto ? 'MOTO' : 'CAR';
  const sorted = [...rates].sort((a, b) => a.sortOrder - b.sortOrder);
  for (const r of sorted) {
    if (r.vehicleKind !== 'ANY' && r.vehicleKind !== kind) continue;
    if (r.ccMin !== null || r.ccMax !== null) {
      if (vehicle.cc === null) continue;
      if (r.ccMin !== null && vehicle.cc < r.ccMin) continue;
      if (r.ccMax !== null && vehicle.cc >= r.ccMax) continue;
    }
    return r;
  }
  return null;
}

export interface InvoiceTotals {
  feeTotal: number;
  serviceTotal: number;
  vatRate: number;
  vatAmount: number;
  whtRate: number;
  whtAmount: number;
  grossTotal: number;
  netTotal: number;
}

export function computeInvoiceTotals(input: {
  lines: Array<{ receiptAmount: number; serviceFee: number }>;
  extras: Array<{ amount: number }>;
  terms: BillingTerms;
  issueDate: string;
}): InvoiceTotals {
  const feeTotal = round2(input.lines.reduce((s, l) => s + l.receiptAmount, 0));
  const serviceTotal = round2(input.lines.reduce((s, l) => s + l.serviceFee, 0) + input.extras.reduce((s, e) => s + e.amount, 0));
  const vatRate = input.terms.vat ? VAT_RATE : 0;
  const whtRate = effectiveWhtRate(input.terms, input.issueDate);
  const vatAmount = round2((serviceTotal * vatRate) / 100);
  const whtAmount = round2((serviceTotal * whtRate) / 100);
  const grossTotal = round2(feeTotal + serviceTotal + vatAmount);
  return { feeTotal, serviceTotal, vatRate, vatAmount, whtRate, whtAmount, grossTotal, netTotal: round2(grossTotal - whtAmount) };
}

// เลขที่บิลถัดไปที่เสนอให้ = เพิ่มเลขท้ายของเลขล่าสุด คงจำนวนหลักเดิม (IV2026-120 -> IV2026-121)
export function nextInvoiceNo(last: string | null): string {
  if (!last) return '';
  const m = /^(.*?)(\d+)$/.exec(last);
  if (!m) return '';
  return m[1] + String(Number(m[2]) + 1).padStart(m[2].length, '0');
}
