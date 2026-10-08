import { describe, expect, it } from 'vitest';
import { isSupplierProvince, withoutOfficeOnlyOptions } from './supplier-route.js';

// ผู้ใช้ 2026-10-08: กรุงเทพฯ / สมุทรปราการ ออฟฟิศจดเอง จังหวัดอื่นส่งซับ - รถส่งซับไม่มี "ด่วน" และ "หยุดใช้ย้ายออก"
describe('supplier route', () => {
  it('ตัดสินจากจังหวัดที่จดอย่างเดียว', () => {
    expect(['กรุงเทพมหานคร', 'สมุทรปราการ', 'เชียงใหม่', 'นนทบุรี', null, ''].map(isSupplierProvince)).toEqual([false, false, true, true, false, false]);
  });

  it('รถส่งซับ: ตัดงานด่วนและหยุดใช้ย้ายออกทิ้ง ตัวเลือกอื่นคงเดิม', () => {
    const options = { urgent: true, stopUseRelocateOut: true, relocateAddon: true, plateNumberOption: 'NORMAL' };
    expect(withoutOfficeOnlyOptions(options, 'เชียงใหม่')).toEqual({ ...options, urgent: false, stopUseRelocateOut: false });
    expect(withoutOfficeOnlyOptions(options, 'สมุทรปราการ')).toBe(options);
    expect(withoutOfficeOnlyOptions(options, 'กรุงเทพมหานคร')).toBe(options);
  });
});
