import { accountOn } from './billing-account.js';

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
