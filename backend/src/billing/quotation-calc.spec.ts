import { describe, expect, it } from 'vitest';
import { formatQuotationNo, isMonth, revisionNo, stageOf, yamahaQuoteItems, yamahaServiceRate } from './quotation-calc.js';

describe('quotation numbers', () => {
  it('pads to 3 digits and appends the revision', () => {
    expect(formatQuotationNo(2026, 4)).toBe('QT2026-004');
    expect(formatQuotationNo(2026, 1000)).toBe('QT2026-1000');
    expect(revisionNo('QT2026-004', 0)).toBe('QT2026-004');
    expect(revisionNo('QT2026-004', 2)).toBe('QT2026-004-R2');
  });
});

describe('stageOf', () => {
  const base = { validUntil: '2026-10-31', hasLiveInvoice: false, ratesApplied: false };
  it('splits issued quotations by the validity date', () => {
    expect(stageOf({ ...base, status: 'ISSUED' }, '2026-10-31')).toBe('WAITING');
    expect(stageOf({ ...base, status: 'ISSUED' }, '2026-11-01')).toBe('EXPIRED');
  });
  it('marks approved quotations done once billed or applied as rates', () => {
    expect(stageOf({ ...base, status: 'APPROVED' }, '2026-12-01')).toBe('APPROVED');
    expect(stageOf({ ...base, status: 'APPROVED', hasLiveInvoice: true }, '2026-12-01')).toBe('DONE');
    expect(stageOf({ ...base, status: 'APPROVED', ratesApplied: true }, '2026-12-01')).toBe('DONE');
  });
  it('passes other statuses through', () => {
    expect(stageOf({ ...base, status: 'DRAFT' }, '2026-12-01')).toBe('DRAFT');
    expect(stageOf({ ...base, status: 'SUPERSEDED' }, '2026-12-01')).toBe('SUPERSEDED');
  });
});

describe('yamaha monthly quote', () => {
  it('prices small vehicles by the work month and keeps large at 50', () => {
    expect(yamahaServiceRate('SMALL', '2026-12')).toBe(20);
    expect(yamahaServiceRate('SMALL', '2027-01')).toBe(21);
    expect(yamahaServiceRate('SMALL', '2028-01')).toBe(22);
    expect(yamahaServiceRate('LARGE', '2028-06')).toBe(50);
  });
  it('builds one line per size with vehicles plus the monthly fee', () => {
    const items = yamahaQuoteItems('2026-10', { SMALL: 512, LARGE: 0 });
    expect(items.map((i) => [i.quantity, i.unitPrice])).toEqual([
      [512, 20],
      [1, 9000],
    ]);
    expect(items[0].description).toContain('(รถเล็ก) เดือน 10/2026');
  });
  it('validates the month format', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
  });
});
