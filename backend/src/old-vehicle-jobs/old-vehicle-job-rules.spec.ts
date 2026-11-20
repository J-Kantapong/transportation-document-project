import { describe, expect, it } from 'vitest';
import {
  chassisKeyOf,
  chassisWarnings,
  cleanChassis,
  INSPECTION_COST_BY_TYPE,
  defaultInspectionCost,
  inspectionRequiredFor,
  intakeStatus,
  linkedStatus,
  vehicleClassOfType,
  vinCheckDigitOk,
  workingDaysBetween,
} from './old-vehicle-job-rules.js';
import { VEHICLE_TYPES } from '../vehicles/vehicle-reference-data.js';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const today = d('2026-11-18');

describe('เลขตัวถัง', () => {
  it('เก็บตัวพิมพ์ใหญ่ ตัดช่องว่าง และกุญแจกันซ้ำตัดขีด/จุด', () => {
    expect(cleanChassis(' mh1 jc-123 ')).toBe('MH1JC-123');
    expect(chassisKeyOf('mh1 jc-12.3')).toBe('MH1JC123');
    expect(chassisKeyOf('MH1JC123')).toBe(chassisKeyOf('mh1-jc-123'));
  });

  it('เลขตรวจสอบ VIN 17 หลัก', () => {
    expect(vinCheckDigitOk('1M8GDM9AXKP042788')).toBe(true); // ตัวอย่างมาตรฐานของ ISO 3779
    expect(vinCheckDigitOk('1M8GDM9A1KP042788')).toBe(false);
  });

  it('เตือนเฉพาะเลข 17 หลัก - I/O/Q ก่อน แล้วจึงเลขตรวจสอบ', () => {
    expect(chassisWarnings('1M8GDM9AXKP042788')).toEqual([]);
    expect(chassisWarnings('1M8GDM9A1KP042788')[0]).toContain('หลักที่ 9');
    expect(chassisWarnings('1M8GDM9AXKPO42788')[0]).toContain('I, O, Q');
    expect(chassisWarnings('ABC123')).toEqual([]); // รถเก่าเลขสั้นไม่เตือน
  });
});

describe('ประเภทรถ', () => {
  it('รย.12 / รย.17 = มอเตอร์ไซค์ ที่เหลือรวม ขส. = รถยนต์', () => {
    expect(vehicleClassOfType('รย.12-น้อยกว่า 300cc')).toBe('MOTO');
    expect(vehicleClassOfType('รย.17-จักรยานยนต์สาธารณะ')).toBe('MOTO');
    expect(vehicleClassOfType('รย.1-เก๋ง 2 ตอน')).toBe('CAR');
    expect(vehicleClassOfType('ขส.-ส่วนบุคคล')).toBe('CAR');
    expect(vehicleClassOfType(null)).toBe('CAR');
  });

  it('ค่าตรวจตั้งต้นตามประเภทรถ (ชีต Rate โอน) / ประเภทที่ไม่มีในตารางกรอกเอง', () => {
    expect(defaultInspectionCost('รย.1-เก๋ง 2 ตอน')).toBe(200);
    expect(defaultInspectionCost('รย.1-นั่ง 3 ตอน')).toBe(300);
    expect(defaultInspectionCost('รย.2-นั่ง 4 ตอน')).toBe(500);
    expect(defaultInspectionCost('รย.3-กระบะบรรทุกมีหลังคา')).toBe(1000);
    expect(defaultInspectionCost('รย.12-น้อยกว่า 300cc')).toBe(100);
    expect(defaultInspectionCost('รย.12-1000cc ขึ้นไป')).toBe(1000);
    expect(defaultInspectionCost('รย.3-กระบะบรรทุกมีหลังคาแหนบ')).toBeNull();
    expect(defaultInspectionCost('รย.17-จักรยานยนต์สาธารณะ')).toBeNull();
    expect(defaultInspectionCost('ขส.-ไม่ประจำทาง')).toBeNull();
    expect(defaultInspectionCost(null)).toBeNull();
  });

  it('ตารางค่าตรวจครอบคลุมเฉพาะประเภทรถที่มีอยู่จริง', () => {
    for (const type of Object.keys(INSPECTION_COST_BY_TYPE)) expect(VEHICLE_TYPES).toContain(type);
  });
});

