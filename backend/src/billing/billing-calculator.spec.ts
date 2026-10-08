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

  it('custom lines: fee has no VAT or WHT, service has both, goods has VAT but no WHT', () => {
    const t = computeInvoiceTotals({
      lines: [],
      extras: [],
      items: [
        { kind: 'FEE', amount: 340 },
        { kind: 'SERVICE', amount: 1000 },
        { kind: 'GOODS', amount: 280000 },
      ],
      terms: terms(),
      issueDate: '2026-09-29',
    });
    expect(t).toMatchObject({ feeTotal: 340, serviceTotal: 1000, goodsTotal: 280000, vatAmount: 19670, whtAmount: 30, grossTotal: 301010, netTotal: 300980 });
  });

  it('custom lines on a no-VAT (personal account) bill: goods get no VAT, service still withheld', () => {
    const t = computeInvoiceTotals({ lines: [], extras: [], items: [{ kind: 'SERVICE', amount: 500 }, { kind: 'GOODS', amount: 1000 }], terms: terms({ vat: false }), issueDate: '2026-09-29' });
    expect(t).toMatchObject({ vatAmount: 0, whtAmount: 15, netTotal: 1485 });
  });

  it('vehicle lines and custom lines add up on one bill', () => {
    const t = computeInvoiceTotals({ lines: [{ receiptAmount: 340, serviceFee: 520 }], extras: [], items: [{ kind: 'FEE', amount: 100 }, { kind: 'SERVICE', amount: 480 }], terms: terms(), issueDate: '2026-09-29' });
    expect(t).toMatchObject({ feeTotal: 440, serviceTotal: 1000, goodsTotal: 0, vatAmount: 70, whtAmount: 30 });
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
  const rate = (o: Partial<RateRow>): RateRow => ({ id: 'r', label: '', vehicleKind: 'ANY', ccMin: null, ccMax: null, chassisPrefix: null, amount: 0, vatInclusive: false, includesReceipt: false, kind: 'BASE', sortOrder: 0, ...o });
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
  const row = (o: Partial<RateRow>): RateRow => ({ id: 'r', label: '', vehicleKind: 'MOTO', ccMin: null, ccMax: null, chassisPrefix: null, amount: 0, vatInclusive: false, includesReceipt: false, kind: 'BASE', sortOrder: 0, ...o });
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
    expect(suggestAddOns(rates, { isMoto: true, otherProvince: false, urgent: false, requestedPlateNumber: false, transferNotice: false, plateSwap: false })).toEqual([]);
    expect(suggestAddOns(rates, { isMoto: true, otherProvince: true, urgent: true, requestedPlateNumber: false, transferNotice: false, plateSwap: false }).map((r) => r.id)).toEqual(['plate', 'urgent']);
    expect(suggestAddOns(rates, { isMoto: false, otherProvince: true, urgent: true, requestedPlateNumber: false, transferNotice: false, plateSwap: false })).toEqual([]); // motorcycle-only add-ons
  });

  it('adds the ขอใช้เลข (plate number request) add-on when the vehicle requested a plate number (Spac EV)', () => {
    const withPlateRow = [...rates, row({ id: 'plateReq', kind: 'PLATE_REQUEST', amount: 98.13, sortOrder: 4 })];
    expect(suggestAddOns(withPlateRow, { isMoto: true, otherProvince: false, urgent: false, requestedPlateNumber: true, transferNotice: false, plateSwap: false }).map((r) => r.id)).toEqual(['plateReq']);
    expect(suggestAddOns(withPlateRow, { isMoto: true, otherProvince: false, urgent: false, requestedPlateNumber: false, transferNotice: false, plateSwap: false })).toEqual([]);
  });

  it('adds the แจ้งย้าย add-on only when the vehicle actually goes through แจ้งย้าย, separately from ขอใช้ (Spac EV)', () => {
    const withTransferRow = [...rates, row({ id: 'transfer', kind: 'TRANSFER_NOTICE', amount: 182.24, sortOrder: 5 })];
    expect(
      suggestAddOns(withTransferRow, { isMoto: true, otherProvince: false, urgent: false, requestedPlateNumber: false, transferNotice: true, plateSwap: false }).map((r) => r.id),
    ).toEqual(['transfer']);
    // otherProvince (จดจังหวัดอื่นจากเจ้าของรถ) และ transferNotice (จดต่างจังหวัดจากกรุงเทพฯ) เป็นเงื่อนไขคนละอย่าง ไม่ผูกกัน
    expect(
      suggestAddOns(withTransferRow, { isMoto: true, otherProvince: true, urgent: false, requestedPlateNumber: false, transferNotice: false, plateSwap: false }).map((r) => r.id),
    ).toEqual(['plate']);
    expect(suggestAddOns(withTransferRow, { isMoto: true, otherProvince: false, urgent: false, requestedPlateNumber: false, transferNotice: false, plateSwap: false })).toEqual([]);
  });
});

