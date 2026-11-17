import { describe, expect, it } from 'vitest';
import { PROVINCES } from '../vehicles/vehicle-reference-data.js';
import { QUICK_COMMANDS } from './commands.js';
import {
  needsCarAtProvince,
  parseProvinceRateCommand,
  provinceRateTableTexts,
  provinceRateText,
  QUOTE_TIERS,
  quotePriceOf,
  supplierCostTotal,
  type SupplierCostRow,
} from './province-rates.js';

const row = (province: string, fees: [number, number, number], extra: Partial<SupplierCostRow> = {}): SupplierCostRow => ({
  province,
  accepts: true,
  serviceFee: fees[0],
  channelFee: fees[1],
  inspectionFee: fees[2],
  plateSwapFee: null,
  plateSwapNote: null,
  ...extra,
});

describe('parseProvinceRateCommand', () => {
  it('ตารางทุกจังหวัด', () => {
    for (const text of ['เรทจังหวัด', 'เรท', 'ตารางเรท', 'เรทต่างจังหวัด', 'ราคาจดต่างจังหวัด', ' เรท จังหวัด ']) {
      expect(parseProvinceRateCommand(text)).toEqual({ kind: 'all' });
    }
  });

  it('จังหวัดเดียว: ชื่อเต็ม ชื่อย่อ ชื่อเรียก มีหรือไม่มีคำนำก็ได้', () => {
    const phuket = { kind: 'province', province: 'ภูเก็ต' };
    expect(parseProvinceRateCommand('เรท ภูเก็ต')).toEqual(phuket);
    expect(parseProvinceRateCommand('ภูเก็ต')).toEqual(phuket);
    expect(parseProvinceRateCommand('เช็คราคาจดภูเก็ต')).toEqual(phuket);
    expect(parseProvinceRateCommand('ค่าจดทะเบียนจังหวัดภูเก็ต')).toEqual(phuket);
    expect(parseProvinceRateCommand('จดอุบล')).toEqual({ kind: 'province', province: 'อุบลราชธานี' });
    expect(parseProvinceRateCommand('เรทโคราช')).toEqual({ kind: 'province', province: 'นครราชสีมา' });
    expect(parseProvinceRateCommand('อยุธยา')).toEqual({ kind: 'province', province: 'พระนครศรีอยุธยา' });
    expect(parseProvinceRateCommand('ขอนแก่น')).toEqual({ kind: 'province', province: 'ขอนแก่น' });
    expect(parseProvinceRateCommand('กทม')).toEqual({ kind: 'province', province: 'กรุงเทพมหานคร' });
  });

  it('ชื่อที่ขึ้นต้นเหมือนกันหลายจังหวัด = ให้เลือก', () => {
    expect(parseProvinceRateCommand('เรท นคร')).toEqual({
      kind: 'ambiguous',
      candidates: ['นครนายก', 'นครราชสีมา', 'นครพนม', 'นครสวรรค์', 'นครปฐม', 'นครศรีธรรมราช'],
    });
    expect(parseProvinceRateCommand('นครส')).toEqual({ kind: 'province', province: 'นครสวรรค์' });
  });

  it('ไม่แย่งคำสั่งอื่นของเลขา', () => {
    const others = QUICK_COMMANDS.map((c) => c.text).filter((t) => t !== 'เรทจังหวัด');
    for (const text of [...others, 'ขอ ที่อยู่', 'จำ ที่อยู่ = 1', 'ลืม ที่อยู่', 'บิลล่าสุด', 'ใบกำกับ TV2026-146', 'ราคา', 'สวัสดี', 'ลำ', '']) {
      expect(parseProvinceRateCommand(text)).toBeNull();
    }
  });
});

describe('เรทเสนอและการตรวจรถ', () => {
  it('ทุกจังหวัดมีเรท ยกเว้นกรุงเทพฯ และชื่อในตารางชั้นเป็นจังหวัดจริงไม่ซ้ำกัน', () => {
    for (const p of PROVINCES) expect(quotePriceOf(p) === null).toBe(p === 'กรุงเทพมหานคร');
    const listed = QUOTE_TIERS.flatMap((t) => t.provinces);
    expect(new Set(listed).size).toBe(listed.length);
    for (const p of listed) expect(PROVINCES).toContain(p);
  });

  it('ราคาที่เคยเสนอลูกค้าไว้ยังเท่าเดิม', () => {
    expect(quotePriceOf('นนทบุรี')).toBe(3000);
    expect(quotePriceOf('ชลบุรี')).toBe(3000);
    expect(quotePriceOf('พระนครศรีอยุธยา')).toBe(3200);
    expect(quotePriceOf('ฉะเชิงเทรา')).toBe(3200);
    expect(quotePriceOf('เพชรบุรี')).toBe(3200);
    expect(quotePriceOf('ระยอง')).toBe(3500);
    expect(quotePriceOf('นครสวรรค์')).toBe(4000);
    expect(quotePriceOf('ภูเก็ต')).toBe(4000);
    expect(quotePriceOf('อุบลราชธานี')).toBe(4000);
    expect(quotePriceOf('ยะลา')).toBe(4500);
    expect(quotePriceOf('สมุทรปราการ')).toBe(3500);
  });

  it('จังหวัดที่ส่งซับต้องนำรถไปตรวจ ออฟฟิศจดเองไม่ต้อง', () => {
    expect(needsCarAtProvince('ภูเก็ต')).toBe(true);
    expect(needsCarAtProvince('สมุทรปราการ')).toBe(false);
    expect(needsCarAtProvince('กรุงเทพมหานคร')).toBe(false);
  });
});

