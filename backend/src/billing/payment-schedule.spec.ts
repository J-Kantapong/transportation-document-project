import { describe, expect, it } from 'vitest';
import { describePaySchedule, expectedPaymentDate } from './payment-schedule.js';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const spi = { billingCreditDays: null, billingPayWeekday: 4, billingPayWeeksAfter: 1 };

describe('expectedPaymentDate', () => {
  // SPI: วางบิลสัปดาห์นี้ ได้เงินพฤหัสสัปดาห์หน้า (ผู้ใช้ 2026-10-31)
  it('next-week Thursday for a bill issued any day of this week', () => {
    expect(expectedPaymentDate(d('2026-10-26'), spi)).toEqual(d('2026-11-05')); // จันทร์
    expect(expectedPaymentDate(d('2026-10-28'), spi)).toEqual(d('2026-11-05')); // พุธ
    expect(expectedPaymentDate(d('2026-10-29'), spi)).toEqual(d('2026-11-05')); // พฤหัสเอง = พฤหัสหน้า
    expect(expectedPaymentDate(d('2026-10-31'), spi)).toEqual(d('2026-11-05')); // เสาร์ ยังนับเป็นสัปดาห์นี้
    expect(expectedPaymentDate(d('2026-11-01'), spi)).toEqual(d('2026-11-05')); // อาทิตย์ = ท้ายสัปดาห์นี้ -> พฤหัสของสัปดาห์หน้า
    expect(expectedPaymentDate(d('2026-11-02'), spi)).toEqual(d('2026-11-12')); // จันทร์ถัดไป = สัปดาห์ใหม่
  });

  it('same-week rule moves to the following week when the weekday has already passed', () => {
    const sameWeek = { ...spi, billingPayWeeksAfter: 0 };
    expect(expectedPaymentDate(d('2026-10-27'), sameWeek)).toEqual(d('2026-10-29')); // อังคาร -> พฤหัสนี้
    expect(expectedPaymentDate(d('2026-10-29'), sameWeek)).toEqual(d('2026-10-29')); // พฤหัสเอง = วันนี้
    expect(expectedPaymentDate(d('2026-10-30'), sameWeek)).toEqual(d('2026-11-05')); // ศุกร์ -> พฤหัสหน้า
  });

  it('falls back to credit days, and null without either', () => {
    expect(expectedPaymentDate(d('2026-10-28'), { billingCreditDays: 30 })).toEqual(d('2026-11-27'));
    expect(expectedPaymentDate(d('2026-10-28'), { billingCreditDays: 30, billingPayWeekday: null })).toEqual(d('2026-11-27'));
    expect(expectedPaymentDate(d('2026-10-28'), { billingCreditDays: null })).toBeNull();
  });

  it('describes the schedule', () => {
    expect(describePaySchedule(spi)).toBe('ได้เงินวันพฤหัสบดี สัปดาห์ถัดจากที่วางบิล');
    expect(describePaySchedule({ billingCreditDays: 30 })).toBe('เครดิต 30 วัน');
    expect(describePaySchedule({ billingCreditDays: null })).toBe('ไม่ได้ตั้งรอบจ่าย');
  });
});
