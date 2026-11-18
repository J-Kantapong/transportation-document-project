import { describe, expect, it } from 'vitest';
import { COST_SHEETS, costIndexMessage, costSheetText, findCostSheet, registrationCostText } from './job-cost-sheet.js';

describe('findCostSheet', () => {
  it('จับงานจากคำที่พิมพ์หลัง "ต้นทุน"', () => {
    expect(findCostSheet('สลับเลข')?.key).toBe('plateSwap');
    expect(findCostSheet('งานโอน')?.key).toBe('transfer');
    expect(findCostSheet('โอนย้ายเข้า')?.key).toBe('transfer');
    expect(findCostSheet('คัดป้าย')?.key).toBe('plateCopy');
    expect(findCostSheet('ยกเลิกการใช้รถ')?.key).toBe('useCancel');
    expect(findCostSheet('ย้าย ออก')?.key).toBe('moveOut');
    expect(findCostSheet('ต่อภาษี')?.key).toBe('taxRenewal');
    expect(findCostSheet('แจ้งย้ายยามาฮ่า')?.key).toBe('yamaha');
    expect(findCostSheet('เชียงใหม่')).toBeNull();
    expect(findCostSheet('')).toBeNull();
  });
});

describe('costSheetText', () => {
  it('สลับเลข: รายการ Bill / No Bill / ค่าอากร และยอดรวมของแต่ละแบบ', () => {
    const out = costSheetText(findCostSheet('สลับเลข')!);
    expect(out).toContain('ต้นทุน สลับเลข (ต่อคัน)');
    // รถยนต์ เลขไม่เคยออก: 5 + 20 + 50 + 500 = 575 · ลงขัน 100 (ด่วนเพิ่ม 100 เป็นรายการเลือก) · อากร 10
    expect(out).toContain('▸ รถยนต์ - เลขที่ไม่เคยออกให้รถคันอื่น\nBill รวม 575\n• คำขอ 5');
    expect(out).toContain('◦ ถ้ามี: ค่าแผ่นป้ายทะเบียนรถยนต์ออกใหม่ รับปกติ +200');
    expect(out).toContain('No Bill รวม 100\n• ลงขัน 100\n');
    // เลขสงวน: 75 + 1,500
    expect(out).toContain('Bill รวม 1,575');
    expect(out).toContain('◦ ถ้ามี: ค่าแผ่นป้ายประมูล +1,200');
    // จักรยานยนต์: 5 + 20 + 10 + 500 = 535 · ลงขัน 100 · ด่วน +50 · อากร 10
    expect(out).toContain('▸ จักรยานยนต์\nBill รวม 535');
    expect(out).toContain('◦ ถ้ามี: ลงขันด่วนเพิ่ม +50\nค่าอากร 10\n= จ่ายจริง 645 (Bill 535 + ต้นทุนเรา 110)');
  });

  it('งานที่ไม่มี Bill ตายตัว แสดงเฉพาะต้นทุนเรา', () => {
    const out = costSheetText(findCostSheet('ต่อภาษี')!);
    expect(out).toContain('▸ รถยนต์\nNo Bill รวม 20\n• ลงขัน 20\n= ต้นทุนเรา 20');
    expect(out).toContain('▸ รถตาม พ.ร.บ.ขนส่ง (ขส.)\nNo Bill รวม 1,100');
    expect(out).toContain('หมายเหตุ: Bill = ภาษีประจำปี');
  });

  it('ทุกงานสร้างข้อความได้และไม่ยาวเกินที่ LINE รับ', () => {
    for (const s of COST_SHEETS) expect(costSheetText(s).length).toBeLessThan(4500);
  });
});

describe('registrationCostText / costIndexMessage', () => {
  it('ตารางอัตราจดทะเบียนใหม่จากฐานข้อมูล', () => {
    const out = registrationCostText('moto', [{ key: 'ค่าคำขอ (ปกติ)', amount: 5 }], [{ key: 'ลงขัน - รย.12 ทุกประเภท (CC)', amount: 40 }, { key: 'x', amount: null }]);
    expect(out).toContain('ต้นทุน จดทะเบียนรถจักรยานยนต์ใหม่');
    expect(out).toContain('• ค่าคำขอ (ปกติ) 5');
    expect(out).toContain('• ลงขัน - รย.12 ทุกประเภท (CC) 40');
    expect(out).toContain('• x ?');
  });

  it('รายการงาน: ปุ่มไม่เกิน 13 ปุ่ม label ไม่เกิน 20 ตัวอักษร และทุกปุ่มพาไปถึงใบต้นทุน', () => {
    const m = costIndexMessage();
    expect(m.quickReply!.items.length).toBeLessThanOrEqual(13);
    for (const i of m.quickReply!.items) {
      expect(i.action.label.length).toBeLessThanOrEqual(20);
      const text = i.action.type === 'message' ? i.action.text : '';
      expect(text.startsWith('ต้นทุน ')).toBe(true);
      expect(!!findCostSheet(text.slice(7)) || /จด|เฉลี่ย/.test(text)).toBe(true);
    }
  });
});
