import { describe, expect, it } from 'vitest';
import { actionFor, matchDeposit, matchStatement, parseKbizCsv, StatementFormatError, type Deposit, type StatementInvoice } from './bank-statement.js';
import { createPrintToken, verifyPrintToken } from './print-link.js';
import { buildStatementMessages, parseStatementPostback, postbackData } from './statement-message.js';

// รูปแบบเดียวกับไฟล์ที่โหลดจาก K BIZ (ยอดและบิลเป็นข้อมูลสมมติ)
const CSV = [
  '"Account number : 0000000000"',
  '"From Date : 01/11/2026"',
  '"To Date : 16/11/2026"',
  '"Transaction Date","Transaction","Withdrawal (Baht)","Deposit (Baht)","Account/PromptPay or Biller","Channel"',
  '"2026-11-15 15:46:13","Transfer Withdrawal","-30,000.00","","Kasikorn bank account","K BIZ"',
  '"2026-11-13 09:30:45","Transfer Deposit","","21,437.00","Other bank account/Other Info","K-Cash Connect Plus"',
  '"2026-11-02 07:37:06","Transfer Deposit","","106,420.00","Kasikorn bank account","K BIZ"',
  '',
].join('\r\n');

const invoice = (over: Partial<StatementInvoice>): StatementInvoice => ({
  id: 'inv1',
  invoiceNo: 'IV2026-900',
  customerId: 'c1',
  customerName: 'ลูกค้า ก',
  issueDate: '2026-10-26',
  status: 'ISSUED',
  paidDate: null,
  account: 'COMPANY',
  hasVat: true,
  serviceTotal: 70_625,
  whtAmount: 2_118.75,
  netTotal: 106_420,
  taxInvoiceNo: null,
  ...over,
});
const deposit = (amount: number, date = '2026-11-02'): Deposit => ({ date, time: '07:37', amount, kind: 'Transfer Deposit', channel: 'K BIZ' });

describe('parseKbizCsv', () => {
  it('reads only deposits, oldest first, with amounts as numbers', () => {
    expect(parseKbizCsv(CSV)).toEqual([
      { date: '2026-11-02', time: '07:37', amount: 106_420, kind: 'Transfer Deposit', channel: 'K BIZ' },
      { date: '2026-11-13', time: '09:30', amount: 21_437, kind: 'Transfer Deposit', channel: 'K-Cash Connect Plus' },
    ]);
  });

  it('accepts a BOM and refuses a file that is not a K BIZ statement', () => {
    expect(parseKbizCsv(`﻿${CSV}`)).toHaveLength(2);
    expect(() => parseKbizCsv('a,b,c\n1,2,3')).toThrow(StatementFormatError);
  });
});

describe('matchDeposit', () => {
  it('matches the bill amount exactly and keeps the bill WHT', () => {
    const r = matchDeposit(deposit(106_420), [invoice({})]);
    expect(r.state).toBe('matched');
    expect(r.matches[0]).toMatchObject({ label: 'ตามบิล', diff: 0 });
    expect(r.matches[0].invoices[0].whtAmount).toBe(2_118.75);
  });

  it('allows a transfer fee of up to 10 baht but not more', () => {
    expect(matchDeposit(deposit(106_412), [invoice({})]).matches[0].diff).toBe(-8);
    expect(matchDeposit(deposit(106_405), [invoice({})]).state).toBe('none');
    expect(matchDeposit(deposit(106_421), [invoice({})]).state).toBe('none');
  });

  it('recognises a customer who did not withhold tax and sets WHT to 0', () => {
    const r = matchDeposit(deposit(108_538.75), [invoice({})]);
    expect(r.matches[0].label).toBe('ไม่หัก ณ ที่จ่าย');
    expect(r.matches[0].invoices[0].whtAmount).toBe(0);
  });

  it('finds several bills of one customer paid in one transfer, never across customers', () => {
    const a = invoice({ id: 'a', invoiceNo: 'PB-1', netTotal: 5_990, whtAmount: 0, serviceTotal: 0 });
    const b = invoice({ id: 'b', invoiceNo: 'PB-2', netTotal: 515, whtAmount: 0, serviceTotal: 0 });
    const other = invoice({ id: 'x', customerId: 'c2', netTotal: 515, whtAmount: 0, serviceTotal: 0 });
    const r = matchDeposit(deposit(6_501), [a, b]);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].label).toBe('2 ใบรวมกัน');
    expect(matchDeposit(deposit(6_501), [a, other]).state).toBe('none');
  });

  it('ignores a bill issued after the money came in', () => {
    expect(matchDeposit(deposit(106_420), [invoice({ issueDate: '2026-11-03' })]).state).toBe('none');
  });

  it('reports a deposit already recorded as paid on that day', () => {
    const paid = invoice({ status: 'PAID', paidDate: '2026-11-02', taxInvoiceNo: 'TV2026-150' });
    const r = matchDeposit(deposit(106_420), [paid]);
    expect(r.state).toBe('done');
    expect(r.done?.taxInvoiceNo).toBe('TV2026-150');
    // PAID วันอื่นไม่นับ และไม่ถูกเสนอให้ออกซ้ำ
    expect(matchDeposit(deposit(106_420, '2026-11-05'), [paid]).state).toBe('none');
  });

  it('puts the closest match first when several bills fit', () => {
    const exact = invoice({ id: 'exact', netTotal: 6_501, whtAmount: 0, serviceTotal: 0 });
    const withFee = invoice({ id: 'fee', netTotal: 6_503, whtAmount: 0, serviceTotal: 0 });
    const r = matchDeposit(deposit(6_501), [withFee, exact]);
    expect(r.matches.map((m) => m.invoices[0].invoice.id)).toEqual(['exact', 'fee']);
  });
});

