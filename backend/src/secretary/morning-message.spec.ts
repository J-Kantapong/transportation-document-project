import { describe, expect, it } from 'vitest';
import { baht, buildMorningMessage, thaiDayLabel, type MorningInput } from './morning-message.js';

const base: MorningInput = {
  today: '2026-10-07',
  spend: { yesterday: { total: 45230 } },
  workingCapital: {
    overdue: {
      count: 4,
      amount: 128400,
      customers: [
        { customerName: 'TWE', count: 2, amount: 86400, maxDaysOver: 12 },
        { customerName: 'SPI', count: 1, amount: 30000, maxDaysOver: 5 },
        { customerName: 'A', count: 1, amount: 12000, maxDaysOver: 3 },
        { customerName: 'B', count: 1, amount: 100, maxDaysOver: 1 },
      ],
    },
  },
  stuck: { total: 12, high: 0 },
  alerts: [
    { severity: 'high', title: 'บิลค้างชำระเกิน 60 วัน', detail: '2 ใบ รวม 50,000 บาท' },
    { severity: 'medium', title: 'รถค้างตรวจ', detail: '5 คัน' },
    { severity: 'medium', title: 'ใบเสนอราคารอ PO', detail: '1 ใบ' },
    { severity: 'info', title: 'ข้อที่ 4 ต้องไม่ถูกแสดง', detail: '' },
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

function flexOf(input: MorningInput, url?: string) {
  const [message] = buildMorningMessage(input, url);
  if (message.type !== 'flex') throw new Error('ต้องเป็น flex');
  return message;
}

describe('thaiDayLabel / baht', () => {
  it('วันที่ภาษาไทย', () => {
    expect(thaiDayLabel('2026-10-07')).toBe('พุธ 7 ต.ค.');
  });

  it('ยอดเงินเต็ม ไม่ปัด', () => {
    expect(baht(45230)).toBe('฿45,230');
    expect(baht(1250.5)).toBe('฿1,250.5');
    expect(baht(0)).toBe('฿0');
  });
});

describe('buildMorningMessage', () => {
  it('altText สรุปตัวเลขหลัก (เห็นในแจ้งเตือนบนมือถือ)', () => {
    expect(flexOf(base).altText).toBe('สรุปเช้า: บิลเกินกำหนด 4 ใบ · รถติดขัด 12 คัน · ใช้เมื่อวาน ฿45,230');
  });

  it('แสดงยอดเงินเต็มและ "ต้องทำก่อน" ครบทุกข้อ (ผู้ใช้ 2026-10-08: ข้อมูลควรครบก่อน)', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('฿128,400');
    expect(texts).toContain('฿45,230');
    expect(texts.some((t) => t.startsWith('1. บิลค้างชำระเกิน 60 วัน - 2 ใบ'))).toBe(true);
    expect(texts.some((t) => t.startsWith('3. ใบเสนอราคารอ PO'))).toBe(true);
    expect(texts.filter((t) => /^\d+\. /.test(t))).toHaveLength(base.alerts.length);
  });

  it('ลูกค้าค้างจ่ายแสดงครบทุกราย (เกินนานสุดก่อน) ไม่ตัด', () => {
    const texts = allText(flexOf(base).contents);
    expect(texts).toContain('TWE ฿86,400 (2 ใบ เกินกำหนด 12 วัน)');
    for (const c of base.workingCapital.overdue.customers) expect(texts.some((t) => t.startsWith(`${c.customerName} `))).toBe(true);
    expect(texts.some((t) => t.startsWith('และอีก'))).toBe(false);
    expect(buildMorningMessage(base)).toHaveLength(1);
  });

  it('ยาวเกินเพดานของการ์ด: ส่วนที่เกินไปต่อในข้อความถัดไป ไม่มีรายไหนหาย และการ์ดไม่เกินขนาดที่ LINE รับ', () => {
    const customers = Array.from({ length: 45 }, (_, i) => ({ customerName: `ลูกค้าชื่อยาวพอสมควร ${i + 1}`, count: 2, amount: 1000 + i, maxDaysOver: 90 - i }));
    const alerts = Array.from({ length: 30 }, (_, i) => ({ severity: 'high', title: `เรื่องที่ต้องทำลำดับที่ ${i + 1}`, detail: 'รายละเอียดยาวๆ ของเรื่องนี้ 12 คัน', href: '/registration/new-vehicle/inspection' }));
    const messages = buildMorningMessage({ ...base, alerts, workingCapital: { overdue: { count: 90, amount: 5, customers } } }, 'https://app.example.com');
    const [card, ...rest] = messages;
    if (card.type !== 'flex') throw new Error('ต้องเป็น flex');
    expect(Buffer.byteLength(JSON.stringify(card.contents))).toBeLessThan(30_000);
    expect(messages.length).toBeLessThanOrEqual(5);
    const everything = [...allText(card.contents), ...rest.flatMap((m) => (m.type === 'text' ? m.text.split('\n') : []))];
    for (const c of customers) expect(everything.some((t) => t.startsWith(`${c.customerName} `))).toBe(true);
    for (let i = 1; i <= 30; i += 1) expect(everything.some((t) => t.startsWith(`${i}. เรื่องที่ต้องทำลำดับที่ ${i} `))).toBe(true);
    expect(allText(card.contents)).toContain('และอีก 30 รายการ (ต่อในข้อความถัดไป)');
  });

  it('ไม่มีอะไรค้าง: ช่องเป็นสีเขียวและบอกว่าไม่มีเรื่องด่วน ไม่มีหัวข้อลูกค้าค้างจ่าย', () => {
    const calm: MorningInput = {
      ...base,
      workingCapital: { overdue: { count: 0, amount: 0, customers: [] } },
      stuck: { total: 0, high: 0 },
      alerts: [],
    };
    const texts = allText(flexOf(calm).contents);
    expect(texts).toContain('ไม่มีเรื่องด่วน');
    expect(texts).not.toContain('ลูกค้าค้างจ่ายเกินกำหนด');
    expect(JSON.stringify(flexOf(calm).contents)).toContain('#EAF3DE');
    expect(JSON.stringify(flexOf(calm).contents)).not.toContain('#FCEBEB');
  });

  it('รถติดขัดระดับสูงเป็นสีแดง ระดับปกติเป็นสีเหลือง', () => {
    const tile = (input: MorningInput) => {
      const body = (flexOf(input).contents as { body: { contents: Array<{ contents: unknown[] }> } }).body.contents[0].contents[1];
      return JSON.stringify(body);
    };
    expect(tile({ ...base, stuck: { total: 3, high: 1 } })).toContain('#FCEBEB');
    expect(tile({ ...base, stuck: { total: 3, high: 0 } })).toContain('#FAEEDA');
  });

  it('แตะแต่ละเรื่องเข้าหน้างานนั้นได้ (ลิงก์ของแจ้งเตือนใช้ href จากระบบ) และไม่มีลิงก์เลยถ้าไม่ตั้งที่อยู่เว็บ', () => {
    const withHref: MorningInput = { ...base, alerts: [{ severity: 'high', title: 'ใบเสนอราคารอ PO', detail: '1 ใบ', href: '/accounting/quotations' }] };
    const json = JSON.stringify(flexOf(withHref, 'https://app.example.com/').contents);
    expect(json).toContain('"uri":"https://app.example.com/accounting/billing"');
    expect(json).toContain('"uri":"https://app.example.com/vehicles?status=problem"');
    expect(json).toContain('"uri":"https://app.example.com/accounting/quotations"');
    expect(json).not.toContain('com//');
    expect(JSON.stringify(flexOf(withHref).contents)).not.toContain('"action"');
  });

  it('ปุ่มดูรายละเอียดมีเมื่อให้ลิงก์เท่านั้น', () => {
    expect(JSON.stringify(flexOf(base).contents)).not.toContain('footer');
    const withUrl = JSON.stringify(flexOf(base, 'https://example.com/').contents);
    expect(withUrl).toContain('"uri":"https://example.com/"');
  });
});