describe('ระบบตัดสินว่าต้องตรวจรถก่อนยื่น', () => {
  const base = { vehicleType: 'รย.1-เก๋ง 2 ตอน', firstRegistrationDate: null, taxExpiryDate: null, today };

  it('โอนตรวจรถ / โอนย้ายเข้า ตรวจทุกคัน', () => {
    expect(inspectionRequiredFor({ ...base, jobType: 'TRANSFER_INSPECTION' })).toBe(true);
    expect(inspectionRequiredFor({ ...base, jobType: 'TRANSFER_MOVE_IN' })).toBe(true);
  });

  it('งานอื่นไม่ตรวจ', () => {
    for (const jobType of ['TRANSFER_OWNER', 'PLATE_SWAP', 'USE_CANCEL', 'MOVE_OUT', 'PLATE_COPY'] as const) {
      expect(inspectionRequiredFor({ ...base, jobType })).toBe(false);
    }
  });

  it('ต่อภาษี รถ ขส. ตรวจทุกครั้ง ไม่ต้องรู้วันที่', () => {
    expect(inspectionRequiredFor({ ...base, jobType: 'TAX_RENEWAL', vehicleType: 'ขส.-ส่วนบุคคล' })).toBe(true);
  });

  it('ต่อภาษี รถอายุมากแต่ภาษีไม่ขาด ไม่ผ่านคิวตรวจรถ (ตรอ. ติ๊กในใบต่อภาษีเอง)', () => {
    const tax = { ...base, jobType: 'TAX_RENEWAL' as const, taxExpiryDate: d('2026-12-01') };
    expect(inspectionRequiredFor({ ...tax, vehicleType: 'รย.3-กระบะบรรทุก', firstRegistrationDate: d('2009-12-02') })).toBe(false); // อายุ 17 ปี
    expect(inspectionRequiredFor({ ...tax, vehicleType: 'รย.12-น้อยกว่า 300cc', firstRegistrationDate: d('2019-12-11') })).toBe(false);
    expect(inspectionRequiredFor({ ...tax, vehicleType: 'รย.17-จักรยานยนต์สาธารณะ', firstRegistrationDate: d('2019-12-11') })).toBe(false);
  });

  it('ต่อภาษี ค้างภาษีเกิน 1 ปี ตรวจแม้รถใหม่', () => {
    const tax = { ...base, jobType: 'TAX_RENEWAL' as const, firstRegistrationDate: d('2024-01-01') };
    expect(inspectionRequiredFor({ ...tax, taxExpiryDate: d('2025-11-01') })).toBe(true); // ค้าง 1 ปีกว่า
    expect(inspectionRequiredFor({ ...tax, taxExpiryDate: d('2026-01-01') })).toBe(false); // ค้างไม่ถึงปี
  });

  it('ต่อภาษี ไม่รู้ประเภทรถหรือวันที่ = ยังตัดสินไม่ได้ (ไม่ตรวจ)', () => {
    expect(inspectionRequiredFor({ ...base, jobType: 'TAX_RENEWAL', vehicleType: null })).toBe(false);
    expect(inspectionRequiredFor({ ...base, jobType: 'TAX_RENEWAL' })).toBe(false);
  });
});

describe('สถานะของงานที่ยังไม่ยื่น', () => {
  const job = { jobType: 'TRANSFER_INSPECTION', inspectionRequired: true, inspectionSentDate: null, inspectionResult: null };

  it('เดินตามลำดับ รอทำ -> รอส่งตรวจ -> รอผลตรวจ -> รอยื่น', () => {
    expect(intakeStatus({ ...job, jobType: null })).toBe('NEW');
    expect(intakeStatus(job)).toBe('TO_INSPECT');
    expect(intakeStatus({ ...job, inspectionSentDate: today })).toBe('TO_RESULT');
    expect(intakeStatus({ ...job, inspectionSentDate: today, inspectionResult: 'PASS' })).toBe('TO_SUBMIT');
  });

  it('ตรวจไม่ผ่านกลับไปรอส่งตรวจ', () => {
    expect(intakeStatus({ ...job, inspectionSentDate: today, inspectionResult: 'FAIL' })).toBe('TO_INSPECT');
  });

  it('งานที่ไม่ต้องตรวจข้ามไปรอยื่น', () => {
    expect(intakeStatus({ ...job, jobType: 'MOVE_OUT', inspectionRequired: false })).toBe('TO_SUBMIT');
  });
});

