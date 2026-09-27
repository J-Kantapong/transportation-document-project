import type { HttpException } from '@nestjs/common';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AuthService, LOGIN_MAX_FAILURES, REGISTER_MAX_PER_IP } from './auth.service.js';
import { verifyToken } from './jwt.js';
import { hashPassword } from './password.js';

const SECRET = 'test-secret-at-least-16-chars';
let passwordHash = '';

beforeAll(async () => {
  process.env.AUTH_SECRET = SECRET;
  passwordHash = await hashPassword('correct-password');
});

function userRow(roles: string[] = ['STAFF_CAR']) {
  return {
    id: 'u1',
    email: 'staff@example.com',
    name: 'พนักงาน',
    displayName: null,
    phone: '0800000000',
    roles,
    status: 'APPROVED',
    requestedRole: 'STAFF_CAR',
    requestedCompany: null,
    customerId: null,
    createdAt: new Date('2026-09-22T00:00:00Z'),
    approvedAt: new Date('2026-09-22T00:00:00Z'),
    customer: null,
    passwordHash,
  };
}

function setup(roles?: string[]) {
  const findUnique = vi.fn(async ({ where }: { where: { email?: string; id?: string } }) =>
    where.email === 'staff@example.com' || where.id === 'u1' ? userRow(roles) : null,
  );
  const create = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...userRow([]), ...data, id: 'new' }));
  const prisma = { user: { findUnique, create } } as unknown as PrismaService;
  return { svc: new AuthService(prisma), findUnique };
}

const login = (email: string, password: string) => ({ email, password });

describe('AuthService.login - จำกัดการเดารหัสผ่าน (พบ 2026-09-27)', () => {
  it('ผิดครบ 5 ครั้งจากอีเมล + IP เดียวกัน = 429 แม้ครั้งถัดไปรหัสถูก', async () => {
    const { svc } = setup();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await expect(svc.login(login('staff@example.com', 'wrong-password'), '1.1.1.1')).rejects.toMatchObject({ status: 401 });
    }
    await expect(svc.login(login('staff@example.com', 'correct-password'), '1.1.1.1')).rejects.toMatchObject({
      status: 429,
      response: { error: expect.stringContaining('กรุณารอ 15 นาที') },
    });
    // อีเมลเดียวกันจาก IP อื่น (เจ้าของบัญชีจริง) ยังเข้าได้
    await expect(svc.login(login('staff@example.com', 'correct-password'), '2.2.2.2')).resolves.toMatchObject({ user: { id: 'u1' } });
  });

  it('ไม่แยกตัวพิมพ์ของอีเมล และล็อกอินสำเร็จแล้วนับใหม่', async () => {
    const { svc } = setup();
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
      await expect(svc.login(login('Staff@Example.com', 'wrong-password'), '1.1.1.1')).rejects.toMatchObject({ status: 401 });
    }
    await expect(svc.login(login('staff@example.com', 'correct-password'), '1.1.1.1')).resolves.toMatchObject({ token: expect.any(String) });
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i += 1) {
      await expect(svc.login(login('staff@example.com', 'wrong-password'), '1.1.1.1')).rejects.toMatchObject({ status: 401 });
    }
    await expect(svc.login(login('staff@example.com', 'correct-password'), '1.1.1.1')).resolves.toMatchObject({ token: expect.any(String) });
  });

  it('ยิงพร้อมกันหลายคำขอก็ผ่านได้แค่ 5 ครั้ง ที่เหลือ 429 แม้มีรหัสถูกปนอยู่', async () => {
    const { svc } = setup();
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        svc.login(login('staff@example.com', i === 9 ? 'correct-password' : 'wrong-password'), '1.1.1.1'),
      ),
    );
    const statuses = results.map((r) => (r.status === 'fulfilled' ? 200 : (r.reason as HttpException).getStatus()));
    expect(statuses.filter((s) => s === 401)).toHaveLength(LOGIN_MAX_FAILURES);
    expect(statuses.filter((s) => s === 429)).toHaveLength(10 - LOGIN_MAX_FAILURES);
  });

  it('ผิด 4 ครั้งพร้อมกันแล้วรหัสถูกยังเข้าได้ และนับใหม่', async () => {
    const { svc } = setup();
    const wrong = Array.from({ length: LOGIN_MAX_FAILURES - 1 }, () => svc.login(login('staff@example.com', 'wrong-password'), '1.1.1.1'));
    const right = svc.login(login('staff@example.com', 'correct-password'), '1.1.1.1');
    const settled = await Promise.allSettled(wrong);
    expect(settled.map((r) => (r.status === 'rejected' ? (r.reason as HttpException).getStatus() : 200))).toEqual(
      Array(LOGIN_MAX_FAILURES - 1).fill(401),
    );
    await expect(right).resolves.toMatchObject({ token: expect.any(String) });
    await expect(svc.login(login('staff@example.com', 'wrong-password'), '1.1.1.1')).rejects.toMatchObject({ status: 401 });
  });

  it('อีเมลที่ไม่มีบัญชีตอบเหมือนรหัสผิด และถูกนับด้วย', async () => {
    const { svc } = setup();
    for (let i = 0; i < LOGIN_MAX_FAILURES; i += 1) {
      await expect(svc.login(login('nobody@example.com', 'whatever-password'), '1.1.1.1')).rejects.toMatchObject({
        status: 401,
        response: { error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' },
      });
    }
    await expect(svc.login(login('nobody@example.com', 'whatever-password'), '1.1.1.1')).rejects.toMatchObject({ status: 429 });
  });
});

