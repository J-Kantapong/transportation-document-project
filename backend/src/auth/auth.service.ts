import { BadRequestException, ForbiddenException, HttpException, HttpStatus, Injectable, UnauthorizedException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { AttemptLimiter, waitMinutes } from './attempt-limiter.js';
import { authSecret, TOKEN_TTL_SECONDS } from './auth-config.js';
import { type PublicUser, toPublicUser, USER_SELECT } from './auth.types.js';
import { resignToken, signToken } from './jwt.js';
import { hashPassword, verifyPassword } from './password.js';

const bad = (error: string) => new BadRequestException({ error });
const tooMany = (error: string) => new HttpException({ error }, HttpStatus.TOO_MANY_REQUESTS);

// จำกัดการเดารหัสผ่าน (พบ 2026-09-27): ผิด 5 ครั้งใน 15 นาทีจากอีเมล + IP เดียวกัน = รอจนครบ 15 นาที
// สมัครได้ 20 ครั้งต่อชั่วโมงต่อ IP (สมัครทุกครั้งคำนวณ scrypt + บอกได้ว่าอีเมลไหนมีบัญชีแล้ว)
// เผื่อพนักงานทั้งออฟฟิศสมัครพร้อมกันผ่าน IP เดียว (NAT) - ครั้งที่ข้อมูลไม่ครบไม่นับ
export const LOGIN_MAX_FAILURES = 5;
const LOGIN_WINDOW_MS = 15 * 60_000;
export const REGISTER_MAX_PER_IP = 20;
const REGISTER_WINDOW_MS = 60 * 60_000;

// hash หลอกรูปแบบเดียวกับของจริง: อีเมลที่ไม่มีในระบบก็คำนวณ scrypt เท่ากัน จับเวลาตอบแล้วเดาไม่ได้ว่าอีเมลไหนมีบัญชี
const DUMMY_HASH = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;

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
  private readonly loginFailures = new AttemptLimiter(LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS);
  private readonly registrations = new AttemptLimiter(REGISTER_MAX_PER_IP, REGISTER_WINDOW_MS);

  constructor(private readonly prisma: PrismaService) {}

  // ip = clientIp() ของคำขอ (auth.controller.ts) - ว่าง = ไม่รู้ IP (เช่น script) ไม่จำกัด
  async register(body: unknown, ip = ''): Promise<{ user: PublicUser }> {
    const dto = parse(RegisterSchema, body);
    if (ip) {
      const wait = this.registrations.blockedFor(ip);
      if (wait > 0) throw tooMany(`สมัครจากเครื่องนี้หลายครั้งเกินไป กรุณารอ ${waitMinutes(wait)} นาทีแล้วลองใหม่`);
      this.registrations.hit(ip);
    }
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

  async login(body: unknown, ip = ''): Promise<{ token: string; user: PublicUser }> {
    const dto = parse(LoginSchema, body);
    // ตรวจก่อนดูรหัสผ่าน: ถูกจำกัดอยู่ก็ไม่บอกว่ารหัสที่ลองครั้งนี้ถูกหรือผิด
    const key = `${dto.email}|${ip}`;
    const wait = this.loginFailures.blockedFor(key);
    if (wait > 0) throw tooMany(`ลองเข้าสู่ระบบผิดหลายครั้งเกินไป กรุณารอ ${waitMinutes(wait)} นาทีแล้วลองใหม่`);
    // นับก่อนตรวจรหัส กันยิงพร้อมกันหลายคำขอ: ถ้านับหลัง await ทุกคำขอที่มาพร้อมกันผ่านการตรวจด้านบนไปหมด - รหัสถูกค่อยล้าง
    this.loginFailures.hit(key);

    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
      select: { ...USER_SELECT, passwordHash: true },
    });
    const valid = await verifyPassword(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) throw new UnauthorizedException({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    this.loginFailures.reset(key);
    if (user.status === 'PENDING') throw new ForbiddenException({ error: 'บัญชีนี้ยังรอผู้ดูแลระบบอนุมัติ' });
    if (user.status === 'REJECTED') throw new ForbiddenException({ error: 'บัญชีนี้ไม่ได้รับการอนุมัติ กรุณาติดต่อผู้ดูแลระบบ' });
    if (user.status === 'DISABLED') throw new ForbiddenException({ error: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อผู้ดูแลระบบ' });
    if (user.roles.length === 0) throw new ForbiddenException({ error: 'บัญชีนี้ยังไม่ได้รับบทบาท กรุณาติดต่อผู้ดูแลระบบ' });

    const { passwordHash: _hash, ...rest } = user;
    return { token: signToken(user.id, user.roles, this.secret, TOKEN_TTL_SECONDS), user: toPublicUser(rest) };
  }

  // ส่ง token ที่มี roles ล่าสุดกลับไปด้วย (พบ 2026-09-27): หน้าเว็บ (proxy.ts, หน้าแรก) เลือกหน้าจาก roles ใน token
  // ที่ออกตอนล็อกอิน ถ้า Admin เปลี่ยนบทบาทระหว่างวัน AppShell จะเก็บ token นี้แทน - หมดอายุเวลาเดิม ไม่ต่ออายุการล็อกอิน
  async me(userId: string, tokenExp?: number): Promise<{ user: PublicUser; token: string }> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT });
    if (!user) throw new UnauthorizedException({ error: 'กรุณาเข้าสู่ระบบ' });
    const token = tokenExp
      ? resignToken(user.id, user.roles, this.secret, tokenExp)
      : signToken(user.id, user.roles, this.secret, TOKEN_TTL_SECONDS);
    return { user: toPublicUser(user), token };
  }

  async changePassword(userId: string, body: unknown): Promise<{ ok: true }> {
    const dto = parse(ChangePasswordSchema, body);
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { passwordHash: true } });
    if (!user || !(await verifyPassword(dto.currentPassword, user.passwordHash))) throw bad('รหัสผ่านเดิมไม่ถูกต้อง');
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(dto.password) } });
    return { ok: true };
  }
}
