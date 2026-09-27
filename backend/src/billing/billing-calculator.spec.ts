import { computeInvoiceTotals, effectiveWhtRate, nextInvoiceNo, rateAmountExVat, serviceFeeFromRate, suggestAddOns, suggestRate, type BillingTerms, type RateRow } from './billing-calculator.js';

const terms = (o: Partial<BillingTerms> = {}): BillingTerms => ({ vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null, ...o });

describe('computeInvoiceTotals', () => {
  it('ตรงกับบิลจริง IV2026-104 (DEEPAL 33 คัน หัก 3%)', () => {
    const t = computeInvoiceTotals({ lines: [{ receiptAmount: 60420.5, serviceFee: 34962.73 }], extras: [], terms: terms(), issueDate: '2026-08-13' });
    expect(t).toMatchObject({ feeTotal: 60420.5, serviceTotal: 34962.73, vatAmount: 2447.39, whtAmount: 1048.88, netTotal: 96781.74 });
  });

  it('ตรงกับบิลจริงของ Yamaha (หัก 1%)', () => {
    const t = computeInvoiceTotals({
      lines: [{ receiptAmount: 96000, serviceFee: 393000 }],
      extras: [],
      terms: terms({ whtSpecialRate: 1, whtSpecialUntil: '2026-12-31' }),
      issueDate: '2026-09-18',
    });
    expect(t).toMatchObject({ vatAmount: 27510, whtAmount: 3930, netTotal: 512580 });
  });

  it('ค่าใช้จ่ายอื่นๆ คิด VAT และหัก ณ ที่จ่ายเหมือนค่าดำเนินการ แต่ค่าใบเสร็จไม่คิด', () => {
    const t = computeInvoiceTotals({ lines: [{ receiptAmount: 1000, serviceFee: 1200 }], extras: [{ amount: 200 }], terms: terms(), issueDate: '2026-09-21' });
    expect(t).toMatchObject({ feeTotal: 1000, serviceTotal: 1400, vatAmount: 98, whtAmount: 42, grossTotal: 2498, netTotal: 2456 });
  });

  it('ลูกค้าที่ไม่มี VAT และไม่หัก ณ ที่จ่าย', () => {
    const t = computeInvoiceTotals({ lines: [{ receiptAmount: 500, serviceFee: 300 }], extras: [], terms: terms({ vat: false, whtRate: 0 }), issueDate: '2026-09-21' });
    expect(t).toMatchObject({ vatRate: 0, vatAmount: 0, whtAmount: 0, netTotal: 800 });
  });
});

describe('effectiveWhtRate', () => {
  const t = terms({ whtSpecialRate: 1, whtSpecialUntil: '2026-12-31' });
  it('ใช้อัตราพิเศษถึงวันสุดท้ายรวมวันนั้น แล้วกลับอัตราปกติ', () => {
    expect(effectiveWhtRate(t, '2026-12-31')).toBe(1);
    expect(effectiveWhtRate(t, '2027-01-01')).toBe(3);
  });
  it('ไม่มีอัตราพิเศษ = อัตราปกติ', () => {
    expect(effectiveWhtRate(terms(), '2026-09-21')).toBe(3);
  });
});

describe('suggestRate', () => {
  const rate = (o: Partial<RateRow>): RateRow => ({ id: 'r', label: '', vehicleKind: 'ANY', ccMin: null, ccMax: null, amount: 0, vatInclusive: false, includesReceipt: false, kind: 'BASE', sortOrder: 0, ...o });
  const rates = [
    rate({ id: 'small', vehicleKind: 'MOTO', ccMax: 150, amount: 360, sortOrder: 1 }),
    rate({ id: 'mid', vehicleKind: 'MOTO', ccMin: 150, ccMax: 300, amount: 440, sortOrder: 2 }),
    rate({ id: 'big', vehicleKind: 'MOTO', ccMin: 300, amount: 790, sortOrder: 3 }),
    rate({ id: 'car', vehicleKind: 'CAR', amount: 920, sortOrder: 4 }),
  ];
  it('เลือกตามชนิดรถและช่วง CC (ccMin <= cc < ccMax)', () => {
    expect(suggestRate(rates, { isMoto: true, cc: 125 })?.id).toBe('small');
    expect(suggestRate(rates, { isMoto: true, cc: 150 })?.id).toBe('mid');
    expect(suggestRate(rates, { isMoto: true, cc: 300 })?.id).toBe('big');
    expect(suggestRate(rates, { isMoto: false, cc: 2487 })?.id).toBe('car');
  });
  it('รถที่ไม่มี CC ไม่จับคู่กับแถวที่กำหนดช่วง CC', () => {
    expect(suggestRate(rates, { isMoto: true, cc: null })).toBeNull();
  });
});