describe('AuthService.register - จำกัดการสมัครต่อ IP (พบ 2026-09-27)', () => {
  const staff = (email: string) => ({
    kind: 'STAFF',
    name: 'พนักงานใหม่',
    email,
    phone: '0800000000',
    password: 'new-password',
    confirmPassword: 'new-password',
    requestedRole: 'STAFF_CAR',
  });

  it(`สมัครได้ ${REGISTER_MAX_PER_IP} ครั้งต่อชั่วโมงต่อ IP - IP อื่นยังสมัครได้`, async () => {
    const { svc } = setup();
    for (let i = 0; i < REGISTER_MAX_PER_IP; i += 1) {
      await expect(svc.register(staff(`new${i}@example.com`), '1.1.1.1')).resolves.toMatchObject({ user: { status: 'PENDING' } });
    }
    await expect(svc.register(staff('more@example.com'), '1.1.1.1')).rejects.toMatchObject({ status: 429 });
    await expect(svc.register(staff('more@example.com'), '2.2.2.2')).resolves.toMatchObject({ user: { status: 'PENDING' } });
  });

  it('ข้อมูลไม่ครบไม่ถูกนับ', async () => {
    const { svc } = setup();
    for (let i = 0; i < REGISTER_MAX_PER_IP + 2; i += 1) {
      await expect(svc.register({ ...staff('x@example.com'), confirmPassword: 'other' }, '1.1.1.1')).rejects.toMatchObject({ status: 400 });
    }
    await expect(svc.register(staff('x@example.com'), '1.1.1.1')).resolves.toMatchObject({ user: { status: 'PENDING' } });
  });
});

describe('AuthService.me - token ใหม่ตาม roles ล่าสุด (พบ 2026-09-27)', () => {
  it('ใส่ roles ปัจจุบันในฐานข้อมูล และหมดอายุเวลาเดิมของ token ที่ใช้อยู่', async () => {
    const { svc } = setup(['STAFF_ENTRY', 'STAFF_CAR']);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const { user, token } = await svc.me('u1', exp);
    expect(user.roles).toEqual(['STAFF_ENTRY', 'STAFF_CAR']);
    expect(verifyToken(token, SECRET)).toMatchObject({ sub: 'u1', roles: ['STAFF_ENTRY', 'STAFF_CAR'], exp });
  });

  it('ไม่รู้วันหมดอายุเดิม = อายุ 12 ชั่วโมงตามปกติ', async () => {
    const { svc } = setup();
    const { token } = await svc.me('u1');
    const payload = verifyToken(token, SECRET);
    expect(payload!.exp - payload!.iat).toBe(12 * 60 * 60);
  });
});
