import { describe, expect, it } from 'vitest';
import { MailFormatError } from './yamaha-mail.js';
import {
  buildYamahaDoMessage,
  buildYamahaPoMessage,
  isYamahaDoMail,
  isYamahaPoMail,
  parseYamahaDoMail,
  parseYamahaPoMail,
  type PoStatus,
} from './yamaha-po-mail.js';

const PO_SUBJECT = 'You have received purchase order (PO) from THAI YAMAHA MOTOR CO., LTD.';
const PO_FROM = 'accounting.info@yamaha-motor.co.th';
const poBody = (nos: string) => `คุณได้รับใบสั่งซื้อจาก บริษัท ไทยยามาฮ่ามอเตอร์ จำกัด ตามรายละเอียด ดังนี้\r\nหมายเลข po : ${nos}\r\n\r\n\r\nรายละเอียดเพิ่มเติม กรุณาตรวจสอบได้ที่ https://purchase.yamaha-motor.co.th`;

const DO_FROM = 'TYM - Group Corporate Purchasing <Purchasing@yamaha-motor.co.th>';
// รูปแบบเดียวกับเมลจริงของระบบ PR-Online (เลขเป็นข้อมูลสมมติ) - bold = true จำลอง Gmail ที่แปลงตัวหนาเป็น *…*
const doBody = (bold = false, po = 'AC693767', iv = 'IV2026-153', reason = '') => {
  const b = (s: string) => (bold ? `*${s}*` : s);
  return [
    'Dear Sir/Madam,',
    'Your Delivery Order has been Received follow PR-Online System',
    '',
    `${b('Document No.')}: DO-20261109-089`,
    `${b('Document Date')}: 09/11/2026`,
    `${b('Purchase Order No.')}: ${po}`,
    `${b('Invoice No.')}: ${iv}`,
    `${b('Invoice Date')}: 05/11/2026`,
    `${b('Reason of Received')}: ${reason}`,
    '',
    'This is an electronic email,please do not reply.',
  ].join('\r\n');
};

type Bubble = { header: { contents: Array<{ text: string }> }; body: { contents: Array<{ text: string }> }; footer?: { contents: Array<{ action: { uri: string } }> } };
const bubbleOf = (m: unknown) => (m as { contents: Bubble }).contents;
const texts = (b: Bubble) => [...b.header.contents, ...b.body.contents].map((c) => c.text).join('\n');

describe('Yamaha PO mail', () => {
  it('accepts only the purchasing system notice from the exact sender', () => {
    expect(isYamahaPoMail({ from: PO_FROM, subject: PO_SUBJECT })).toBe(true);
    expect(isYamahaPoMail({ from: `X <${PO_FROM.toUpperCase()}>`, subject: PO_SUBJECT })).toBe(true);
    expect(isYamahaPoMail({ from: PO_FROM, subject: `RE: ${PO_SUBJECT}` })).toBe(false);
    expect(isYamahaPoMail({ from: 'accounting.info@yamaha-motor.co.th.evil.example', subject: PO_SUBJECT })).toBe(false);
    expect(isYamahaPoMail({ from: 'finance@yamaha-motor.co.th', subject: PO_SUBJECT })).toBe(false);
    expect(isYamahaPoMail({ from: PO_FROM, subject: 'อย่างอื่น' })).toBe(false);
  });

  it('reads one or several PO numbers without duplicates', () => {
    expect(parseYamahaPoMail({ body: poBody('AC693332') })).toEqual(['AC693332']);
    expect(parseYamahaPoMail({ body: poBody('AC693788, ac693767,AC693788') })).toEqual(['AC693788', 'AC693767']);
  });

  it('does not take numbers from other lines and fails loudly without a PO', () => {
    expect(() => parseYamahaPoMail({ body: poBody('') })).toThrow(MailFormatError);
    expect(() => parseYamahaPoMail({ body: 'สวัสดี AC693788' })).toThrow(MailFormatError);
  });

  const po = (over: Partial<PoStatus>): PoStatus => ({ poNumber: 'AC693788', state: 'new', quotationNo: null, invoiceNo: null, ...over });

  it('alerts for a new PO and lists the quotations waiting for approval', () => {
    const b = bubbleOf(buildYamahaPoMessage([po({})], [{ quotationNo: 'QT2026-030', title: 'แจ้งย้าย (ใหญ่)', netTotal: 1_234.5 }], 'https://app.example'));
    expect(texts(b)).toContain('AC693788');
    expect(texts(b)).toContain('ยังไม่ได้บันทึก PO นี้');
    expect(texts(b)).toContain('QT2026-030 แจ้งย้าย (ใหญ่) · 1,234.50');
    expect(b.footer!.contents[0].action.uri).toBe('https://app.example/accounting/quotations');
  });

  it('says so when no quotation is waiting, and has no link without a web address', () => {
    const b = bubbleOf(buildYamahaPoMessage([po({})], []));
    expect(texts(b)).toContain('ไม่มีใบเสนอราคาที่รออนุมัติ');
    expect(b.footer).toBeUndefined();
  });

  it('counts only the POs still to bill and stays silent when all are billed', () => {
    const billed = po({ poNumber: 'AC693767', state: 'billed', invoiceNo: 'IV2026-153', quotationNo: 'QT2026-023' });
    const approved = po({ state: 'approved', quotationNo: 'QT2026-024' });
    const b = bubbleOf(buildYamahaPoMessage([billed, approved], []));
    expect(texts(b)).toContain('ต้องออกใบวางบิล 1 ใบ');
    expect(texts(b)).toContain('ออกใบวางบิล IV2026-153 แล้ว');
    expect(texts(b)).toContain('บันทึกใน QT2026-024 แล้ว');
    expect(texts(b)).not.toContain('รออนุมัติ');
    expect(buildYamahaPoMessage([billed], [])).toBeNull();
  });
});

