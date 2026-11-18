import { describe, expect, it } from 'vitest';
import {
  ambiguousText,
  buildJobSummaries,
  jobSummaryTexts,
  costText,
  customerSummaryText,
  matchCustomers,
  MENU_GROUPS,
  menuMessage,
  parseLookupCommand,
  pendingText,
  quotationMessages,
  rateCustomersMessage,
  ratesText,
  summarizeCosts,
  supplierRateText,
  type QuotationRow,
} from './lookup.js';

describe('parseLookupCommand', () => {
  it('เมนู / งานค้าง', () => {
    expect(parseLookupCommand(' เมนู ')).toEqual({ kind: 'menu' });
    expect(parseLookupCommand('งานค้าง')).toEqual({ kind: 'pending' });
    expect(parseLookupCommand('งานค้างทั้งหมด')).toEqual({ kind: 'pending' });
  });

  it('ราคา / ต้นทุน มีหรือไม่มีคำค้น', () => {
    expect(parseLookupCommand('ราคา')).toEqual({ kind: 'rates', term: '' });
    expect(parseLookupCommand('ราคา SPI')).toEqual({ kind: 'rates', term: 'SPI' });
    expect(parseLookupCommand('ราคาลูกค้า บางบ่อ อารียนต์')).toEqual({ kind: 'rates', term: 'บางบ่อ อารียนต์' });
    expect(parseLookupCommand('ต้นทุน')).toEqual({ kind: 'cost', term: '' });
    expect(parseLookupCommand('ต้นทุน เชียงใหม่')).toEqual({ kind: 'cost', term: 'เชียงใหม่' });
  });

  it('ใบเสนอราคา: ล่าสุด / ตามเลข / ตามลูกค้า', () => {
    expect(parseLookupCommand('ใบเสนอราคาล่าสุด')).toEqual({ kind: 'quotations', mode: 'latest', count: 3 });
    expect(parseLookupCommand('ใบเสนอราคา ล่าสุด 9')).toEqual({ kind: 'quotations', mode: 'latest', count: 5 });
    expect(parseLookupCommand('ใบเสนอราคา qt2026-012')).toEqual({ kind: 'quotations', mode: 'numbers', numbers: ['QT2026-012'] });
    expect(parseLookupCommand('QT2026-005-R1')).toEqual({ kind: 'quotations', mode: 'numbers', numbers: ['QT2026-005-R1'] });
    expect(parseLookupCommand('ใบเสนอราคา ยามาฮ่า')).toEqual({ kind: 'quotations', mode: 'customer', term: 'ยามาฮ่า' });
  });

  it('เอกสารและยอดของลูกค้า · ยอดใช้จ่ายยังเป็นคำสั่งเดิม', () => {
    expect(parseLookupCommand('บิล SPI')).toEqual({ kind: 'docs', doc: 'iv', term: 'SPI' });
    expect(parseLookupCommand('ใบกำกับภาษี Lexus')).toEqual({ kind: 'docs', doc: 'tv', term: 'Lexus' });
    expect(parseLookupCommand('ยอด SPI')).toEqual({ kind: 'customer', term: 'SPI' });
    expect(parseLookupCommand('ยอดใช้จ่าย')).toBeNull();
  });

  it('ข้อความอื่นไม่ใช่คำสั่งค้นข้อมูล', () => {
    for (const t of ['สรุปเช้า', 'การเงินค้าง', 'ค้างจ่าย', 'ขอ ที่อยู่', 'จำ ราคา = 500', 'จำ QT2026-001 = ส่งแล้ว', 'บิล', 'ใบกำกับ', 'สวัสดี']) expect(parseLookupCommand(t)).toBeNull();
  });
});

describe('matchCustomers', () => {
  const customers = [
    { id: '1', name: 'SPI', company: 'บริษัท เอส พี ไอ จำกัด' },
    { id: '2', name: 'SPI สาขา 2', company: null },
    { id: '3', name: 'YM', company: 'ไทยยามาฮ่ามอเตอร์' },
  ];
  it('ตรงทั้งชื่อชนะ ไม่งั้นเอาทุกรายที่มีคำนั้น', () => {
    expect(matchCustomers(customers, 'spi').map((c) => c.id)).toEqual(['1']);
    expect(matchCustomers(customers, 'ยามาฮ่า').map((c) => c.id)).toEqual(['3']);
    expect(matchCustomers(customers, 'สาขา').map((c) => c.id)).toEqual(['2']);
    expect(matchCustomers(customers, 'S').map((c) => c.id)).toEqual(['1', '2']);
    expect(matchCustomers(customers, '  ')).toEqual([]);
  });
  it('ไม่พบ / พบหลายราย บอกให้พิมพ์ใหม่', () => {
    expect(ambiguousText('xx', [])).toContain('ไม่พบลูกค้า');
    expect(ambiguousText('S', customers.slice(0, 2))).toContain('2 ราย');
  });
});

