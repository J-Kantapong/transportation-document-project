import { describe, expect, it } from 'vitest';
import { matchBook, type BookCandidate } from './book-reading.js';

const car = (id: string, chassis: string, cat: string | null, num: string | null, province: string | null = 'กรุงเทพมหานคร'): BookCandidate => ({
  id,
  chassis,
  plateCategory: cat,
  plateNumber: num,
  registrationProvince: province,
});
const read = (chassis: string | null, category: string | null, number: string | null, province: string | null = 'กรุงเทพมหานคร') => ({
  chassis,
  category,
  number,
  province,
  uncertain: false,
});

describe('matchBook', () => {
  const pending = [car('a', 'MR0HA3CD100123456', '8ขก', '3484'), car('b', 'LGXCE4CB0P0654321', '1กข', '12'), car('m', 'MH1JM4110RK000111', '1กข', '12', 'ชลบุรี')];

  it('exact VIN wins regardless of case/spaces', () => {
    expect(matchBook(read('mr0ha3cd1 00123456', '8ขก', '3484'), pending, [])).toEqual({
      kind: 'exact',
      vehicleIds: ['a'],
      by: 'chassis',
      plateMismatch: false,
      provinceMismatch: false,
    });
  });

  it('exact VIN but different plate in the book = warn (plateMismatch)', () => {
    expect(matchBook(read('MR0HA3CD100123456', '8ขก', '3485'), pending, [])).toMatchObject({ kind: 'exact', vehicleIds: ['a'], plateMismatch: true });
  });

  it('no VIN read: unique plate is exact, duplicate plate (car + moto) needs province or a choice', () => {
    expect(matchBook(read(null, '8ขก', '3484'), pending, [])).toMatchObject({ kind: 'exact', vehicleIds: ['a'], by: 'plate' });
    expect(matchBook(read(null, '1กข', '12', 'ชลบุรี'), pending, [])).toMatchObject({ kind: 'exact', vehicleIds: ['m'] });
    expect(matchBook(read(null, '1กข', '12', null), pending, [])).toMatchObject({ kind: 'close', vehicleIds: ['b', 'm'] });
  });

  it('VIN one character off = suggest, never auto-pick', () => {
    expect(matchBook(read('MR0HA3CD1O0123456', null, null), pending, [])).toMatchObject({ kind: 'close', vehicleIds: ['a'] });
  });

  it('plate matches but VIN read differs = suggest only', () => {
    expect(matchBook(read('ZZZZZZZZZZZZZZZZZ', '8ขก', '3484'), pending, [])).toMatchObject({ kind: 'close', vehicleIds: ['a'] });
  });

  it('already received, not found, unreadable', () => {
    const received = [car('z', 'JTDKB20U000999999', '9กก', '1')];
    expect(matchBook(read('JTDKB20U000999999', null, null), pending, received)).toMatchObject({ kind: 'received', vehicleIds: ['z'], by: 'chassis' });
    expect(matchBook(read('XXXXXXXXXXXXXXXXX', '5ขข', '99'), pending, received).kind).toBe('none');
    expect(matchBook(read(null, null, '3484'), pending, received).kind).toBe('unreadable');
  });
});
