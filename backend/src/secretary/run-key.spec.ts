import { describe, expect, it } from 'vitest';
import { isSlot, verifyRunKey } from './run-key.js';

const key = 'k'.repeat(32);

describe('verifyRunKey', () => {
  it('รับกุญแจที่ตรงกัน', () => {
    expect(verifyRunKey(key, key)).toBe(true);
  });

  it('ปฏิเสธกุญแจผิด ว่าง หรือไม่ส่งมา', () => {
    expect(verifyRunKey('x'.repeat(32), key)).toBe(false);
    expect(verifyRunKey('', key)).toBe(false);
    expect(verifyRunKey(undefined, key)).toBe(false);
  });

  it('ไม่ตั้งกุญแจ หรือกุญแจสั้นเกินไป = ปฏิเสธทุกคำขอ (ห้ามยอมรับกุญแจว่างหรือเดาง่าย)', () => {
    expect(verifyRunKey('', '')).toBe(false);
    expect(verifyRunKey(undefined, undefined)).toBe(false);
    expect(verifyRunKey('short', 'short')).toBe(false);
  });
});

describe('isSlot', () => {
  it('รับเฉพาะ morning / evening', () => {
    expect(isSlot('morning')).toBe(true);
    expect(isSlot('evening')).toBe(true);
    expect(isSlot('noon')).toBe(false);
    expect(isSlot(undefined)).toBe(false);
  });
});
