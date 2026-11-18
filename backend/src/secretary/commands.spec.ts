import { describe, expect, it } from 'vitest';
import { parseCommand, QUICK_COMMANDS } from './commands.js';
import { parseInvoiceLinkCommand } from './invoice-link.js';
import { parseLookupCommand } from './lookup.js';
import { parseProvinceRateCommand } from './province-rates.js';

describe('parseCommand', () => {
  it('จับคำสั่งหลักจากคำสำคัญ ไม่ต้องพิมพ์ตรงเป๊ะ', () => {
    expect(parseCommand('สรุปเช้า')).toBe('morning');
    expect(parseCommand('  สรุป เย็น ')).toBe('evening');
    expect(parseCommand('การเงินค้าง')).toBe('finance');
    expect(parseCommand('การเงิน')).toBe('finance');
    expect(parseCommand('ค้างจ่าย')).toBe('overdue');
    expect(parseCommand('ใครค้างเงินบ้าง')).toBe('overdue');
    expect(parseCommand('รถติดขัด')).toBe('stuck');
    expect(parseCommand('ยอดใช้จ่าย')).toBe('spend');
    expect(parseCommand('ใช้เงินเท่าไหร่')).toBe('spend');
  });

  it('คำสั่งที่ไม่รู้จักหรือว่าง = การ์ดเมนู · "คำสั่ง" = รายการคำสั่งแบบข้อความ', () => {
    expect(parseCommand('สวัสดี')).toBe('menu');
    expect(parseCommand('')).toBe('menu');
    expect(parseCommand('คำสั่ง')).toBe('help');
    expect(parseCommand('ตารางเตือน')).toBe('reminders');
  });

  it('ปุ่มลัดทุกปุ่มต้องถูกจับโดยตัวรับคำสั่งตัวใดตัวหนึ่ง และ label ไม่เกิน 20 ตัวอักษร', () => {
    // ลำดับเดียวกับ handleEvents: ลิงก์เอกสาร -> เรทจังหวัด -> ค้นข้อมูล -> คำสั่งสรุป (ตู้ข้อความไม่มีปุ่มลัดแล้ว)
    const handler = (text: string) => (parseInvoiceLinkCommand(text) ? 'link' : parseProvinceRateCommand(text) ? 'province' : (parseLookupCommand(text)?.kind ?? parseCommand(text)));
    expect(QUICK_COMMANDS.map((c) => handler(c.text))).toEqual(['menu', 'pending', 'finance', 'link', 'link', 'quotations', 'rates', 'cost', 'province', 'help']);
    // คำสั่งค้นข้อมูลที่ตามด้วยชื่อลูกค้า/งาน ไม่ถูกเรทจังหวัดแย่งไป · "ราคา <จังหวัด>" = เรทจังหวัด
    for (const t of ['ราคา SPI', 'ต้นทุน สลับเลข', 'ต้นทุน เชียงใหม่', 'บิล SPI', 'ยอด SPI', 'งานค้าง', 'เมนู']) expect(parseProvinceRateCommand(t)).toBeNull();
    expect(parseProvinceRateCommand('ราคา เชียงใหม่')).toEqual({ kind: 'province', province: 'เชียงใหม่' });
    for (const c of QUICK_COMMANDS) expect(c.label.length).toBeLessThanOrEqual(20);
    expect(QUICK_COMMANDS.length).toBeLessThanOrEqual(13); // ข้อจำกัดของ LINE
  });
});
