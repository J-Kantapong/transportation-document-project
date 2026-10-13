import { describe, expect, it } from 'vitest';
import {
  buildKnownModels,
  chassisWarnings,
  dataWarningsFor,
  findSuspectVehicles,
  isDataWarningsConfirmed,
  modelPrefix,
  type ModelSample,
} from './vehicle-data-check.js';

// คำเตือนข้อมูลน่าจะคีย์ผิด (ผู้ใช้ 2026-10-13) - ตัวอย่างมาจากของจริงที่พบ: Zontes คีย์เป็น Yamaha, 149.5cc คีย์เป็น 300-799cc,
// เลขตัวถัง 16 / 18 หลัก

const zontes = (n: number, overrides: Partial<ModelSample> = {}): ModelSample => ({
  chassis: `MLTZT1509TX00${String(1000 + n)}`,
  brandId: 'zontes',
  brandName: 'Zontes',
  cc: 149.5,
  body: 'รย.12-น้อยกว่า 300cc',
  ...overrides,
});
const brandNameOf = (id: string) => ({ zontes: 'Zontes', yamaha: 'Yamaha' })[id] ?? '-';
const codes = (warnings: Array<{ code: string }>) => warnings.map((w) => w.code);

describe('chassisWarnings', () => {
  it('17 หลัก ไม่มี I O Q = ไม่เตือน', () => {
    expect(chassisWarnings('MLTZT1509TX010479')).toEqual([]);
    expect(chassisWarnings(' mltzt1509tx010479 ')).toEqual([]);
  });

  it('16 หรือ 18 หลัก = เตือนจำนวนหลัก', () => {
    expect(codes(chassisWarnings('MLTZ1509TX006844'))).toEqual(['CHASSIS_LENGTH']);
    expect(codes(chassisWarnings('MR2B78D38000001221'))).toEqual(['CHASSIS_LENGTH']);
    expect(chassisWarnings('MLTZ1509TX006844')[0].message).toContain('16 หลัก');
  });

  it('มี I O Q หรือขีด = เตือนตัวอักษร', () => {
    expect(codes(chassisWarnings('MLTZT15O9TX010479'))).toEqual(['CHASSIS_CHARS']);
    expect(codes(chassisWarnings('MLTZT1509-X010479'))).toEqual(['CHASSIS_CHARS']);
  });

  it('ยังไม่กรอก = ไม่เตือน (ช่องว่างเป็น error ของ getVehicleRowErrors อยู่แล้ว)', () => {
    expect(chassisWarnings('')).toEqual([]);
  });
});

describe('buildKnownModels', () => {
  it('รถ 3 คันขึ้นไปที่คีย์ตรงกัน = รุ่นที่รู้จัก', () => {
    const model = buildKnownModels([zontes(1), zontes(2), zontes(3)]).get('MLTZT150');
    expect(model).toEqual({ prefix: 'MLTZT150', count: 3, brand: { id: 'zontes', name: 'Zontes' }, cc: 149.5, body: 'รย.12-น้อยกว่า 300cc' });
  });

  it('มีแค่ 2 คัน = ยังไม่เชื่อ (กันคันแรกคีย์ผิดแล้วพาคันถัดไปผิดตาม)', () => {
    expect(buildKnownModels([zontes(1), zontes(2)]).size).toBe(0);
  });

  it('คันส่วนน้อยที่คีย์ผิดไม่ทำให้รุ่นเปลี่ยน', () => {
    const samples = [...Array.from({ length: 9 }, (_, i) => zontes(i)), zontes(99, { brandId: 'yamaha', brandName: 'Yamaha' })];
    expect(buildKnownModels(samples).get('MLTZT150')?.brand).toEqual({ id: 'zontes', name: 'Zontes' });
  });

  it('ค่าที่ต่างกันได้จริงในรุ่นเดียวกัน (ไม่ถึง 80%) = ไม่เชื่อช่องนั้น แต่ช่องอื่นยังเชื่อ', () => {
    const pickup = (n: number, body: string): ModelSample => ({ chassis: `MR0AA9CA${n}00000000`.slice(0, 17), brandId: 'toyota', brandName: 'Toyota', cc: 2393, body });
    const model = buildKnownModels([
      pickup(1, 'รย.3-กระบะบรรทุก'),
      pickup(2, 'รย.3-กระบะบรรทุก'),
      pickup(3, 'รย.3-กระบะบรรทุกมีหลังคาแหนบ'),
      pickup(4, 'รย.3-กระบะบรรทุกมีหลังคาแหนบ'),
    ]).get('MR0AA9CA');
    expect(model?.body).toBeNull();
    expect(model?.brand?.name).toBe('Toyota');
    expect(model?.cc).toBe(2393);
  });

  it('เลขตัวถังสั้นกว่า 8 ตัว = ไม่มีรุ่น', () => {
    expect(modelPrefix('MLT')).toBeNull();
  });
});