describe('ratesText', () => {
  const terms = { vat: true, whtRate: 3, creditDays: 30, payWeekday: null, requiresQuotation: false };
  it('แยกราคาหลัก ค่าเพิ่ม งานอื่น และเงื่อนไข', () => {
    const out = ratesText(
      'MC Superbike',
      [
        { label: 'จดทะเบียนรถจักรยานยนต์ 300 cc - 799 cc', vehicleKind: 'MOTO', ccMin: 300, ccMax: 800, chassisPrefix: 'ML', registrationProvince: null, bodyPrefix: null, amount: 885, vatInclusive: false, includesReceipt: false, kind: 'BASE' },
        { label: '', vehicleKind: 'ANY', ccMin: null, ccMax: null, chassisPrefix: null, registrationProvince: null, bodyPrefix: null, amount: 100, vatInclusive: false, includesReceipt: false, kind: 'URGENT' },
      ],
      [{ jobLabel: 'งานโอน (โอนตรวจรถ)', vehicleClass: 'CAR', label: '', amount: 800, includesReceipt: true }],
      terms,
    );
    expect(out).toContain('• จดทะเบียนรถจักรยานยนต์ 300 cc - 799 cc [ตัวถัง ML…]: 885');
    expect(out).toContain('• ด่วน: +100');
    expect(out).toContain('• งานโอน (โอนตรวจรถ) รถยนต์: 800 (เหมารวมใบเสร็จ)');
    expect(out).toContain('เงื่อนไข: VAT 7% · หัก ณ ที่จ่าย 3% · เครดิต 30 วัน');
  });
  it('ยังไม่ตั้งราคา บอกตรงๆ · รอบจ่ายตามวันแทนเครดิต', () => {
    const out = ratesText('ลูกค้าใหม่', [], [], { ...terms, vat: false, whtRate: 0, payWeekday: 4 });
    expect(out).toContain('ยังไม่ได้ตั้งตารางราคา');
    expect(out).toContain('ไม่มี VAT · ไม่หัก ณ ที่จ่าย · จ่ายทุกวันพฤหัสบดี');
  });
  it('รายชื่อลูกค้า: ปุ่มไม่เกิน 13 ปุ่ม label ไม่เกิน 20 ตัวอักษร', () => {
    const names = Array.from({ length: 20 }, (_, i) => `ลูกค้าชื่อยาวมากๆๆๆๆๆๆๆๆๆๆ ${i}`);
    const m = rateCustomersMessage(names);
    expect(m.quickReply?.items).toHaveLength(13);
    for (const i of m.quickReply!.items) expect(i.action.label.length).toBeLessThanOrEqual(20);
    expect(m.type === 'text' && m.text).toContain(names[19]);
    expect(rateCustomersMessage([]).quickReply).toBeUndefined();
  });
});

describe('ต้นทุน', () => {
  it('เฉลี่ยตามหัวข้อ + ช่วงต่ำสุดสูงสุด', () => {
    const rows = summarizeCosts([
      { group: 'จดทะเบียนรถใหม่', label: 'รถยนต์ (จดเอง)', cost: 200 },
      { group: 'จดทะเบียนรถใหม่', label: 'รถยนต์ (จดเอง)', cost: 301 },
      { group: 'งานอื่นๆ', label: 'โอน รถยนต์', cost: 110 },
    ]);
    expect(rows).toEqual([
      { group: 'จดทะเบียนรถใหม่', label: 'รถยนต์ (จดเอง)', count: 2, average: 250.5, min: 200, max: 301 },
      { group: 'งานอื่นๆ', label: 'โอน รถยนต์', count: 1, average: 110, min: 110, max: 110 },
    ]);
    const out = costText(rows, 90);
    expect(out).toContain('• รถยนต์ (จดเอง): 250.5 บาท (ต่ำสุด 200 สูงสุด 301) · 2 งาน');
    expect(out).toContain('• โอน รถยนต์: 110 บาท · 1 งาน');
    expect(costText([], 90)).toContain('ยังไม่มีงาน');
  });
  it('ราคาซับ: รวมสามช่อง บอกเมื่อยังไม่ครบ / ไม่รับจด', () => {
    const row = { province: 'เชียงใหม่', accepts: true, serviceFee: 1500, channelFee: null, inspectionFee: 500, plateSwapFee: null, plateSwapNote: null, note: null };
    const out = supplierRateText('เชียง', [row, { ...row, province: 'เชียงราย', accepts: false, note: 'ไกล' }]);
    expect(out).toContain('ค่าดำเนินการ 1,500 · ค่าช่อง ? · นำรถเข้าตรวจ 500');
    expect(out).toContain('รวม 2,000 บาท (ยังไม่ครบ');
    expect(out).toContain('เชียงราย: ซับไม่รับจด (ไกล)');
    expect(supplierRateText('xx', [])).toContain('ไม่พบจังหวัด');
  });
});

