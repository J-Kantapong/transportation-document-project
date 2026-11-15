import { describe, expect, it } from 'vitest';
import { buildYamahaNoticeMessage, type NoticeInvoice } from './mail-message.js';
import { normalizeMails } from './mail.service.js';
import { parseStatementPostback } from './statement-message.js';
import { isYamahaNotice, MailFormatError, parseYamahaNotice, senderAddress } from './yamaha-mail.js';

const SUBJECT = 'แจ้งรายละเอียด Invoice เพื่อขอรับใบเสร็จรับเงินของ บริษัท ตัวอย่าง จำกัด';
// รูปแบบเดียวกับเมลจริงของฝ่ายการเงินยามาฮ่า (ยอดและเลขบิลเป็นข้อมูลสมมติ)
const body = (invoiceLines: string, date = '13/11/2026', amount = '411,133.60') =>
  [
    'เรียน ผู้เกี่ยวข้อง',
    '',
    `ขอแจ้งรายละเอียด Invoice ที่ทาง บริษัท ไทยยามาฮ่ามอเตอร์ จำกัด จะมีการโอนเงินให้ในวันที่ ${date}`,
    '',
    `รบกวนส่งใบเสร็จรับเงินภายในวันที่ ${date}`,
    '',
    'จ่ายให้ : บริษัท ตัวอย่าง จำกัด',
    `วันที่โอนเงิน : ${date}`,
    `ยอดเงินที่โอน : ${amount} บาท`,
    '',
    'Invoice ดังนี้',
    '',
    invoiceLines,
    '',
    'กรุณาแจ้งวิธีการจัดส่งเอกสาร',
    '(กรณีจัดส่งทางไปรษณีย์ กรุณาแจ้งเลขที่จัดส่ง)',
  ].join('\r\n');

describe('isYamahaNotice', () => {
  it('accepts the finance notice, also when the From header carries a display name', () => {
    expect(senderAddress('TYM_Finance <finance@yamaha-motor.co.th>')).toBe('finance@yamaha-motor.co.th');
    expect(isYamahaNotice({ from: 'TYM_Finance <Finance@Yamaha-Motor.co.th>', subject: SUBJECT })).toBe(true);
    expect(isYamahaNotice({ from: 'finance@yamaha-motor.co.th', subject: `Revised ${SUBJECT}` })).toBe(true);
  });

  it('rejects replies, other senders and look-alike addresses', () => {
    expect(isYamahaNotice({ from: 'finance@yamaha-motor.co.th', subject: `RE: ${SUBJECT}` })).toBe(false);
    expect(isYamahaNotice({ from: 'pranom@yamaha-motor.co.th', subject: SUBJECT })).toBe(false);
    expect(isYamahaNotice({ from: 'finance@yamaha-motor.co.th.evil.example', subject: SUBJECT })).toBe(false);
    expect(isYamahaNotice({ from: 'finance@yamaha-motor.co.th <attacker@example.com>', subject: SUBJECT })).toBe(false);
    expect(isYamahaNotice({ from: 'finance@yamaha-motor.co.th', subject: 'อย่างอื่น' })).toBe(false);
  });
});

describe('parseYamahaNotice', () => {
  it('reads the pay date, the amount and the invoice number', () => {
    expect(parseYamahaNotice({ subject: SUBJECT, body: body('IV2026-131') })).toEqual({ payDate: '2026-11-13', amount: 411_133.6, invoiceNos: ['IV2026-131'], revised: false });
  });

  it('accepts the "IV : IV…" form, several invoices and a revised notice', () => {
    const n = parseYamahaNotice({ subject: `Revised ${SUBJECT}`, body: body('IV : IV2026-085\r\nIV2026-086, iv2026-086', '07/08/2026', '24,858.24') });
    expect(n).toEqual({ payDate: '2026-08-07', amount: 24_858.24, invoiceNos: ['IV2026-085', 'IV2026-086'], revised: true });
  });

  it('converts a Buddhist year', () => {
    expect(parseYamahaNotice({ subject: SUBJECT, body: body('IV2026-131', '13/11/2569') }).payDate).toBe('2026-11-13');
  });

  it('ignores a quoted older notice below "From:"', () => {
    const quoted = `${body('IV2026-200', '20/11/2026', '100.00')}\r\nFrom: TYM_Finance\r\n${body('IV2026-131')}`;
    expect(parseYamahaNotice({ subject: SUBJECT, body: quoted })).toMatchObject({ payDate: '2026-11-20', amount: 100, invoiceNos: ['IV2026-200'] });
  });

  it('fails loudly when a part is missing or wrong', () => {
    expect(() => parseYamahaNotice({ subject: SUBJECT, body: 'สวัสดี' })).toThrow(MailFormatError);
    expect(() => parseYamahaNotice({ subject: SUBJECT, body: body('ไม่มีเลขบิล') })).toThrow(MailFormatError);
    expect(() => parseYamahaNotice({ subject: SUBJECT, body: body('IV2026-131', '31/02/2026') })).toThrow(MailFormatError);
    expect(() => parseYamahaNotice({ subject: SUBJECT, body: body('IV2026-131', '13/11/2026', '0.00') })).toThrow(MailFormatError);
  });
});

