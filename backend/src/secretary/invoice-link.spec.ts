import { describe, expect, it } from 'vitest';
import { accessFor } from '../auth/access-policy.js';
import { buildInvoiceLinkMessages, buildTaxInvoiceLinkMessages, documentDownloadUrl, invoiceDownloadUrl, parseInvoiceLinkCommand, type InvoiceLinkRow, type TaxInvoiceLinkRow } from './invoice-link.js';
import { parseNoteCommand } from './notes.js';
import { createPrintToken, verifyPrintToken } from './print-link.js';

describe('parseInvoiceLinkCommand', () => {
  it('reads "latest" with a default of 2 and a cap of 5', () => {
    expect(parseInvoiceLinkCommand('บิลล่าสุด')).toEqual({ doc: 'iv', kind: 'latest', count: 2 });
    expect(parseInvoiceLinkCommand('ใบวางบิลที่ออกล่าสุด 2 อัน')).toEqual({ doc: 'iv', kind: 'latest', count: 2 });
    expect(parseInvoiceLinkCommand('ขอบิลล่าสุด 3 ใบ')).toEqual({ doc: 'iv', kind: 'latest', count: 3 });
    expect(parseInvoiceLinkCommand('บิลล่าสุด 20')).toEqual({ doc: 'iv', kind: 'latest', count: 5 });
    expect(parseInvoiceLinkCommand('บิลล่าสุด 0')).toEqual({ doc: 'iv', kind: 'latest', count: 1 });
  });

  it('reads invoice numbers, without duplicates', () => {
    expect(parseInvoiceLinkCommand('บิล iv2026-155')).toEqual({ doc: 'iv', kind: 'numbers', numbers: ['IV2026-155'] });
    expect(parseInvoiceLinkCommand('IV2026-155, IV2026-156 และ IV2026-155')).toEqual({ doc: 'iv', kind: 'numbers', numbers: ['IV2026-155', 'IV2026-156'] });
  });

  it('leaves other messages to the other commands', () => {
    expect(parseInvoiceLinkCommand('ค้างจ่าย')).toBeNull();
    expect(parseInvoiceLinkCommand('การเงินค้าง')).toBeNull();
    expect(parseInvoiceLinkCommand('บิล')).toBeNull();
    expect(parseInvoiceLinkCommand('จำ บิลยามาฮ่า = IV2026-155')).toBeNull();
    expect(parseInvoiceLinkCommand('ขอ ที่อยู่')).toBeNull();
    expect(parseNoteCommand('ขอ ที่อยู่')).toEqual({ type: 'get', query: 'ที่อยู่' });
  });
});

const row = (over: Partial<InvoiceLinkRow> = {}): InvoiceLinkRow => ({ invoiceNo: 'IV2026-155', customerName: 'ลูกค้า ก', issueDate: '2026-11-16', netTotal: 12_345.5, status: 'ISSUED', url: 'https://app.example/iv?token=t', ...over });
const textsOf = (messages: ReturnType<typeof buildInvoiceLinkMessages>) => messages.map((m) => (m as { text: string }).text);

describe('buildInvoiceLinkMessages', () => {
  it('sends one forwardable text per invoice', () => {
    const t = textsOf(buildInvoiceLinkMessages([row(), row({ invoiceNo: 'IV2026-154', status: 'PAID' })]));
    expect(t).toHaveLength(2);
    expect(t[0]).toContain('ใบวางบิล IV2026-155 ลูกค้า ก');
    expect(t[0]).toContain('วันที่ 16/11/2026 · ยอดสุทธิ 12,345.50 บาท');
    expect(t[0]).toContain('https://app.example/iv?token=t');
    expect(t[1]).toContain('รับเงินแล้ว');
  });

  it('reports unknown numbers and never exceeds 5 messages', () => {
    expect(textsOf(buildInvoiceLinkMessages([], ['IV2026-999']))).toEqual(['ไม่พบเลขบิล: IV2026-999']);
    const five = Array.from({ length: 5 }, (_, i) => row({ invoiceNo: `IV2026-10${i}` }));
    const t = textsOf(buildInvoiceLinkMessages(five, ['IV2026-999']));
    expect(t).toHaveLength(5);
    expect(t[4]).toContain('ไม่พบเลขบิล: IV2026-999');
    expect(textsOf(buildInvoiceLinkMessages([]))).toEqual(['ยังไม่มีใบวางบิลในระบบ']);
  });

  it('builds a download url that opens the device browser', () => {
    expect(invoiceDownloadUrl('https://app.example', 'a.b')).toBe('https://app.example/iv?token=a.b&download=1&openExternalBrowser=1');
  });
});

