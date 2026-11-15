// อ่านไฟล์รายการเดินบัญชีที่โหลดจาก K BIZ (CSV) แล้วจับคู่ยอดเงินเข้ากับใบวางบิล (ผู้ใช้ 2026-11-16: "ผมชอบลืมออกใบกำกับ")
// ไฟล์ไม่มีชื่อผู้โอน จึงจับคู่จากยอดเงินอย่างเดียว - ผลเป็นแค่ข้อเสนอ คนต้องกดยืนยันก่อนออกใบกำกับทุกครั้ง
// ล้วนเป็นฟังก์ชันบริสุทธิ์ ไม่แตะฐานข้อมูล (ทดสอบใน bank-statement.spec.ts)

export interface Deposit {
  date: string; // YYYY-MM-DD (เวลาไทยตามไฟล์)
  time: string; // HH:MM
  amount: number;
  kind: string; // Transfer Deposit / Cheque Deposit / Automatic Deposit
  channel: string;
}

// บิลเท่าที่การจับคู่ต้องใช้ (ตัวเลขเป็น number แล้ว)
export interface StatementInvoice {
  id: string;
  invoiceNo: string;
  customerId: string;
  customerName: string;
  issueDate: string;
  status: 'ISSUED' | 'PAID';
  paidDate: string | null;
  account: 'COMPANY' | 'PERSONAL';
  hasVat: boolean;
  serviceTotal: number;
  whtAmount: number;
  netTotal: number; // ยอดที่ลูกค้าต้องโอน (หลังหัก ณ ที่จ่ายตามบิล)
  taxInvoiceNo: string | null; // ใบกำกับที่ยังใช้อยู่ (ออกก่อนรับเงิน หรือออกแล้ว)
}

export interface MatchedInvoice {
  invoice: StatementInvoice;
  whtAmount: number; // หัก ณ ที่จ่ายที่ใช้ถ้าออกใบกำกับจากรายการนี้
}

export interface DepositMatch {
  label: string; // ตามบิล / ไม่หัก ณ ที่จ่าย / หัก 1% / 2 ใบรวมกัน
  expected: number;
  diff: number; // เงินเข้า - ยอดที่คาด (ติดลบ = ค่าธรรมเนียมโอน)
  invoices: MatchedInvoice[];
}

export interface DepositResult {
  deposit: Deposit;
  // done = มีบิลที่บันทึกรับเงินวันเดียวกันยอดตรงอยู่แล้ว · matched = มีบิลรอรับเงินที่ยอดตรง · none = ไม่พบ
  state: 'done' | 'matched' | 'none';
  done: StatementInvoice | null;
  matches: DepositMatch[];
}

export class StatementFormatError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100;

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (c === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((v) => v.trim());
}

