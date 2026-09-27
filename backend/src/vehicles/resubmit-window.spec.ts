import { describe, expect, it } from 'vitest';
import { cancelledSubmitDate, resubmitWindow } from './resubmit-window.js';

// ถึงกำหนดตรวจรอบ 2 แต่ยังยื่นใหม่ด้วยวันที่ยื่นเดิมได้ (ผู้ใช้ 2026-09-27 F19)

describe('cancelledSubmitDate', () => {
  it('อ่านวันที่ยื่นจาก snapshot ที่การยกเลิกเขียนไว้', () => {
    const changes = JSON.stringify({ 'submission.cancelled': { from: 'ยื่น 2026-09-01 ด่วน | Bill: - | No Bill: -', to: 'ยกเลิกการยื่น' } });
    expect(cancelledSubmitDate(changes)).toBe('2026-09-01');
  });

  it('ประวัติแบบอื่นหรือ JSON เสีย = null', () => {
    expect(cancelledSubmitDate(JSON.stringify({ plate: { from: 'ก', to: 'ข' } }))).toBeNull();
    expect(cancelledSubmitDate('{')).toBeNull();
  });
});

describe('resubmitWindow', () => {
  const pass = new Date('2026-06-01T00:00:00.000Z'); // ยื่นได้ถึง 2026-08-29

  it('ครั้งล่าสุดที่ยื่นด้วยผลตรวจผ่านปัจจุบัน + วันสุดท้ายที่ยื่นได้', () => {
    expect(
      resubmitWindow(pass, [
        { submitDate: '2026-07-01', reason: 'FAILED' },
        { submitDate: '2026-08-20', reason: 'CANCELLED' },
      ]),
    ).toEqual({ submitDate: '2026-08-20', reason: 'CANCELLED', validUntil: '2026-08-29' });
  });

  it('ยื่นก่อนวันที่ตรวจผ่านนี้ (ผลตรวจรอบก่อน) หรือหลังหมดอายุ ไม่นับ', () => {
    expect(
      resubmitWindow(pass, [
        { submitDate: '2026-05-20', reason: 'FAILED' },
        { submitDate: '2026-08-30', reason: 'CANCELLED' },
      ]),
    ).toBeNull();
  });

  it('ไม่เคยยื่น = null', () => {
    expect(resubmitWindow(pass, [])).toBeNull();
  });
});
