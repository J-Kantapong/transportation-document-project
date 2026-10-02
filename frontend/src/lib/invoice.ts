import type { BillingTerms, Invoice, InvoiceItemKind, InvoiceLine, ServiceFeeRate } from "@/lib/billing-api";
import { jobSheetGroup } from "@/lib/job-sheet";
import { comparePlate } from "@/lib/plate-order";

// คำนวณยอดบิลแบบสดบนหน้าจอ - ต้องให้ผลเท่ากับ backend/src/billing/billing-calculator.ts (backend คำนวณซ้ำและเป็นตัวจริงตอนบันทึก)
export const VAT_RATE = 7;

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function formatMoney(amount: number): string {
  return amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ราคาก่อน VAT ของแถวราคา / ค่าดำเนินการจากแถวราคาหลัก - เหมือน backend/src/billing/billing-calculator.ts
// ราคาเหมารวมใบเสร็จ (YMAC): ค่าดำเนินการ = ราคา - ค่าใบเสร็จจริง, ไม่รู้ค่าใบเสร็จ / ใบเสร็จแพงกว่าราคา = null
export function rateAmountExVat(rate: Pick<ServiceFeeRate, "amount" | "vatInclusive">): number {
  return rate.vatInclusive ? round2(rate.amount / (1 + VAT_RATE / 100)) : round2(rate.amount);
}

export function serviceFeeFromRate(rate: Pick<ServiceFeeRate, "amount" | "vatInclusive" | "includesReceipt">, receiptAmount: number | null): number | null {
  if (!rate.includesReceipt) return rateAmountExVat(rate);
  if (receiptAmount === null) return null;
  const rest = round2(rate.amount - receiptAmount);
  return rest < 0 ? null : rateAmountExVat({ amount: rest, vatInclusive: rate.vatInclusive });
}

export function effectiveWhtRate(terms: BillingTerms, issueDate: string): number {
  if (terms.whtSpecialRate !== null && terms.whtSpecialUntil && issueDate <= terms.whtSpecialUntil) return terms.whtSpecialRate;
  return terms.whtRate;
}

// whtOverride = อัตราหัก ณ ที่จ่ายที่เลือกให้บิลนี้ (ผู้ใช้ 2026-09-29) null = ตามเงื่อนไขลูกค้า
// items = บรรทัดกำหนดเอง: FEE ไม่มี VAT ไม่หัก · SERVICE VAT + หัก · GOODS VAT ไม่หัก
export function computeTotals(
  lines: Array<{ receiptAmount: number; serviceFee: number; swapReceiptAmount?: number | null }>,
  extras: Array<{ amount: number }>,
  terms: BillingTerms,
  issueDate: string,
  items: Array<{ kind: InvoiceItemKind; amount: number }> = [],
  whtOverride: number | null = null,
) {
  const itemSum = (kind: InvoiceItemKind) => items.filter((i) => i.kind === kind).reduce((s, i) => s + i.amount, 0);
  // ค่าใบเสร็จกรมฯ ของรถเก่าในงานสลับเลขรวมอยู่ในยอดค่าธรรมเนียมด้วย (ผู้ใช้ 2026-09-28)
  const feeTotal = round2(lines.reduce((s, l) => s + l.receiptAmount + (l.swapReceiptAmount ?? 0), 0) + itemSum("FEE"));
  const serviceTotal = round2(lines.reduce((s, l) => s + l.serviceFee, 0) + extras.reduce((s, e) => s + e.amount, 0) + itemSum("SERVICE"));
  const goodsTotal = round2(itemSum("GOODS"));
  const vatRate = terms.vat ? VAT_RATE : 0;
  const whtRate = whtOverride ?? effectiveWhtRate(terms, issueDate);
  const vatAmount = round2(((serviceTotal + goodsTotal) * vatRate) / 100);
  const whtAmount = round2((serviceTotal * whtRate) / 100);
  const grossTotal = round2(feeTotal + serviceTotal + goodsTotal + vatAmount);
  return { feeTotal, serviceTotal, goodsTotal, vatRate, vatAmount, whtRate, whtAmount, grossTotal, netTotal: round2(grossTotal - whtAmount) };
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
// บรรทัดกำหนดเอง (ผู้ใช้ 2026-09-29) พิมพ์ตามลำดับที่กรอก บรรทัดละรายการ ต่อจากบรรทัดของรถ
export function invoiceFaceLines(invoice: Pick<Invoice, "jobLabel" | "lines" | "extras" | "feeTotal" | "items">): InvoiceFaceLine[] {
  const itemLines = invoice.items.map((it) => ({ name: it.description, qty: it.quantity, unit: it.unitPrice }));
  if (invoice.lines.length === 0) return [...itemLines, ...invoice.extras.map((e) => ({ name: e.label, qty: 1, unit: e.amount }))];
  const brands = [...new Set(invoice.lines.map((l) => l.brandName.toUpperCase()))];
  const brandText = brands.length === 1 ? ` ${brands[0]}` : "";
  // ค่าธรรมเนียมของรถ = ยอดค่าธรรมเนียมทั้งบิลหักส่วนที่มาจากบรรทัดกำหนดเอง (บรรทัดพวกนั้นพิมพ์แยกของมันเอง)
  const itemFees = invoice.items.filter((it) => it.kind === "FEE").reduce((s, it) => s + it.amount, 0);
  const out: InvoiceFaceLine[] = [{ name: `ค่าธรรมเนียม${invoice.jobLabel}${brandText} ${invoice.lines.length} คัน`, qty: 1, unit: round2(invoice.feeTotal - itemFees) }];

  const groups = new Map<string, InvoiceFaceLine & { parts: number }>();
  for (const l of invoice.lines) {
    const suffix = l.deduction > 0 ? ` ${l.plateText || l.chassis}` : l.serviceLabel ? ` ${l.serviceLabel}` : "";
    const name = `ค่าบริการ${invoice.jobLabel}${suffix}`;
    const key = `${name}|${l.serviceFee}`;
    // จำนวนส่วนในวงเล็บ: "" = 0, "(300-799 cc)" = 1, "(300-799 cc + ขอใช้)" = 2 - คันที่มีหักยอดไว้ท้ายสุด
    const parts = l.deduction > 0 ? 99 : l.serviceLabel ? l.serviceLabel.split(" + ").length : 0;
    const g = groups.get(key) ?? { name, qty: 0, unit: l.serviceFee, parts };
    g.qty += 1;
    groups.set(key, g);
  }
  // ลำดับบรรทัด (ผู้ใช้ 2026-09-28): จดปกติก่อน แล้วค่อยบรรทัดที่มีค่าเพิ่ม (ขอใช้ / ด่วน) - ในกลุ่มเดียวกันราคาน้อยไปมาก
  // เช่น (ต่ำกว่า 300 cc) → (300-799 cc) → (ต่ำกว่า 300 cc + ขอใช้) → (300-799 cc + ขอใช้)
  out.push(...[...groups.values()].sort((a, b) => a.parts - b.parts || a.unit - b.unit).map(({ name, qty, unit }) => ({ name, qty, unit })));
  out.push(...itemLines);
  for (const e of invoice.extras) out.push({ name: e.label, qty: 1, unit: e.amount });
  return out;
}

// ลำดับกลุ่มใบส่งงานในใบแนบ (วันที่ยื่นเดียวกัน): รย.1 ธรรมดา, รย.1 ด่วน, รย.2+3, มอเตอร์ไซค์ ธรรมดา, ด่วน, อื่นๆ
const SHEET_GROUP_ORDER = ["รย.1 แบบธรรมดา", "รย.1 แบบด่วน", "รย.2 และ รย.3", "มอเตอร์ไซค์ แบบธรรมดา", "มอเตอร์ไซค์ แบบด่วน"];

// ใบแนบเรียงตามใบยื่นก่อน (วันที่ยื่น เก่าสุดก่อน > กลุ่มใบส่งงาน) แล้วทะเบียน (หมวด > เลข) แล้วเลขตัวถัง
// (ผู้ใช้ 2026-10-02) - บรรทัดที่หาใบยื่นไม่เจอ (submitDate ว่าง) ไว้ท้ายสุด
export function sortLinesByPlate(lines: InvoiceLine[]): InvoiceLine[] {
  const split = (l: InvoiceLine) => {
    const [plateCategory = null, plateNumber = null] = l.plateText ? l.plateText.split(" ") : [];
    return { plateCategory, plateNumber };
  };
  const groupRank = (l: InvoiceLine) => {
    const rank = SHEET_GROUP_ORDER.indexOf(jobSheetGroup(l.body, l.submitUrgent ?? false).label);
    return rank < 0 ? SHEET_GROUP_ORDER.length : rank;
  };
  return [...lines].sort(
    (a, b) =>
      (a.submitDate ?? "9999").localeCompare(b.submitDate ?? "9999") ||
      groupRank(a) - groupRank(b) ||
      comparePlate(split(a), split(b)) ||
      a.chassis.localeCompare(b.chassis),
  );
}

const TH_NUM = ["ศูนย์", "หนึ่ง", "สอง", "สาม", "สี่", "ห้า", "หก", "เจ็ด", "แปด", "เก้า"];
const TH_POS = ["", "สิบ", "ร้อย", "พัน", "หมื่น", "แสน"];

function thaiInteger(n: number): string {
  if (n === 0) return "";
  let s = "";
  // มีหลักล้านนำหน้า = หลักหน่วย 1 อ่าน "เอ็ด" แม้เศษหลังหลักล้านจะเหลือหลักเดียว (พบ 2026-09-27: 1,000,001 เคยเป็น "หนึ่งล้านหนึ่ง")
  const hasMillions = n >= 1_000_000;
  if (hasMillions) {
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
    else if (p === 0 && v === 1 && (d.length > 1 || hasMillions)) s += "เอ็ด"; // 11 สิบเอ็ด, 101 หนึ่งร้อยเอ็ด, 1,000,001 หนึ่งล้านเอ็ด
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
