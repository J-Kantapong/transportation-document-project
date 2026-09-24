import { accessFor, isAllowed } from './access-policy.js';
import { canEditTransferNotice } from './vehicle-scope.js';

// ขั้น 2 แจ้งย้าย/ตัดบัญชี: STAFF_MOTO บันทึกได้เฉพาะจักรยานยนต์ (ผู้ใช้ 2026-09-24)
describe('transfer-notice access', () => {
  const patch = accessFor('/api/vehicles/abc/transfer-notice', 'PATCH');

  it('lets entry staff, admin and STAFF_MOTO through the route', () => {
    expect(isAllowed(patch, ['STAFF_ENTRY'])).toBe(true);
    expect(isAllowed(patch, ['ADMIN'])).toBe(true);
    expect(isAllowed(patch, ['STAFF_MOTO'])).toBe(true);
    expect(isAllowed(patch, ['STAFF_CAR'])).toBe(false);
    expect(isAllowed(patch, ['ACCOUNTANT'])).toBe(false);
  });

  it('keeps the other step 1-3 writes closed to STAFF_MOTO', () => {
    expect(isAllowed(accessFor('/api/vehicles/abc/inspection-sent', 'PATCH'), ['STAFF_MOTO'])).toBe(false);
    expect(isAllowed(accessFor('/api/vehicles', 'POST'), ['STAFF_MOTO'])).toBe(false);
  });

  it('limits STAFF_MOTO to motorcycles', () => {
    expect(canEditTransferNotice(['STAFF_MOTO'], 'รย.12-น้อยกว่า 300cc')).toBe(true);
    expect(canEditTransferNotice(['STAFF_MOTO'], 'รย.1-เก๋ง 4 ประตู')).toBe(false);
    expect(canEditTransferNotice(['STAFF_MOTO'], null)).toBe(false);
    expect(canEditTransferNotice(['STAFF_ENTRY'], 'รย.1-เก๋ง 4 ประตู')).toBe(true);
    expect(canEditTransferNotice(['STAFF_CAR'], 'รย.12-น้อยกว่า 300cc')).toBe(false);
  });
});
