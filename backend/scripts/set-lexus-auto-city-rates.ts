// one-off: set Lexus Auto City's ServiceFeeRate rows (user-quoted prices, before VAT, user 2026-10-05)
// npx tsx scripts/set-lexus-auto-city-rates.ts            (refuses to run if the customer already has rates)
// npx tsx scripts/set-lexus-auto-city-rates.ts --replace  (deletes the customer's existing rates first)
// Not stored (billing has no rate kind for them yet): ต่อภาษี 100, คัดป้ายแดง/เล่มป้ายแดง 495, โอน รย.1 2,500
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const matches = await prisma.customer.findMany({ where: { name: { contains: 'Lexus', mode: 'insensitive' } } });
console.log('customers matching "Lexus":', matches.map((c) => `${c.name} (${c.id})`));
if (matches.length !== 1) throw new Error('expected exactly one Lexus customer, found ' + matches.length);
const customer = matches[0];

const existing = await prisma.serviceFeeRate.findMany({ where: { customerId: customer.id } });
console.log(`existing rates for ${customer.name}:`, existing.length);
if (existing.length > 0 && !process.argv.includes('--replace')) throw new Error('customer already has rates, pass --replace to overwrite');

const rows = [
  { label: 'จดทะเบียนรถใหม่', vehicleKind: 'ANY', amount: 1200, vatInclusive: false, kind: 'BASE', sortOrder: 0 },
  { label: 'ค่าเพิ่ม: ขอใช้ (จดจังหวัดอื่น)', vehicleKind: 'ANY', amount: 75, vatInclusive: false, kind: 'OTHER_PROVINCE', sortOrder: 1 },
  { label: 'ค่าเพิ่ม: แจ้งย้าย', vehicleKind: 'ANY', amount: 95, vatInclusive: false, kind: 'TRANSFER_NOTICE', sortOrder: 2 },
  { label: 'ค่าเพิ่ม: สลับเลข', vehicleKind: 'CAR', amount: 1220, vatInclusive: false, kind: 'PLATE_SWAP', sortOrder: 3 },
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
