// one-off (user 2026-10-26): Lexus Auto City branch + address were wrong. Dry run by default, --apply writes.
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const APPLY = process.argv.includes('--apply');
const TAX = '0105547142882';
const NEW_BRANCH = '00001';
const fixAddr = (a: unknown) => (typeof a === 'string' ? a.replace(/10110\s*$/, '10400') : a);

const customers = await prisma.customer.findMany({ where: { OR: [{ name: { contains: 'เลกซัส' } }, { name: { contains: 'Lexus', mode: 'insensitive' } }, { company: { contains: 'เลกซัส' } }, { taxId: TAX }] } });
console.log('customers:', customers.map((c) => ({ id: c.id, name: c.name, company: c.company, branch: c.branch, address: c.address, taxId: c.taxId })));
const ids = customers.map((c) => c.id);

type Snap = Record<string, unknown>;
const changeOf = (s: Snap) => ({ ...s, branch: NEW_BRANCH, address: fixAddr(s.address) });
const isLexus = (s: Snap, cid: string | null) => (cid && ids.includes(cid)) || String(s?.taxId ?? '').replace(/\D/g, '') === TAX;

const tables = [
  { name: 'Invoice', rows: await prisma.invoice.findMany({ select: { id: true, invoiceNo: true, customerId: true, customerSnapshot: true } }), no: (r: any) => r.invoiceNo },
  { name: 'TaxInvoice', rows: await prisma.taxInvoice.findMany({ select: { id: true, taxInvoiceNo: true, customerId: true, customerSnapshot: true } }), no: (r: any) => r.taxInvoiceNo },
  { name: 'Quotation', rows: await prisma.quotation.findMany({ select: { id: true, quotationNo: true, customerId: true, customerSnapshot: true } }), no: (r: any) => r.quotationNo },
] as const;

const plan: { table: string; id: string; no: string; before: Snap; after: Snap }[] = [];
for (const t of tables) for (const r of t.rows as any[]) {
  const s = r.customerSnapshot as Snap;
  if (!isLexus(s, r.customerId)) continue;
  const after = changeOf(s);
  if (JSON.stringify(after) === JSON.stringify(s)) continue;
  plan.push({ table: t.name, id: r.id, no: String(t.no(r)), before: s, after });
}
for (const p of plan) console.log(p.table, p.no, '| branch', JSON.stringify(p.before.branch), '->', JSON.stringify(p.after.branch), '| address', JSON.stringify(p.before.address), '->', JSON.stringify(p.after.address));
console.log('rows to change:', plan.length, plan.reduce((m: Record<string, number>, p) => ((m[p.table] = (m[p.table] ?? 0) + 1), m), {}));

if (APPLY) {
  const remark = 'กรณีพิเศษ ลูกค้าแจ้งข้อมูลผิด: แก้สาขาเป็น 00001 และรหัสไปรษณีย์เป็น 10400 (สคริปต์ 2026-10-26)';
  await prisma.$transaction(async (tx) => {
    for (const c of customers) {
      const to = { branch: NEW_BRANCH, address: fixAddr(c.address) as string | null };
      await tx.customer.update({ where: { id: c.id }, data: to, select: { id: true } });
      await tx.auditLog.create({ data: { entity: 'Customer', entityId: c.id, action: 'update', remark, changes: { branch: { from: c.branch, to: to.branch }, address: { from: c.address, to: to.address } } } });
    }
    for (const p of plan) {
      const data = { customerSnapshot: p.after as any };
      if (p.table === 'Invoice') await tx.invoice.update({ where: { id: p.id }, data, select: { id: true } });
      else if (p.table === 'TaxInvoice') await tx.taxInvoice.update({ where: { id: p.id }, data, select: { id: true } });
      else await tx.quotation.update({ where: { id: p.id }, data, select: { id: true } });
      await tx.auditLog.create({ data: { entity: p.table, entityId: p.id, action: 'update-customer-snapshot', remark, changes: { branch: { from: p.before.branch, to: p.after.branch }, address: { from: p.before.address, to: p.after.address } } } });
    }
  });
  console.log('APPLIED');
} else console.log('DRY RUN only');
await prisma.$disconnect();
