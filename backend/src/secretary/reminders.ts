// เตือนประจำสัปดาห์ (ผู้ใช้ 2026-10-31 "ตั้งเตือนกันลืม"): ข้อความคงที่ส่งเข้าไลน์ส่วนตัวตามวัน/เวลา (เวลาไทย)
// ฟังก์ชันล้วน ไม่แตะฐานข้อมูล · ตัวตั้งเวลา (GitHub Actions, secretary.yml) เรียก slot=reminder ตามเวลาในตารางนี้
// เพิ่ม/แก้เตือน: แก้ตาราง WEEKLY_REMINDERS แล้วเพิ่มบรรทัด cron ใน .github/workflows/secretary.yml ให้ตรงเวลา (UTC = ไทย - 7 ชม.)
import { textMessage } from './replies.js';
import type { LineMessage } from './line-client.js';
import { urlFor } from './card-parts.js';

export interface WeeklyReminder {
  id: string;
  weekday: number; // 0 = อาทิตย์ … 6 = เสาร์ (เหมือน Date.getDay)
  time: string; // HH:mm เวลาไทย
  title: string;
  detail?: string;
  path?: string; // หน้าเว็บที่เกี่ยว (ใส่ลิงก์เมื่อ FRONTEND_ORIGIN ตั้งไว้)
}

const BILLING = '/accounting/billing';

export const WEEKLY_REMINDERS: readonly WeeklyReminder[] = [
  { id: 'mon-lexus', weekday: 1, time: '16:00', title: 'วางบิล Lexus', path: BILLING },
  { id: 'tue-spi', weekday: 2, time: '16:00', title: 'เช็คยอด SPI', detail: 'ก่อนส่งงานวันพุธ', path: BILLING },
  { id: 'wed-spacev-mc', weekday: 3, time: '15:00', title: 'วางบิล Spac EV กับ MC Superbike', path: BILLING },
  { id: 'fri-tde', weekday: 5, time: '15:00', title: 'วางบิล T Double E', path: BILLING },
];

export const THAI_WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];

// เวลาไทยตอนนี้: วันในสัปดาห์ + นาทีนับจากเที่ยงคืน
export function bangkokClock(now: Date = new Date()): { weekday: number; minutes: number } {
  const local = new Date(now.getTime() + 7 * 60 * 60 * 1000);
  return { weekday: local.getUTCDay(), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

const minutesOf = (time: string) => {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
};

// เตือนที่ถึงเวลาแล้วของวันนี้ (เวลาเตือน <= ตอนนี้) - GitHub อาจเลื่อนได้หลายนาที จึงไม่เทียบนาทีตรงเป๊ะ
// ผู้เรียก (SecretaryService.runScheduled) จดว่าส่งไปแล้ววันนี้ ไม่ให้รอบถัดไปของวันเดียวกันส่งซ้ำ
export function dueReminders(now: Date = new Date(), table: readonly WeeklyReminder[] = WEEKLY_REMINDERS): WeeklyReminder[] {
  const { weekday, minutes } = bangkokClock(now);
  return table.filter((r) => r.weekday === weekday && minutesOf(r.time) <= minutes);
}

export function reminderMessage(reminder: WeeklyReminder, baseUrl?: string): LineMessage {
  const lines = [`🔔 เตือน: ${reminder.title}`];
  if (reminder.detail) lines.push(reminder.detail);
  const url = reminder.path ? urlFor(baseUrl, reminder.path) : undefined;
  if (url) lines.push(url);
  return textMessage(lines.join('\n'));
}

// รายการเตือนทั้งสัปดาห์ (คำสั่ง "ตารางเตือน")
export function remindersText(table: readonly WeeklyReminder[] = WEEKLY_REMINDERS): string {
  const rows = [...table]
    .sort((a, b) => a.weekday - b.weekday || minutesOf(a.time) - minutesOf(b.time))
    .map((r) => `• ${THAI_WEEKDAYS[r.weekday]} ${r.time} น. - ${r.title}${r.detail ? ` (${r.detail})` : ''}`);
  return ['เตือนประจำสัปดาห์', ...rows, '', 'แก้รายการได้ในโค้ด backend/src/secretary/reminders.ts'].join('\n');
}
