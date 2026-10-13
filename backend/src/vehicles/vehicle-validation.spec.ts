import { describe, expect, it } from 'vitest';
import { getVehicleRowErrors, normalizeVehicleRow } from './vehicle-validation.js';

// ตรวจข้อมูลรถแต่ละแถว (Single entry / Batch / แก้ไข) - frontend/src/lib/vehicle-validation.ts เป็นสำเนาเดียวกัน

function validRow(overrides: Record<string, unknown> = {}) {
  return normalizeVehicleRow({
    date: '2026-09-27',
    customerId: 'c1',
    chassis: 'MR0HA3CD100123456',
    engine: 'E123',
    brandId: 'b1',
    fuel: 'เบนซิน',
    cc: '1598',
    weight: '',
    color: '',
    body: 'รย.1-เก๋ง 2 ตอน',
    registrationProvince: 'กรุงเทพมหานคร',
    ownerProvince: 'กรุงเทพมหานคร',
    ownerType: 'บุคคลธรรมดา',
    financeId: '',
    ownerName: 'นายทดสอบ',
    hirerName: '',
    ...overrides,
  });
}

describe('normalizeVehicleRow', () => {
  it('เลขตัวถังเป็นตัวพิมพ์ใหญ่และไม่มีช่องว่าง (พบ 2026-09-27)', () => {
    expect(validRow({ chassis: ' mr0ha3cd 100 123456 ' }).chassis).toBe('MR0HA3CD100123456');
  });

  it('ประเภทเจ้าของรถภาษาไทยแปลงเป็นรหัส', () => {
    expect(validRow().ownerType).toBe('INDIVIDUAL');
  });
});

describe('getVehicleRowErrors', () => {
  it('ข้อมูลครบ ไม่มีข้อผิดพลาด', () => {
    expect(getVehicleRowErrors(validRow())).toEqual([]);
  });

  it('ขนาด CC ที่ใช้คิดภาษีต้องมากกว่า 0 (พบ 2026-09-27)', () => {
    expect(getVehicleRowErrors(validRow({ cc: '0' }))).toEqual(['ขนาด CC ต้องมากกว่า 0']);
    expect(getVehicleRowErrors(validRow({ cc: '0.00' }))).toEqual(['ขนาด CC ต้องมากกว่า 0']);
  });

  it('น้ำหนักรถที่ใช้คิดภาษีต้องมากกว่า 0', () => {
    const pickup = { body: 'รย.3-กระบะบรรทุก', cc: '', weight: '0' };
    expect(getVehicleRowErrors(validRow(pickup))).toEqual(['น้ำหนักรถต้องมากกว่า 0']);
    expect(getVehicleRowErrors(validRow({ ...pickup, weight: '1850' }))).toEqual([]);
  });

  it('ช่องที่ไม่ได้ใช้คิดภาษีใส่ 0 ได้เหมือนเดิม', () => {
    expect(getVehicleRowErrors(validRow({ weight: '0' }))).toEqual([]);
  });

  it('วันที่ผิดบอกรูปแบบที่หน้าจอใช้ (วว/ดด/ปปปป)', () => {
    expect(getVehicleRowErrors(validRow({ date: '' }))).toEqual(['วันที่ต้องเป็น วว/ดด/ปปปป ที่ถูกต้อง']);
  });
});

describe('มอเตอร์ไซค์: CC ต้องอยู่ในช่วงของประเภทรถ', () => {
  const moto = { body: 'รย.12-300-799cc', cc: '367.6' };

  it('CC อยู่ในช่วง = ผ่าน', () => {
    expect(getVehicleRowErrors(validRow(moto))).toEqual([]);
    expect(getVehicleRowErrors(validRow({ body: 'รย.12-น้อยกว่า 300cc', cc: '149.5' }))).toEqual([]);
  });

  it('149.5cc แต่เลือก 300-799cc = ไม่ผ่าน บอกช่วงที่ถูก', () => {
    const errors = getVehicleRowErrors(validRow({ ...moto, cc: '149.5' }));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('รย.12-น้อยกว่า 300cc');
  });

  it('เส้นแบ่ง 300 / 800 / 1000', () => {
    expect(getVehicleRowErrors(validRow({ body: 'รย.12-น้อยกว่า 300cc', cc: '300' }))).toHaveLength(1);
    expect(getVehicleRowErrors(validRow({ body: 'รย.12-300-799cc', cc: '300' }))).toEqual([]);
    expect(getVehicleRowErrors(validRow({ body: 'รย.12-800-999cc', cc: '799.9' }))).toHaveLength(1);
    expect(getVehicleRowErrors(validRow({ body: 'รย.12-1000cc ขึ้นไป', cc: '1000' }))).toEqual([]);
  });

  it('รย.17 ไม่มีช่วง CC', () => {
    expect(getVehicleRowErrors(validRow({ body: 'รย.17-จักรยานยนต์สาธารณะ', cc: '110' }))).toEqual([]);
  });
});
