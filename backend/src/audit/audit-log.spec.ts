import { BadRequestException } from '@nestjs/common';
import { vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { requestContext } from '../auth/request-context.js';
import { diffChanges, requireRemark, toAuditJson, writeAudit } from './audit-log.js';

const asUser = <T>(fn: () => T) => requestContext.run({ user: { id: 'u1', roles: ['ADMIN'], customerId: null, name: 'ทดสอบ' } }, fn);

function fakeDb() {
  const create = vi.fn().mockResolvedValue({ id: 'a1' });
  return { db: { auditLog: { create } } as unknown as Pick<Prisma.TransactionClient, 'auditLog'>, create };
}

describe('writeAudit', () => {
  it('stores the current user as editedById and a JSON-safe changes object', async () => {
    const { db, create } = fakeDb();
    const result = await asUser(() =>
      writeAudit(db, {
        entity: 'Invoice',
        entityId: 'inv1',
        action: 'unpay',
        remark: '  กดรับเงินผิดใบ  ',
        changes: {
          status: { from: 'PAID', to: 'ISSUED' },
          paidDate: { from: new Date('2026-09-26T00:00:00.000Z'), to: null },
          netTotal: { from: new Prisma.Decimal('1070.50'), to: new Prisma.Decimal('1070.50') },
          skipped: undefined,
        },
      }),
    );
    expect(result).toEqual({ id: 'a1' });
    expect(create).toHaveBeenCalledWith({
      data: {
        entity: 'Invoice',
        entityId: 'inv1',
        action: 'unpay',
        remark: 'กดรับเงินผิดใบ',
        changes: {
          status: { from: 'PAID', to: 'ISSUED' },
          paidDate: { from: '2026-09-26', to: null },
          netTotal: { from: '1070.5', to: '1070.5' },
        },
        editedById: 'u1',
      },
      select: { id: true },
    });
  });

  it('leaves editedById null outside an HTTP request (scripts, tests)', async () => {
    const { db, create } = fakeDb();
    await writeAudit(db, { entity: 'Customer', entityId: 'c1', action: 'update', remark: 'แก้ชื่อสาขา', changes: {} });
    expect(create.mock.calls[0][0].data.editedById).toBeNull();
  });

  it('rejects a blank remark with 400 and writes nothing', async () => {
    const { db, create } = fakeDb();
    await expect(asUser(() => writeAudit(db, { entity: 'TaxRenewal', entityId: 't1', action: 'cancel', remark: '   ', changes: {} }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('never stores a password, even when the caller forgets to strip it', async () => {
    const { db, create } = fakeDb();
    await asUser(() =>
      writeAudit(db, {
        entity: 'User',
        entityId: 'u2',
        action: 'set-password',
        remark: 'ลืมรหัสผ่าน',
        changes: { passwordHash: { from: 'scrypt$old', to: 'scrypt$new' }, nested: { newPassword: 'abc12345' } },
      }),
    );
    expect(create.mock.calls[0][0].data.changes).toEqual({ passwordHash: '[ซ่อน]', nested: { newPassword: '[ซ่อน]' } });
  });
});

describe('diffChanges', () => {
  it('returns only the fields that really changed, in the VehicleEditLog shape', () => {
    const before = { name: 'บริษัท ก', branch: null as string | null, billingWhtRate: new Prisma.Decimal('3.00'), phone: '0811111111' };
    const changes = diffChanges(before, { name: 'บริษัท ก จำกัด', branch: 'สาขา 1', billingWhtRate: 3, phone: undefined });
    expect(changes).toEqual({ name: { from: 'บริษัท ก', to: 'บริษัท ก จำกัด' }, branch: { from: null, to: 'สาขา 1' } });
  });

  it('limits the comparison to the given fields and writes date-only values as YYYY-MM-DD', () => {
    const before = { returnedDate: new Date('2026-09-20T00:00:00.000Z'), note: 'x' };
    const changes = diffChanges(before, { returnedDate: null, note: 'y' }, ['returnedDate']);
    expect(changes).toEqual({ returnedDate: { from: '2026-09-20', to: null } });
  });

  it('treats an unchanged date as unchanged', () => {
    const d = '2026-09-20T00:00:00.000Z';
    expect(diffChanges({ date: new Date(d) }, { date: new Date(d) })).toEqual({});
  });
});

describe('requireRemark / toAuditJson', () => {
  it('trims the remark and uses the caller message when it is empty', () => {
    expect(requireRemark('  ผิดคัน ')).toBe('ผิดคัน');
    expect(() => requireRemark(undefined, 'กรุณาระบุเหตุผลที่ยกเลิกงานต่อภาษี')).toThrow(BadRequestException);
    try {
      requireRemark('', 'กรุณาระบุเหตุผลที่ยกเลิกงานต่อภาษี');
    } catch (e) {
      expect((e as BadRequestException).getResponse()).toEqual({ error: 'กรุณาระบุเหตุผลที่ยกเลิกงานต่อภาษี' });
    }
  });

  it('keeps full timestamps and snapshots arrays', () => {
    expect(toAuditJson(new Date('2026-09-27T05:30:00.000Z'))).toBe('2026-09-27T05:30:00.000Z');
    expect(toAuditJson({ items: [{ label: 'ลงขัน', amount: new Prisma.Decimal(200) }] })).toEqual({ items: [{ label: 'ลงขัน', amount: '200' }] });
  });
});
