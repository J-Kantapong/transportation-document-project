import { describe, expect, it } from 'vitest';
import { parseCommand, QUICK_COMMANDS } from './commands.js';

describe('parseCommand', () => {
  it('จับคำสั่งหลักจากคำสำคัญ ไม่ต้องพิมพ์ตรงเป๊ะ', () => {
    expect(parseCommand('สรุปเช้า')).toBe('morning');
    expect(parseCommand('  สรุป เย็น ')).toBe('evening');
    expect(parseCommand('ค้างจ่าย')).toBe('overdue');
    expect(parseCommand('ใครค้างเงินบ้าง')).toBe('overdue');
    expect(parseCommand('รถติดขัด')).toBe('stuck');
    expect(parseCommand('ยอดใช้จ่าย')).toBe('spend');
    expect(parseCommand('ใช้เงินเท่าไหร่')).toBe('spend');
  });

  it('คำสั่งที่ไม่รู้จักหรือว่าง = เมนูช่วยเหลือ', () => {
    expect(parseCommand('สวัสดี')).toBe('help');
    expect(parseCommand('')).toBe('help');
  });

  it('ปุ่มลัดทุกปุ่มต้องจับเป็นคำสั่งที่ตรงกับปุ่ม และ label ไม่เกิน 20 ตัวอักษร', () => {
    // ตู้เอกสารถูกจับก่อนโดย parseNoteCommand (ดู notes.spec.ts) จึงไม่นับที่นี่ · "คำสั่ง" = เมนูช่วยเหลือ
    const labels = QUICK_COMMANDS.map((c) => c.label);
    expect(labels).toContain('ตู้เอกสาร');
    expect(QUICK_COMMANDS.filter((c) => c.text !== 'ตู้เอกสาร').map((c) => parseCommand(c.text))).toEqual(['morning', 'evening', 'overdue', 'stuck', 'spend', 'help']);
    for (const c of QUICK_COMMANDS) expect(c.label.length).toBeLessThanOrEqual(20);
    expect(QUICK_COMMANDS.length).toBeLessThanOrEqual(13); // ข้อจำกัดของ LINE
  });
});
