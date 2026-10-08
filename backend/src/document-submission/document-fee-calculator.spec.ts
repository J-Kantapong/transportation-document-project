import {
  computeDocumentFees,
  isSwapPlateOption,
  requestsPlateNumber,
  type DocumentFeeRuleSet,
  type DocumentSubmissionOptionsInput,
  type DocumentSubmissionVehicleInput,
} from './document-fee-calculator.js';

// Fixture mirroring the real seeded rows in backend/prisma/seed.ts (feeCarBillParam/feeCarNoBillParam/
// feeMotorcycleBillParam/feeMotorcycleNoBillParam) - keep these two in sync when seed.ts changes.
function baseRules(): DocumentFeeRuleSet {
  return {
    carBill: [
      { key: 'ค่าคำขอ (ปกติ)', amount: 5 },
      { key: 'ค่าคำขอ (ขอใช้จังหวัดอื่น)', amount: 10 },
      { key: 'ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)', amount: 20 },
      { key: 'ค่าตรวจสภาพรถ (Step4)', amount: 50 },
      { key: 'ค่าแผ่นป้ายทะเบียนรถ', amount: 200 },
      { key: 'ค่าใบคู่มือการจดทะเบียน', amount: 100 },
      { key: 'ค่าขอใช้เลขทะเบียน - เลขประมูล', amount: 1500 },
      { key: 'ค่าขอใช้เลขทะเบียน - ไม่ใช่เลขประมูล', amount: 500 },
      { key: 'ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายขาวดำ', amount: 200 },
      { key: 'ค่าทำแผ่นป้ายทะเบียนใหม่ - ป้ายประมูล', amount: 1200 },
      { key: 'ค่าย้ายออกต่างจังหวัด', amount: 50 },
    ],
    carNoBill: [
      { key: 'ค่าอากร (ปกติ)', amount: 10 },
      { key: 'ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)', amount: 30 },
      { key: 'ลงขัน - รย.1-เก๋ง 2 ตอน', amount: 40 },
      { key: 'ลงขัน - รย.1-นั่ง 2 ตอน', amount: 40 },
      { key: 'งานด่วนเพิ่ม (ต่อคัน)', amount: 100 },
    ],
    motoBill: [
      { key: 'ค่าคำขอ (ปกติ)', amount: 5 },
      { key: 'ค่าคำขอ (ขอใช้จังหวัดอื่น)', amount: 10 },
      { key: 'ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)', amount: 20 },
      { key: 'ค่าตรวจสภาพรถ (จยย.)', amount: 10 },
      { key: 'ค่าแผ่นป้ายทะเบียน', amount: 100 },
      { key: 'ค่าใบคู่มือจดทะเบียน', amount: 100 },
      { key: 'ค่าขอใช้เลขทะเบียน', amount: 500 },
    ],
    motoNoBill: [
      { key: 'ค่าอากร (ปกติ)', amount: 10 },
      { key: 'ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)', amount: 30 },
      { key: 'ลงขัน - รย.12 ทุกประเภท (CC)', amount: 40 },
      { key: 'ลงขันด่วนเพิ่ม (ต่อคัน)', amount: 50 },
      { key: 'ลงขัน - จดใหม่ หยุดใช้ย้ายออก', amount: 250 },
    ],
  };
}

function carVehicle(overrides: Partial<DocumentSubmissionVehicleInput> = {}): DocumentSubmissionVehicleInput {
  return { body: 'รย.1-เก๋ง 2 ตอน', registrationProvince: 'กรุงเทพมหานคร', ownerProvince: 'กรุงเทพมหานคร', ...overrides };
}

function motoVehicle(overrides: Partial<DocumentSubmissionVehicleInput> = {}): DocumentSubmissionVehicleInput {
  return { body: 'รย.12-300-799cc', registrationProvince: 'กรุงเทพมหานคร', ownerProvince: 'กรุงเทพมหานคร', ...overrides };
}

function baseOptions(overrides: Partial<DocumentSubmissionOptionsInput> = {}): DocumentSubmissionOptionsInput {
  return {
    plateNumberOption: 'NONE',
    includePlateFee: true,
    newPlateOption: 'NONE',
    relocateAddon: false,
    stopUseRelocateOut: false,
    urgent: false,
    ...overrides,
  };
}