describe('สถานะของงานที่ยื่นแล้ว', () => {
  const base = { cancelledAt: null, returnedDate: null, deliveredDate: null };

  it('งานทั่วไป: รอใบเสร็จ -> รอส่งงาน -> เสร็จ (เสร็จ = ส่งงานแล้ว)', () => {
    expect(linkedStatus(base)).toBe('TO_RECEIPT');
    expect(linkedStatus({ ...base, returnedDate: today })).toBe('TO_DELIVER');
    expect(linkedStatus({ ...base, returnedDate: today, deliveredDate: today })).toBe('DONE');
  });

  it('งานจริงถูกยกเลิก', () => {
    expect(linkedStatus({ ...base, cancelledAt: today })).toBe('CANCELLED');
  });

  it('งานโอนลำดับเดิมที่ตรวจรถหลังยื่น', () => {
    const transfer = { ...base, hasInspection: true, inspectionSentDate: null, inspectionResult: null };
    expect(linkedStatus(transfer)).toBe('TO_INSPECT');
    expect(linkedStatus({ ...transfer, inspectionSentDate: today })).toBe('TO_RESULT');
    expect(linkedStatus({ ...transfer, inspectionSentDate: today, inspectionResult: 'FAIL' })).toBe('TO_INSPECT');
    expect(linkedStatus({ ...transfer, inspectionSentDate: today, inspectionResult: 'PASS' })).toBe('TO_RECEIPT');
  });

  it('ต่อภาษี: รอชำระภาษีก่อนรอใบเสร็จ', () => {
    expect(linkedStatus({ ...base, paymentDate: null })).toBe('TO_PAY');
    expect(linkedStatus({ ...base, paymentDate: today })).toBe('TO_RECEIPT');
  });

  it('คัดแผ่นป้าย: รอป้ายหลังได้ใบเสร็จ', () => {
    const copy = { ...base, returnedDate: today, needsPlate: true, plateReceivedDate: null };
    expect(linkedStatus(copy)).toBe('TO_PLATE');
    expect(linkedStatus({ ...copy, plateReceivedDate: today })).toBe('TO_DELIVER');
    expect(linkedStatus({ ...copy, plateReceivedDate: today, deliveredDate: today })).toBe('DONE');
  });

  it('สลับเลข: รอป้าย (ถ้าซื้อ) -> รอเล่ม -> รอส่งงาน และป้ายค้างส่งยังไม่ถือว่าเสร็จ', () => {
    const swap = { ...base, returnedDate: today, needsBook: true, bookReceivedDate: null, needsPlate: true, plateReceivedDate: null, plateDeliveredDate: null };
    expect(linkedStatus(swap)).toBe('TO_PLATE');
    expect(linkedStatus({ ...swap, plateReceivedDate: today })).toBe('TO_BOOK');
    expect(linkedStatus({ ...swap, needsPlate: false })).toBe('TO_BOOK');
    expect(linkedStatus({ ...swap, plateReceivedDate: today, bookReceivedDate: today })).toBe('TO_DELIVER');
    // ส่งเล่มแล้ว ป้ายยังไม่มา / มาแล้วยังไม่ส่ง
    expect(linkedStatus({ ...swap, bookReceivedDate: today, deliveredDate: today })).toBe('TO_PLATE');
    expect(linkedStatus({ ...swap, bookReceivedDate: today, plateReceivedDate: today, deliveredDate: today })).toBe('TO_DELIVER');
    expect(linkedStatus({ ...swap, bookReceivedDate: today, plateReceivedDate: today, deliveredDate: today, plateDeliveredDate: today })).toBe('DONE');
  });
});

describe('workingDaysBetween (ติดขัดนับวันทำการ ผู้ใช้ 2026-11-18)', () => {
  it('ข้ามเสาร์-อาทิตย์: ศุกร์ถึงจันทร์ = 1, จันทร์ถึงศุกร์ = 4, ครบสัปดาห์ = 5', () => {
    expect(workingDaysBetween('2026-11-20', '2026-11-23')).toBe(1); // ศุกร์ -> จันทร์
    expect(workingDaysBetween('2026-11-16', '2026-11-20')).toBe(4); // จันทร์ -> ศุกร์
    expect(workingDaysBetween('2026-11-16', '2026-11-23')).toBe(5);
    expect(workingDaysBetween('2026-11-18', '2026-11-24')).toBe(4); // พุธ -> อังคารถัดไป = เกิน 3 วันทำการ
    expect(workingDaysBetween('2026-11-18', '2026-11-18')).toBe(0);
    expect(workingDaysBetween('2026-11-21', '2026-11-22')).toBe(0); // เสาร์ -> อาทิตย์
  });
});
