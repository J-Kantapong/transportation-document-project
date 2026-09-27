// สร้างบัญชี Admin คนแรก (ไม่เปิดให้สมัครเป็น Admin ผ่านหน้าเว็บ) หรือตั้งรหัสผ่านใหม่ให้ Admin ที่ลืมรหัส - รันซ้ำได้
// ใช้ได้ทั้ง dev และ prod (ตั้ง env แล้วรันครั้งเดียว)
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... ADMIN_NAME="ชื่อ" npx tsx scripts/seed-admin.ts
// หรือใส่ 3 ค่านี้ใน backend/.env แล้วรัน npm run seed:admin
// - อีเมลยังไม่มีบัญชี: สร้าง Admin ใหม่ (อนุมัติแล้ว)
// - อีเมลเป็น Admin อยู่แล้ว: ตั้งรหัสผ่านใหม่ + เปิดใช้งาน บทบาทเดิมคงไว้ และเขียนประวัติลง AuditLog
// - อีเมลเป็นบัญชีพนักงาน/ลูกค้าที่ไม่ใช่ Admin: ไม่แตะเลย (พบ 2026-09-27: เดิมตั้ง roles ['ADMIN'] ทับ
//   ทำให้คนที่แค่ลืมรหัสกลายเป็น Admin) - ลืมรหัสให้ Admin กด "ตั้งรหัสผ่านใหม่" ที่หน้า จัดการผู้ใช้ (/admin/users)
import 'dotenv/config';
import process from 'node:process';
import { PrismaPg } from '@prisma/adapter-pg';
import { writeAudit } from '../src/audit/audit-log.js';
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
const select = { id: true, email: true, name: true } as const;

try {
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true, roles: true, status: true } });
  if (existing && !existing.roles.includes('ADMIN')) {
    console.error(
      [
        `${email} เป็นบัญชีที่ไม่ใช่ Admin - สคริปต์นี้ไม่เปลี่ยนบัญชีนี้ (ไม่ตั้งรหัสผ่าน ไม่เพิ่มสิทธิ์ Admin)`,
        'ถ้าผู้ใช้ลืมรหัสผ่าน: ให้ Admin กด "ตั้งรหัสผ่านใหม่" ที่หน้า จัดการผู้ใช้ (/admin/users)',
        'ถ้าต้องการให้บัญชีนี้เป็น Admin: ให้ Admin ติ๊กบทบาทผู้ดูแลระบบที่หน้าเดียวกัน',
      ].join('\n'),
    );
    process.exitCode = 1;
  } else if (existing) {
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, status: 'APPROVED', ...(existing.status === 'APPROVED' ? {} : { approvedAt: new Date() }) },
      select,
    });
    // ประวัติแบบเดียวกับปุ่มตั้งรหัสผ่านใหม่ (ไม่เก็บรหัสผ่าน) - ฐานข้อมูลที่ยังไม่มีตาราง AuditLog ไม่ทำให้การกู้บัญชีล้ม
    try {
      await writeAudit(prisma, {
        entity: 'User',
        entityId: user.id,
        action: 'set-password',
        remark: 'ตั้งรหัสผ่านใหม่ผ่าน scripts/seed-admin.ts',
        changes: { password: true, ...(existing.status === 'APPROVED' ? {} : { status: { from: existing.status, to: 'APPROVED' } }) },
      });
    } catch (error) {
      console.warn(`ตั้งรหัสผ่านแล้ว แต่บันทึกประวัติไม่สำเร็จ: ${error instanceof Error ? error.message : String(error)}`);
    }
    console.log(`ตั้งรหัสผ่านใหม่ให้ Admin แล้ว: ${user.email} (${user.name}) id=${user.id}`);
  } else {
    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, name, roles: ['ADMIN'], status: 'APPROVED', approvedAt: new Date() },
      select,
    });
    console.log(`Admin พร้อมใช้งาน: ${user.email} (${user.name}) id=${user.id}`);
  }
} finally {
  await prisma.$disconnect();
}
