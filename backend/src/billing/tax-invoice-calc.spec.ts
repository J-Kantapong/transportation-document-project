import { describe, expect, it } from 'vitest';
import { daysBetween, formatTaxInvoiceNo, missingBuyerFields, taxInvoiceAmounts } from './tax-invoice-calc.js';

describe('formatTaxInvoiceNo', () => {
  it('pads to 3 digits and grows past 999', () => {
    expect(formatTaxInvoiceNo(2026, 1)).toBe('TV2026-001');
    expect(formatTaxInvoiceNo(2026, 158)).toBe('TV2026-158');
    expect(formatTaxInvoiceNo(2026, 1000)).toBe('TV2026-1000');
  });
});

describe('taxInvoiceAmounts', () => {
  it('grand total is before WHT, received is after the actual WHT', () => {
    const r = taxInvoiceAmounts({ feeTotal: 20435, serviceTotal: 38290, goodsTotal: 0, vatAmount: 2680.3 }, 1148.7);
    expect(r).toEqual({ grandTotal: 61405.3, whtAmount: 1148.7, receivedAmount: 60256.6 });
  });
  it('actual WHT can differ from the bill (e-WHT 1%)', () => {
    expect(taxInvoiceAmounts({ feeTotal: 0, serviceTotal: 1000, goodsTotal: 0, vatAmount: 70 }, 10).receivedAmount).toBe(1060);
  });
});

describe('missingBuyerFields', () => {
  const ok = { name: 'บริษัท ก จำกัด', address: 'กรุงเทพ', taxId: '0105560000000' };
  it('passes a complete buyer', () => expect(missingBuyerFields(ok, false)).toEqual([]));
  it('requires a 13-digit tax id unless the buyer is not VAT registered', () => {
    expect(missingBuyerFields({ ...ok, taxId: '123' }, false)).toEqual(['เลขประจำตัวผู้เสียภาษี 13 หลัก']);
    expect(missingBuyerFields({ ...ok, taxId: null }, true)).toEqual([]);
    expect(missingBuyerFields({ ...ok, taxId: '0-1055-60000-00-0' }, false)).toEqual([]);
  });
  it('always requires name and address', () => {
    expect(missingBuyerFields({ name: ' ', address: null, taxId: null }, true)).toEqual(['ชื่อลูกค้า', 'ที่อยู่']);
  });
});

describe('daysBetween', () => {
  it('counts whole days', () => {
    expect(daysBetween('2026-10-01', '2026-10-31')).toBe(30);
    expect(daysBetween('2026-10-31', '2026-10-01')).toBe(-30);
  });
});
