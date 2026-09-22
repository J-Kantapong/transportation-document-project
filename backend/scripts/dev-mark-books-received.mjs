// สคริปต์ทดสอบ (dev เท่านั้น): ตั้งวันที่รับเล่มให้รถที่ระบุ เพื่อให้รถไหลเข้าคิว Delivery/วางบิลได้โดยไม่ต้องถ่ายรูปเล่ม
// ใช้: node --env-file=.env scripts/dev-mark-books-received.mjs <เลขตัวรถ> [<เลขตัวรถ> ...]
// รถที่ตั้งด้วยสคริปต์นี้จะไม่มีรูปเล่มเป็นหลักฐาน (bookPhotoId ว่าง) - ใช้กับข้อมูลทดสอบเท่านั้น
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../dist/generated/prisma/client.js';

const chassis = process.argv.slice(2);
if (chassis.length === 0) {
  console.error('ระบุเลขตัวรถอย่างน้อย 1 คัน');
  process.exit(1);
}
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const result = await prisma.vehicle.updateMany({
  where: { chassis: { in: chassis }, bookReceivedDate: null },
  data: { bookReceivedDate: new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`) },
});
console.log(`ตั้งวันที่รับเล่มแล้ว ${result.count} คัน`);
console.table(
  await prisma.vehicle.findMany({
    where: { chassis: { in: chassis } },
    select: { chassis: true, plateCategory: true, plateNumber: true, bookReceivedDate: true, plateReceivedDate: true },
  }),
);
await prisma.$disconnect();
