import {
  limitStuckPerKind,
  sortStuck,
  STAGES,
  stuckItemFor,
  summarizeBacklog,
  waitsFor,
  type OpenVehicle,
  type StuckItem,
  type StuckSubject,
} from './overview-process.js';

const TODAY = '2026-09-24';
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function vehicle(o: Partial<OpenVehicle> = {}): OpenVehicle {
  return {
    id: 'v1',
    date: d('2026-09-20'),
    body: 'รย.1-เก๋ง 2 ตอน',
    transferDone: false,
    transferCompletedDate: null,
    inspectionSentDate: null,
    inspectionResult: null,
    inspectionResultDate: null,
    inspectionFailRemark: null,
    plateReceivedDate: null,
    bookReceivedDate: null,
    deliveredDate: null,
    plateDeliveredDate: null,
    latestSubmission: null,
    hasPendingPlateSwap: false,
    billed: false,
    ...o,
  };
}

const passed = (resultIso: string) =>
  vehicle({ transferDone: true, transferCompletedDate: d('2026-09-01'), inspectionSentDate: d('2026-09-01'), inspectionResult: 'ผ่าน', inspectionResultDate: d(resultIso) });

const sub = (status: string, o: Partial<NonNullable<OpenVehicle['latestSubmission']>> = {}) => ({
  status,
  submitDate: d('2026-09-10'),
  receiptDate: null,
  receiptReceivedDate: status === 'RECEIPT_RECEIVED' ? d('2026-09-15') : null,
  failRemark: null,
  receiptCarriedAt: null,
  ...o,
});

const stages = (v: OpenVehicle) => waitsFor(v, TODAY).map((w) => w.stage);

describe('waitsFor - ขั้นที่รถค้างอยู่', () => {
  it('ขั้น 2-4 ตามลำดับ', () => {
    expect(stages(vehicle())).toEqual(['transfer']);
    expect(stages(vehicle({ transferDone: true }))).toEqual(['inspectSend']);
    expect(stages(vehicle({ transferDone: true, inspectionSentDate: d('2026-09-22') }))).toEqual(['inspectResult']);
    expect(stages(passed('2026-09-20'))).toEqual(['submit']);
  });

  it('ตรวจไม่ผ่าน = กลับไปรอส่งตรวจ พร้อมเหตุผล', () => {
    const [w] = waitsFor({ ...passed('2026-09-20'), inspectionResult: 'ไม่ผ่าน', inspectionFailRemark: 'ไฟหน้า' }, TODAY);
    expect(w.stage).toBe('inspectSend');
    expect(w.flags).toEqual(['INSPECTION_FAILED']);
    expect(w.reason).toContain('ไฟหน้า');
  });

  it('ผลตรวจ: ใกล้หมดอายุเตือน, ครบ 90 วันกลับไปตรวจรอบ 2', () => {
    const expiring = waitsFor(passed('2026-07-01'), TODAY)[0]; // 85 วัน เหลือ 5 วัน
    expect(expiring.stage).toBe('submit');
    expect(expiring.flags).toContain('INSPECTION_EXPIRING');
    expect(expiring.reason).toContain('5 วัน');
    const expired = waitsFor(passed('2026-06-20'), TODAY)[0]; // 96 วัน
    expect(expired.stage).toBe('inspectSend');
    expect(expired.flags).toContain('INSPECTION_EXPIRED');
    expect(expired.since).toBe('2026-09-18');
  });

  it('ยื่นไม่สำเร็จ และรอเอกสารสลับเลข', () => {
    const w = waitsFor({ ...passed('2026-09-20'), latestSubmission: sub('FAILED', { failRemark: 'ชื่อผิด' }), hasPendingPlateSwap: true }, TODAY)[0];
    expect(w.stage).toBe('submit');
    expect(w.flags).toEqual(['SUBMISSION_FAILED', 'PLATE_SWAP_PENDING']);
    expect(w.reason).toContain('ชื่อผิด');
  });

  it('ยื่นแล้วรอใบเสร็จ - ค้างจากใบก่อนถูกติดธง', () => {
    expect(stages({ ...passed('2026-09-01'), latestSubmission: sub('PENDING') })).toEqual(['receipt']);
    const w = waitsFor({ ...passed('2026-09-01'), latestSubmission: sub('PENDING', { receiptCarriedAt: d('2026-09-20') }) }, TODAY)[0];
    expect(w.flags).toEqual(['RECEIPT_UNKNOWN']);
  });

  it('ค้างจากใบก่อนแต่แนบรูปใบเสร็จแล้ว - ยังรอบันทึกแต่ไม่ติดธง', () => {
    const w = waitsFor(
      { ...passed('2026-09-01'), latestSubmission: sub('PENDING', { receiptCarriedAt: d('2026-09-20'), _count: { receipts: 1 } }) },
      TODAY,
    )[0];
    expect(w.stage).toBe('receipt');
    expect(w.flags).toEqual([]);
    expect(w.reason).toBeNull();
  });

  it('ได้ใบเสร็จแล้ว: รอป้ายและเล่มพร้อมกัน, ได้เล่มแล้วรอส่งงาน, ส่งงานแล้วรอส่งป้าย + วางบิล', () => {
    const base = { ...passed('2026-09-01'), latestSubmission: sub('RECEIPT_RECEIVED') };
    expect(stages(base)).toEqual(['plate', 'book']);
    expect(stages({ ...base, bookReceivedDate: d('2026-09-18') })).toEqual(['plate', 'delivery']);
    expect(stages({ ...base, bookReceivedDate: d('2026-09-18'), plateReceivedDate: d('2026-09-22'), deliveredDate: d('2026-09-20') })).toEqual([
      'plateDelivery',
      'billing',
    ]);
    expect(stages({ ...base, bookReceivedDate: d('2026-09-18'), plateReceivedDate: d('2026-09-18'), deliveredDate: d('2026-09-20'), plateDeliveredDate: d('2026-09-20'), billed: true })).toEqual([]);
  });

  it('รอป้าย/เล่มนับจากวันที่ในใบเสร็จ (ไม่มีค่อยใช้วันที่รับใบเสร็จ)', () => {
    const since = (o: Partial<NonNullable<OpenVehicle['latestSubmission']>>) =>
      waitsFor({ ...passed('2026-09-01'), latestSubmission: sub('RECEIPT_RECEIVED', o) }, TODAY).map((w) => w.since);
    expect(since({ receiptDate: d('2026-09-10') })).toEqual(['2026-09-10', '2026-09-10']);
    expect(since({})).toEqual(['2026-09-15', '2026-09-15']);
  });
});