describe('computeDocumentFees - ค่าคำขอ/ค่าอากร ใช้เงื่อนไข hasExtraRequest ร่วมกัน', () => {
  it('จดปกติ (จังหวัดตรงกัน, ไม่มีตัวเลือกเสริม) -> ค่าคำขอ 5, ค่าอากร 10', () => {
    const result = computeDocumentFees(carVehicle(), baseOptions(), baseRules());
    expect(result.hasExtraRequest).toBe(false);
    expect(result.billItems.find((i) => i.label.includes('ค่าคำขอ'))?.amount).toBe(5);
    expect(result.noBillItems.find((i) => i.label.includes('ค่าอากร'))?.amount).toBe(10);
  });

  it('จังหวัดไม่ตรงกัน -> ค่าคำขอ 10, ค่าธรรมเนียมอื่นๆ 20, ค่าอากร 30', () => {
    const result = computeDocumentFees(carVehicle({ ownerProvince: 'เชียงใหม่' }), baseOptions(), baseRules());
    expect(result.isOtherProvince).toBe(true);
    expect(result.hasExtraRequest).toBe(true);
    expect(result.billItems.find((i) => i.label.includes('ค่าคำขอ'))?.amount).toBe(10);
    expect(result.billItems.some((i) => i.label.includes('ค่าธรรมเนียมอื่นๆ'))).toBe(true);
    expect(result.noBillItems.find((i) => i.label.includes('ค่าอากร'))?.amount).toBe(30);
  });

  it('ขอใช้เลขทะเบียนอย่างเดียว (จังหวัดตรงกัน) ก็ทำให้ค่าคำขอ=10 และค่าอากร=30 ทันที (แค่ 1 รายการก็เกิน 1 แล้ว)', () => {
    const result = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'NORMAL' }), baseRules());
    expect(result.hasExtraRequest).toBe(true);
    expect(result.billItems.find((i) => i.label.includes('ค่าคำขอ'))?.amount).toBe(10);
    expect(result.noBillItems.find((i) => i.label.includes('ค่าอากร'))?.amount).toBe(30);
  });
});

describe('computeDocumentFees - ขอใช้เลขทะเบียน: รถยนต์ 2 ชั้นราคา vs มอเตอร์ไซค์ชั้นเดียว', () => {
  it('รถยนต์เลือกเลขประมูล -> 1500 บาท', () => {
    const result = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'AUCTION' }), baseRules());
    expect(result.billItems.find((i) => i.label.includes('เลขประมูล'))?.amount).toBe(1500);
  });

  it('รถยนต์เลือกไม่ใช่เลขประมูล -> 500 บาท', () => {
    const result = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'NORMAL' }), baseRules());
    expect(result.billItems.find((i) => i.label.includes('ไม่ใช่เลขประมูล'))?.amount).toBe(500);
  });

  it('มอเตอร์ไซค์มีราคาเดียว 500 บาท ไม่มีตัวเลือกเลขประมูล', () => {
    const result = computeDocumentFees(motoVehicle(), baseOptions({ plateNumberOption: 'NORMAL' }), baseRules());
    expect(result.billItems.find((i) => i.label === 'ค่าขอใช้เลขทะเบียน')?.amount).toBe(500);
  });
});

describe('computeDocumentFees - จดใหม่ หยุดใช้ย้ายออก (มอเตอร์ไซค์เท่านั้น, ลงขัน 250)', () => {
  it('มอเตอร์ไซค์ปกติ -> ลงขัน 40', () => {
    const result = computeDocumentFees(motoVehicle(), baseOptions(), baseRules());
    expect(result.noBillItems.find((i) => i.label.includes('ลงขัน'))?.amount).toBe(40);
  });

  it('มอเตอร์ไซค์ติ๊กจดใหม่หยุดใช้ย้ายออก -> ลงขัน 250', () => {
    const result = computeDocumentFees(motoVehicle(), baseOptions({ stopUseRelocateOut: true }), baseRules());
    expect(result.noBillItems.find((i) => i.label.includes('ลงขัน'))?.amount).toBe(250);
  });

  it('รถยนต์ไม่มีตัวเลือกนี้ - ลงขันคงเดิมตามประเภทรถแม้ flag จะถูกส่งมา (defensive gating)', () => {
    const options = baseOptions({ stopUseRelocateOut: true }) as DocumentSubmissionOptionsInput;
    const result = computeDocumentFees(carVehicle(), options, baseRules());
    expect(result.noBillItems.find((i) => i.label.includes('ลงขัน'))?.amount).toBe(40);
  });
});