describe('Yamaha DO mail', () => {
  it('accepts Received / Cancelled notices from the purchasing sender only', () => {
    expect(isYamahaDoMail({ from: DO_FROM, subject: 'Received Delivery Order: DO-20261109-089' })).toBe(true);
    expect(isYamahaDoMail({ from: DO_FROM, subject: 'Cancelled Delivery Order: DO-20260410-002' })).toBe(true);
    expect(isYamahaDoMail({ from: DO_FROM, subject: 'Successful Login Notification' })).toBe(false);
    expect(isYamahaDoMail({ from: DO_FROM, subject: 'RE: Received Delivery Order: DO-20261109-089' })).toBe(false);
    expect(isYamahaDoMail({ from: 'purchasing@yamaha-motor.co.th <a@evil.example>', subject: 'Received Delivery Order: DO-20261109-089' })).toBe(false);
  });

  it('reads the DO, PO and invoice numbers, with or without bold markers', () => {
    const expected = { doNumber: 'DO-20261109-089', received: true, statusWord: 'Received', poNumber: 'AC693767', invoiceNo: 'IV2026-153', reason: null };
    expect(parseYamahaDoMail({ subject: 'Received Delivery Order: DO-20261109-089', body: doBody() })).toEqual(expected);
    expect(parseYamahaDoMail({ subject: 'Received Delivery Order: DO-20261109-089', body: doBody(true) })).toEqual(expected);
  });

  it('keeps empty fields empty instead of reading the next line', () => {
    const mail = parseYamahaDoMail({ subject: 'Cancelled Delivery Order: DO-20260410-002', body: doBody(false, '', '', 'เอกสารไม่ครบ') });
    expect(mail).toMatchObject({ received: false, statusWord: 'Cancelled', poNumber: null, invoiceNo: null, reason: 'เอกสารไม่ครบ' });
  });

  it('builds a calm card when received and a warning when cancelled', () => {
    const ok = bubbleOf(buildYamahaDoMessage(parseYamahaDoMail({ subject: 'Received Delivery Order: DO-20261109-089', body: doBody() })));
    expect(texts(ok)).toContain('ยามาฮ่ารับ DO แล้ว');
    expect(texts(ok)).toContain('PO AC693767 · บิล IV2026-153');
    const bad = bubbleOf(buildYamahaDoMessage(parseYamahaDoMail({ subject: 'Cancelled Delivery Order: DO-20260410-002', body: doBody(false, 'AC693767', 'IV2026-153', 'ยอดไม่ตรง') })));
    expect(texts(bad)).toContain('ยกเลิก DO');
    expect(texts(bad)).toContain('เหตุผล: ยอดไม่ตรง');
    expect(texts(bad)).toContain('ออก Delivery Order ใหม่');
  });
});
