import { OwnerType } from '../generated/prisma/enums.js';
import { parseDate, parseRenewalOwner, storedRenewalOwner } from './tax-renewal-validation.js';

describe('parseDate', () => {
  it('รับ ค.ศ. YYYY-MM-DD เป็นเที่ยงคืน UTC', () => {
    expect(parseDate('2026-09-27', 'วันที่ชำระ')).toEqual(new Date('2026-09-27T00:00:00.000Z'));
  });

  // พบ 2026-09-27: Date.parse ยอมวันที่ที่ไม่มีจริง (เลื่อนไปเดือนถัดไป) และปี พ.ศ.
  it.each(['2026-02-31', '2569-09-27', '1899-12-31', '27/09/2026'])('%s -> 400', (raw) => {
    expect(() => parseDate(raw, 'วันที่ชำระ')).toThrow();
  });

  it('ว่าง: ไม่บังคับ = null, บังคับ = กรุณาระบุ', () => {
    expect(parseDate('', 'วันที่ชำระ')).toBeNull();
    expect(() => parseDate(null, 'วันครบกำหนดภาษี', true)).toThrow();
  });
});

describe('parseRenewalOwner', () => {
  it('ไม่ติดไฟแนนซ์: ประเภทที่เลือกคือเจ้าของ', () => {
    expect(parseRenewalOwner({ ownerType: 'JURISTIC' })).toEqual({
      ownerType: OwnerType.JURISTIC,
      isHirePurchaseBusiness: false,
      hirerType: null,
    });
  });

  it('ติดไฟแนนซ์: เจ้าของ = นิติบุคคลเช่าซื้อ ประเภทที่เลือกคือผู้เช่าซื้อ (แบบเดียวกับหน้าเพิ่มข้อมูลรถ)', () => {
    expect(parseRenewalOwner({ ownerType: 'INDIVIDUAL', financed: true })).toEqual({
      ownerType: OwnerType.JURISTIC,
      isHirePurchaseBusiness: true,
      hirerType: OwnerType.INDIVIDUAL,
    });
  });

  it('ยังบังคับเลือกประเภทเจ้าของรถเสมอ', () => {
    expect(() => parseRenewalOwner({ financed: true })).toThrow();
  });
});

describe('storedRenewalOwner', () => {
  it('อ่านเจ้าของที่เก็บไว้ใน taxBreakdown.owner', () => {
    const owner = { ownerType: 'JURISTIC', isHirePurchaseBusiness: true, hirerType: 'INDIVIDUAL' };
    expect(storedRenewalOwner({ companyMultiplier: 1, owner })).toEqual(owner);
  });

  it.each([null, {}, { owner: { ownerType: 'X' } }])('ไม่มี/ค่าเสีย (%j) -> null', (taxBreakdown) => {
    expect(storedRenewalOwner(taxBreakdown)).toBeNull();
  });
});