describe('rateAmountExVat / nextInvoiceNo', () => {
  it('ถอดราคารวม VAT เป็นก่อน VAT (1,045 -> 976.64)', () => {
    expect(rateAmountExVat({ amount: 1045, vatInclusive: true })).toBe(976.64);
    expect(rateAmountExVat({ amount: 1200, vatInclusive: false })).toBe(1200);
  });
  it('เสนอเลขบิลถัดไปโดยคงจำนวนหลัก', () => {
    expect(nextInvoiceNo('IV2026-120')).toBe('IV2026-121');
    expect(nextInvoiceNo('IV2026-099')).toBe('IV2026-100');
    expect(nextInvoiceNo(null)).toBe('');
  });
});

describe('serviceFeeFromRate', () => {
  it('uses the rate as the service fee when it does not include the receipt', () => {
    expect(serviceFeeFromRate({ amount: 700, vatInclusive: false, includesReceipt: false }, 3745)).toBe(700);
  });

  it('subtracts the actual receipt from an all-in price (YMAC new registration 650 incl. receipt 340)', () => {
    expect(serviceFeeFromRate({ amount: 650, vatInclusive: false, includesReceipt: true }, 340)).toBe(310);
  });

  it('takes VAT out of what is left when the all-in price includes VAT', () => {
    expect(serviceFeeFromRate({ amount: 1447, vatInclusive: true, includesReceipt: true }, 340)).toBe(1034.58);
  });

  it('suggests nothing when the receipt is unknown or costs more than the price', () => {
    expect(serviceFeeFromRate({ amount: 650, vatInclusive: false, includesReceipt: true }, null)).toBeNull();
    expect(serviceFeeFromRate({ amount: 650, vatInclusive: false, includesReceipt: true }, 700)).toBeNull();
  });
});

describe('rate kinds (TWE: <300cc 520, 300-799cc 885, ขอใช้ +100, ด่วน +100)', () => {
  const row = (o: Partial<RateRow>): RateRow => ({ id: 'r', label: '', vehicleKind: 'MOTO', ccMin: null, ccMax: null, amount: 0, vatInclusive: false, includesReceipt: false, kind: 'BASE', sortOrder: 0, ...o });
  const rates = [
    row({ id: 'plate', kind: 'OTHER_PROVINCE', amount: 100, sortOrder: 0 }),
    row({ id: 'small', ccMax: 300, amount: 520, sortOrder: 1 }),
    row({ id: 'big', ccMin: 300, ccMax: 800, amount: 885, sortOrder: 2 }),
    row({ id: 'urgent', kind: 'URGENT', amount: 100, sortOrder: 3 }),
  ];

  it('never picks an add-on row as the base price', () => {
    expect(suggestRate(rates, { isMoto: true, cc: 149.5 })?.id).toBe('small');
    expect(suggestRate(rates, { isMoto: true, cc: 367.6 })?.id).toBe('big');
  });

  it('adds the ขอใช้ (other-province) add-on for other-province cars and the urgent add-on for urgent submissions', () => {
    expect(suggestAddOns(rates, { isMoto: true, otherProvince: false, urgent: false })).toEqual([]);
    expect(suggestAddOns(rates, { isMoto: true, otherProvince: true, urgent: true }).map((r) => r.id)).toEqual(['plate', 'urgent']);
    expect(suggestAddOns(rates, { isMoto: false, otherProvince: true, urgent: true })).toEqual([]); // motorcycle-only add-ons
  });
});
