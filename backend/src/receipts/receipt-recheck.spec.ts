import { describe, expect, it } from 'vitest';
import { acceptRecheck, recheckJobs, recheckReceipt } from './receipt-recheck.js';
import type { ReceiptReading } from './receipt-extraction.js';

const reading = (o: Partial<ReceiptReading>): ReceiptReading => ({
  receiptNo: '69/0001', pcNo: null, date: '2026-11-18', plateCategory: '1ฆจ', plateNumber: '256', chassis: 'MLHJC1234K5000001',
  cc: null, weightKg: null, items: [{ label: 'คำขอ', amount: 5 }, { label: 'โอนทะเบียนรถ', amount: 100 }], total: 105, uncertainFields: [], ...o,
});
const job = { billTotal: 105, receiptAmount: 105, chassis: 'MLHJC1234K5000001', plates: [{ category: '1ฆจ', number: '256' }] };

describe('recheckReceipt (ตรวจใบเสร็จซ้ำ ผู้ใช้ 2026-11-19)', () => {
  it('ยอด ตัวถัง ทะเบียนตรง = ผ่าน', () => {
    const c = recheckReceipt(job, [reading({})]);
    expect(c.problems).toEqual([]);
    expect([c.amount.status, c.chassis.status, c.plate.status]).toEqual(['MATCH', 'MATCH', 'MATCH']);
  });

  it('ยอดใบเสร็จไม่ตรง Bill (เคสจริง: ยื่นเป็นโอนปกติ 105 แต่ใบเสร็จเป็นโอนขอใช้ 130)', () => {
    const c = recheckReceipt({ ...job, receiptAmount: 130 }, [reading({ total: 130, items: [{ label: 'คำขอ', amount: 10 }, { label: 'โอนทะเบียนรถ', amount: 100 }, { label: 'ธรรมเนียมอื่นๆ', amount: 20 }] })]);
    expect(c.amount).toMatchObject({ status: 'DIFF', diff: 25 });
    expect(c.problems[0]).toContain('ต่าง +25');
  });

  it('ทะเบียนหมวดเพี้ยน 1 ตัวอักษร = ผ่าน (AI อ่าน ฆ เป็น พ) / เลขต่าง = ไม่ผ่าน / ทะเบียนใหม่ของงานก็นับ', () => {
    expect(recheckReceipt(job, [reading({ plateCategory: '1พจ' })]).plate.status).toBe('MATCH');
    expect(recheckReceipt(job, [reading({ plateNumber: '257' })]).plate.status).toBe('DIFF');
    const swap = { ...job, plates: [{ category: '1ฆจ', number: '256' }, { category: '9กก', number: '8888' }] };
    expect(recheckReceipt(swap, [reading({ plateCategory: '9กก', plateNumber: '8888' })]).plate.status).toBe('MATCH');
  });

  it('เลขตัวถังคนละคันชัดเจน = ไม่ผ่าน / อ่านไม่ได้ = ไม่ตัดสิน', () => {
    expect(recheckReceipt(job, [reading({ chassis: 'JYARJ1234K0999999' })]).chassis.status).toBe('DIFF');
    expect(recheckReceipt(job, [reading({ chassis: null })]).chassis.status).toBe('MISSING');
    expect(recheckReceipt(job, []).problems).toEqual([]);
  });

  it('รายการรวมไม่เท่ายอดรวม = เตือนให้ดูรูปซ้ำ', () => {
    expect(recheckReceipt(job, [reading({ total: 115 })]).itemsSumMismatch).toBe(true);
  });

  it('ยืนยัน: ไม่มียอด = 400 เสมอ / ไม่ผ่าน = ต้องมีเหตุผล / ผ่าน = ไม่ต้อง', () => {
    expect(() => acceptRecheck(recheckReceipt({ ...job, receiptAmount: null }, []), 'x')).toThrow();
    const diff = recheckReceipt({ ...job, receiptAmount: 130 }, []);
    expect(() => acceptRecheck(diff, '')).toThrow();
    expect(acceptRecheck(diff, 'ลูกค้าขอใช้ แก้ Bill แล้ว')).toBe('ลูกค้าขอใช้ แก้ Bill แล้ว');
    expect(acceptRecheck(recheckReceipt(job, [reading({})]), undefined)).toBeNull();
  });
});

