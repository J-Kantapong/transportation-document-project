import {
  hasWrongSwapPlate,
  NEW_VEHICLE_LINKED_ERROR,
  NEW_VEHICLE_SUBMITTED_ERROR,
  newVehicleLinkBlockReason,
  OPEN_PLATE_SWAP_WHERE,
} from './plate-swap-link.js';

describe('newVehicleLinkBlockReason - ผูกรถใหม่กับงานสลับเลข (ผู้ใช้ 2026-09-27)', () => {
  it('ยื่นแล้ว (รอใบเสร็จ/ได้ใบเสร็จ) ผูกไม่ได้', () => {
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: 'PENDING', hasOtherOpenSwap: false })).toBe(NEW_VEHICLE_SUBMITTED_ERROR);
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: 'RECEIPT_RECEIVED', hasOtherOpenSwap: false })).toBe(NEW_VEHICLE_SUBMITTED_ERROR);
  });

  it('ยื่นไม่สำเร็จ (FAILED) / ไม่เคยยื่น ไม่นับว่ายื่นแล้ว', () => {
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: 'FAILED', hasOtherOpenSwap: false })).toBeNull();
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: undefined, hasOtherOpenSwap: false })).toBeNull();
  });

  it('เป็นรถใหม่ของงานอื่นที่ยังเปิดอยู่ ผูกไม่ได้', () => {
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: null, hasOtherOpenSwap: true })).toBe(NEW_VEHICLE_LINKED_ERROR);
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: null, hasOtherOpenSwap: false })).toBeNull();
  });

  it('ยื่นแล้วและผูกงานอื่นอยู่ด้วย บอกเหตุผลเรื่องการยื่นก่อน', () => {
    expect(newVehicleLinkBlockReason({ activeSubmissionStatus: 'PENDING', hasOtherOpenSwap: true })).toBe(NEW_VEHICLE_SUBMITTED_ERROR);
  });

  it('งานที่เปิดอยู่ = ยังไม่รับเอกสารกลับและไม่ได้ยกเลิก (ตัวเดียวกับขั้นยื่นเอกสารและหน้างานสลับเลข)', () => {
    expect(OPEN_PLATE_SWAP_WHERE).toEqual({ returnedDate: null, cancelledAt: null });
  });
});

describe('hasWrongSwapPlate - รถใหม่ที่ถูกเติมทะเบียนผิดฝั่งก่อน 2026-09-27', () => {
  const swap = { oldPlateCategory: '1กข', oldPlateNumber: '1234', newPlateCategory: '9ขค', newPlateNumber: '5678' };

  it('ทะเบียนรถใหม่ตรงกับทะเบียนใหม่ของรถเก่า = ผิดฝั่ง', () => {
    expect(hasWrongSwapPlate(swap, { plateCategory: '9ขค', plateNumber: '5678' })).toBe(true);
    expect(hasWrongSwapPlate(swap, { plateCategory: '9ขค ', plateNumber: '5678' })).toBe(true);
  });

  it('ทะเบียนเก่าของรถเก่า (ถูกต้อง) / ยังไม่มีทะเบียน / ยังไม่รู้ทะเบียนใหม่ = ไม่ติดธง', () => {
    expect(hasWrongSwapPlate(swap, { plateCategory: '1กข', plateNumber: '1234' })).toBe(false);
    expect(hasWrongSwapPlate(swap, { plateCategory: null, plateNumber: null })).toBe(false);
    expect(hasWrongSwapPlate({ ...swap, newPlateCategory: null, newPlateNumber: null }, { plateCategory: '9ขค', plateNumber: '5678' })).toBe(false);
  });

  it('ทะเบียนใหม่เท่ากับทะเบียนเก่า (กรอกซ้ำ) ไม่ถือว่าผิดฝั่ง', () => {
    expect(hasWrongSwapPlate({ ...swap, newPlateCategory: '1กข', newPlateNumber: '1234' }, { plateCategory: '1กข', plateNumber: '1234' })).toBe(false);
  });
});