describe('suggestRate with chassisPrefix (MC Superbike: ML=885, JH=2685, both 300-799cc)', () => {
  const rate = (o: Partial<RateRow>): RateRow => ({
    id: 'r',
    label: '',
    vehicleKind: 'MOTO',
    ccMin: null,
    ccMax: null,
    chassisPrefix: null,
    amount: 0,
    vatInclusive: false,
    includesReceipt: false,
    kind: 'BASE',
    sortOrder: 0,
    ...o,
  });
  const rates = [
    rate({ id: 'jh', chassisPrefix: 'JH', amount: 2685, sortOrder: 0 }),
    rate({ id: 'ml', chassisPrefix: 'ML', amount: 885, sortOrder: 1 }),
  ];

  it('picks the row whose chassisPrefix matches, even when CC overlaps between rows', () => {
    expect(suggestRate(rates, { isMoto: true, cc: 471, chassis: 'MLHPC7272T5100369' })?.id).toBe('ml');
    expect(suggestRate(rates, { isMoto: true, cc: 745, chassis: 'JH2RH21T6TK101029' })?.id).toBe('jh');
    expect(suggestRate(rates, { isMoto: true, cc: 348, chassis: 'JH2NC64TXTK000575' })?.id).toBe('jh');
  });

  it('matches case-insensitively and ignores rows whose prefix does not match', () => {
    expect(suggestRate(rates, { isMoto: true, cc: 200, chassis: 'mlhpc123' })?.id).toBe('ml');
    expect(suggestRate(rates, { isMoto: true, cc: 200, chassis: 'ZZZ12345' })).toBeNull();
  });
});

// วางบิลงานสลับเลข (ผู้ใช้ 2026-09-28, Spac EV: "สลับเลข" 1,720 รวม VAT เฉพาะรถยนต์ คิดเพิ่มจากค่าจดทะเบียนปกติ)
describe('ค่าเพิ่มงานสลับเลข', () => {
  const swapRate = { id: 'swap', label: 'ค่าเพิ่ม: สลับเลข', vehicleKind: 'CAR', ccMin: null, ccMax: null, chassisPrefix: null, amount: 1720, vatInclusive: true, includesReceipt: false, kind: 'PLATE_SWAP', sortOrder: 5 };
  const plain = { isMoto: false, otherProvince: false, urgent: false, requestedPlateNumber: false, transferNotice: false, plateSwap: false };

  it('เสนอให้เฉพาะรถที่เป็นรถใหม่ของงานสลับเลข', () => {
    expect(suggestAddOns([swapRate], { ...plain, plateSwap: true }).map((r) => r.id)).toEqual(['swap']);
    expect(suggestAddOns([swapRate], plain)).toEqual([]);
  });

  it('ไม่เสนอให้รถจักรยานยนต์ (อัตรานี้เฉพาะรถยนต์)', () => {
    expect(suggestAddOns([swapRate], { ...plain, isMoto: true, plateSwap: true })).toEqual([]);
  });

  it('ลูกค้าจ่ายค่าสลับเลขเอง (ใบยื่นแบบมีคนทำมาให้) = เสนอ PLATE_SWAP_GIVEN 540 รวม VAT = 504.67 ก่อน VAT ไม่ใช่ 1,720', () => {
    const givenRate = { ...swapRate, id: 'given', amount: 540, kind: 'PLATE_SWAP_GIVEN', sortOrder: 6 };
    expect(suggestAddOns([swapRate, givenRate], { ...plain, plateSwapGiven: true }).map((r) => r.id)).toEqual(['given']);
    expect(suggestAddOns([swapRate, givenRate], plain)).toEqual([]);
    expect(rateAmountExVat(givenRate)).toBe(504.67);
  });

  it('1,720 รวม VAT = ค่าดำเนินการ 1,607.48 ก่อน VAT', () => {
    expect(rateAmountExVat(swapRate)).toBe(1607.48);
  });

  it('ค่าใบเสร็จของรถเก่ารวมอยู่ในยอดค่าธรรมเนียม ไม่โดน VAT', () => {
    const totals = computeInvoiceTotals({
      lines: [{ receiptAmount: 1000, serviceFee: 1607.48, swapReceiptAmount: 250 }],
      extras: [],
      terms: { vat: true, whtRate: 0, whtSpecialRate: null, whtSpecialUntil: null },
      issueDate: '2026-09-28',
    });
    expect(totals.feeTotal).toBe(1250);
    expect(totals.serviceTotal).toBe(1607.48);
    expect(totals.vatAmount).toBe(112.52);
    expect(totals.grossTotal).toBe(2970);
  });

  // ผู้ใช้ 2026-10-08: ใบเสร็จแจ้งย้ายของรถ (ขั้น 2) รวมอยู่ในค่าธรรมเนียมของบิล ไม่คิด VAT / ไม่เป็นฐานหัก ณ ที่จ่าย
  it('ใบเสร็จแจ้งย้ายรวมเข้าค่าธรรมเนียม ไม่กระทบ VAT และหัก ณ ที่จ่าย', () => {
    const base = { extras: [], terms: terms(), issueDate: '2026-10-08' };
    const without = computeInvoiceTotals({ ...base, lines: [{ receiptAmount: 240, serviceFee: 500 }] });
    const withTransfer = computeInvoiceTotals({ ...base, lines: [{ receiptAmount: 240, serviceFee: 500, transferReceiptAmount: 5 }] });
    expect(withTransfer.feeTotal).toBe(245);
    expect(withTransfer.vatAmount).toBe(without.vatAmount);
    expect(withTransfer.whtAmount).toBe(without.whtAmount);
    expect(withTransfer.netTotal).toBe(without.netTotal + 5);
  });

  it('บรรทัดเก่าที่ไม่มีงานสลับเลข คิดเหมือนเดิม', () => {
    const totals = computeInvoiceTotals({
      lines: [{ receiptAmount: 1000, serviceFee: 100 }],
      extras: [],
      terms: { vat: false, whtRate: 0, whtSpecialRate: null, whtSpecialUntil: null },
      issueDate: '2026-09-28',
    });
    expect(totals.feeTotal).toBe(1000);
  });
});
