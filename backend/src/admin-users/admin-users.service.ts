import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { requireRemark, writeAudit } from '../audit/audit-log.js';
import { type PublicUser, toPublicUser, USER_SELECT } from '../auth/auth.types.js';
import { hashPassword } from '../auth/password.js';
import type { UserStatus } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';

const bad = (error: string) => new BadRequestException({ error });

const STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'DISABLED'] as const;

// Admin แก้ได้ 3 อย่าง: สถานะ (อนุมัติ/ปฏิเสธ/ระงับ/เปิดใช้), บทบาท (หลายบทบาท), บริษัทลูกค้าที่ผูก
const UpdateSchema = z.object({
  status: z.enum(STATUSES).optional(),
  roles: z.array(z.enum(['ADMIN', 'STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT', 'DELIVERY', 'CUSTOMER'])).optional(),
  customerId: z.string().trim().nullable().optional(),
});

export const REMARK_MAX_LENGTH = 500;

// ตั้งรหัสผ่านชั่วคราวให้ผู้ใช้ที่ลืมรหัส (ผู้ใช้ 2026-09-27) - กติการหัสผ่านเดียวกับตอนสมัคร (auth.service.ts):
// อย่างน้อย 8 ตัว ไม่เกิน 200 ตัว + พิมพ์ยืนยันให้ตรงกัน / เหตุผลบังคับ (เก็บใน AuditLog แต่ไม่เก็บรหัสผ่าน)
const SetPasswordSchema = z
  .object({
    password: z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(200, 'รหัสผ่านยาวเกินไป'),
    confirmPassword: z.string(),
  })
  .refine((v) => v.password === v.confirmPassword, { message: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' });

@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(status?: string): Promise<{ users: PublicUser[] }> {
    if (status !== undefined && !STATUSES.includes(status as UserStatus)) throw bad('สถานะไม่ถูกต้อง');
    const users = await this.prisma.user.findMany({
      where: status ? { status: status as UserStatus } : undefined,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      select: USER_SELECT,
    });
    return { users: users.map(toPublicUser) };
  }

  async update(adminId: string, id: string, body: unknown): Promise<{ user: PublicUser }> {
    const result = UpdateSchema.safeParse(body ?? {});
    if (!result.success) throw bad(result.error.issues[0]?.message ?? 'กรุณาตรวจสอบข้อมูล');
    const dto = result.data;

    const current = await this.prisma.user.findUnique({ where: { id }, select: USER_SELECT });
    if (!current) throw new NotFoundException({ error: 'ไม่พบผู้ใช้' });

    const status = dto.status ?? current.status;
    const roles = [...new Set(dto.roles ?? current.roles)];
    const customerId = dto.customerId === undefined ? current.customerId : dto.customerId || null;

    if (status === 'APPROVED' && roles.length === 0) throw bad('ต้องกำหนดบทบาทอย่างน้อย 1 บทบาทก่อนอนุมัติ');
    if (roles.includes('CUSTOMER') && roles.length > 1) throw bad('บทบาทลูกค้าใช้ร่วมกับบทบาทพนักงานไม่ได้');
    if (roles.includes('CUSTOMER') && !customerId) throw bad('ต้องเลือกบริษัทลูกค้าที่จะผูกกับบัญชีนี้');
    if (customerId) {
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId }, select: { id: true } });
      if (!customer) throw bad('ไม่พบบริษัทลูกค้าที่เลือก');
    }
    // กันล็อกตัวเองออกจากระบบ: Admin ที่กำลังแก้ ห้ามถอดบทบาท ADMIN หรือระงับบัญชีตัวเอง
    if (id === adminId && (!roles.includes('ADMIN') || status !== 'APPROVED')) {
      throw bad('ไม่สามารถถอดสิทธิ์ผู้ดูแลระบบหรือระงับบัญชีของตัวเองได้');
    }

    const becameApproved = status === 'APPROVED' && current.status !== 'APPROVED';
    const user = await this.prisma.user.update({
      where: { id },
      data: {
        status,
        roles,
        customerId: roles.includes('CUSTOMER') ? customerId : null,
        ...(becameApproved ? { approvedById: adminId, approvedAt: new Date() } : {}),
      },
      select: USER_SELECT,
    });
    return { user: toPublicUser(user) };
  }

  // ADMIN ตั้งรหัสผ่านชั่วคราวให้ผู้ใช้คนอื่น (ผู้ใช้ 2026-09-27) แล้วแจ้งผู้ใช้ให้เปลี่ยนเองที่เมนู "เปลี่ยนรหัสผ่าน"
  // - บัญชีตัวเองใช้ทางนี้ไม่ได้: ต้องเปลี่ยนผ่าน /api/auth/change-password ที่ตรวจรหัสผ่านเดิม (token ที่หลุดไปจะเปลี่ยนรหัสไม่ได้)
  // - ไม่เปลี่ยนสถานะ/บทบาท (ต่างจาก scripts/seed-admin.ts เดิมที่ตั้งเป็น ADMIN ทุกครั้ง)
  // - ประวัติ: AuditLog entity 'User' action 'set-password' เก็บแค่ว่ามีการตั้งรหัสใหม่ ไม่เก็บรหัสผ่านหรือ hash
  async setPassword(adminId: string, id: string, body: unknown): Promise<{ user: PublicUser }> {
    if (id === adminId) throw bad('ตั้งรหัสผ่านของตัวเองที่นี่ไม่ได้ กรุณาใช้เมนู "เปลี่ยนรหัสผ่าน" (ต้องใส่รหัสผ่านเดิม)');
    const raw = (body ?? {}) as { remark?: unknown };
    const remark = requireRemark(raw.remark, 'กรุณาระบุเหตุผลที่ตั้งรหัสผ่านใหม่');
    if (remark.length > REMARK_MAX_LENGTH) throw bad(`เหตุผลยาวเกิน ${REMARK_MAX_LENGTH} ตัวอักษร`);
    const result = SetPasswordSchema.safeParse(body ?? {});
    if (!result.success) throw bad(result.error.issues[0]?.message ?? 'กรุณาตรวจสอบข้อมูล');

    const current = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!current) throw new NotFoundException({ error: 'ไม่พบผู้ใช้' });

    const passwordHash = await hashPassword(result.data.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({ where: { id }, data: { passwordHash }, select: USER_SELECT });
      // writeAudit ซ่อนทุกคีย์ที่มีคำว่า password อยู่แล้ว - ใส่แค่ true ให้รู้ว่ารหัสถูกตั้งใหม่
      await writeAudit(tx, { entity: 'User', entityId: id, action: 'set-password', remark, changes: { password: true } });
      return updated;
    });
    return { user: toPublicUser(user) };
  }
}