// รับเฉพาะรูปแบบที่ K BIZ ส่งออก: มีหัวตาราง "Transaction Date" และคอลัมน์ "Deposit (Baht)" วันที่เป็น YYYY-MM-DD HH:MM:SS
export function parseKbizCsv(raw: string): Deposit[] {
  const lines = raw.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const headerIdx = lines.findIndex((l) => l.includes('Transaction Date'));
  if (headerIdx < 0) throw new StatementFormatError('ไม่พบหัวตาราง "Transaction Date" - ต้องเป็นไฟล์ CSV ที่โหลดจาก K BIZ');
  const header = parseCsvLine(lines[headerIdx]);
  // ชื่อตรงก่อน แล้วค่อยชื่อที่มีหน่วยต่อท้าย ("Deposit (Baht)") - ไม่งั้น "Transaction" จะไปตรงกับ "Transaction Date"
  const col = (name: string) => {
    const exact = header.indexOf(name);
    return exact >= 0 ? exact : header.findIndex((h) => h.startsWith(`${name} (`));
  };
  const cDate = col('Transaction Date');
  const cKind = col('Transaction');
  const cDeposit = col('Deposit');
  const cChannel = col('Channel');
  if (cDate < 0 || cDeposit < 0) throw new StatementFormatError('ไม่พบคอลัมน์วันที่หรือยอดเงินเข้า (Deposit) ในไฟล์');

  const deposits: Deposit[] = [];
  for (const line of lines.slice(headerIdx + 1)) {
    const f = parseCsvLine(line);
    const rawAmount = f[cDeposit] ?? '';
    if (!rawAmount) continue;
    const amount = Number(rawAmount.replace(/,/g, ''));
    const [date, time = ''] = (f[cDate] ?? '').split(' ');
    if (!Number.isFinite(amount) || amount <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    deposits.push({ date, time: time.slice(0, 5), amount: round2(amount), kind: f[cKind] ?? '', channel: f[cChannel] ?? '' });
  }
  return deposits.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
}

// เงินเข้าอาจต่ำกว่ายอดที่คาดได้ถึง 10 บาท (ค่าธรรมเนียมโอน 2 / 5 / 8) และสูงกว่าได้ 0.5
export const FEE_TOLERANCE = 10;
export const OVER_TOLERANCE = 0.5;
const MAX_COMBINED = 4;

const within = (deposit: number, expected: number) => deposit <= expected + OVER_TOLERANCE && deposit >= expected - FEE_TOLERANCE;

// ยอดที่ลูกค้าอาจโอนจริงสำหรับบิลหนึ่งใบ: ตามบิล หรือหัก ณ ที่จ่ายอัตราอื่น (ฐาน = ค่าบริการ)
function expectedAmounts(inv: StatementInvoice): Array<{ label: string; amount: number; whtAmount: number }> {
  const gross = round2(inv.netTotal + inv.whtAmount);
  const out = [{ label: 'ตามบิล', amount: inv.netTotal, whtAmount: inv.whtAmount }];
  const alts = [
    { label: 'ไม่หัก ณ ที่จ่าย', rate: 0 },
    { label: 'หัก 1%', rate: 1 },
    { label: 'หัก 3%', rate: 3 },
    { label: 'หัก 5%', rate: 5 },
  ];
  for (const alt of alts) {
    const wht = round2((inv.serviceTotal * alt.rate) / 100);
    const amount = round2(gross - wht);
    if (!out.some((o) => Math.abs(o.amount - amount) < 0.005)) out.push({ label: alt.label, amount, whtAmount: wht });
  }
  return out;
}

export function matchDeposit(deposit: Deposit, invoices: StatementInvoice[]): DepositResult {
  // บันทึกรับเงินไปแล้ว: บิล PAID วันเดียวกับเงินเข้าและยอดตรง
  const done =
    invoices.find((i) => i.status === 'PAID' && i.paidDate === deposit.date && expectedAmounts(i).some((e) => within(deposit.amount, e.amount))) ?? null;
  if (done) return { deposit, state: 'done', done, matches: [] };

  // บิลที่ออกหลังวันเงินเข้าไม่ใช่บิลของยอดนี้
  const open = invoices.filter((i) => i.status === 'ISSUED' && i.issueDate <= deposit.date);
  const matches: DepositMatch[] = [];
  for (const inv of open) {
    for (const e of expectedAmounts(inv)) {
      if (within(deposit.amount, e.amount)) {
        matches.push({ label: e.label, expected: e.amount, diff: round2(deposit.amount - e.amount), invoices: [{ invoice: inv, whtAmount: e.whtAmount }] });
      }
    }
  }

  // หลายบิลของลูกค้าเดียวกันโอนรวมมาก้อนเดียว (2-4 ใบ ยอดตามบิล)
  const byCustomer = new Map<string, StatementInvoice[]>();
  for (const inv of open) byCustomer.set(inv.customerId, [...(byCustomer.get(inv.customerId) ?? []), inv]);
  for (const list of byCustomer.values()) {
    const candidates = list.filter((i) => i.netTotal <= deposit.amount + OVER_TOLERANCE);
    const walk = (start: number, chosen: StatementInvoice[], sum: number) => {
      if (chosen.length >= 2 && within(deposit.amount, sum)) {
        matches.push({
          label: `${chosen.length} ใบรวมกัน`,
          expected: round2(sum),
          diff: round2(deposit.amount - sum),
          invoices: chosen.map((invoice) => ({ invoice, whtAmount: invoice.whtAmount })),
        });
      }
      if (chosen.length >= MAX_COMBINED || sum > deposit.amount + OVER_TOLERANCE) return;
      for (let i = start; i < candidates.length; i++) walk(i + 1, [...chosen, candidates[i]], sum + candidates[i].netTotal);
    };
    walk(0, [], 0);
  }

  // ตรงที่สุดก่อน (ส่วนต่างน้อย, ใบเดียวก่อนหลายใบ)
  matches.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || a.invoices.length - b.invoices.length);
  return { deposit, state: matches.length ? 'matched' : 'none', done: null, matches };
}

export function matchStatement(deposits: Deposit[], invoices: StatementInvoice[]): DepositResult[] {
  return deposits.map((d) => matchDeposit(d, invoices));
}

// สิ่งที่ทำได้กับบิลที่จับคู่ได้: ออกใบกำกับ (บัญชีบริษัท มี VAT ยังไม่มีใบกำกับ) หรือบันทึกรับเงินอย่างเดียว
export function actionFor(invoice: StatementInvoice): 'tax-invoice' | 'mark-paid' {
  return invoice.account === 'COMPANY' && invoice.hasVat && !invoice.taxInvoiceNo ? 'tax-invoice' : 'mark-paid';
}
