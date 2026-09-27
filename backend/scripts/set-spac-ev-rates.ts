// one-off: set Spac EV's ServiceFeeRate rows (user-quoted prices, VAT-inclusive round numbers per user 2026-09-28)
// npx tsx scripts/set-spac-ev-rates.ts
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const customer = await prisma.customer.findFirst({ where: { name: 'Spac EV' } });
if (!customer) throw new Error('Spac EV customer not found');

const existing = await prisma.serviceFeeRate.findMany({ where: { customerId: customer.id } });
console.log(`existing rates for ${customer.name} (${customer.id}):`, existing.length);

const rows = [
  { label: 'จดทะเบียนรถใหม่', vehicleKind: 'ANY', amount: 1045, vatInclusive: true, kind: 'BASE', sortOrder: 0 },
  { label: 'ค่าเพิ่ม: ขอใช้ (จดจังหวัดอื่น)', vehicleKind: 'ANY', amount: 75, vatInclusive: true, kind: 'OTHER_PROVINCE', sortOrder: 1 },
  { label: 'ค่าเพิ่ม: ขอใช้เลขทะเบียน', vehicleKind: 'ANY', amount: 105, vatInclusive: true, kind: 'PLATE_REQUEST', sortOrder: 2 },
  { label: 'ค่าเพิ่ม: แจ้งย้าย', vehicleKind: 'ANY', amount: 195, vatInclusive: true, kind: 'TRANSFER_NOTICE', sortOrder: 3 },
];

await prisma.$transaction([
  prisma.serviceFeeRate.deleteMany({ where: { customerId: customer.id } }),
  prisma.serviceFeeRate.createMany({ data: rows.map((r) => ({ ...r, customerId: customer.id })) }),
]);

const saved = await prisma.serviceFeeRate.findMany({ where: { customerId: customer.id }, orderBy: { sortOrder: 'asc' } });
console.log(
  'saved rates:',
  saved.map((r) => ({ label: r.label, kind: r.kind, amount: r.amount.toString(), vatInclusive: r.vatInclusive })),
);

await prisma.$disconnect();
