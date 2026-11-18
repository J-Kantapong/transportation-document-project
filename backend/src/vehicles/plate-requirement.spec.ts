import { describe, expect, it } from 'vitest';
import { deliveryKind } from '../delivery/delivery.service.js';
import { waitsFor, type OpenVehicle } from '../overview/overview-process.js';
import { buildSteps } from '../portal/portal.service.js';
import { plateNotRequired } from './plate-requirement.js';

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const NO_PLATE = { plateNumberOption: 'AUCTION', newPlateOption: 'NONE', includePlateFee: false };

describe('plateNotRequired (รถที่ไม่ซื้อป้าย ผู้ใช้ 2026-11-18)', () => {
  it('ขอใช้เลขแล้วไม่รวมค่าแผ่นป้าย = ไม่ต้องรับป้าย', () => {
    expect(plateNotRequired(NO_PLATE)).toBe(true);
    expect(plateNotRequired({ ...NO_PLATE, plateNumberOption: 'NORMAL', newPlateOption: null })).toBe(true);
  });

  it('ไม่ขอเลข / เลขจากงานสลับเลข / รวมค่าป้าย / สั่งทำป้ายใหม่ / ยังไม่ยื่น = ยังต้องรับป้าย', () => {
    expect(plateNotRequired({ ...NO_PLATE, plateNumberOption: 'NONE' })).toBe(false);
    expect(plateNotRequired({ ...NO_PLATE, plateNumberOption: 'SWAP_NORMAL' })).toBe(false);
    expect(plateNotRequired({ ...NO_PLATE, includePlateFee: true })).toBe(false);
    expect(plateNotRequired({ ...NO_PLATE, newPlateOption: 'AUCTION' })).toBe(false);
    expect(plateNotRequired(null)).toBe(false);
    expect(plateNotRequired(undefined)).toBe(false);
  });
});

describe('รถที่ไม่ซื้อป้ายในขั้นถัดไป', () => {
  it('Delivery: ส่งเล่มอย่างเดียว แล้วจบ ไม่ค้างรอป้าย', () => {
    const base = { plateReceivedDate: null, plateDeliveredDate: null, plateNotRequired: true };
    expect(deliveryKind({ ...base, deliveredDate: null })).toBe('NO_PLATE');
    expect(deliveryKind({ ...base, deliveredDate: d('2026-10-15') })).toBe('DONE');
    // ไม่ติดธง = กฎเดิม
    expect(deliveryKind({ ...base, plateNotRequired: false, deliveredDate: d('2026-10-15') })).toBe('WAITING_PLATE');
    // แนบรูปป้ายไว้จริง = กฎเดิม (ยังต้องส่งป้าย)
    expect(deliveryKind({ ...base, plateReceivedDate: d('2026-10-16'), deliveredDate: d('2026-10-15') })).toBe('PLATE_ONLY');
  });

  it('ภาพรวม / ค้นหารถ: ไม่ขึ้น "รอรับป้าย"', () => {
    const vehicle = (options: object): OpenVehicle => ({
      id: 'v1',
      date: d('2026-10-01'),
      body: 'รย.1-นั่ง 2 ตอน',
      transferDone: true,
      transferCompletedDate: d('2026-10-02'),
      inspectionSentDate: null,
      inspectionResult: null,
      inspectionResultDate: null,
      inspectionFailRemark: null,
      plateReceivedDate: null,
      bookReceivedDate: d('2026-10-14'),
      deliveredDate: d('2026-10-15'),
      plateDeliveredDate: null,
      latestSubmission: {
        status: 'RECEIPT_RECEIVED',
        submitDate: d('2026-10-14'),
        receiptDate: d('2026-10-14'),
        receiptReceivedDate: d('2026-10-14'),
        failRemark: null,
        receiptCarriedAt: null,
        ...options,
      },
      hasPendingPlateSwap: false,
      billed: true,
    });
    expect(waitsFor(vehicle(NO_PLATE), '2026-11-18')).toEqual([]);
    expect(waitsFor(vehicle({ ...NO_PLATE, includePlateFee: true }), '2026-11-18').map((w) => w.stage)).toEqual(['plate']);
  });

  it('พอร์ทัลลูกค้า: ไม่มีขั้นรับป้าย ส่งเล่มแล้ว = ส่งมอบครบ', () => {
    const row = {
      id: 'v1',
      date: d('2026-10-01'),
      chassis: 'X',
      color: null,
      body: 'รย.1-นั่ง 2 ตอน',
      registrationProvince: 'กรุงเทพมหานคร',
      plateCategory: '7กฮ',
      plateNumber: '4411',
      transferDone: true,
      transferCompletedDate: d('2026-10-02'),
      inspectionSentDate: d('2026-10-03'),
      inspectionResult: 'ผ่าน',
      inspectionResultDate: d('2026-10-04'),
      plateReceivedDate: null,
      bookReceivedDate: d('2026-10-14'),
      deliveredDate: d('2026-10-15'),
      plateDeliveredDate: null,
      deliveryConfirmedAt: null,
      createdAt: d('2026-10-01'),
      brand: { name: 'Deepal' },
      documentSubmissions: [{ status: 'RECEIPT_RECEIVED', submitDate: d('2026-10-14'), receiptReceivedDate: d('2026-10-14'), ...NO_PLATE }],
    };
    const steps = buildSteps(row);
    expect(steps.some((s) => s.key === 'plate')).toBe(false);
    expect(steps.every((s) => s.state === 'DONE')).toBe(true);
    expect(steps.find((s) => s.key === 'delivery')?.note).toBeNull();
    // ซื้อป้ายตามปกติ = ยังมีขั้นรับป้ายและค้างอยู่
    const normal = buildSteps({ ...row, documentSubmissions: [{ ...row.documentSubmissions[0], includePlateFee: true }] });
    expect(normal.find((s) => s.key === 'plate')?.state).toBe('CURRENT');
  });
});
