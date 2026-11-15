// Read-only: จับคู่ยอดเงินเข้าใน statement K BIZ (CSV) กับใบวางบิลในระบบ เพื่อดูว่าบิลไหนได้เงินแล้วแต่ยังไม่ออกใบกำกับภาษี (TV)
//   npx tsx scripts/match-bank-statement.ts "<path>.csv"          -> ฐานข้อมูลตาม DATABASE_URL ใน .env (dev)
//   npx tsx scripts/match-bank-statement.ts "<path>.csv" --prod   -> ใช้บรรทัด #DATABASE_URL= (production) ใน .env
// ไม่เขียนอะไรลงฐานข้อมูล
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const args = process.argv.slice(2);
const csvPath = args.find((a) => !a.startsWith('--'));
if (!csvPath) throw new Error('ใส่ path ของไฟล์ CSV เป็น argument แรก');

let connectionString = process.env.DATABASE_URL;
if (args.includes('--prod')) {
  const env = readFileSync(new URL('../.env', import.meta.url), 'utf8');
  const line = env.split(/\r?\n/).find((l) => /^#\s*DATABASE_URL=/.test(l));
  if (!line) throw new Error('ไม่พบบรรทัด #DATABASE_URL= (production) ใน backend/.env');
  connectionString = line.replace(/^#\s*DATABASE_URL=/, '').trim().replace(/^"|"$/g, '');
}
const host = connectionString?.match(/@([^/]+)\//)?.[1] ?? '?';
console.log(`ฐานข้อมูล: ${host}${args.includes('--prod') ? ' (production)' : ' (ตาม .env)'}`);

// ---------- CSV ----------
type Deposit = { date: string; time: string; kind: string; amount: number; channel: string };
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === ',' && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}
const toNum = (s: string) => Number(s.replace(/,/g, '').trim());
const raw = readFileSync(csvPath, 'utf8').replace(/^﻿/, '');
const lines = raw.split(/\r?\n/).filter((l) => l.trim());
const headerIdx = lines.findIndex((l) => l.includes('Transaction Date'));
if (headerIdx < 0) throw new Error('ไม่พบหัวตาราง "Transaction Date" ใน CSV');
const header = parseCsvLine(lines[headerIdx]).map((h) => h.trim());
const col = (name: string) => { const i = header.indexOf(name); return i >= 0 ? i : header.findIndex((h) => h.startsWith(name + ' ')); };
const cDate = col('Transaction Date'), cKind = col('Transaction'), cDep = col('Deposit'), cCh = col('Channel');
const deposits: Deposit[] = [];
for (const l of lines.slice(headerIdx + 1)) {
  const f = parseCsvLine(l);
  const dep = f[cDep]?.trim();
  if (!dep) continue;
  const [date, time = ''] = f[cDate].trim().split(' ');
  deposits.push({ date, time: time.slice(0, 5), kind: f[cKind], amount: toNum(dep), channel: f[cCh] });
}
deposits.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
console.log(`เงินเข้าใน statement: ${deposits.length} รายการ รวม ${fmt(deposits.reduce((s, d) => s + d.amount, 0))}\n`);

// ---------- invoices ----------
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const since = new Date();
since.setMonth(since.getMonth() - 8);
const invoices = await prisma.invoice.findMany({
  where: { status: { in: ['ISSUED', 'PAID'] }, issueDate: { gte: since } },
  select: {
    id: true, invoiceNo: true, issueDate: true, status: true, paidDate: true, account: true,
    vatRate: true, whtRate: true, feeTotal: true, serviceTotal: true, goodsTotal: true, vatAmount: true, whtAmount: true, netTotal: true,
    taxInvoiceNo: true, customer: { select: { name: true } },
    taxInvoices: { where: { status: 'ISSUED' }, select: { taxInvoiceNo: true, issueDate: true, receivedAmount: true, beforePayment: true } },
  },
  orderBy: { issueDate: 'asc' },
});
await prisma.$disconnect();

type Inv = (typeof invoices)[number];
const n = (d: unknown) => Number(d);
const d8 = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '-');
function fmt(x: number) { return x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function tvOf(inv: Inv) { return inv.taxInvoices[0]?.taxInvoiceNo ?? inv.taxInvoiceNo ?? null; }
function describe(inv: Inv) {
  const tv = tvOf(inv);
  const money = `net ${fmt(n(inv.netTotal))} (ก่อนหัก ${fmt(n(inv.netTotal) + n(inv.whtAmount))}, หัก ณ ที่จ่าย ${fmt(n(inv.whtAmount))})`;
  const state = inv.status === 'PAID' ? `PAID ${d8(inv.paidDate)}` : 'ISSUED';
  const tvText = tv ? `TV ${tv}${inv.taxInvoices[0]?.beforePayment ? ' (ออกก่อนรับเงิน)' : ''}` : 'ยังไม่มี TV';
  return `${inv.invoiceNo} ${inv.customer.name} [${inv.account}${n(inv.vatRate) > 0 ? ' VAT' : ''}] ออก ${d8(inv.issueDate)} ${money} ${state} ${tvText}`;
}

// ยอดที่คาดว่าจะเข้าบัญชีจากบิล 1 ใบ: ตามบิล / ไม่หัก ณ ที่จ่าย / หัก 1% (e-WHT) / หัก 3% / หัก 5%
function expectedAmounts(inv: Inv): { label: string; amount: number }[] {
  const gross = n(inv.netTotal) + n(inv.whtAmount);
  const base = n(inv.serviceTotal); // ฐานหัก ณ ที่จ่าย = ค่าบริการ
  const out = [{ label: 'ตามบิล', amount: n(inv.netTotal) }];
  const alts = [
    { label: 'ไม่หัก ณ ที่จ่าย', amount: gross },
    { label: 'หัก 1%', amount: gross - Math.round(base) / 100 },
    { label: 'หัก 3%', amount: gross - Math.round(base * 3) / 100 },
    { label: 'หัก 5%', amount: gross - Math.round(base * 5) / 100 },
  ];
  for (const a of alts) if (!out.some((o) => Math.abs(o.amount - a.amount) < 0.005)) out.push(a);
  return out;
}
// เงินเข้าอาจต่ำกว่ายอดบิลได้ถึง 10 บาท (ค่าธรรมเนียมโอน 2 / 5 / 8) และสูงกว่าได้ 0.5
const FEE_TOLERANCE = 10, OVER_TOLERANCE = 0.5;
const within = (deposit: number, expected: number) => deposit <= expected + OVER_TOLERANCE && deposit >= expected - FEE_TOLERANCE;

type Match = { invs: Inv[]; label: string; expected: number };
function findMatches(dep: Deposit): Match[] {
  const out: Match[] = [];
  for (const inv of invoices) for (const e of expectedAmounts(inv)) if (within(dep.amount, e.amount)) out.push({ invs: [inv], label: e.label, expected: e.amount });
  // บิลหลายใบของลูกค้าเดียวกัน (2-4 ใบ, ยอดตามบิล) โอนรวมมาก้อนเดียว
  const byCustomer = new Map<string, Inv[]>();
  for (const inv of invoices) byCustomer.set(inv.customer.name, [...(byCustomer.get(inv.customer.name) ?? []), inv]);
  for (const list of byCustomer.values()) {
    const cand = list.filter((i) => n(i.netTotal) <= dep.amount + OVER_TOLERANCE);
    const rec = (start: number, chosen: Inv[], sum: number) => {
      if (chosen.length >= 2 && within(dep.amount, sum)) out.push({ invs: [...chosen], label: `${chosen.length} ใบรวมกัน`, expected: sum });
      if (chosen.length >= 4 || sum > dep.amount + OVER_TOLERANCE) return;
      for (let i = start; i < cand.length; i++) rec(i + 1, [...chosen, cand[i]], sum + n(cand[i].netTotal));
    };
    rec(0, [], 0);
  }
  return out;
}

const matchedInvoiceIds = new Set<string>();
console.log('===== เงินเข้าแต่ละรายการ =====');
for (const dep of deposits) {
  console.log(`\n${dep.date} ${dep.time}  +${fmt(dep.amount)}  ${dep.kind} / ${dep.channel}`);
  const matches = findMatches(dep);
  if (!matches.length) { console.log('   ✗ ไม่พบบิลที่ยอดตรง'); continue; }
  for (const m of matches) {
    const diff = dep.amount - m.expected;
    const diffText = Math.abs(diff) < 0.005 ? 'ตรงเป๊ะ' : `ต่าง ${diff > 0 ? '+' : ''}${fmt(diff)}`;
    console.log(`   ✓ ${m.label} (${diffText})`);
    for (const inv of m.invs) { console.log(`       ${describe(inv)}`); matchedInvoiceIds.add(inv.id); }
  }
}

console.log('\n===== สรุป: บิลที่น่าจะได้เงินแล้ว (ตาม statement) แต่ยังไม่มี TV =====');
const needTv = invoices.filter((i) => matchedInvoiceIds.has(i.id) && !tvOf(i));
for (const i of needTv) console.log(' - ' + describe(i));
if (!needTv.length) console.log(' (ไม่มี)');

console.log('\n===== บิลสถานะ PAID แต่ไม่มี TV (ทุกใบในช่วง 8 เดือน) =====');
const paidNoTv = invoices.filter((i) => i.status === 'PAID' && !tvOf(i));
for (const i of paidNoTv) console.log(' - ' + describe(i));
if (!paidNoTv.length) console.log(' (ไม่มี)');

console.log('\n===== บิล ISSUED (ยังไม่บันทึกรับเงิน) ที่ไม่พบยอดเข้าใน statement นี้ =====');
const open = invoices.filter((i) => i.status === 'ISSUED' && !matchedInvoiceIds.has(i.id));
for (const i of open) console.log(' - ' + describe(i));
if (!open.length) console.log(' (ไม่มี)');