describe('print token kinds', () => {
  const secret = 'test-secret';
  const now = Date.UTC(2026, 10, 16);
  it('keeps invoice and tax invoice links apart', () => {
    const iv = createPrintToken('inv1', secret, now, 7, 'iv');
    const tv = createPrintToken('tv1', secret, now);
    expect(verifyPrintToken(iv, secret, now, 'iv')).toBe('inv1');
    expect(verifyPrintToken(tv, secret, now)).toBe('tv1');
    expect(verifyPrintToken(iv, secret, now)).toBeNull(); // ลิงก์ใบวางบิลเปิดใบกำกับไม่ได้
    expect(verifyPrintToken(tv, secret, now, 'iv')).toBeNull(); // ลิงก์ใบกำกับเปิดใบวางบิลไม่ได้
    expect(verifyPrintToken(iv, secret, now + 8 * 86_400_000, 'iv')).toBeNull();
    expect(verifyPrintToken(createPrintToken('', secret, now, 7, 'iv'), secret, now, 'iv')).toBeNull();
  });

  it('opens only the exact invoice route to the public', () => {
    expect(accessFor('/api/secretary/invoice', 'GET')).toBe('PUBLIC');
    expect(accessFor('/api/secretary/invoice/x', 'GET')).toEqual(['ADMIN']);
    expect(accessFor('/api/secretary/invoices', 'GET')).toEqual(['ADMIN']);
  });
});

describe('tax invoice links', () => {
  it('reads the tax invoice commands and keeps them apart from bills', () => {
    expect(parseInvoiceLinkCommand('ใบกำกับล่าสุด')).toEqual({ doc: 'tv', kind: 'latest', count: 2 });
    expect(parseInvoiceLinkCommand('ขอใบกำกับภาษีล่าสุด 3 ใบ')).toEqual({ doc: 'tv', kind: 'latest', count: 3 });
    expect(parseInvoiceLinkCommand('ใบกำกับ tv2026-146')).toEqual({ doc: 'tv', kind: 'numbers', numbers: ['TV2026-146'] });
    expect(parseInvoiceLinkCommand('TV2026-145 TV2026-146')).toEqual({ doc: 'tv', kind: 'numbers', numbers: ['TV2026-145', 'TV2026-146'] });
    expect(parseInvoiceLinkCommand('บิลล่าสุด')).toEqual({ doc: 'iv', kind: 'latest', count: 2 });
    expect(parseInvoiceLinkCommand('TV2026-146 IV2026-155')).toBeNull(); // เลขสองชนิดปนกัน - ไม่เดา
    expect(parseInvoiceLinkCommand('ใบกำกับ')).toBeNull();
  });

  const tv = (over: Partial<TaxInvoiceLinkRow> = {}): TaxInvoiceLinkRow => ({
    taxInvoiceNo: 'TV2026-146',
    invoiceNo: 'IV2026-159',
    customerName: 'ลูกค้า ก',
    issueDate: '2026-11-16',
    vatRate: 7,
    feeTotal: 26_580,
    serviceTotal: 55_860,
    goodsTotal: 0,
    vatAmount: 3_910.2,
    grandTotal: 86_350.2,
    whtAmount: 1_675.8,
    receivedAmount: 84_674.4,
    beforePayment: false,
    status: 'ISSUED',
    url: 'https://app.example/tv?token=t',
    ...over,
  });

  it('lists the amounts, VAT and withholding tax of each tax invoice', () => {
    const [t] = textsOf(buildTaxInvoiceLinkMessages([tv()]));
    expect(t.split('\n')).toEqual([
      'ใบกำกับภาษี TV2026-146 ลูกค้า ก',
      'วันที่ 16/11/2026 · บิล IV2026-159',
      '',
      'ค่าธรรมเนียม 26,580.00',
      'ค่าบริการ 55,860.00',
      'VAT 7% 3,910.20',
      'รวมทั้งสิ้น 86,350.20',
      'หัก ณ ที่จ่าย 3% 1,675.80',
      'ยอดรวม 84,674.40 บาท',
      '',
      'ดาวน์โหลด PDF: https://app.example/tv?token=t',
      '(ลิงก์ใช้ได้ 7 วัน)',
    ]);
    // e-WHT 1% และใบที่ไม่มีค่าบริการ (ไม่มีฐานให้คิด %)
    expect(textsOf(buildTaxInvoiceLinkMessages([tv({ whtAmount: 558.6, receivedAmount: 85_791.6 })]))[0]).toContain('หัก ณ ที่จ่าย 1% 558.60');
    expect(textsOf(buildTaxInvoiceLinkMessages([tv({ serviceTotal: 0, whtAmount: 50 })]))[0]).toContain('หัก ณ ที่จ่าย 50.00');
  });

  it('marks no withholding, before-payment, cancelled and custom tax invoices', () => {
    const [t] = textsOf(buildTaxInvoiceLinkMessages([tv({ whtAmount: 0, receivedAmount: 86_350.2, beforePayment: true, invoiceNo: null, feeTotal: 0, goodsTotal: 100, status: 'CANCELLED' })]));
    expect(t).toContain('วันที่ 16/11/2026 · ออกก่อนรับเงิน · ยกเลิกแล้ว');
    expect(t).toContain('หัก ณ ที่จ่าย ไม่มี');
    expect(t).toContain('ยอดรวม 86,350.20 บาท');
    expect(t).toContain('ค่าสินค้า 100.00');
    expect(t).not.toContain('ค่าธรรมเนียม');
    expect(textsOf(buildTaxInvoiceLinkMessages([], ['TV2026-999']))).toEqual(['ไม่พบเลขใบกำกับ: TV2026-999']);
    expect(textsOf(buildTaxInvoiceLinkMessages([]))).toEqual(['ยังไม่มีใบกำกับภาษีในระบบ']);
    expect(documentDownloadUrl('https://app.example', 'tv', 'a.b')).toBe('https://app.example/tv?token=a.b&download=1&openExternalBrowser=1');
  });
});
