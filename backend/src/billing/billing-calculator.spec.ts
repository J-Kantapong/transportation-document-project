import { computeInvoiceTotals, effectiveWhtRate, nextInvoiceNo, rateAmountExVat, suggestRate, type BillingTerms, type RateRow } from './billing-calculator.js';

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
  const rate = (o: Partial<RateRow>): RateRow => ({ id: 'r', label: '', vehicleKind: 'ANY', ccMin: null, ccMax: null, amount: 0, vatInclusive: false, sortOrder: 0, ...o });
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
