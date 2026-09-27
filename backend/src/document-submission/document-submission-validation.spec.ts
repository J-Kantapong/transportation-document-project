import { assertPlateNumberProvided, parseDocumentSubmissionOptions } from './document-submission-validation.js';

const base = { plateNumberOption: 'NONE', includePlateFee: true, newPlateOption: 'NONE' };

// ข้อความ error ที่ส่งให้หน้าเว็บ ({ error }) - null = ไม่ throw
function errorOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (err) {
    return (err as { response?: { error?: string } }).response?.error ?? String(err);
  }
  return null;
}

describe('parseDocumentSubmissionOptions - มีคนทำสลับเลขมาให้ (ผู้ใช้ 2026-09-27)', () => {
  it.each(['SWAP_NORMAL', 'SWAP_AUCTION'])('รถยนต์เลือก %s ได้ และบังคับรวมค่าแผ่นป้าย', (option) => {
    const parsed = parseDocumentSubmissionOptions({ ...base, plateNumberOption: option, includePlateFee: false }, false);
    expect(parsed.plateNumberOption).toBe(option);
    expect(parsed.includePlateFee).toBe(true);
  });

  it('มอเตอร์ไซค์เลือกไม่ได้', () => {
    expect(errorOf(() => parseDocumentSubmissionOptions({ ...base, plateNumberOption: 'SWAP_NORMAL' }, true))).toContain('เฉพาะรถยนต์');
  });

  it('ค่าที่ไม่รู้จัก -> 400 บอกตัวเลือกทั้งหมด', () => {
    expect(errorOf(() => parseDocumentSubmissionOptions({ ...base, plateNumberOption: 'SWAP' }, false))).toContain('SWAP_NORMAL');
  });

  it('ตัวเลือกเดิมยังเลือกรวม/ไม่รวมค่าแผ่นป้ายได้', () => {
    expect(parseDocumentSubmissionOptions({ ...base, plateNumberOption: 'NORMAL', includePlateFee: false }, false).includePlateFee).toBe(false);
  });
});

describe('assertPlateNumberProvided', () => {
  it('ไม่ขอเลข = เว้นว่างได้', () => {
    expect(errorOf(() => assertPlateNumberProvided('NONE', null, null))).toBeNull();
  });

  it('สลับเลขต้องกรอกหมวด+เลข (ข้อความบอกว่าเป็นเลขจากการสลับเลข)', () => {
    expect(errorOf(() => assertPlateNumberProvided('SWAP_NORMAL', '1กข', null))).toContain('สลับเลข');
    expect(errorOf(() => assertPlateNumberProvided('SWAP_AUCTION', '1กข', '1234'))).toBeNull();
  });

  it('ตรวจรูปแบบทะเบียนเมื่อกรอกแล้ว', () => {
    expect(errorOf(() => assertPlateNumberProvided('SWAP_NORMAL', '1กขค', '1234'))).toContain('หมวดทะเบียน');
    expect(errorOf(() => assertPlateNumberProvided('NORMAL', '1กข', '12345'))).toContain('เลขทะเบียน');
  });
});
