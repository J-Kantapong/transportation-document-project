import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { type PublicUser, toPublicUser, USER_SELECT } from '../auth/auth.types.js';
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
}
