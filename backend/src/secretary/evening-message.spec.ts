import { describe, expect, it } from 'vitest';
import { buildEveningMessage, type EveningInput } from './evening-message.js';

const base: EveningInput = {
  today: '2026-10-07',
  spend: { today: { total: 52180 } },
  process: [
    { label: 'ยื่นเอกสาร', done: { car: 20, moto: 0 } },
    { label: 'เพิ่มข้อมูลรถ', done: { car: 14, moto: null } },
    { label: 'ตรวจสภาพ', done: { car: 0, moto: 0 } },
    { label: 'ยามาฮ่า', done: { car: null, moto: null, unsplit: 3 } },
  ],
  alerts: [
    { severity: 'high', title: 'ยื่นไม่ผ่าน', detail: '1 คัน' },
    { severity: 'high', title: 'บิลค้างเกิน 60 วัน', detail: '2 ใบ' },
    { severity: 'medium', title: 'ใบเสนอราคารอ PO', detail: '1 ใบ' },
  ],
  workingCapital: { overdue: { customers: [{ customerName: 'TWE', amount: 86400 }, { customerName: 'SPI', amount: 30000 }, { customerName: 'X', amount: 5 }] } },
  staff: [
    { name: 'ก.', entered: 14, submitted: 0, received: 0, edits: 2, slips: 1 },
    { name: 'ข.', entered: 0, submitted: 0, received: 0, edits: 0, slips: 0 },
    { name: 'ค.', entered: 0, submitted: 20, received: 5, edits: 0, slips: 3 },
  ],
};

const allText = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.flatMap(allText);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [...(typeof record.text === 'string' ? [record.text] : []), ...Object.values(record).flatMap(allText)];
  }
  return [];
};

function flexOf(input: EveningInput, url?: string) {
  const message = buildEveningMessage(input, url);
  if (message.type !== 'flex') throw new Error('ต้องเป็น flex');
  return message;
}

describe('buildEveningMessage', () => {
  it('altText บอกยอดจริงและจำนวนปัญหา', () => {
    expect(flexOf(base).altText).toBe('สรุปเย็น: ใช้จริง ฿52,180 · ปัญหา 2 เรื่อง');
  });

  it('งานที่ทำไปแล้ว: เรียงมากไปน้อย ไม่แสดงขั้นที่ไม่ได้ทำ และรวมงานที่ไม่แยกประเภทรถ', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('ยื่นเอกสาร 20');
    expect(texts).toContain('เพิ่มข้อมูลรถ 14');
    expect(texts).toContain('ยามาฮ่า 3');
    expect(texts.some((t) => t.startsWith('ตรวจสภาพ'))).toBe(false);
    expect(texts.indexOf('ยื่นเอกสาร 20')).toBeLessThan(texts.indexOf('เพิ่มข้อมูลรถ 14'));
  });

  it('พนักงาน: แสดงเฉพาะคนที่มีรายการ พร้อมหมายเหตุว่ารายคนมีเท่าที่ระบบจดไว้', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('ก.: ใส่รถ 14 · ใบส่งงาน 1 · แก้/ยกเลิก 2 ครั้ง');
    expect(texts).toContain('ค.: ยื่น 20 · รับใบเสร็จ 5 · ใบส่งงาน 3');
    expect(texts.some((t) => t.startsWith('ข.'))).toBe(false);
    expect(texts).toContain('ยังไม่จดชื่อคนทำ: รับป้าย รับเล่ม งานอื่นๆ');
  });

  it('ปัญหา = รายการแจ้งเตือนระดับสูงเท่านั้น', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('● ยื่นไม่ผ่าน - 1 คัน');
    expect(texts.some((t) => t.includes('ใบเสนอราคารอ PO') && t.startsWith('●'))).toBe(false);
  });

  it('พรุ่งนี้อย่าลืม: ตามเงิน 2 รายแรกก่อน แล้วเติมเรื่องไม่ด่วน รวมไม่เกิน 3', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('1. ตามเงิน TWE ฿86,400');
    expect(texts).toContain('2. ตามเงิน SPI ฿30,000');
    expect(texts).toContain('3. ใบเสนอราคารอ PO - 1 ใบ');
    expect(texts.some((t) => t.includes('ตามเงิน X'))).toBe(false);
  });

  it('วันเงียบ: บอกว่าไม่มีปัญหา/ไม่มีงาน และไม่มีหัวข้อพนักงานกับพรุ่งนี้', () => {
    const quiet: EveningInput = { ...base, spend: { today: { total: 0 } }, process: [], alerts: [], staff: [], workingCapital: { overdue: { customers: [] } } };
    const texts = allText(flexOf(quiet).contents);
    expect(texts).toContain('ไม่มีปัญหา');
    expect(texts).toContain('วันนี้ยังไม่มีงานที่ทำ');
    expect(texts).not.toContain('พนักงาน');
    expect(texts).not.toContain('พรุ่งนี้อย่าลืม');
    expect(flexOf(quiet).altText).toBe('สรุปเย็น: ใช้จริง ฿0 · ปัญหา 0 เรื่อง');
  });
});
