import type { BillingTerms, Invoice, InvoiceLine } from "@/lib/billing-api";
import { comparePlate } from "@/lib/plate-order";

// คำนวณยอดบิลแบบสดบนหน้าจอ - ต้องให้ผลเท่ากับ backend/src/billing/billing-calculator.ts (backend คำนวณซ้ำและเป็นตัวจริงตอนบันทึก)
export const VAT_RATE = 7;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatMoney(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function effectiveWhtRate(terms: BillingTerms, issueDate: string): number {
  if (terms.whtSpecialRate !== null && terms.whtSpecialUntil && issueDate <= terms.whtSpecialUntil) return terms.whtSpecialRate;
  return terms.whtRate;
}

export function computeTotals(
  lines: Array<{ receiptAmount: number; serviceFee: number }>,
  extras: Array<{ amount: number }>,
  terms: BillingTerms,
  issueDate: string,
) {
  const feeTotal = round2(lines.reduce((s, l) => s + l.receiptAmount, 0));
  const serviceTotal = round2(lines.reduce((s, l) => s + l.serviceFee, 0) + extras.reduce((s, e) => s + e.amount, 0));
  const vatRate = terms.vat ? VAT_RATE : 0;
  const whtRate = effectiveWhtRate(terms, issueDate);
  const vatAmount = round2((serviceTotal * vatRate) / 100);
  const whtAmount = round2((serviceTotal * whtRate) / 100);
  const grossTotal = round2(feeTotal + serviceTotal + vatAmount);
  return { feeTotal, serviceTotal, vatRate, vatAmount, whtRate, whtAmount, grossTotal, netTotal: round2(grossTotal - whtAmount) };
}

export function termsSummary(terms: BillingTerms, today: string): string {
  const vat = terms.vat ? "มี VAT 7%" : "ไม่มี VAT";
  const special = terms.whtSpecialRate !== null && terms.whtSpecialUntil && today <= terms.whtSpecialUntil;
  const wht = special
    ? `หัก ณ ที่จ่าย ${terms.whtSpecialRate}% ถึง ${isoToThaiDate(terms.whtSpecialUntil!)} จากนั้น ${terms.whtRate}%`
    : terms.whtRate > 0
      ? `หัก ณ ที่จ่าย ${terms.whtRate}%`
      : "ไม่หัก ณ ที่จ่าย";
  return `${vat} · ${wht}`;
}

// วันที่บนเอกสารบัญชีใช้ พ.ศ. ตามฟอร์มใบวางบิลเดิมของบริษัท (13/08/2569)
export function isoToThaiDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${Number(m[1]) + 543}` : iso;
}

export interface InvoiceFaceLine {
  name: string;
  qty: number;
  unit: number;
}

// บรรทัดบนหน้าบิลตามแบบที่บริษัทใช้อยู่: ค่าธรรมเนียมรวมเป็นบรรทัดเดียว ("ค่าธรรมเนียมจดทะเบียนรถยนต์ LEXUS 6 คัน")
// ค่าดำเนินการรวมคันที่ข้อความและราคาเท่ากันเป็นบรรทัดเดียว คันที่มีการหักยอด (เช่น ลูกค้าชำระค่าขอใช้เลขเอง) แยกบรรทัดพร้อมทะเบียน
export function invoiceFaceLines(invoice: Pick<Invoice, "jobLabel" | "lines" | "extras" | "feeTotal">): InvoiceFaceLine[] {
  if (invoice.lines.length === 0) return [];
  const brands = [...new Set(invoice.lines.map((l) => l.brandName.toUpperCase()))];
  const brandText = brands.length === 1 ? ` ${brands[0]}` : "";
  const out: InvoiceFaceLine[] = [{ name: `ค่าธรรมเนียม${invoice.jobLabel}${brandText} ${invoice.lines.length} คัน`, qty: 1, unit: invoice.feeTotal }];

  const groups = new Map<string, InvoiceFaceLine>();
  for (const l of invoice.lines) {
    const suffix = l.deduction > 0 ? ` ${l.plateText || l.chassis}` : l.serviceLabel ? ` ${l.serviceLabel}` : "";
    const name = `ค่าดำเนินการ${invoice.jobLabel}${suffix}`;
    const key = `${name}|${l.serviceFee}`;
    const g = groups.get(key) ?? { name, qty: 0, unit: l.serviceFee };
    g.qty += 1;
    groups.set(key, g);
  }
  out.push(...groups.values());
  for (const e of invoice.extras) out.push({ name: e.label, qty: 1, unit: e.amount });
  return out;
}

export function sortLinesByPlate(lines: InvoiceLine[]): InvoiceLine[] {
  const split = (l: InvoiceLine) => {
    const [plateCategory = null, plateNumber = null] = l.plateText ? l.plateText.split(" ") : [];
    return { plateCategory, plateNumber };
  };
  return [...lines].sort((a, b) => comparePlate(split(a), split(b)) || a.chassis.localeCompare(b.chassis));
}

const TH_NUM = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const TH_POS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

function thaiInteger(n: number): string {
  if (n === 0) return "";
  let s = "";
  if (n >= 1_000_000) {
    s += `${thaiInteger(Math.floor(n / 1_000_000))}ล้าน`;
    n %= 1_000_000;
  }
  const d = String(n);
  for (let i = 0; i < d.length; i++) {
    const v = Number(d[i]);
    const p = d.length - i - 1;
    if (!v) continue;
    if (p === 1 && v === 1) s += "สิบ";
    else if (p === 1 && v === 2) s += "ยี่สิบ";
    else if (p === 0 && v === 1 && d.length > 1) s += "เอ็ด"; // 11 สิบเอ็ด, 101 หนึ่งร้อยเอ็ด
    else s += TH_NUM[v] + TH_POS[p];
  }
  return s;
}

// จำนวนเงินเป็นตัวอักษร เช่น 4699 -> "สี่พันหกร้อยเก้าสิบเก้าบาทถ้วน"
export function bahtText(amount: number): string {
  const satangTotal = Math.round(amount * 100);
  const baht = Math.floor(satangTotal / 100);
  const satang = satangTotal % 100;
  return `${baht ? thaiInteger(baht) : "ศูนย์"}บาท${satang ? `${thaiInteger(satang)}สตางค์` : "ถ้วน"}`;
}
