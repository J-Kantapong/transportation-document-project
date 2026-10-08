import { getSubmitBlockReason, inspectionValidUntil, OPEN_PLATE_SWAP_WHERE, PLATE_SWAP_PENDING_REASON } from './submission-eligibility.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// รถที่ผ่าน Step 2/3 แล้ว ตรวจผ่าน 2026-06-01 (ยื่นได้ถึง 2026-08-29) ยังไม่เคยยื่น
const PASSED = {
  transferDone: true,
  inspectionSentDate: day('2026-05-30'),
  inspectionResult: 'ผ่าน',
  inspectionResultDate: day('2026-06-01'),
  activeSubmissionStatus: null,
};

// ผู้ใช้ 2026-09-27 (F19): ยกเลิก/ยื่นไม่สำเร็จแล้วยื่นใหม่ด้วยวันที่ยื่นเดิมได้ - ตรวจ ณ วันที่ยื่นที่เลือก ไม่ใช่วันนี้
describe('getSubmitBlockReason - ตรวจ ณ วันที่ยื่นที่เลือก', () => {
  it('ผลตรวจหมดอายุแล้ว ณ วันนี้ แต่ยื่นด้วยวันที่ยื่นเดิมที่ยังไม่ครบ 90 วันได้', () => {
    expect(inspectionValidUntil(PASSED.inspectionResultDate)).toBe('2026-08-29');
    expect(getSubmitBlockReason(PASSED, day('2026-08-25'))).toBeNull();
    expect(getSubmitBlockReason(PASSED, day('2026-08-29'))).toBeNull();
  });

  it('วันที่ยื่นเกินวันสุดท้ายของผลตรวจ = ต้องตรวจรถใหม่', () => {
    expect(getSubmitBlockReason(PASSED, day('2026-08-30'))).toContain('ผลตรวจรถหมดอายุ');
  });

  it('วันที่ยื่นก่อนวันที่ตรวจผ่านไม่ได้', () => {
    expect(getSubmitBlockReason(PASSED, day('2026-05-31'))).toContain('ก่อนวันที่ตรวจรถผ่าน');
  });
});

// ผู้ใช้ 2026-09-27 (F51): งานสลับเลขไหนก็ได้ที่ยังเปิดอยู่ล็อกการยื่น - ผู้เรียกหาด้วย OPEN_PLATE_SWAP_WHERE
describe('งานสลับเลขที่ยังเปิดอยู่', () => {
  it('ยังไม่รับเอกสารกลับและไม่ได้ยกเลิก', () => {
    expect(OPEN_PLATE_SWAP_WHERE).toEqual({ returnedDate: null, cancelledAt: null });
  });

  it('มีงานที่ยังเปิดอยู่ = ยื่นไม่ได้ / ไม่มี (หรือรับกลับแล้ว) = ยื่นได้', () => {
    expect(getSubmitBlockReason({ ...PASSED, plateSwap: { returnedDate: null } }, day('2026-06-10'))).toBe(PLATE_SWAP_PENDING_REASON);
    expect(getSubmitBlockReason({ ...PASSED, plateSwap: null }, day('2026-06-10'))).toBeNull();
    expect(getSubmitBlockReason({ ...PASSED, plateSwap: { returnedDate: '2026-06-05' } }, day('2026-06-10'))).toBeNull();
  });
});

// ผู้ใช้ 2026-10-08: จังหวัดอื่นนอกจากกรุงเทพฯ/สมุทรปราการ ส่งซับจด - แจ้งย้ายเสร็จแล้วส่งได้เลย ไม่ดูผลตรวจรถ
describe('ส่งซับจดต่างจังหวัด', () => {
  const NOT_INSPECTED = {
    transferDone: true,
    transferCompletedDate: day('2026-06-01'),
    inspectionSentDate: null,
    inspectionResult: null,
    inspectionResultDate: null,
    activeSubmissionStatus: null,
  };

  it('จังหวัดที่ส่งซับ: ยังไม่ตรวจรถก็ส่งได้ ตั้งแต่วันที่แจ้งย้ายเสร็จ', () => {
    const v = { ...NOT_INSPECTED, registrationProvince: 'เชียงใหม่' };
    expect(getSubmitBlockReason(v, day('2026-06-01'))).toBeNull();
    expect(getSubmitBlockReason(v, day('2026-12-31'))).toBeNull(); // ไม่มีอายุ 90 วัน
    expect(getSubmitBlockReason(v, day('2026-05-31'))).toContain('ก่อนวันที่แจ้งย้ายเสร็จ');
  });

  it('กรุงเทพฯ และสมุทรปราการ ออฟฟิศจดเอง: ยังต้องตรวจรถผ่านก่อน', () => {
    expect(getSubmitBlockReason({ ...NOT_INSPECTED, registrationProvince: 'กรุงเทพมหานคร' }, day('2026-06-10'))).toBe('ยังไม่ได้ตรวจรถ');
    expect(getSubmitBlockReason({ ...NOT_INSPECTED, registrationProvince: 'สมุทรปราการ' }, day('2026-06-10'))).toBe('ยังไม่ได้ตรวจรถ');
  });

  it('จังหวัดที่ส่งซับยังต้องแจ้งย้ายก่อน และติดกฎยื่นซ้ำ/สลับเลขเหมือนเดิม', () => {
    const v = { ...NOT_INSPECTED, registrationProvince: 'เชียงใหม่' };
    expect(getSubmitBlockReason({ ...v, transferDone: false }, day('2026-06-10'))).toBe('ยังไม่ผ่านขั้นตอนแจ้งย้าย/ตัดบัญชี');
    expect(getSubmitBlockReason({ ...v, activeSubmissionStatus: 'PENDING' }, day('2026-06-10'))).toContain('ยื่นซ้ำไม่ได้');
    expect(getSubmitBlockReason({ ...v, plateSwap: { returnedDate: null } }, day('2026-06-10'))).toBe(PLATE_SWAP_PENDING_REASON);
  });
});
