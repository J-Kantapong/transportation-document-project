import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { vi } from 'vitest';
import { Prisma } from '../generated/prisma/client.js';
import { requestContext } from '../auth/request-context.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CustomersService, parseCustomerFields, parseCustomerTerms } from './customers.service.js';

const asAdmin = <T>(fn: () => T) => requestContext.run({ user: { id: 'admin1', roles: ['ADMIN'], customerId: null, name: 'แอดมิน' } }, fn);

function customerRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    name: 'Lexus',
    company: 'บริษัท เลกซัส ออโต้ ซิตี้ จำกัด',
    branch: null,
    address: 'ที่อยู่เดิม',
    taxId: '0105547142882',
    phone: '021234567',
    email: null,
    createdAt: new Date('2026-09-01T03:00:00.000Z'),
    updatedAt: new Date('2026-09-01T03:00:00.000Z'),
    billingVat: true,
    billingWhtRate: new Prisma.Decimal('3.00'),
    billingWhtSpecialRate: null,
    billingWhtSpecialUntil: null,
    ...overrides,
  };
}

// ข้อความ { error } ที่หน้าเว็บเห็น (message ของ BadRequestException เป็นข้อความกลางของ Nest)
function errorOf(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return (e as BadRequestException).getResponse();
  }
  return undefined;
}

const form = (o: Record<string, unknown> = {}) => ({
  name: 'Lexus',
  company: 'บริษัท เลกซัส ออโต้ ซิตี้ จำกัด',
  branch: '',
  address: 'ที่อยู่เดิม',
  taxId: '0105547142882',
  phone: '021234567',
  email: '',
  remark: 'แก้เลขภาษีที่พิมพ์ผิด',
  expectedUpdatedAt: '2026-09-01T03:00:00.000Z', // = customerRow().updatedAt (ค่าตอนเปิดหน้าแก้)
  ...o,
});

function setup(current: unknown = customerRow()) {
  const calls: string[] = [];
  const queryRaw = vi.fn(async () => {
    calls.push('lock');
    return [];
  });
  const findUnique = vi.fn(async () => {
    calls.push('read');
    return current;
  });
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    calls.push('update');
    return { ...(current as object), ...data };
  });
  const auditCreate = vi.fn(async () => {
    calls.push('audit');
    return { id: 'a1' };
  });
  const create = vi.fn(async () => ({ id: 'new' }));
  const tx = { $queryRaw: queryRaw, customer: { findUnique, update }, auditLog: { create: auditCreate } };
  const prisma = {
    customer: { create },
    $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  return { svc: new CustomersService(prisma), calls, update, auditCreate, create, findUnique };
}

