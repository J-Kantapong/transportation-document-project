import { describe, expect, it } from 'vitest';
import type { UserRole } from '../generated/prisma/enums.js';
import { requestContext } from './request-context.js';
import {
  assertKindInScope,
  assertVehicleInScope,
  assertVehicleReadable,
  currentDeliveryScope,
  vehicleScopeFor,
  writeScopeFor,
} from './vehicle-scope.js';

const CAR = 'รย.1-เก๋ง 4 ประตู';
const MOTO = 'รย.12-รถจักรยานยนต์ส่วนบุคคล';

function as<T>(roles: UserRole[], fn: () => T): T {
  return requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);
}

// ถือหลายบทบาทแล้วสิทธิ์แก้ต้องไม่ขยายเกินประเภทรถของ STAFF_* (พบ 2026-09-27)
describe('vehicle scope - อ่านกับแก้แยกกัน', () => {
  it('ACCOUNTANT / DELIVERY ไม่ขยายสิทธิ์แก้ของ STAFF_CAR / STAFF_MOTO', () => {
    expect(vehicleScopeFor(['STAFF_MOTO', 'DELIVERY'])).toBe('ALL');
    expect(writeScopeFor(['STAFF_MOTO', 'DELIVERY'])).toBe('MOTO');
    expect(writeScopeFor(['STAFF_CAR', 'ACCOUNTANT'])).toBe('CAR');
    expect(writeScopeFor(['STAFF_CAR', 'STAFF_MOTO'])).toBe('ALL');
    expect(writeScopeFor(['ADMIN', 'STAFF_CAR'])).toBe('ALL');
    expect(writeScopeFor(['ACCOUNTANT'])).toBe('ALL');
    expect(writeScopeFor(['STAFF_ENTRY'])).toBe('NONE');
  });

  it('บันทึกรถอีกประเภทไม่ได้ แต่ยังอ่านได้', () => {
    as(['STAFF_MOTO', 'DELIVERY'], () => {
      expect(() => assertVehicleInScope(MOTO)).not.toThrow();
      expect(() => assertVehicleInScope(CAR)).toThrow();
      expect(() => assertKindInScope('car')).toThrow();
      expect(() => assertVehicleReadable(CAR)).not.toThrow();
    });
    as(['STAFF_CAR', 'ACCOUNTANT'], () => {
      expect(() => assertVehicleInScope(MOTO)).toThrow();
      expect(() => assertKindInScope('moto')).toThrow();
      expect(() => assertKindInScope('car')).not.toThrow();
    });
  });

  it('ส่งงาน: DELIVERY ส่งได้ทุกคันแม้ถือ STAFF_* ด้วย', () => {
    expect(as(['STAFF_MOTO', 'DELIVERY'], currentDeliveryScope)).toBe('ALL');
    expect(as(['STAFF_MOTO'], currentDeliveryScope)).toBe('MOTO');
    expect(as(['STAFF_CAR', 'ACCOUNTANT'], currentDeliveryScope)).toBe('CAR');
  });
});
