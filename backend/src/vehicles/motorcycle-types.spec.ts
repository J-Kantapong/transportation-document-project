import { describe, expect, it } from 'vitest';
import { vehicleKindOf, vehicleTypeWhere } from '../auth/vehicle-scope.js';
import { computeDocumentFees, isMotorcycle } from '../document-submission/document-fee-calculator.js';
import { classifyVehicleFamily } from '../tax/government-tax-reference-data.js';
import { vehicleClassOf } from '../tax-renewal/tax-renewal-fee.js';
import { isMotorcycleType, motorcycleTypeWhere, VEHICLE_TYPES } from './vehicle-reference-data.js';
import { requiredSizeField } from './vehicle-validation.js';

// ผู้ใช้ 2026-10-08: เพิ่มประเภทรถ "รย.17-จักรยานยนต์สาธารณะ" - นับเป็นมอเตอร์ไซค์ทุกที่ (ขอบเขตงาน ค่าธรรมเนียม ภาษี)
const PUBLIC_MOTO = 'รย.17-จักรยานยนต์สาธารณะ';

describe('รย.17 จักรยานยนต์สาธารณะ', () => {
  it('อยู่ในรายการประเภทรถ (14 ประเภท) ต่อจาก รย.12', () => {
    expect(VEHICLE_TYPES).toHaveLength(14);
    expect(VEHICLE_TYPES.indexOf(PUBLIC_MOTO)).toBe(4);
  });

  it('นับเป็นมอเตอร์ไซค์ทุกจุดที่ตัดสินประเภทรถ', () => {
    expect(isMotorcycleType(PUBLIC_MOTO)).toBe(true);
    expect(vehicleKindOf(PUBLIC_MOTO)).toBe('moto');
    expect(isMotorcycle(PUBLIC_MOTO)).toBe(true);
    expect(vehicleClassOf(PUBLIC_MOTO)).toBe('MOTO');
    expect(classifyVehicleFamily(PUBLIC_MOTO)).toBe(classifyVehicleFamily('รย.12-น้อยกว่า 300cc'));
    expect(requiredSizeField(PUBLIC_MOTO, 'เบนซิน')).toBe('cc');
  });

  it('รถยนต์ยังเป็นรถยนต์ (รย.1 ไม่ถูกนับเป็น รย.12 / รย.17)', () => {
    for (const body of ['รย.1-เก๋ง 2 ตอน', 'รย.2-นั่ง 2 แถว', 'รย.3-ตู้บรรทุก', null, '']) {
      expect(isMotorcycleType(body)).toBe(false);
      expect(vehicleKindOf(body)).toBe('car');
    }
  });

  it('เงื่อนไขฐานข้อมูลของ STAFF_MOTO / STAFF_CAR รวม รย.17 ด้วย', () => {
    const moto = { OR: [{ body: { startsWith: 'รย.12-' } }, { body: { startsWith: 'รย.17-' } }] };
    expect(motorcycleTypeWhere('body')).toEqual(moto);
    expect(vehicleTypeWhere('MOTO')).toEqual({ AND: [moto] });
    expect(vehicleTypeWhere('CAR')).toEqual({ AND: [{ OR: [{ body: null }, { NOT: moto }] }] });
  });

  it('ค่าธรรมเนียมขั้นยื่นใช้ชุดมอเตอร์ไซค์', () => {
    const row = (key: string, amount: number) => ({ key, amount });
    const rules = {
      carBill: [],
      carNoBill: [],
      motoBill: [
        row('ค่าคำขอ (ปกติ)', 5),
        row('ค่าคำขอ (ขอใช้จังหวัดอื่น)', 10),
        row('ค่าธรรมเนียมอื่นๆ (ขอใช้จังหวัดอื่น)', 20),
        row('ค่าตรวจสภาพรถ (จยย.)', 10),
        row('ค่าแผ่นป้ายทะเบียน', 100),
        row('ค่าใบคู่มือจดทะเบียน', 100),
      ],
      motoNoBill: [
        row('ค่าอากร (ปกติ)', 10),
        row('ค่าอากร (ทำเพิ่มเติมเกิน 1 รายการ)', 30),
        row('ลงขัน - รย.12 ทุกประเภท (CC)', 40),
        row('ลงขัน - จดสมุทรปราการ', 100),
      ],
    };
    const fee = computeDocumentFees(
      { body: PUBLIC_MOTO, registrationProvince: 'สมุทรปราการ', ownerProvince: 'สมุทรปราการ' },
      { plateNumberOption: 'NONE', includePlateFee: true, newPlateOption: null, relocateAddon: false, stopUseRelocateOut: false, urgent: false },
      rules,
    );
    const options = { plateNumberOption: 'NONE' as const, includePlateFee: true, newPlateOption: null, relocateAddon: false, stopUseRelocateOut: false, urgent: false };
    expect(fee.isMoto).toBe(true);
    expect(fee.billTotal).toBe(215);
    // จดสมุทรปราการ: ลงขัน 100 + อากรปกติ 10 (ผู้ใช้ 2026-10-08)
    expect(fee.noBillItems).toEqual([
      { label: 'ค่าอากร (ปกติ)', amount: 10 },
      { label: 'ลงขัน (จดสมุทรปราการ)', amount: 100 },
    ]);
    // ผู้ใช้รถอยู่จังหวัดอื่น = ขอใช้: ค่าคำขอ 10 + ธรรมเนียมอื่น 20 และอากร 30
    const requested = computeDocumentFees({ body: PUBLIC_MOTO, registrationProvince: 'สมุทรปราการ', ownerProvince: 'กรุงเทพมหานคร' }, options, rules);
    expect(requested.billTotal).toBe(240);
    expect(requested.noBillTotal).toBe(130);
    // จดกรุงเทพฯ ยังลงขัน 40 เหมือนเดิม ทั้ง รย.12 และ รย.17
    for (const body of [PUBLIC_MOTO, 'รย.12-น้อยกว่า 300cc']) {
      const bangkok = computeDocumentFees({ body, registrationProvince: 'กรุงเทพมหานคร', ownerProvince: 'กรุงเทพมหานคร' }, options, rules);
      expect(bangkok.noBillTotal).toBe(50);
    }
    // รย.12 ที่จดสมุทรปราการก็ลงขัน 100 เช่นกัน
    const ry12 = computeDocumentFees({ body: 'รย.12-น้อยกว่า 300cc', registrationProvince: 'สมุทรปราการ', ownerProvince: 'สมุทรปราการ' }, options, rules);
    expect(ry12.noBillTotal).toBe(110);
  });
});