describe('parseCustomerFields - กติกาเดียวกันทั้งเพิ่มและแก้', () => {
  it('trims every field and turns empty optional fields into null', () => {
    expect(parseCustomerFields({ ...form(), name: '  Lexus ', branch: '   ' })).toEqual({
      name: 'Lexus',
      company: 'บริษัท เลกซัส ออโต้ ซิตี้ จำกัด',
      branch: null,
      address: 'ที่อยู่เดิม',
      taxId: '0105547142882',
      phone: '021234567',
      email: null,
    });
  });

  it('rejects a missing name, a bad tax id, a bad email and a missing field', () => {
    expect(() => parseCustomerFields(form({ name: '  ' }))).toThrow(BadRequestException);
    expect(errorOf(() => parseCustomerFields(form({ taxId: '12345' })))).toEqual({ error: 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' });
    expect(errorOf(() => parseCustomerFields(form({ email: 'no-at-sign' })))).toEqual({ error: 'กรุณาตรวจสอบอีเมล' });
    expect(errorOf(() => parseCustomerFields({ name: 'x' }))).toEqual({ error: 'กรุณาตรวจสอบข้อมูลลูกค้า' });
  });
});

describe('parseCustomerTerms', () => {
  it('needs an end date for a special rate and rejects a date that does not exist', () => {
    expect(errorOf(() => parseCustomerTerms({ vat: true, whtRate: 3, whtSpecialRate: 1 }))).toEqual({ error: 'อัตราพิเศษต้องระบุวันสุดท้ายที่ใช้' });
    expect(() => parseCustomerTerms({ vat: true, whtRate: 3, whtSpecialRate: 1, whtSpecialUntil: '2026-02-31' })).toThrow(BadRequestException);
    expect(errorOf(() => parseCustomerTerms({ vat: 'yes', whtRate: 3 }))).toEqual({ error: 'ต้องระบุว่ามี VAT หรือไม่' });
    expect(() => parseCustomerTerms({ vat: true, whtRate: 101 })).toThrow(BadRequestException);
    expect(parseCustomerTerms({ vat: false, whtRate: 1.5, whtSpecialRate: 1, whtSpecialUntil: '2026-12-31' })).toEqual({
      billingVat: false,
      billingWhtRate: 1.5,
      billingWhtSpecialRate: 1,
      billingWhtSpecialUntil: new Date('2026-12-31T00:00:00.000Z'),
    });
  });
});

describe('CustomersService.create', () => {
  it('saves the parsed fields', async () => {
    const { svc, create } = setup();
    await expect(svc.create(form())).resolves.toEqual({ id: 'new' });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Lexus', branch: null, email: null }), select: { id: true } });
  });
});

describe('CustomersService.update - ADMIN แก้ข้อมูลลูกค้า ต้องมีเหตุผลและประวัติ (ผู้ใช้ 2026-09-27)', () => {
  it('locks the row, updates it and writes only the changed fields to AuditLog', async () => {
    const { svc, calls, update, auditCreate } = setup();
    await asAdmin(() => svc.update('c1', form({ taxId: '0105547142883', branch: 'สาขา 00001' })));
    expect(calls).toEqual(['lock', 'read', 'update', 'audit']);
    expect(update.mock.calls[0][0]).toMatchObject({ where: { id: 'c1' }, data: { taxId: '0105547142883', branch: 'สาขา 00001' } });
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        entity: 'Customer',
        entityId: 'c1',
        action: 'update',
        remark: 'แก้เลขภาษีที่พิมพ์ผิด',
        changes: { branch: { from: null, to: 'สาขา 00001' }, taxId: { from: '0105547142882', to: '0105547142883' } },
        editedById: 'admin1',
      },
      select: { id: true },
    });
  });

  it('logs billing-term changes too and leaves the terms alone when they are not sent', async () => {
    const withTerms = setup();
    await asAdmin(() =>
      withTerms.svc.update('c1', form({ terms: { vat: false, whtRate: 3, whtSpecialRate: 1, whtSpecialUntil: '2026-12-31' } })),
    );
    const changes = (withTerms.auditCreate.mock.calls[0] as unknown as [{ data: { changes: unknown } }])[0].data.changes;
    expect(changes).toEqual({
      billingVat: { from: true, to: false },
      billingWhtSpecialRate: { from: null, to: 1 },
      billingWhtSpecialUntil: { from: null, to: '2026-12-31' },
    });

    const noTerms = setup();
    await asAdmin(() => noTerms.svc.update('c1', form({ phone: '029999999' })));
    expect(Object.keys(noTerms.update.mock.calls[0][0].data)).not.toContain('billingVat');
  });

  it('requires a reason before anything else', async () => {
    const { svc, calls } = setup();
    await expect(svc.update('c1', form({ remark: '   ' }))).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่แก้ไขข้อมูลลูกค้า' } });
    await expect(svc.update('c1', form({ remark: 'ก'.repeat(501) }))).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toEqual([]);
  });

  it('uses the create validation', async () => {
    const { svc, calls } = setup();
    await expect(svc.update('c1', form({ taxId: '01-0554' }))).rejects.toMatchObject({ response: { error: 'เลขประจำตัวผู้เสียภาษีต้องเป็นตัวเลข 13 หลัก' } });
    expect(calls).toEqual([]);
  });

  // หน้าแก้ส่ง 7 ช่องครบจากข้อมูลตอนเปิด: A เปิด 10:00, B แก้เบอร์ 10:05, A แก้เลขภาษี 10:10 -> ต้องไม่เอาเบอร์เก่าทับของ B
  it('answers 409 without saving when someone edited the customer after the page was opened', async () => {
    const stale = setup(customerRow({ phone: '029999999', updatedAt: new Date('2026-09-27T03:05:00.000Z') }));
    const attempt = stale.svc.update('c1', form({ taxId: '0105547142883' }));
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({ response: { error: 'ข้อมูลลูกค้าถูกแก้ไขไปแล้ว กรุณาปิดแล้วเปิดใหม่' } });
    expect(stale.calls).toEqual(['lock', 'read']);
    expect(stale.update).not.toHaveBeenCalled();
    expect(stale.auditCreate).not.toHaveBeenCalled();
  });

  it('needs the updatedAt the page was opened with', async () => {
    const { svc, calls } = setup();
    await expect(svc.update('c1', form({ expectedUpdatedAt: undefined }))).rejects.toMatchObject({
      response: { error: 'ไม่พบเวลาที่เปิดข้อมูลลูกค้า กรุณาปิดแล้วเปิดใหม่' },
    });
    await expect(svc.update('c1', form({ expectedUpdatedAt: 123 }))).rejects.toBeInstanceOf(BadRequestException);
    expect(calls).toEqual([]);
  });

  it('answers 404 for an unknown customer and 400 when nothing changed', async () => {
    await expect(setup(null).svc.update('nope', form())).rejects.toBeInstanceOf(NotFoundException);
    const same = setup();
    await expect(same.svc.update('c1', form({ terms: { vat: true, whtRate: 3, whtSpecialRate: null, whtSpecialUntil: null } }))).rejects.toMatchObject({
      response: { error: 'ข้อมูลลูกค้าเหมือนเดิม - ไม่มีอะไรต้องแก้' },
    });
    expect(same.update).not.toHaveBeenCalled();
    expect(same.auditCreate).not.toHaveBeenCalled();
  });
});

