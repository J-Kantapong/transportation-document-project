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
