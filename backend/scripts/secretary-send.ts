// ส่งการ์ดสรุปของเลขาเข้าไลน์ส่วนตัวทันที (ผู้ใช้ 2026-10-07) - ใช้ทดสอบ/ส่งมือ
//   npm run secretary:morning   สรุปเช้า
//   npm run secretary:evening   สรุปเย็น
// ใช้ฐานข้อมูลตาม DATABASE_URL ใน backend/.env (ตอนนี้ = dev)
// ไม่ใช้ Nest DI เพราะ tsx ไม่ส่ง decorator metadata - ประกอบ service เองเหมือนที่ Nest ทำ
import 'dotenv/config';
import process from 'node:process';
import { OverviewService } from '../src/overview/overview.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { LineConfigError } from '../src/secretary/line-client.js';
import { NotesService } from '../src/secretary/notes.service.js';
import { SecretaryService } from '../src/secretary/secretary.service.js';

const kind = process.argv[2];
if (kind !== 'morning' && kind !== 'evening') {
  console.error('ใช้: npm run secretary:morning หรือ npm run secretary:evening');
  process.exit(1);
}

const prisma = new PrismaService();
let failed = false;
try {
  await prisma.$connect();
  const secretary = new SecretaryService(new OverviewService(prisma), prisma, new NotesService(prisma));
  if (kind === 'morning') await secretary.sendMorning();
  else await secretary.sendEvening();
  console.log(`ส่งสรุป${kind === 'morning' ? 'เช้า' : 'เย็น'}แล้ว - เปิดไลน์ดูได้เลย`);
} catch (error) {
  failed = true;
  if (error instanceof LineConfigError) {
    console.error(error.message);
  } else {
    console.error('ส่งไม่สำเร็จ:', error instanceof Error ? error.message : error);
  }
} finally {
  await prisma.$disconnect();
}
if (failed) process.exit(1);
