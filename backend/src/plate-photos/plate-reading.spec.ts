import { describe, expect, it } from 'vitest';
import { matchPlate, type PlateCandidate } from './plate-reading.js';

const car = (id: string, cat: string, num: string, province: string | null = 'กรุงเทพมหานคร'): PlateCandidate => ({
  id,
  plateCategory: cat,
  plateNumber: num,
  registrationProvince: province,
});
const read = (category: string | null, number: string | null, province: string | null = 'กรุงเทพมหานคร') => ({ category, number, province, uncertain: false, plateType: null });

describe('matchPlate', () => {
  const pending = [car('a', '8ขก', '3484'), car('b', '8ขค', '195'), car('c', '1กข', '12')];

  it('exact match ignores spaces and leading zeros', () => {
    expect(matchPlate(read('8 ขก', '3484'), pending, [])).toEqual({ kind: 'exact', vehicleIds: ['a'], provinceMismatch: false, typeMismatch: false });
    expect(matchPlate(read('1กข', '012'), pending, []).vehicleIds).toEqual(['c']);
  });

  it('flags province mismatch on exact match', () => {
    expect(matchPlate(read('8ขก', '3484', 'ชลบุรี'), pending, []).provinceMismatch).toBe(true);
  });

  it('suggests a one-character misread (letter or digit) without auto-picking', () => {
    expect(matchPlate(read('8ขม', '3484'), pending, [])).toMatchObject({ kind: 'close', vehicleIds: ['a'] });
    expect(matchPlate(read('8ขค', '192'), pending, [])).toMatchObject({ kind: 'close', vehicleIds: ['b'] });
  });

  it('two-character difference is not a match', () => {
    expect(matchPlate(read('8มม', '3484'), pending, []).kind).toBe('none');
  });

  it('reports plates already received and unreadable ones', () => {
    expect(matchPlate(read('9กก', '1'), pending, [car('z', '9กก', '1')])).toMatchObject({ kind: 'received', vehicleIds: ['z'] });
    expect(matchPlate(read(null, '3484'), pending, []).kind).toBe('unreadable');
  });

  it('duplicate plate in queue (different provinces) asks staff to choose', () => {
    const dup = [car('x', 'กข', '1', 'กรุงเทพมหานคร'), car('y', 'กข', '1', 'ชลบุรี')];
    expect(matchPlate(read('กข', '1', null), dup, [])).toMatchObject({ kind: 'close', vehicleIds: ['x', 'y'] });
  });
});

describe('matchPlate province tie-break', () => {
  it('uses the province on the plate to pick between duplicate plates', () => {
    const dup = [car('x', 'กข', '1', 'กรุงเทพมหานคร'), car('y', 'กข', '1', 'ชลบุรี')];
    expect(matchPlate(read('กข', '1', 'ชลบุรี'), dup, [])).toMatchObject({ kind: 'exact', vehicleIds: ['y'] });
  });
});

describe('matchPlate plate type', () => {
  const pending = [car('a', '1กข', '12')];
  const typed = (plateType: 'car' | 'motorcycle' | null) => ({ ...read('1กข', '12'), plateType });

  it('flags a motorcycle plate photographed on the car tab (and vice versa)', () => {
    expect(matchPlate(typed('motorcycle'), pending, [], 'car')).toMatchObject({ kind: 'exact', typeMismatch: true });
    expect(matchPlate(typed('car'), pending, [], 'moto').typeMismatch).toBe(true);
  });

  it('no warning when the type agrees or the AI is unsure', () => {
    expect(matchPlate(typed('motorcycle'), pending, [], 'moto').typeMismatch).toBe(false);
    expect(matchPlate(typed(null), pending, [], 'moto').typeMismatch).toBe(false);
  });
});