describe('pendingText', () => {
  it('แสดงเฉพาะขั้นที่มีงานค้าง แยกรถใหม่/งานอื่น', () => {
    const out = pendingText(
      [
        { group: 'new', label: 'รับใบเสร็จ', pending: { car: 3, moto: 12 }, oldestDays: 9, lateCount: 2 },
        { group: 'new', label: 'รับเล่มทะเบียน', pending: { car: 0, moto: 0 }, oldestDays: null, lateCount: 0 },
        { group: 'other', label: 'งานโอน (รอรับใบเสร็จ)', pending: { car: null, moto: 1 }, oldestDays: 1, lateCount: 0 },
        { group: 'other', label: 'แจ้งย้ายยามาฮ่า', pending: null, oldestDays: null, lateCount: 0 },
      ],
      { unbilledVehicles: 4, unbilledJobs: 1, receivableCount: 2, receivableAmount: 15000.5 },
    );
    expect(out).toContain('‼ รับใบเสร็จ: รถยนต์ 3 · จยย. 12 (นานสุด 9 วัน, เกินกำหนด 2)');
    expect(out).toContain('• งานโอน (รอรับใบเสร็จ): จยย. 1 (นานสุด 1 วัน)');
    expect(out).not.toContain('รับเล่มทะเบียน');
    expect(out).not.toContain('ยามาฮ่า');
    expect(out).toContain('• รอวางบิล: รถ 4 คัน · งานอื่น 1 งาน');
    expect(out).toContain('• รอรับเงิน: 2 ใบ ฿15,000.5');
    expect(pendingText([])).toContain('ไม่มีงานค้าง');
  });
});

describe('สรุปแยกตามประเภทงาน', () => {
  it('คำสั่ง: สรุปงาน / สรุปแต่ละงาน ไม่ชนสรุปเช้า', () => {
    expect(parseLookupCommand('สรุปงาน')).toEqual({ kind: 'jobs' });
    expect(parseLookupCommand('สรุป แต่ละ งาน')).toEqual({ kind: 'jobs' });
    expect(parseLookupCommand('สรุปเช้า')).toBeNull();
  });

  it('แต่ละงาน: ยื่นเดือนนี้ ค้าง ต้นทุน ค่าบริการ ส่วนต่าง', () => {
    const sample = (type: 'NEW' | 'TRANSFER', kind: 'car' | 'moto', cost: number) => ({ type, kind, cost, date: '2026-11-03', group: '', label: '' });
    const summary = buildJobSummaries({
      samples: [sample('NEW', 'car', 300), sample('NEW', 'car', 400), sample('TRANSFER', 'moto', 110)],
      prices: [
        { type: 'NEW', kind: 'car', amount: 655 },
        { type: 'NEW', kind: 'moto', amount: 440 },
      ],
      submitted: [
        { type: 'NEW', kind: 'car' },
        { type: 'NEW', kind: 'moto' },
        { type: 'NEW', kind: 'moto' },
        { type: 'TRANSFER', kind: 'moto' },
      ],
      process: [
        { key: 'receipt', group: 'new', label: 'รับใบเสร็จ', pending: { car: 3, moto: 2 }, oldestDays: 9, lateCount: 1 },
        { key: 'book', group: 'new', label: 'รับเล่มทะเบียน', pending: { car: 0, moto: 0 }, oldestDays: null, lateCount: 0 },
        { key: 'transferJob', group: 'other', label: 'งานโอน (ยื่น)', pending: { car: null, moto: 1 }, oldestDays: 1, lateCount: 0 },
        { key: 'jobDelivery', group: 'other', label: 'งานอื่น (รอส่งงานลูกค้า)', pending: { car: 2, moto: 0 }, oldestDays: 1, lateCount: 0 },
      ],
    });
    expect(summary.jobs.map((j) => j.title)).toEqual(['จดทะเบียนรถใหม่', 'งานโอน', 'สลับเลข', 'ต่อภาษี', 'ยกเลิกการใช้รถ', 'คัดแผ่นป้ายทะเบียน', 'ย้ายออก']);
    const [out] = jobSummaryTexts(summary, { month: '2026-11', days: 90 });
    expect(out).toContain('【จดทะเบียนรถใหม่】\nยื่นเดือนนี้: รถยนต์ 1 · จยย. 2\nค้าง: รับใบเสร็จ 5 ‼');
    expect(out).toContain('รถยนต์: ต้นทุน 350 (2 งาน) · ค่าบริการ 655 (1 งาน) · ส่วนต่าง 305');
    expect(out).toContain('จยย.: ต้นทุน - · ค่าบริการ 440 (1 งาน)');
    expect(out).toContain('【งานโอน】\nยื่นเดือนนี้: จยย. 1\nค้าง: งานโอน (ยื่น) 1\nจยย.: ต้นทุน 110 (1 งาน) · ค่าบริการ -');
    expect(out).toContain('【ย้ายออก】\nยื่นเดือนนี้: ไม่มี\nค้าง: ไม่มี');
    expect(out).toContain('รอส่งงานลูกค้า: 2 งาน');
  });
});