describe('recheckReceipt - ข้อ 1 2 6 (ผู้ใช้ 2026-11-19)', () => {
  it('ข้อ 6: เทียบรายการทีละยอด + จับโอนปกติที่ใบเสร็จเป็นโอนขอใช้ (เคสจริง production)', () => {
    const c = recheckReceipt(
      { ...job, receiptAmount: 130, expectedItems: [{ label: 'คำขอ', amount: 5 }, { label: 'โอนทะเบียนรถ', amount: 100 }], useRequest: false },
      [reading({ total: 130, items: [{ label: 'คำขอ', amount: 10 }, { label: 'โอนทะเบียนรถ', amount: 100 }, { label: 'ธรรมเนียมอื่นๆ(ขอใช้รถต่างภูมิลำเนา)', amount: 20 }] })],
    );
    expect(c.items).toEqual({ extra: [{ label: 'คำขอ', amount: 10 }, { label: 'ธรรมเนียมอื่นๆ(ขอใช้รถต่างภูมิลำเนา)', amount: 20 }], missing: [{ label: 'คำขอ', amount: 5 }] });
    expect(c.problems.some((p) => p.includes('โอนขอใช้ แต่งานยื่นเป็นโอนปกติ'))).toBe(true);
  });

  it('ข้อ 6: ยอดรวมตรงแต่รายการต่าง = เตือน ไม่ขวาง', () => {
    const c = recheckReceipt({ ...job, expectedItems: [{ label: 'คำขอ', amount: 5 }, { label: 'โอนทะเบียนรถ', amount: 100 }] }, [reading({ items: [{ label: 'รวม', amount: 105 }], total: 105 })]);
    expect(c.problems).toEqual([]);
    expect(c.warnings.some((w) => w.startsWith('รายการไม่ตรงกัน'))).toBe(true);
  });

  it('ข้อ 1-2: ช่องที่ AI ไม่แน่ใจ (ยกเว้นที่ตรวจแล้วตรง) + เลขที่ใบเสร็จผิดรูปแบบ = เตือน', () => {
    const c = recheckReceipt({ ...job, receiptNo: '69-0001' }, [reading({ uncertainFields: ['total', 'chassis', 'cc'] })]);
    expect(c.problems).toEqual([]);
    expect(c.warnings.join(' ')).toContain('AI ไม่แน่ใจ: ยอดรวม');
    expect(c.warnings.join(' ')).not.toContain('เลขตัวถัง'); // ตัวถังตรงกับงานแล้ว
    expect(c.warnings.join(' ')).toContain('ผิดรูปแบบ');
    expect(recheckReceipt({ ...job, receiptNo: '69/0001' }, [reading({})]).warnings).toEqual([]);
  });
});

describe('recheckJobs - ข้อ 4 เลขที่ใบเสร็จซ้ำข้ามงาน', () => {
  const none = { findMany: async () => [] };
  const mk = (moveOutNo: string, transferType: string) => {
    const moveOut = { id: 'm1', chassis: 'A', plateCategory: '7ขฐ', plateNumber: '4860', billTotal: 25, receiptAmount: 25, receiptNo: '70/0000301', receipts: [] };
    const transfer = { id: 't1', receiptNo: moveOutNo, plateCategory: '7ขฐ', plateNumber: '5805', transferType };
    return {
      plateSwap: none, vehicleUseCancellation: none, plateCopy: none, taxRenewal: none, documentSubmission: none,
      vehicleMoveOut: { findMany: async ({ where }: any) => (where.id ? [moveOut] : where.receiptNo.in.includes(moveOut.receiptNo) ? [moveOut] : []) },
      vehicleTransfer: { findMany: async ({ where }: any) => (where.receiptNo?.in.includes(transfer.receiptNo) ? [transfer] : []) },
    } as any;
  };
  it('ซ้ำกับงานอื่น = เตือน (เลขรันแยกต่อสำนักงาน) / ย้ายออกกับโอนย้ายเข้าคนละสำนักงาน = ไม่เตือน', async () => {
    const dup = (await recheckJobs(mk('70/0000301', 'OWNER'), 'MOVE_OUT', ['m1'])).get('m1')!;
    expect(dup.duplicates).toEqual(['งานโอน 7ขฐ 5805']);
    expect(dup.problems).toEqual([]);
    expect(dup.warnings.join(' ')).toContain('เลขที่ใบเสร็จซ้ำกับงานอื่น');
    expect((await recheckJobs(mk('70/0000301', 'MOVE_IN'), 'MOVE_OUT', ['m1'])).get('m1')!.duplicates).toEqual([]);
  });
});