const inv = (over: Partial<NoticeInvoice>): NoticeInvoice => ({
  invoiceNo: 'IV2026-131',
  id: 'inv1',
  state: 'open',
  customerName: 'ไทยยามาฮ่ามอเตอร์',
  netTotal: 411_133.6,
  whtAmount: 3_155.6,
  taxInvoiceNo: null,
  beforePaymentAllowed: true,
  ...over,
});
const notice = { payDate: '2026-11-13', amount: 411_133.6, invoiceNos: ['IV2026-131'], revised: false };
type Bubble = { footer?: { contents: Array<{ action: { data: string; label: string } }> }; body: { contents: Array<{ text: string }> } };
const bubbleOf = (m: ReturnType<typeof buildYamahaNoticeMessage>) => (m as unknown as { contents: Bubble }).contents;
const texts = (b: Bubble) => b.body.contents.map((c) => c.text).join('\n');

describe('buildYamahaNoticeMessage', () => {
  it('offers a before-payment tax invoice dated the pay date with the bill WHT', () => {
    const b = bubbleOf(buildYamahaNoticeMessage(notice, [inv({})]));
    const button = b.footer!.contents[0].action;
    expect(button.label.length).toBeLessThanOrEqual(20);
    expect(button.label).toContain('IV2026-131'); // เลขบิลต้องไม่ถูกตัด (ปุ่มของหลายบิลต้องแยกกันออก)
    expect(parseStatementPostback(button.data)).toEqual({ action: 'tvb', invoiceId: 'inv1', date: '2026-11-13', whtAmount: 3_155.6 });
    expect(texts(b)).not.toContain('⚠');
  });

  it('says nothing when every bill already has a tax invoice or is paid', () => {
    expect(buildYamahaNoticeMessage(notice, [inv({ state: 'has-tv', taxInvoiceNo: 'TV2026-142' })])).toBeNull();
    expect(buildYamahaNoticeMessage(notice, [inv({ state: 'paid' })])).toBeNull();
  });

  it('warns when the mail amount differs from the bills and still lets the owner decide', () => {
    const b = bubbleOf(buildYamahaNoticeMessage({ ...notice, amount: 400_000 }, [inv({})]));
    expect(texts(b)).toContain('ไม่ตรงยอดบิลรวม');
    expect(b.footer!.contents).toHaveLength(1);
  });

  it('gives no button for an unknown bill or a customer not set for before-payment', () => {
    const unknown = bubbleOf(buildYamahaNoticeMessage(notice, [inv({ state: 'not-found', id: null, customerName: '', netTotal: 0 })]));
    expect(unknown.footer).toBeUndefined();
    expect(texts(unknown)).toContain('ไม่พบเลขบิลนี้ในระบบ');
    const notSet = bubbleOf(buildYamahaNoticeMessage(notice, [inv({ beforePaymentAllowed: false })]));
    expect(notSet.footer).toBeUndefined();
    expect(texts(notSet)).toContain('ยังไม่ได้ตั้ง');
  });
});

describe('normalizeMails', () => {
  it('keeps only well-formed messages and caps the batch', () => {
    const ok = { id: 'm1', from: 'a', subject: 's', body: 'b' };
    expect(normalizeMails({ messages: [ok, { id: 'm2' }, null, 'x', { ...ok, id: '' }] })).toEqual([ok]);
    expect(normalizeMails({ messages: Array.from({ length: 50 }, (_, i) => ({ ...ok, id: `m${i}` })) })).toHaveLength(20);
    expect(normalizeMails(null)).toEqual([]);
    expect(normalizeMails({ messages: 'x' })).toEqual([]);
  });
});