describe('provinceRateText', () => {
  it('จังหวัดที่ส่งซับ: เรท + ต้องนำรถไปตรวจ + ต้นทุนซับแยกรายการ + ส่วนที่เหลือ', () => {
    expect(provinceRateText('ภูเก็ต', row('ภูเก็ต', [1000, 300, 300]))).toBe(
      [
        'จดทะเบียนจังหวัดภูเก็ต (ส่งซับ)',
        'เรทเสนอ: 4,000 + แจ้งย้าย 200 + จากใบเสร็จ (ยังไม่รวม VAT)',
        'ตรวจรถ: ต้องนำรถเข้าตรวจที่ภูเก็ต',
        'ต้นทุนซับ: 1,600 (ค่าดำเนินการ 1,000 · ค่าช่อง 300 · นำรถเข้าตรวจ 300)',
        'เหลือหลังหักค่าซับ: 2,400 (ยังไม่หักภาษี)',
      ].join('\n'),
    );
  });

  it('มีราคาสลับป้ายของซับ = แสดงเพิ่ม', () => {
    const text = provinceRateText('ชลบุรี', row('ชลบุรี', [1000, 200, 300], { plateSwapFee: 500, plateSwapNote: 'จดพร้อมสลับ' }));
    expect(text).toContain('สลับป้าย: ซับคิดเพิ่ม 500 · จดพร้อมสลับ (ไม่รวมในเรทเสนอ)');
  });

  it('ซับไม่รับ / ยังไม่มีราคา / ราคาไม่ครบ ไม่เดาต้นทุน', () => {
    expect(provinceRateText('พะเยา', row('พะเยา', [0, 0, 0], { accepts: false }))).toContain('ซับไม่รับจดจังหวัดนี้');
    expect(provinceRateText('ตาก', undefined)).toContain('ยังไม่มีราคาซับในระบบ');
    const partial = provinceRateText('ตาก', { ...row('ตาก', [1000, 300, 300]), channelFee: null });
    expect(partial).toContain('ราคาซับในระบบยังไม่ครบ');
    expect(partial).not.toContain('เหลือหลังหักค่าซับ');
  });

  it('ออฟฟิศจดเอง', () => {
    const samutPrakan = provinceRateText('สมุทรปราการ', undefined);
    expect(samutPrakan).toContain('เรทเสนอ: 3,500');
    expect(samutPrakan).toContain('ตรวจรถ: ไม่ต้องนำรถไป');
    expect(provinceRateText('กรุงเทพมหานคร', undefined)).toContain('ออฟฟิศจดเอง');
  });
});

describe('provinceRateTableTexts', () => {
  const rows = [
    row('ภูเก็ต', [1000, 300, 300]),
    row('อุบลราชธานี', [1000, 200, 200]),
    row('นนทบุรี', [1000, 300, 200]),
    row('ปทุมธานี', [200, 200, 500]),
    row('ยะลา', [1200, 500, 200]),
    row('พะเยา', [0, 0, 0], { accepts: false }),
  ];

  it('ทุกจังหวัดอยู่ในตาราง แยกตามเรทและต้นทุนซับ', () => {
    const texts = provinceRateTableTexts(rows);
    expect(texts.length).toBeLessThanOrEqual(5);
    for (const t of texts) expect(t.length).toBeLessThanOrEqual(5000);
    const all = texts.join('\n');
    for (const p of PROVINCES) expect(all).toContain(p);
    expect(all).toContain('ต้องนำรถเข้าตรวจที่จังหวัดนั้น');
    expect(all).toContain('▸ เรท 3,000 (ปริมณฑลและใกล้)\nซับ 900: ปทุมธานี\nซับ 1,500: นนทบุรี');
    expect(all).toMatch(/▸ เรท 4,000 \(จังหวัดไกล\)\nซับ 1,400: อุบลราชธานี\nซับ 1,600: ภูเก็ต\nยังไม่มีราคาซับ: /);
    expect(all).toContain('▸ เรท 4,500 (สามจังหวัดชายแดนใต้)\nซับ 1,900: ยะลา');
    expect(all).toContain('▸ ซับไม่รับจด: พะเยา');
    expect(all).toContain('สมุทรปราการ 3,500');
  });

  it('ต้นทุนซับรวม 3 ช่อง', () => {
    expect(supplierCostTotal(rows[0])).toBe(1600);
    expect(supplierCostTotal(rows[5])).toBeNull();
    expect(supplierCostTotal(undefined)).toBeNull();
  });
});
