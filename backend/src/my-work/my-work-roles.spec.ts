import { describe, expect, it } from 'vitest';
import { bangkokDateOf, hasCheckOwner, isMine, kindsFor, stagesFor, workHrefFor } from './my-work-roles.js';

// งานของฉัน (ผู้ใช้ 2026-10-13): แต่ละบทบาทเห็นเฉพาะขั้นที่ตัวเองทำได้ และรถประเภทที่ดูแล

describe('stagesFor / isMine', () => {
  it('STAFF_ENTRY = ขั้น 1-3 ทุกประเภทรถ', () => {
    expect(stagesFor(['STAFF_ENTRY'])).toEqual(['transfer', 'inspectSend', 'inspectResult']);
    expect(isMine(['STAFF_ENTRY'], 'inspectSend', 'moto')).toBe(true);
    expect(isMine(['STAFF_ENTRY'], 'submit', 'car')).toBe(false);
  });

  it('STAFF_CAR = ขั้น 4-8 + งานอื่น เฉพาะรถยนต์', () => {
    expect(isMine(['STAFF_CAR'], 'receipt', 'car')).toBe(true);
    expect(isMine(['STAFF_CAR'], 'receipt', 'moto')).toBe(false);
    expect(isMine(['STAFF_CAR'], 'transfer', 'car')).toBe(false);
    expect(kindsFor(['STAFF_CAR'], 'plateCopy')).toEqual(['car']);
    expect(kindsFor(['STAFF_CAR'], 'transfer')).toBeNull();
  });

  it('STAFF_MOTO ทำขั้น 2 แจ้งย้ายของจักรยานยนต์ได้ด้วย (ผู้ใช้ 2026-09-24)', () => {
    expect(isMine(['STAFF_MOTO'], 'transfer', 'moto')).toBe(true);
    expect(isMine(['STAFF_MOTO'], 'transfer', 'car')).toBe(false);
    expect(stagesFor(['STAFF_MOTO'])[0]).toBe('transfer');
  });

  it('ถือหลายบทบาท: STAFF_ENTRY + STAFF_CAR = ขั้น 1-3 ทุกคัน แต่ขั้น 4-8 เฉพาะรถยนต์', () => {
    const roles = ['STAFF_ENTRY', 'STAFF_CAR'] as const;
    expect(isMine([...roles], 'inspectResult', 'moto')).toBe(true);
    expect(isMine([...roles], 'plate', 'moto')).toBe(false);
    expect(kindsFor([...roles], 'plate')).toEqual(['car']);
    expect(kindsFor([...roles], 'transfer')).toEqual(['car', 'moto']);
  });

  it('ACCOUNTANT = วางบิล + ส่งงานที่ค้าง (บันทึกได้จากหน้าวางบิล) · DELIVERY = ส่งงานอย่างเดียว · ADMIN ทุกขั้น', () => {
    expect(stagesFor(['ACCOUNTANT'])).toEqual(['delivery', 'plateDelivery', 'billing', 'jobDelivery']);
    expect(stagesFor(['DELIVERY'])).toEqual(['delivery', 'plateDelivery', 'jobDelivery']);
    expect(isMine(['DELIVERY'], 'billing', 'car')).toBe(false);
    expect(stagesFor(['ADMIN']).length).toBeGreaterThan(15);
    expect(stagesFor(['CUSTOMER'])).toEqual([]);
  });

  it('รายการที่ไม่รู้ประเภทรถ (kind null) เห็นได้ทุกคนที่ทำขั้นนั้น', () => {
    expect(isMine(['STAFF_MOTO'], 'delivery', null)).toBe(true);
    expect(isMine(['STAFF_ENTRY'], 'delivery', null)).toBe(false);
  });

  it('ตัวช่วยตรวจเป็นของฝ่ายไหน', () => {
    expect(hasCheckOwner(['STAFF_ENTRY'], 'entry')).toBe(true);
    expect(hasCheckOwner(['STAFF_ENTRY'], 'submit')).toBe(false);
    expect(hasCheckOwner(['ACCOUNTANT'], 'accounting')).toBe(true);
    expect(hasCheckOwner(['ACCOUNTANT'], 'delivery')).toBe(true);
    expect(hasCheckOwner(['DELIVERY'], 'accounting')).toBe(false);
  });
});

describe('workHrefFor', () => {
  const base = { source: 'vehicle' as const, kind: 'car' as const, chassis: 'CH1', flags: [], href: '/x' };

  it('พาไปหน้าที่มีรายการรถจริงพร้อม ?focus= และต่อประเภทรถสำหรับหน้าใบเสร็จ/ป้าย/เล่ม', () => {
    expect(workHrefFor({ ...base, stage: 'receipt', kind: 'moto' }, ['STAFF_MOTO'])).toBe('/registration/new-vehicle/receive-receipt/moto?focus=CH1');
    expect(workHrefFor({ ...base, stage: 'inspectResult' }, ['STAFF_ENTRY'])).toBe('/registration/new-vehicle/inspection/result?focus=CH1');
    expect(workHrefFor({ ...base, stage: 'billing' }, ['ACCOUNTANT'])).toBe('/accounting/billing?focus=CH1');
  });

  it('รอเอกสารสลับเลข: ไปหน้ารับใบเสร็จของงานสลับเลข ไม่ใช่คิวยื่น', () => {
    expect(workHrefFor({ ...base, stage: 'submit', flags: ['PLATE_SWAP_PENDING'] }, ['STAFF_CAR'])).toBe('/registration/plate-swap/car/old-new/receive-receipt?focus=CH1');
  });

  it('ส่งงาน: บัญชีที่เปิดหน้า Delivery ไม่ได้ ไปหน้าวางบิล (แผงบันทึกส่งงาน) · คนอื่นไปหน้า Delivery', () => {
    expect(workHrefFor({ ...base, stage: 'delivery' }, ['ACCOUNTANT'])).toBe('/accounting/billing?focus=CH1');
    expect(workHrefFor({ ...base, stage: 'jobDelivery', source: 'otherJob', href: '/delivery' }, ['ACCOUNTANT', 'STAFF_CAR'])).toBe('/delivery?focus=CH1');
    expect(workHrefFor({ ...base, stage: 'delivery' }, ['DELIVERY'])).toBe('/delivery?focus=CH1');
  });

  it('งานอื่น / ต่อภาษี ใช้ href ของงานนั้นจาก backend', () => {
    expect(workHrefFor({ ...base, source: 'otherJob', stage: 'plateCopy', href: '/registration/other/plate-copy/return' }, ['STAFF_CAR'])).toBe('/registration/other/plate-copy/return');
  });
});

describe('bangkokDateOf', () => {
  it('เวลาหลังเที่ยงคืนไทยแต่ก่อนเที่ยงคืน UTC นับเป็นวันถัดไป', () => {
    expect(bangkokDateOf(new Date('2026-10-12T18:30:00.000Z'))).toBe('2026-10-13');
    expect(bangkokDateOf(new Date('2026-10-12T16:59:00.000Z'))).toBe('2026-10-12');
  });
});
