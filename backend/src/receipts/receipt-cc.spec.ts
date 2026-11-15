import { describe, expect, it } from 'vitest';
import { motorcycleBodyForCc } from '../vehicles/vehicle-validation.js';
import { ccDiffers, receiptCcMismatch, receiptCcOf } from './receipt-cc.js';

const reading = (cc: number | null | undefined, extra: Record<string, unknown> = {}) => ({ reading: { cc, chassis: 'X' }, ...extra });

describe('receiptCcOf', () => {
  it('ใช้ผลอ่านล่าสุดที่มี CC', () => {
    const receipts = [
      { extraction: reading(150), createdAt: new Date('2026-11-01') },
      { extraction: reading(155), createdAt: new Date('2026-11-02') },
    ];
    expect(receiptCcOf(receipts)).toBe(155);
  });

  it('ข้ามใบที่เลขตัวถังไม่ตรง, ใบที่อ่านไม่ได้ และใบเก่าที่ไม่มีช่อง cc', () => {
    expect(
      receiptCcOf([
        { extraction: reading(999, { match: 'chassis-mismatch' }), createdAt: new Date('2026-11-03') },
        { extraction: { error: 'อ่านไม่ได้' }, createdAt: new Date('2026-11-02') },
        { extraction: reading(undefined), createdAt: new Date('2026-11-01') },
        { extraction: reading(149.5), createdAt: new Date('2026-10-30') },
      ]),
    ).toBe(149.5);
    expect(receiptCcOf([{ extraction: reading(undefined) }])).toBeNull();
    expect(receiptCcOf([{ extraction: reading(0) }])).toBeNull();
    expect(receiptCcOf([])).toBeNull();
  });
});

describe('ccDiffers / receiptCcMismatch', () => {
  it('ปัดเศษไม่ถึง 1 cc ถือว่าตรง', () => {
    expect(ccDiffers(149.5, 150)).toBe(false);
    expect(ccDiffers('150.00', 149.5)).toBe(false);
    expect(receiptCcMismatch(150, 150)).toBeNull();
  });

  it('ต่างตั้งแต่ 1 cc หรือไม่มี CC ในระบบ = ไม่ตรง', () => {
    expect(ccDiffers(350, 149.5)).toBe(true);
    expect(ccDiffers(null, 150)).toBe(true);
    expect(ccDiffers(0, 150)).toBe(true);
    expect(receiptCcMismatch(350, 149.5)).toBe('CC ในใบเสร็จ 149.5 ไม่ตรงกับที่คีย์ไว้ 350 - ตรวจกับรูปใบเสร็จ');
    expect(receiptCcMismatch(null, 150)).toBe('CC ในใบเสร็จ 150 ไม่ตรงกับที่คีย์ไว้ (ไม่มี) - ตรวจกับรูปใบเสร็จ');
  });

  it('ใบเสร็จไม่มี CC = เทียบไม่ได้ ไม่เตือน', () => {
    expect(ccDiffers(350, null)).toBe(false);
    expect(receiptCcMismatch(null, null)).toBeNull();
  });
});

describe('motorcycleBodyForCc', () => {
  it('ย้ายช่วง รย.12 ตาม CC ใหม่', () => {
    expect(motorcycleBodyForCc('รย.12-300-799cc', 149.5)).toBe('รย.12-น้อยกว่า 300cc');
    expect(motorcycleBodyForCc('รย.12-น้อยกว่า 300cc', 1000)).toBe('รย.12-1000cc ขึ้นไป');
    expect(motorcycleBodyForCc('รย.12-น้อยกว่า 300cc', 299.9)).toBe('รย.12-น้อยกว่า 300cc');
  });

  it('ประเภทที่ไม่มีช่วง CC คงเดิม', () => {
    expect(motorcycleBodyForCc('รย.17-จักรยานยนต์สาธารณะ', 150)).toBe('รย.17-จักรยานยนต์สาธารณะ');
    expect(motorcycleBodyForCc('รย.1-รถยนต์นั่งส่วนบุคคลไม่เกิน 7 คน', 1500)).toBe('รย.1-รถยนต์นั่งส่วนบุคคลไม่เกิน 7 คน');
    expect(motorcycleBodyForCc('รย.12-300-799cc', 0)).toBe('รย.12-300-799cc');
  });
});
