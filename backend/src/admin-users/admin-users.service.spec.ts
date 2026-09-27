import { BadRequestException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { verifyPassword } from '../auth/password.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AdminUsersService } from './admin-users.service.js';

const asAdmin = <T>(fn: () => T) => requestContext.run({ user: { id: 'admin1', roles: ['ADMIN'], customerId: null, name: 'แอดมิน' } }, fn);

function userRow(id = 'u2') {
  return {
    id,
    email: 'staff@example.com',
    name: 'พนักงาน',
    displayName: null,
    phone: '0800000000',
    roles: ['STAFF_CAR'],
    status: 'APPROVED',
    requestedRole: 'STAFF_CAR',
    requestedCompany: null,
    customerId: null,
    createdAt: new Date('2026-09-22T00:00:00Z'),
    approvedAt: new Date('2026-09-22T00:00:00Z'),
    customer: null,
  };
}

function setup(exists = true) {
  const findUnique = vi.fn(async () => (exists ? { id: 'u2' } : null));
  const update = vi.fn(async () => userRow());
  const auditCreate = vi.fn(async () => ({ id: 'a1' }));
  const tx = { user: { update }, auditLog: { create: auditCreate } };
  const prisma = {
    user: { findUnique },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { svc: new AdminUsersService(prisma), update, auditCreate, findUnique };
}

const body = (o: Record<string, unknown> = {}) => ({ password: 'temp-pass-1', confirmPassword: 'temp-pass-1', remark: 'ผู้ใช้ลืมรหัสผ่าน', ...o });

describe('AdminUsersService.setPassword - ADMIN ตั้งรหัสผ่านชั่วคราว (ผู้ใช้ 2026-09-27)', () => {
  it('stores a scrypt hash of the new password and logs the action without the password', async () => {
    const { svc, update, auditCreate } = setup();
    const result = await asAdmin(() => svc.setPassword('admin1', 'u2', body()));
    expect(result.user).toMatchObject({ id: 'u2', roles: ['STAFF_CAR'], status: 'APPROVED' });

    const data = (update.mock.calls[0] as unknown as [{ where: unknown; data: Record<string, unknown> }])[0];
    expect(data.where).toEqual({ id: 'u2' });
    // เปลี่ยนแค่รหัสผ่าน - ไม่แตะสถานะ/บทบาท
    expect(Object.keys(data.data)).toEqual(['passwordHash']);
    await expect(verifyPassword('temp-pass-1', data.data.passwordHash as string)).resolves.toBe(true);

    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        entity: 'User',
        entityId: 'u2',
        action: 'set-password',
        remark: 'ผู้ใช้ลืมรหัสผ่าน',
        changes: { password: '[ซ่อน]' },
        editedById: 'admin1',
      },
      select: { id: true },
    });
    expect(JSON.stringify(auditCreate.mock.calls)).not.toContain('temp-pass-1');
  });

  it('refuses the caller own account so the old-password check cannot be skipped', async () => {
    const { svc, update } = setup();
    await expect(svc.setPassword('admin1', 'admin1', body())).rejects.toMatchObject({
      response: { error: expect.stringContaining('เปลี่ยนรหัสผ่าน') },
    });
    expect(update).not.toHaveBeenCalled();
  });

  it('uses the registration password rules and needs a reason', async () => {
    const { svc, update } = setup();
    await expect(svc.setPassword('admin1', 'u2', body({ password: 'short', confirmPassword: 'short' }))).rejects.toMatchObject({
      response: { error: 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร' },
    });
    await expect(svc.setPassword('admin1', 'u2', body({ confirmPassword: 'temp-pass-2' }))).rejects.toMatchObject({
      response: { error: 'รหัสผ่านทั้งสองช่องไม่ตรงกัน' },
    });
    await expect(svc.setPassword('admin1', 'u2', body({ password: 'x'.repeat(201), confirmPassword: 'x'.repeat(201) }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.setPassword('admin1', 'u2', body({ remark: ' ' }))).rejects.toMatchObject({
      response: { error: 'กรุณาระบุเหตุผลที่ตั้งรหัสผ่านใหม่' },
    });
    await expect(svc.setPassword('admin1', 'u2', undefined)).rejects.toBeInstanceOf(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown user', async () => {
    const { svc, update } = setup(false);
    await expect(svc.setPassword('admin1', 'ghost', body())).rejects.toBeInstanceOf(NotFoundException);
    expect(update).not.toHaveBeenCalled();
  });
});