describe('summarizeBacklog', () => {
  it('นับแยกรถยนต์/จักรยานยนต์ อายุงานค้าง และงานที่เกินกำหนด', () => {
    const b = summarizeBacklog(
      [
        { stage: 'receipt', kind: 'car', since: '2026-09-20' },
        { stage: 'receipt', kind: 'moto', since: '2026-09-10' }, // 14 วัน > 7
        { stage: 'receipt', kind: 'moto', since: '2026-09-23' },
      ],
      TODAY,
    );
    expect(b.receipt).toEqual({ pending: { car: 1, moto: 2 }, oldestDays: 14, lateCount: 1 });
    expect(b.plate).toEqual({ pending: { car: 0, moto: 0 }, oldestDays: null, lateCount: 0 });
  });
});

describe('stuckItemFor / sortStuck', () => {
  const subject: StuckSubject = { id: 'v1', source: 'vehicle', kind: 'moto', customerName: 'ลูกค้า', brandName: 'Honda', chassis: 'CH1', plate: null };

  it('ยังไม่เกินกำหนดและไม่มีปัญหา = ไม่ติดขัด', () => {
    expect(stuckItemFor(subject, [{ stage: 'receipt', since: '2026-09-22', flags: [], reason: null }], TODAY)).toBeNull();
  });

  it('เกินกำหนด = ควรดู, มีปัญหาด่วน = ด่วนแม้ยังไม่เกินกำหนด - เลือกรายการที่หนักสุดของคันนั้น', () => {
    const item = stuckItemFor(
      subject,
      [
        { stage: 'plate', since: '2026-09-01', flags: [], reason: null }, // 23 วัน เกิน 16
        { stage: 'book', since: '2026-09-20', flags: [], reason: null },
      ],
      TODAY,
    )!;
    expect(item).toMatchObject({ stage: 'plate', days: 23, overdueDays: 16, severity: 'medium' });
    expect(item.reason).toContain('รับป้ายทะเบียน');

    const urgent = stuckItemFor(subject, [{ stage: 'submit', since: '2026-09-23', flags: ['INSPECTION_EXPIRING'], reason: 'ผลตรวจจะหมดอายุใน 3 วัน' }], TODAY)!;
    expect(urgent).toMatchObject({ severity: 'high', overdueDays: 0, reason: 'ผลตรวจจะหมดอายุใน 3 วัน' });

    expect(sortStuck([item, urgent]).map((i) => i.stage)).toEqual(['submit', 'plate']);
  });

  it('ขั้นผลตรวจรถพาไปแท็บกรอกผลตรวจ ไม่ใช่แท็บส่งตรวจ (พบ 2026-09-27)', () => {
    expect(STAGES.inspectResult.href).toBe('/registration/new-vehicle/inspection/result');
  });
});

describe('limitStuckPerKind (พบ 2026-09-27)', () => {
  const item = (id: string, kind: 'car' | 'moto', overdueDays: number): StuckItem => ({
    id,
    source: 'vehicle',
    kind,
    customerName: '-',
    brandName: null,
    chassis: id,
    plate: null,
    stage: 'receipt',
    stageLabel: 'รับใบเสร็จ',
    href: '',
    since: TODAY,
    days: overdueDays + 7,
    overdueDays,
    severity: 'medium',
    reason: '-',
    flags: [],
  });

  it('ตัดทีละประเภทรถ: จักรยานยนต์ที่ด่วนน้อยกว่ารถยนต์ทุกคันยังถูกส่งไปให้ปุ่มกรองแสดงได้', () => {
    const sorted = sortStuck([item('c1', 'car', 30), item('c2', 'car', 20), item('c3', 'car', 10), item('m1', 'moto', 5), item('m2', 'moto', 1)]);
    const limited = limitStuckPerKind(sorted, 2);
    expect(limited.map((i) => i.id)).toEqual(['c1', 'c2', 'm1', 'm2']);
    // แถวแรกๆ ยังเป็นคันที่ด่วนที่สุดของทั้งหมดตามลำดับเดิม
    expect(limited.slice(0, 2).map((i) => i.id)).toEqual(sorted.slice(0, 2).map((i) => i.id));
  });
});