describe('CustomersService.history', () => {
  function historySetup(exists = true) {
    const findMany = vi.fn(async () => [
      {
        id: 'a2',
        entity: 'Customer',
        entityId: 'c1',
        action: 'update',
        remark: 'แก้เลขภาษีที่พิมพ์ผิด',
        changes: { taxId: { from: '0105547142882', to: '0105547142883' } },
        editedById: 'admin1',
        createdAt: new Date('2026-09-27T04:00:00.000Z'),
        editedBy: { name: 'สมชาย ใจดี', displayName: 'ชาย' },
      },
      {
        id: 'a1',
        entity: 'Customer',
        entityId: 'c1',
        action: 'update',
        remark: 'จากสคริปต์',
        changes: {},
        editedById: null,
        createdAt: new Date('2026-09-26T04:00:00.000Z'),
        editedBy: null,
      },
    ]);
    const prisma = {
      customer: { findUnique: vi.fn(async () => (exists ? { id: 'c1' } : null)) },
      auditLog: { findMany },
    } as unknown as PrismaService;
    return { svc: new CustomersService(prisma), findMany };
  }

  it('lists only this customer entries, newest first, with the editor nickname', async () => {
    const { svc, findMany } = historySetup();
    const { entries } = await svc.history('c1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { entity: 'Customer', entityId: 'c1' }, orderBy: { createdAt: 'desc' } }),
    );
    expect(entries).toEqual([
      {
        id: 'a2',
        action: 'update',
        remark: 'แก้เลขภาษีที่พิมพ์ผิด',
        changes: { taxId: { from: '0105547142882', to: '0105547142883' } },
        editedBy: 'ชาย',
        createdAt: '2026-09-27T04:00:00.000Z',
      },
      { id: 'a1', action: 'update', remark: 'จากสคริปต์', changes: {}, editedBy: null, createdAt: '2026-09-26T04:00:00.000Z' },
    ]);
  });

  it('answers 404 for an unknown customer', async () => {
    const { svc, findMany } = historySetup(false);
    await expect(svc.history('nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(findMany).not.toHaveBeenCalled();
  });
});
