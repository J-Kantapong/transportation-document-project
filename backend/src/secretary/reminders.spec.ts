import { describe, expect, it } from 'vitest';
import { dueReminders, reminderMessage, remindersText, WEEKLY_REMINDERS } from './reminders.js';

// 2026-11-02 เป็นวันจันทร์
const at = (iso: string) => new Date(iso);

describe('dueReminders', () => {
  it('จันทร์ 16:00 ไทย = เตือนวางบิล Lexus, ก่อนเวลายังไม่เตือน', () => {
    expect(dueReminders(at('2026-11-02T09:00:00.000Z')).map((r) => r.id)).toEqual(['mon-lexus']);
    expect(dueReminders(at('2026-11-02T08:59:00.000Z'))).toEqual([]);
  });

  it('GitHub เลื่อนเวลาไปหลายนาทีก็ยังเตือน และวันอื่นไม่เตือนของวันจันทร์', () => {
    expect(dueReminders(at('2026-11-02T09:12:00.000Z')).map((r) => r.id)).toEqual(['mon-lexus']);
    expect(dueReminders(at('2026-11-03T09:00:00.000Z')).map((r) => r.id)).toEqual(['tue-spi']);
    expect(dueReminders(at('2026-11-04T08:00:00.000Z')).map((r) => r.id)).toEqual(['wed-spacev-mc']);
    expect(dueReminders(at('2026-11-06T08:00:00.000Z')).map((r) => r.id)).toEqual(['fri-tde']);
    expect(dueReminders(at('2026-11-05T09:00:00.000Z'))).toEqual([]); // พฤหัส
    expect(dueReminders(at('2026-11-07T09:00:00.000Z'))).toEqual([]); // เสาร์
  });

  it('ข้ามเที่ยงคืน UTC ยังนับวันไทยถูก (ศุกร์ 23:30 UTC = เสาร์ไทย)', () => {
    expect(dueReminders(at('2026-11-06T23:30:00.000Z'))).toEqual([]);
  });
});

describe('reminderMessage / remindersText', () => {
  it('ข้อความมีหัวข้อ รายละเอียด และลิงก์เมื่อมี FRONTEND_ORIGIN', () => {
    const spi = WEEKLY_REMINDERS.find((r) => r.id === 'tue-spi')!;
    expect(reminderMessage(spi, 'https://app.example.com/')).toEqual({
      type: 'text',
      text: '🔔 เตือน: เช็คยอด SPI\nก่อนส่งงานวันพุธ\nhttps://app.example.com/accounting/billing',
    });
    expect(reminderMessage(spi)).toEqual({ type: 'text', text: '🔔 เตือน: เช็คยอด SPI\nก่อนส่งงานวันพุธ' });
  });

  it('ตารางเรียงตามวัน', () => {
    const text = remindersText();
    expect(text).toContain('• จันทร์ 16:00 น. - วางบิล Lexus');
    expect(text).toContain('• อังคาร 16:00 น. - เช็คยอด SPI (ก่อนส่งงานวันพุธ)');
    expect(text).toContain('• พุธ 15:00 น. - วางบิล Spac EV กับ MC Superbike');
    expect(text).toContain('• ศุกร์ 15:00 น. - วางบิล T Double E');
    expect(text.indexOf('จันทร์')).toBeLessThan(text.indexOf('ศุกร์'));
  });
});
