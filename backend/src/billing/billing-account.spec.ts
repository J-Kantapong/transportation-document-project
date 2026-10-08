import { accountOn } from './billing-account.js';
import { payeeSnapshot } from './billing.service.js';

describe('accountOn', () => {
  it('defaults to the company account when the customer has no periods', () => {
    expect(accountOn([], '2026-09-27')).toBe('COMPANY');
  });

  it('uses the latest period that started on or before the date', () => {
    const periods = [
      { account: 'PERSONAL', effectiveFrom: '2026-01-01' },
      { account: 'COMPANY', effectiveFrom: '2027-01-01' },
    ];
    expect(accountOn(periods, '2026-12-31')).toBe('PERSONAL');
    expect(accountOn(periods, '2027-01-01')).toBe('COMPANY');
    expect(accountOn(periods, '2025-12-31')).toBe('COMPANY'); // before the first period
  });

  it('does not depend on the order of the periods', () => {
    const periods = [
      { account: 'COMPANY', effectiveFrom: '2027-01-01' },
      { account: 'PERSONAL', effectiveFrom: '2026-01-01' },
    ];
    expect(accountOn(periods, '2026-06-01')).toBe('PERSONAL');
  });
});

describe('payeeSnapshot', () => {
  const spi = { personalPayeeName: 'ผู้รับเงิน ทดสอบ', personalPayeeBank: 'ธนาคารทดสอบ', personalPayeeAccountNo: '000-0-00000-0' };
  it('adds the payee only for personal-account bills', () => {
    expect(payeeSnapshot('PERSONAL', spi)).toEqual({ payee: { name: 'ผู้รับเงิน ทดสอบ', bank: 'ธนาคารทดสอบ', accountNo: '000-0-00000-0' } });
    expect(payeeSnapshot('COMPANY', spi)).toEqual({});
  });
  it('falls back to the default payee when none is set', () => {
    expect(payeeSnapshot('PERSONAL', { personalPayeeName: null, personalPayeeBank: null, personalPayeeAccountNo: null })).toEqual({});
  });
});
