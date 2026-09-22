// สคริปต์ dev: นับแถวในตารางที่เกี่ยวกับข้อมูลรถ (ใช้ก่อน/หลังล้างข้อมูลทดสอบ)
// ใช้: node --env-file=.env scripts/dev-count-vehicle-data.mjs
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const counts = {};
for (const m of ['vehicle','vehicleEditLog','case','taxCalculation','documentSubmission','receiptImage','platePhoto','bookPhoto','vehicleOwner','invoice','invoiceLine','customer','brand','serviceFeeRate','yamahaRelocationEntry','user']) {
  counts[m] = await prisma[m].count();
}
console.table(counts);
await prisma.$disconnect();