describe('actionFor', () => {
  it('issues a tax invoice only for a company VAT bill without one', () => {
    expect(actionFor(invoice({}))).toBe('tax-invoice');
    expect(actionFor(invoice({ taxInvoiceNo: 'TV2026-142' }))).toBe('mark-paid');
    expect(actionFor(invoice({ account: 'PERSONAL', hasVat: false }))).toBe('mark-paid');
  });
});

describe('statement messages', () => {
  it('summarises every deposit and gives one card per deposit that needs action', () => {
    const results = matchStatement(parseKbizCsv(CSV), [invoice({})]);
    const messages = buildStatementMessages(results);
    expect(messages[0]).toMatchObject({ type: 'text' });
    expect((messages[0] as { text: string }).text).toContain('ต้องทำ 1 รายการ');
    expect((messages[0] as { text: string }).text).toContain('ไม่พบบิลที่ยอดตรง 1 รายการ');
    const carousel = (messages[1] as unknown as { contents: { contents: Array<{ footer: { contents: Array<{ action: { data: string; label: string } }> } }> } }).contents;
    expect(carousel.contents).toHaveLength(1);
    const button = carousel.contents[0].footer.contents[0].action;
    expect(button.label.length).toBeLessThanOrEqual(20);
    expect(parseStatementPostback(button.data)).toEqual({ action: 'tv', invoiceId: 'inv1', date: '2026-11-02', whtAmount: 2_118.75 });
  });

  it('answers an empty statement plainly', () => {
    expect(buildStatementMessages([])).toEqual([{ type: 'text', text: 'ไฟล์นี้ไม่มีรายการเงินเข้า' }]);
  });

  it('round-trips postback data and rejects anything else', () => {
    const p = { action: 'tvgo' as const, invoiceId: 'abc', date: '2026-11-02', whtAmount: 12.5 };
    expect(parseStatementPostback(postbackData(p))).toEqual(p);
    expect(parseStatementPostback('tro:car')).toBeNull();
    expect(parseStatementPostback('st|delete|abc|2026-11-02|0')).toBeNull();
    expect(parseStatementPostback('st|tv|abc|02/11/2026|0')).toBeNull();
    expect(parseStatementPostback('st|tv|abc|2026-11-02|-1')).toBeNull();
    expect(parseStatementPostback(undefined)).toBeNull();
  });
});

describe('print link token', () => {
  const secret = 'test-secret-value';
  const now = Date.UTC(2026, 10, 16);

  it('returns the id while valid and nothing after it expires', () => {
    const token = createPrintToken('tv123', secret, now);
    expect(verifyPrintToken(token, secret, now)).toBe('tv123');
    expect(verifyPrintToken(token, secret, now + 6 * 86_400_000)).toBe('tv123');
    expect(verifyPrintToken(token, secret, now + 8 * 86_400_000)).toBeNull();
  });

  it('rejects a changed id, another secret, or a malformed token', () => {
    const token = createPrintToken('tv123', secret, now);
    const [, signature] = token.split('.');
    const forged = `${Buffer.from('tv999.9999999999').toString('base64url')}.${signature}`;
    expect(verifyPrintToken(forged, secret, now)).toBeNull();
    expect(verifyPrintToken(token, 'other-secret', now)).toBeNull();
    expect(verifyPrintToken('', secret, now)).toBeNull();
    expect(verifyPrintToken(undefined, secret, now)).toBeNull();
    expect(verifyPrintToken(token, '', now)).toBeNull();
  });
});