describe('dataWarningsFor', () => {
  const models = buildKnownModels([zontes(1), zontes(2), zontes(3), zontes(4)]);
  const row = { chassis: 'MLTZT1509TX010479', brandId: 'zontes', cc: '149.5', body: 'รย.12-น้อยกว่า 300cc' };

  it('ตรงกับรุ่น = ไม่เตือน (CC เป็นข้อความ "149.50" ก็นับว่าเท่ากัน)', () => {
    expect(dataWarningsFor(row, models, brandNameOf)).toEqual([]);
    expect(dataWarningsFor({ ...row, cc: '149.50' }, models, brandNameOf)).toEqual([]);
  });

  it('ยี่ห้อ / CC / ประเภทรถ ไม่ตรงรุ่น = เตือนแยกข้อ บอกค่าที่ควรเป็น', () => {
    const warnings = dataWarningsFor({ ...row, brandId: 'yamaha', cc: '367.6', body: 'รย.12-300-799cc' }, models, brandNameOf);
    expect(codes(warnings)).toEqual(['MODEL_BRAND', 'MODEL_CC', 'MODEL_BODY']);
    expect(warnings[0].message).toContain('Yamaha');
    expect(warnings[0].message).toContain('Zontes');
    expect(warnings[1].message).toContain('149.5');
  });

  it('รุ่นที่ไม่เคยคีย์ = ไม่มีอะไรให้เทียบ ไม่เตือน', () => {
    expect(dataWarningsFor({ ...row, chassis: 'JH2NC64TXTK000575', brandId: 'yamaha' }, models, brandNameOf)).toEqual([]);
  });

  it('เลขตัวถังผิดหลักและไม่ตรงรุ่น = เตือนทั้งสองเรื่อง', () => {
    expect(codes(dataWarningsFor({ ...row, chassis: 'MLTZT1509TX01047', brandId: 'yamaha' }, models, brandNameOf))).toEqual(['CHASSIS_LENGTH', 'MODEL_BRAND']);
  });
});

describe('findSuspectVehicles (รายงานในหน้าภาพรวม)', () => {
  const candidate = (n: number, overrides: Record<string, unknown> = {}) => ({ ...zontes(n), id: `v${n}`, hasOwner: true, open: true, ...overrides });

  it('รายงานเฉพาะคันที่ยังไม่วางบิล แต่รุ่นที่รู้จักเรียนจากรถทุกคัน', () => {
    const billed = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => candidate(n, { open: false }));
    const wrongBilled = candidate(9, { open: false, brandId: 'yamaha', brandName: 'Yamaha' });
    const wrongOpen = candidate(10, { brandId: 'yamaha', brandName: 'Yamaha' });
    const fine = candidate(11);
    const suspects = findSuspectVehicles([...billed, wrongBilled, wrongOpen, fine]);
    expect(suspects.map((s) => s.vehicle.id)).toEqual(['v10']);
    expect(suspects[0].notes).toEqual(['ยี่ห้อ Yamaha (รุ่นนี้ปกติ Zontes)']);
  });

  it('เลขตัวถังผิดหลัก ไม่มีเจ้าของ และข้อสังเกตเพิ่มจากผู้เรียก รวมอยู่ในคันเดียวกัน', () => {
    const suspects = findSuspectVehicles([candidate(1, { chassis: 'MLTZ1509TX006844', hasOwner: false })], () => ['CC ไม่อยู่ในช่วง']);
    expect(suspects[0].notes).toEqual(['เลขตัวถัง 16 หลัก (ปกติ 17)', 'CC ไม่อยู่ในช่วง', 'ไม่มีข้อมูลเจ้าของรถ']);
  });

  it('ข้อมูลปกติทั้งหมด = ไม่มีอะไรรายงาน', () => {
    expect(findSuspectVehicles([1, 2, 3].map((n) => candidate(n)))).toEqual([]);
  });
});

describe('isDataWarningsConfirmed', () => {
  const warnings = chassisWarnings('MLTZ1509TX006844');

  it('ไม่มีคำเตือน = ผ่าน', () => {
    expect(isDataWarningsConfirmed([], undefined)).toBe(true);
  });

  it('ต้องส่ง key ของทุกข้อที่มีตอนนี้', () => {
    expect(isDataWarningsConfirmed(warnings, undefined)).toBe(false);
    expect(isDataWarningsConfirmed(warnings, [])).toBe(false);
    expect(isDataWarningsConfirmed(warnings, [warnings[0].key])).toBe(true);
  });

  it('ยืนยันของเลขตัวถังอื่นใช้ไม่ได้', () => {
    expect(isDataWarningsConfirmed(warnings, chassisWarnings('MLTZ1509TX006845').map((w) => w.key))).toBe(false);
  });
});
