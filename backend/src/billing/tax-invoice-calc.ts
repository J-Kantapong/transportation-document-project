import { round2 } from './billing-calculator.js';

// ใบกำกับภาษี/ใบเสร็จรับเงิน (ผู้ใช้ 2026-09-28) - ส่วนคำนวณล้วน ไม่แตะฐานข้อมูล (ทดสอบใน tax-invoice-calc.spec.ts)

// เลขที่ TV{ปี ค.ศ.}-{3 หลัก} เช่น TV2026-001 - เกิน 999 ใบในปีเดียว = 4 หลักเอง (TV2026-1000) ไม่ชนกัน
export function formatTaxInvoiceNo(year: number, number: number): string {
  return `TV${year}-${String(number).padStart(3, '0')}`;
}

export const WHT_METHODS = ['NONE', 'PAPER', 'EWHT'] as const;
export type WhtMethod = (typeof WHT_METHODS)[number];

// ยอดตามใบกำกับ: รวมเงินทั้งสิ้น = ค่าธรรมเนียม (ทดรองจ่าย) + ค่าบริการ + ค่าสินค้า + VAT (ก่อนหัก ณ ที่จ่าย)
// เงินที่รับจริง = รวมเงินทั้งสิ้น - ภาษีที่ลูกค้าหักจริง (อาจไม่เท่าบิล เช่น e-WHT 1% แทน 3%)
export function taxInvoiceAmounts(inv: { feeTotal: number; serviceTotal: number; goodsTotal: number; vatAmount: number }, whtAmount: number) {
  const grandTotal = round2(inv.feeTotal + inv.serviceTotal + inv.goodsTotal + inv.vatAmount);
  return { grandTotal, whtAmount: round2(whtAmount), receivedAmount: round2(grandTotal - whtAmount) };
}

// ข้อมูลผู้ซื้อที่กฎหมายบังคับบนใบกำกับเต็มรูป: ชื่อ ที่อยู่ และเลขผู้เสียภาษี (ยกเว้นผู้ซื้อไม่ได้จด VAT)
// คืนรายการที่ขาด (ว่าง = ออกได้)
export function missingBuyerFields(c: { name: string | null; address: string | null; taxId: string | null }, buyerNotVatRegistered: boolean): string[] {
  const missing: string[] = [];
  if (!c.name?.trim()) missing.push('ชื่อลูกค้า');
  if (!c.address?.trim()) missing.push('ที่อยู่');
  if (!buyerNotVatRegistered && !/^\d{13}$/.test((c.taxId ?? '').replace(/\D/g, ''))) missing.push('เลขประจำตัวผู้เสียภาษี 13 หลัก');
  return missing;
}

// จำนวนวันระหว่างวันที่ ISO สองวัน (b - a)
export function daysBetween(aIso: string, bIso: string): number {
  return Math.round((Date.parse(`${bIso}T00:00:00Z`) - Date.parse(`${aIso}T00:00:00Z`)) / 86_400_000);
}