// ลงขันรถยนต์ยัง lookup คีย์ "ลงขัน - " + ประเภทรถ แยกตามประเภทจริง (ไม่ใช่คีย์เดียวคงที่) แม้ราคาปัจจุบัน
// ของทุกประเภทจะเท่ากัน (40 บาท) แล้วก็ตาม - เผื่อผู้ใช้แยกราคาต่างกันอีกในอนาคต
describe('computeDocumentFees - ลงขันรถยนต์ lookup ตามประเภทรถจริงเสมอ', () => {
  it('รย.1-เก๋ง 2 ตอน -> ลงขัน 40', () => {
    const result = computeDocumentFees(carVehicle({ body: 'รย.1-เก๋ง 2 ตอน' }), baseOptions(), baseRules());
    expect(result.noBillItems.find((i) => i.label.includes('ลงขัน'))?.amount).toBe(40);
  });

  it('รย.1-นั่ง 2 ตอน -> ลงขัน 40', () => {
    const result = computeDocumentFees(carVehicle({ body: 'รย.1-นั่ง 2 ตอน' }), baseOptions(), baseRules());
    expect(result.noBillItems.find((i) => i.label.includes('ลงขัน'))?.amount).toBe(40);
  });
});

describe('computeDocumentFees - ค่าแผ่นป้ายทะเบียน includePlateFee toggle', () => {
  it('ไม่ขอเลขทะเบียน -> รวมค่าป้ายเสมอ', () => {
    const result = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'NONE' }), baseRules());
    expect(result.billItems.some((i) => i.label.includes('ค่าแผ่นป้ายทะเบียน'))).toBe(true);
  });

  it('ขอเลขทะเบียน + ไม่ติ๊กรวมค่าป้าย -> ไม่มีรายการค่าป้าย', () => {
    const result = computeDocumentFees(
      carVehicle(),
      baseOptions({ plateNumberOption: 'NORMAL', includePlateFee: false }),
      baseRules(),
    );
    expect(result.billItems.some((i) => i.label.includes('ค่าแผ่นป้ายทะเบียนรถ'))).toBe(false);
  });

  it('ขอเลขทะเบียน + ติ๊กรวมค่าป้าย -> มีรายการค่าป้าย', () => {
    const result = computeDocumentFees(
      carVehicle(),
      baseOptions({ plateNumberOption: 'NORMAL', includePlateFee: true }),
      baseRules(),
    );
    expect(result.billItems.some((i) => i.label.includes('ค่าแผ่นป้ายทะเบียนรถ'))).toBe(true);
  });
});

// "มีคนทำสลับเลขมาให้" (ผู้ใช้ 2026-09-27): ไม่มีค่าขอใช้เลข คิดค่าแผ่นป้ายตามปกติ ไม่นับเป็นคำขอเพิ่ม
describe('computeDocumentFees - มีคนทำสลับเลขมาให้ (SWAP_NORMAL / SWAP_AUCTION)', () => {
  it.each(['SWAP_NORMAL', 'SWAP_AUCTION'] as const)('%s -> ยอดเท่ากับไม่ขอเลข: ค่าคำขอ/อากรปกติ มีค่าป้าย ไม่มีค่าขอใช้เลข', (option) => {
    const swap = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: option }), baseRules());
    const none = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'NONE' }), baseRules());
    expect(swap.hasExtraRequest).toBe(false);
    expect(swap.billItems.find((i) => i.label.includes('ค่าคำขอ'))?.amount).toBe(5);
    expect(swap.noBillItems.find((i) => i.label.includes('ค่าอากร'))?.amount).toBe(10);
    expect(swap.billItems.find((i) => i.label === 'ค่าแผ่นป้ายทะเบียนรถ')?.amount).toBe(200);
    expect(swap.billItems.some((i) => i.label.includes('ขอใช้เลข'))).toBe(false);
    expect(swap.billTotal).toBe(none.billTotal);
    expect(swap.noBillTotal).toBe(none.noBillTotal);
  });

  it('คิดค่าแผ่นป้ายเสมอ แม้ส่ง includePlateFee = false มา', () => {
    const result = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'SWAP_AUCTION', includePlateFee: false }), baseRules());
    expect(result.billItems.some((i) => i.label === 'ค่าแผ่นป้ายทะเบียนรถ')).toBe(true);
  });

  it('ตัวเลือกอื่นยังนับเป็นคำขอเพิ่มตามเดิม (จังหวัดอื่น / ทำป้ายใหม่)', () => {
    const otherProvince = computeDocumentFees(carVehicle({ ownerProvince: 'เชียงใหม่' }), baseOptions({ plateNumberOption: 'SWAP_NORMAL' }), baseRules());
    expect(otherProvince.hasExtraRequest).toBe(true);
    const newPlate = computeDocumentFees(carVehicle(), baseOptions({ plateNumberOption: 'SWAP_NORMAL', newPlateOption: 'BLACKWHITE' }), baseRules());
    expect(newPlate.hasExtraRequest).toBe(true);
    expect(newPlate.noBillItems.find((i) => i.label.includes('ค่าอากร'))?.amount).toBe(30);
  });
});

