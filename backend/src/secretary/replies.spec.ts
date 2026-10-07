import { describe, expect, it } from 'vitest';
import { helpText, overdueText, quickReply, spendText, stuckText, withQuickReply, type OverviewLike } from './replies.js';

const overview: OverviewLike = {
  spend: { today: { total: 1000 }, yesterday: { total: 45230 }, last7: { total: 300000.5 }, month: { total: 1200000 } },
  workingCapital: {
    overdue: {
      count: 3,
      amount: 128400,
      customers: [
        { customerName: 'TWE', count: 2, amount: 86400, maxDaysOver: 12 },
        { customerName: 'SPI', count: 1, amount: 42000, maxDaysOver: 5 },
      ],
    },
  },
  stuck: {
    total: 7,
    high: 1,
    byKind: { car: 5, moto: 2 },
    items: [
      { chassis: 'MLH1', customerName: 'A', stageLabel: 'ตรวจสภาพ', days: 9, severity: 'high' },
      { chassis: 'MLH2', customerName: 'B', stageLabel: 'รับใบเสร็จ', days: 4, severity: 'medium' },
    ],
  },
};

describe('replies', () => {
  it('ค้างจ่าย: ยอดเต็มและรายลูกค้า', () => {
    expect(overdueText(overview)).toBe(['บิลเกินกำหนด 3 ใบ รวม ฿128,400', '• TWE ฿86,400 (2 ใบ เกิน 12 วัน)', '• SPI ฿42,000 (1 ใบ เกิน 5 วัน)'].join('\n'));
  });

  it('ค้างจ่าย: ไม่มีบิลเกินกำหนด / เกิน 10 ราย บอกว่ามีอีกกี่ราย', () => {
    expect(overdueText({ ...overview, workingCapital: { overdue: { count: 0, amount: 0, customers: [] } } })).toBe('ตอนนี้ไม่มีบิลเกินกำหนด');
    const many = Array.from({ length: 12 }, (_, i) => ({ customerName: `C${i}`, count: 1, amount: 1, maxDaysOver: 1 }));
    const text = overdueText({ ...overview, workingCapital: { overdue: { count: 12, amount: 12, customers: many } } });
    expect(text).toContain('และอีก 2 ราย');
    expect(text).not.toContain('C11');
  });

  it('รถติดขัด: นับจากยอดรวม ไม่ใช่จำนวนที่แสดง และใส่เครื่องหมายเรื่องด่วน', () => {
    const text = stuckText(overview);
    expect(text).toContain('รถติดขัด 7 คัน (ด่วน 1)');
    expect(text).toContain('รถยนต์ 5 · จักรยานยนต์ 2');
    expect(text).toContain('‼ MLH1 A - ตรวจสภาพ 9 วัน');
    expect(text).toContain('• MLH2 B - รับใบเสร็จ 4 วัน');
    expect(text).toContain('และอีก 5 คัน');
    expect(stuckText({ ...overview, stuck: { total: 0, high: 0, byKind: { car: 0, moto: 0 }, items: [] } })).toBe('ตอนนี้ไม่มีรถติดขัด');
  });

  it('ยอดใช้จ่าย: ยอดเต็มทุกช่วง', () => {
    expect(spendText(overview)).toBe(['ยอดใช้จ่าย', 'วันนี้ ฿1,000', 'เมื่อวาน ฿45,230', '7 วันล่าสุด ฿300,000.5', 'เดือนนี้ ฿1,200,000'].join('\n'));
  });

  it('ปุ่มลัดอยู่ที่ข้อความสุดท้ายเท่านั้น', () => {
    const out = withQuickReply([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    expect(out[0]).not.toHaveProperty('quickReply');
    expect(out[1]).toHaveProperty('quickReply', quickReply);
    expect(helpText()).toContain('สรุปเช้า');
  });
});
