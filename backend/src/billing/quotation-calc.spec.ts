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
  it('builds a fee and a service line per size, with the monthly fee between small and large', () => {
    const items = yamahaQuoteItems('2026-10', { SMALL: 512, LARGE: 40 });
    expect(items.map((i) => [i.kind, i.description, i.quantity, i.unitPrice])).toEqual([
      ['FEE', 'ค่าธรรมเนียมแจ้งจำหน่ายรถจักรยานยนต์ เดือน 10/2026', 512, 5],
      ['SERVICE', 'ค่าดำเนินการแจ้งจำหน่ายรถจักรยานยนต์ เดือน 10/2026', 512, 20],
      ['SERVICE', 'ค่าดำเนินการจัดการเอกสารบัญชีรถจักรยานยนต์ยามาฮ่า เดือน 10/2026', 1, 9000],
      ['FEE', 'ค่าธรรมเนียมแจ้งจำหน่ายรถจักรยานยนต์(ใหญ่) เดือน 10/2026', 40, 5],
      ['SERVICE', 'ค่าดำเนินการแจ้งจำหน่ายรถจักรยานยนต์(ใหญ่) เดือน 10/2026', 40, 50],
    ]);
  });
  it('leaves out a size with no vehicles', () => {
    expect(yamahaQuoteItems('2026-10', { SMALL: 512, LARGE: 0 }).map((i) => i.quantity)).toEqual([512, 512, 1]);
  });
  it('validates the month format', () => {
    expect(isMonth('2026-10')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(isMonth('2026-1')).toBe(false);
  });
});