describe('ใบเสนอราคา', () => {
  const q: QuotationRow = {
    quotationNo: 'QT2026-023',
    customerName: 'ไทยยามาฮ่ามอเตอร์',
    kind: 'JOB',
    status: 'APPROVED',
    title: 'งานแจ้งย้าย ต.ค.',
    issueDate: '2026-11-02',
    validUntil: '2026-12-02',
    feeTotal: 1000,
    serviceTotal: 5000,
    goodsTotal: 0,
    vatRate: 7,
    vatAmount: 350,
    whtRate: 3,
    whtAmount: 150,
    netTotal: 6200,
    poNumber: 'AC693788',
    invoiceNos: [],
    url: 'https://x/accounting/quotations/view?id=q1',
  };
  it('ยอดแยกบรรทัด สถานะ PO และลิงก์', () => {
    const [m] = quotationMessages([q], [], '2026-11-18');
    const out = m.type === 'text' ? m.text : '';
    expect(out).toContain('ใบเสนอราคา QT2026-023 ไทยยามาฮ่ามอเตอร์');
    expect(out).toContain('วันที่ 02/11/2026 · ยืนราคาถึง 02/12/2026 · อนุมัติแล้ว');
    expect(out).toContain('ค่าบริการ 5,000');
    expect(out).toContain('VAT 7% 350');
    expect(out).toContain('หัก ณ ที่จ่าย 3% 150');
    expect(out).toContain('ยอดสุทธิ 6,200 บาท');
    expect(out).toContain('PO: AC693788');
    expect(out).toContain('ยังไม่ได้วางบิล');
    expect(out).not.toContain('ค่าสินค้า');
  });
  it('หมดอายุ / ไม่พบเลข / ไม่มีใบ', () => {
    const [expired, missing] = quotationMessages([{ ...q, status: 'ISSUED', validUntil: '2026-11-10' }], ['QT2026-999'], '2026-11-18');
    expect(expired.type === 'text' && expired.text).toContain('หมดอายุแล้ว');
    expect(missing.type === 'text' && missing.text).toContain('QT2026-999');
    expect(quotationMessages([], [], '2026-11-18')).toEqual([{ type: 'text', text: 'ยังไม่มีใบเสนอราคา' }]);
  });
});

describe('customerSummaryText', () => {
  it('บิลรอรับเงิน เกินกำหนด และยอดเดือนนี้', () => {
    const out = customerSummaryText(
      {
        customerName: 'SPI',
        month: '2026-11',
        open: [
          { invoiceNo: 'IV2026-150', issueDate: '2026-11-01', dueDate: '2026-11-12', netTotal: 1000 },
          { invoiceNo: 'IV2026-155', issueDate: '2026-11-15', dueDate: null, netTotal: 2500.5 },
        ],
        billedMonth: { count: 3, amount: 9000 },
        paidMonth: { count: 1, amount: 5500 },
        unbilledVehicles: 7,
        quotations: [{ quotationNo: 'QT2026-020', status: 'ISSUED', netTotal: 4000, kind: 'JOB' }],
      },
      '2026-11-18',
    );
    expect(out).toContain('รอรับเงิน 2 ใบ ฿3,500.5 (เกินกำหนด 1 ใบ)');
    expect(out).toContain('‼ IV2026-150 ฿1,000 ออก 01/11/2026 ครบ 12/11/2026');
    expect(out).toContain('• IV2026-155 ฿2,500.5 ออก 15/11/2026');
    expect(out).toContain('• วางบิล 3 ใบ ฿9,000');
    expect(out).toContain('ส่งงานแล้วรอวางบิล: รถ 7 คัน');
    expect(out).toContain('• QT2026-020 รอลูกค้าอนุมัติ ฿4,000');
  });
});

describe('menuMessage', () => {
  it('ปุ่มทุกปุ่ม label ไม่เกิน 20 ตัวอักษร และการ์ดเล็กกว่าที่ LINE รับ', () => {
    for (const g of MENU_GROUPS) for (const b of g.buttons) expect(b.label.length).toBeLessThanOrEqual(20);
    const m = menuMessage();
    expect(m.type).toBe('flex');
    expect(JSON.stringify(m).length).toBeLessThan(30_000);
  });
});