describe('requestsPlateNumber / isSwapPlateOption', () => {
  it('ขอใช้เลข = NORMAL/AUCTION เท่านั้น, สลับเลข = SWAP_*', () => {
    expect(['NONE', 'NORMAL', 'AUCTION', 'SWAP_NORMAL', 'SWAP_AUCTION'].map(requestsPlateNumber)).toEqual([false, true, true, false, false]);
    expect(['NONE', 'NORMAL', 'AUCTION', 'SWAP_NORMAL', 'SWAP_AUCTION', null].map(isSwapPlateOption)).toEqual([false, false, false, true, true, false]);
  });
});

// ผู้ใช้ 2026-10-08: จังหวัดอื่นนอกจากกรุงเทพฯ/สมุทรปราการ ส่งซับจด - No bill = ค่าจ้างซับตามตารางจังหวัด (คิดทุกคัน ทั้ง 3 ช่อง)
describe('computeDocumentFees - ส่งซับจดต่างจังหวัด', () => {
  const rates = [
    { province: 'เชียงใหม่', accepts: true, serviceFee: 1000, channelFee: 300, inspectionFee: 200 },
    { province: 'พะเยา', accepts: false, serviceFee: null, channelFee: null, inspectionFee: null },
    { province: 'ตราด', accepts: true, serviceFee: 1000, channelFee: null, inspectionFee: 200 },
  ];
  const rules = () => ({ ...baseRules(), supplierRates: rates });

  it('No bill = ค่าดำเนินการ + ค่าช่อง + นำรถเข้าตรวจสภาพ ไม่มีอากร/ลงขัน/ด่วนของออฟฟิศ - Bill คิดตามปกติ', () => {
    const normal = computeDocumentFees(carVehicle({ registrationProvince: 'เชียงใหม่', ownerProvince: 'เชียงใหม่' }), baseOptions({ urgent: true }), rules());
    expect(normal.viaSupplier).toBe(true);
    expect(normal.noBillItems).toEqual([
      { label: 'ค่าดำเนินการซับ', amount: 1000 },
      { label: 'ค่าช่อง', amount: 300 },
      { label: 'นำรถเข้าตรวจสภาพ', amount: 200 },
    ]);
    expect(normal.noBillTotal).toBe(1500);
    const self = computeDocumentFees(carVehicle(), baseOptions(), rules());
    expect(self.viaSupplier).toBe(false);
    expect(normal.billItems.map((i) => i.label)).toEqual(self.billItems.map((i) => i.label));
  });

  it('สมุทรปราการออฟฟิศจดเอง - ใช้ No bill ปกติ', () => {
    const fee = computeDocumentFees(motoVehicle({ registrationProvince: 'สมุทรปราการ', ownerProvince: 'สมุทรปราการ' }), baseOptions(), rules());
    expect(fee.viaSupplier).toBe(false);
    expect(fee.noBillItems.some((i) => i.label.startsWith('ลงขัน'))).toBe(true);
  });

  it('ซับไม่รับ / ยังไม่มีราคา / ราคาไม่ครบ = คิดไม่ได้ พร้อมเหตุผล (ไม่เดาราคา)', () => {
    const at = (province: string) => () => computeDocumentFees(carVehicle({ registrationProvince: province }), baseOptions(), rules());
    expect(at('พะเยา')).toThrow('ซับไม่รับจดทะเบียนจังหวัดพะเยา');
    expect(at('น่าน')).toThrow('ยังไม่มีราคาซับของจังหวัดน่าน');
    expect(at('ตราด')).toThrow('ยังไม่ครบ (ค่าช่อง)');
    expect(() => computeDocumentFees(carVehicle({ registrationProvince: 'น่าน' }), baseOptions(), baseRules())).toThrow('ยังไม่มีราคาซับ');
  });

  it('billOnly (หน้าวางบิล): ได้ยอด Bill โดยไม่ต้องมีตารางราคาซับ', () => {
    const fee = computeDocumentFees(carVehicle({ registrationProvince: 'น่าน' }), baseOptions(), baseRules(), { billOnly: true });
    expect(fee.billTotal).toBeGreaterThan(0);
    expect(fee.noBillTotal).toBe(0);
  });
});
