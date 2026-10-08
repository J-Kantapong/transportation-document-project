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
  const [message] = buildEveningMessage(input, url);
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

  it('พรุ่งนี้อย่าลืม: ตามเงินครบทุกราย แล้วตามด้วยเรื่องไม่ด่วนครบทุกเรื่อง (ผู้ใช้ 2026-10-08: ข้อมูลควรครบก่อน)', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('1. ตามเงิน TWE ฿86,400');
    expect(texts).toContain('2. ตามเงิน SPI ฿30,000');
    expect(texts).toContain('3. ตามเงิน X ฿5');
    expect(texts).toContain('4. ใบเสนอราคารอ PO - 1 ใบ');
  });

  it('ครบทุกรายการ ไม่ตัด: งานที่ทำ 12 ขั้น พนักงาน 8 คน ปัญหา 6 เรื่อง อยู่ในการ์ดใบเดียว ไม่มี "และอีก"', () => {
    const full: EveningInput = {
      ...base,
      process: Array.from({ length: 12 }, (_, i) => ({ label: `ขั้นที่ ${i + 1}`, done: { car: i + 1, moto: 0 } })),
      staff: Array.from({ length: 8 }, (_, i) => ({ name: `คนที่ ${i + 1}`, entered: 0, submitted: 0, received: 0, edits: i + 1, slips: 0 })),
      alerts: Array.from({ length: 6 }, (_, i) => ({ severity: 'high', title: `ปัญหาที่ ${i + 1}`, detail: '' })),
    };
    const messages = buildEveningMessage(full);
    expect(messages).toHaveLength(1);
    const texts = allText(flexOf(full).contents);
    for (let i = 1; i <= 12; i += 1) expect(texts).toContain(`ขั้นที่ ${i} ${i}`);
    for (let i = 1; i <= 8; i += 1) expect(texts).toContain(`คนที่ ${i}: แก้/ยกเลิก ${i} ครั้ง`);
    for (let i = 1; i <= 6; i += 1) expect(texts).toContain(`● ปัญหาที่ ${i}`);
    expect(texts.some((t) => t.startsWith('และอีก'))).toBe(false);
  });

  it('ยาวเกินเพดานของการ์ด: ส่วนที่เกินไปต่อในข้อความถัดไป ไม่มีอะไรหาย และการ์ดไม่เกินขนาดที่ LINE รับ', () => {
    const huge: EveningInput = {
      ...base,
      process: Array.from({ length: 30 }, (_, i) => ({ label: `งานโอนตรวจรถ (รอผลตรวจ) ขั้นที่ ${i + 1}`, done: { car: 100 - i, moto: 0 } })),
      staff: Array.from({ length: 30 }, (_, i) => ({ name: `พนักงานชื่อยาวนามสกุลยาว ${i + 1}`, entered: 40, submitted: 30, received: 20, edits: 100 - i, slips: 3 })),
      alerts: [
        ...Array.from({ length: 30 }, (_, i) => ({ severity: 'high', title: `ปัญหาเรื่องที่ ${i + 1}`, detail: 'ตรวจไม่ผ่าน 1 คัน · ผลตรวจหมดอายุ 0 คัน', href: '/registration/new-vehicle/inspection' })),
        ...Array.from({ length: 30 }, (_, i) => ({ severity: 'medium', title: `เรื่องไม่ด่วนที่ ${i + 1}`, detail: 'ตรวจว่าอัตราค่าธรรมเนียมยังถูกต้อง', href: '/accounting/billing' })),
      ],
    };
    const messages = buildEveningMessage(huge, 'https://app.example.com');
    const [card, ...rest] = messages;
    if (card.type !== 'flex') throw new Error('ต้องเป็น flex');
    expect(Buffer.byteLength(JSON.stringify(card.contents))).toBeLessThan(30_000);
    expect(messages.length).toBeLessThanOrEqual(5);
    expect(rest.length).toBeGreaterThan(0);
    for (const m of rest) expect(m.type === 'text' && m.text.length <= 5000).toBe(true);
    const everything = [...allText(card.contents), ...rest.flatMap((m) => (m.type === 'text' ? m.text.split('\n') : []))];
    for (let i = 1; i <= 30; i += 1) {
      expect(everything.some((t) => t.startsWith(`งานโอนตรวจรถ (รอผลตรวจ) ขั้นที่ ${i} `))).toBe(true);
      expect(everything.some((t) => t.startsWith(`พนักงานชื่อยาวนามสกุลยาว ${i}:`))).toBe(true);
      expect(everything.some((t) => t.startsWith(`● ปัญหาเรื่องที่ ${i} `))).toBe(true);
      expect(everything.some((t) => t.includes(`. เรื่องไม่ด่วนที่ ${i} `))).toBe(true);
    }
    expect(allText(card.contents)).toContain('และอีก 15 รายการ (ต่อในข้อความถัดไป)');
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
