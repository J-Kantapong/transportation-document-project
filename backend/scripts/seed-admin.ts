// สร้าง/อัปเดตบัญชี Admin คนแรก (ไม่เปิดให้สมัครเป็น Admin ผ่านหน้าเว็บ) - รันได้ซ้ำ ถ้าอีเมลมีอยู่แล้วจะ
// ตั้งรหัสผ่านใหม่ + เปิดสิทธิ์ ADMIN ให้ ใช้ได้ทั้ง dev และ prod (ตั้ง env แล้วรันครั้งเดียว)
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... ADMIN_NAME="ชื่อ" npx tsx scripts/seed-admin.ts
// หรือใส่ 3 ค่านี้ใน backend/.env แล้วรัน npm run seed:admin
import 'dotenv/config';
import * as process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { hashPassword } from '../src/auth/password.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD ?? '';
const name = process.env.ADMIN_NAME?.trim() || 'ผู้ดูแลระบบ';

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('ต้องตั้ง ADMIN_EMAIL เป็นอีเมลที่ถูกต้อง');
  process.exit(1);
}
if (password.length < 8) {
  console.error('ต้องตั้ง ADMIN_PASSWORD อย่างน้อย 8 ตัวอักษร');
  process.exit(1);
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

try {
  const passwordHash = await hashPassword(password);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, passwordHash, name, roles: ['ADMIN'], status: 'APPROVED', approvedAt: new Date() },
    update: { passwordHash, roles: ['ADMIN'], status: 'APPROVED', approvedAt: new Date() },
    select: { id: true, email: true, name: true },
  });
  console.log(`Admin พร้อมใช้งาน: ${user.email} (${user.name}) id=${user.id}`);
} finally {
  await prisma.$disconnect();
}
