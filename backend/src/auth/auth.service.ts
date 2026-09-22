import { BadRequestException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { authSecret, TOKEN_TTL_SECONDS } from './auth-config.js';
import { type PublicUser, toPublicUser, USER_SELECT } from './auth.types.js';
import { signToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';

const bad = (error: string) => new BadRequestException({ error });

const text = (max: number) => z.string().trim().max(max, `ข้อความยาวเกิน ${max} ตัวอักษร`);
const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(250)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'กรุณาตรวจสอบอีเมล');
const password = z.string().min(8, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร').max(200, 'รหัสผ่านยาวเกินไป');

// ช่องสมัครสมาชิก (ผู้ใช้ตกลง 2026-09-22): พนักงาน = ชื่อ-นามสกุล, ชื่อเล่น (ไม่บังคับ), อีเมล, เบอร์โทร, รหัสผ่าน x2,
// ตำแหน่งที่ขอ | ลูกค้า = ชื่อผู้ติดต่อ, บริษัท/ร้าน, เบอร์โทร, อีเมล, รหัสผ่าน x2 - ไม่ขอเลขบัตรประชาชน
const base = {
  name: text(250).min(1, 'กรุณากรอกชื่อ'),
  email,
  phone: text(50).min(1, 'กรุณากรอกเบอร์โทรศัพท์'),
  password,
  confirmPassword: z.string(),
};
const RegisterSchema = z
  .discriminatedUnion('kind', [
    z.object({
      kind: z.literal('STAFF'),
      displayName: text(100).optional(),
      requestedRole: z.enum(['STAFF_ENTRY', 'STAFF_CAR', 'STAFF_MOTO', 'ACCOUNTANT', 'DELIVERY'], { message: 'กรุณาเลือกตำแหน่งที่ขอ' }),
      ...base,
    }),
    z.object({ kind: z.literal('CUSTOMER'), company: text(250).min(1, 'กรุณากรอกชื่อบริษัท/ร้าน'), ...base }),
  ])
  .refine((v) => v.password === v.confirmPassword, { message: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' });

const LoginSchema = z.object({ email, password: z.string().min(1, 'กรุณากรอกรหัสผ่าน') });

const ChangePasswordSchema = z
  .object({ currentPassword: z.string().min(1, 'กรุณากรอกรหัสผ่านเดิม'), password, confirmPassword: z.string() })
  .refine((v) => v.password === v.confirmPassword, { message: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw bad(result.error.issues[0]?.message ?? 'กรุณาตรวจสอบข้อมูล');
  return result.data;
}

@Injectable()
export class AuthService {
  private readonly secret = authSecret();

  constructor(private readonly prisma: PrismaService) {}

  async register(body: unknown): Promise<{ user: PublicUser }> {
    const dto = parse(RegisterSchema, body);
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (exists) throw bad('อีเมลนี้ถูกใช้สมัครแล้ว');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        passwordHash: await hashPassword(dto.password),
        name: dto.name,
        phone: dto.phone,
        displayName: dto.kind === 'STAFF' ? dto.displayName || null : null,
        requestedRole: dto.kind === 'STAFF' ? dto.requestedRole : 'CUSTOMER',
        requestedCompany: dto.kind === 'CUSTOMER' ? dto.company : null,
        status: 'PENDING',
        roles: [],
      },
      select: USER_SELECT,
    });
    return { user: toPublicUser(user) };
  }

  async login(body: unknown): Promise<{ token: string; user: PublicUser }> {
    const dto = parse(LoginSchema, body);
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...USER_SELECT, passwordHash: true },
    });
    if (!user || !(await verifyPassword(dto.password, user.passwordHash))) {
      throw new UnauthorizedException({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }
    if (user.status === 'PENDING') throw new ForbiddenException({ error: 'บัญชีนี้ยังรอผู้ดูแลระบบอนุมัติ' });
    if (user.status === 'REJECTED') throw new ForbiddenException({ error: 'บัญชีนี้ไม่ได้รับการอนุมัติ กรุณาติดต่อผู้ดูแลระบบ' });
    if (user.status === 'DISABLED') throw new ForbiddenException({ error: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
    if (user.roles.length === 0) throw new ForbiddenException({ error: 'บัญชีนี้ยังไม่ได้รับบทบาท กรุณาติดต่อผู้ดูแลระบบ' });

    const { passwordHash: _hash, ...rest } = user;
    return { token: signToken(user.id, user.roles, this.secret, TOKEN_TTL_SECONDS), user: toPublicUser(rest) };
  }

  async me(userId: string): Promise<{ user: PublicUser }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
    if (!user) throw new UnauthorizedException({ error: 'กรุณาเข้าสู่ระบบ' });
    return { user: toPublicUser(user) };
  }

  async changePassword(userId: string, body: unknown): Promise<{ ok: true }> {
    const dto = parse(ChangePasswordSchema, body);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || !(await verifyPassword(dto.currentPassword, user.passwordHash))) throw bad('รหัสผ่านเดิมไม่ถูกต้อง');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(dto.password) } });
    return { ok: true };
  }
}
