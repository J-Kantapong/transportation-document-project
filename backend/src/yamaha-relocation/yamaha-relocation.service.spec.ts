import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ReceiptStorage } from '../receipts/receipt-storage.js';
import { contentHashOf } from '../receipts/upload-hash.js';
import { detectAttachmentType, YamahaRelocationService } from './yamaha-relocation.service.js';

const jpeg = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), size: 5, originalname: 'receipt.jpg' };
const pdf = { buffer: Buffer.from('%PDF-1.4 report'), size: 15, originalname: 'report.pdf' };
const text = { buffer: Buffer.from('hello'), size: 5, originalname: 'note.txt' };

type CreateArgs = { data: { attachments: { create: Array<Record<string, unknown>> } } };

function build(createImpl?: () => Promise<unknown>, existingHashes: string[] = []) {
  const create = vi.fn(
    createImpl ??
      (async (args: CreateArgs) => ({
        id: 'e1',
        date: new Date('2026-09-22T00:00:00.000Z'),
        size: 'SMALL',
        count: 3,
        billFee: 15,
        noBillFee: 30,
        createdAt: new Date('2026-09-22T01:00:00.000Z'),
        attachments: args.data.attachments.create.map((a, i) => ({ id: `a${i}`, createdAt: new Date(0), ...a })),
      })),
  );
  const storage = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) };
  const findMany = vi.fn(async (args: { where: { contentHash: { in: string[] } } }) =>
    args.where.contentHash.in.filter((h) => existingHashes.includes(h)).map((contentHash) => ({ contentHash })),
  );
  const prisma = { yamahaRelocationEntry: { create }, yamahaRelocationAttachment: { findMany } } as unknown as PrismaService;
  return { svc: new YamahaRelocationService(prisma, storage as unknown as ReceiptStorage), create, storage };
}

describe('detectAttachmentType', () => {
  it('รับรูปและ PDF ปฏิเสธไฟล์อื่น', () => {
    expect(detectAttachmentType(jpeg.buffer)?.ext).toBe('jpg');
    expect(detectAttachmentType(pdf.buffer)).toEqual({ mimeType: 'application/pdf', ext: 'pdf' });
    expect(detectAttachmentType(text.buffer)).toBeNull();
  });
});

describe('YamahaRelocationService.create', () => {
  const dto = { date: '2026-09-22', size: 'SMALL', count: '3' }; // multipart ส่ง count เป็นข้อความ

  it('บันทึกพร้อมไฟล์แนบ 2 ไฟล์ และคิดค่าธรรมเนียมจาก count', async () => {
    const { svc, create, storage } = build();
    const res = await svc.create(dto, { receipt: [jpeg], report: [pdf] });
    expect(storage.put).toHaveBeenCalledTimes(2);
    expect(storage.put.mock.calls[0][0]).toMatch(/^yamaha-relocation\/receipts\/\d{4}\/\d{2}\/[0-9a-f-]+\.jpg$/);
    expect(storage.put.mock.calls[1][0]).toMatch(/^yamaha-relocation\/reports\/\d{4}\/\d{2}\/[0-9a-f-]+\.pdf$/);
    const { data } = create.mock.calls[0][0] as CreateArgs;
    expect(data).toMatchObject({ count: 3, billFee: 15, noBillFee: 30 });
    expect(data.attachments.create.map((a) => a.kind)).toEqual(['RECEIPT', 'REPORT']);
    expect(res.entry.receipt?.kind).toBe('RECEIPT');
    expect(res.entry.report?.mimeType).toBe('application/pdf');
  });

  it('แนบใบเสร็จ/Report ได้หลายไฟล์ และไฟล์เดียวกันซ้ำในคำขอเดียว = ปฏิเสธ', async () => {
    const jpeg2 = { buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x01]), size: 5, originalname: 'receipt2.jpg' };
    const { svc, storage } = build();
    const res = await svc.create(dto, { receipt: [jpeg, jpeg2], report: [pdf] });
    expect(storage.put).toHaveBeenCalledTimes(3);
    expect(res.entry.receipts).toHaveLength(2);
    expect(res.entry.reports).toHaveLength(1);
    await expect(svc.create(dto, { receipt: [jpeg, jpeg], report: [pdf] })).rejects.toMatchObject({ status: 409 });
  });

  it('ไม่มีใบเสร็จ = ปฏิเสธ ไม่อัปโหลดอะไรเลย', async () => {
    const { svc, storage } = build();
    await expect(svc.create(dto, { report: [pdf] })).rejects.toMatchObject({ response: { error: 'กรุณาแนบไฟล์ใบเสร็จ' } });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('ไม่มี Report = ปฏิเสธ ไม่อัปโหลดอะไรเลย', async () => {
    const { svc, storage } = build();
    await expect(svc.create(dto, { receipt: [jpeg] })).rejects.toMatchObject({ response: { error: 'กรุณาแนบไฟล์ Report' } });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('ไฟล์ที่ไม่ใช่รูป/PDF = ปฏิเสธ', async () => {
    const { svc, storage } = build();
    await expect(svc.create(dto, { receipt: [jpeg], report: [text] })).rejects.toMatchObject({
      response: { error: expect.stringContaining('PDF') },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('count ไม่ใช่จำนวนเต็มบวก = ปฏิเสธ', async () => {
    const { svc } = build();
    await expect(svc.create({ ...dto, count: '0' }, { receipt: [jpeg], report: [pdf] })).rejects.toMatchObject({
      response: { error: expect.stringContaining('จำนวนคัน') },
    });
    await expect(svc.create({ ...dto, count: '2.5' }, { receipt: [jpeg], report: [pdf] })).rejects.toBeTruthy();
  });

  it('บันทึกฐานข้อมูลล้ม = ลบไฟล์ที่อัปโหลดไปแล้วทิ้ง', async () => {
    const { svc, storage } = build(() => Promise.reject(new Error('db down')));
    await expect(svc.create(dto, { receipt: [jpeg], report: [pdf] })).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalledTimes(2);
  });

  it('บันทึก hash ของไฟล์แนบทั้ง 2 ไฟล์', async () => {
    const { svc, create } = build();
    await svc.create(dto, { receipt: [jpeg], report: [pdf] });
    const { data } = create.mock.calls[0][0] as CreateArgs;
    expect(data.attachments.create.map((a) => a.contentHash)).toEqual([contentHashOf(jpeg.buffer), contentHashOf(pdf.buffer)]);
  });

  it('ไฟล์ใบเสร็จเคยแนบกับรายการอื่นแล้ว = ปฏิเสธ "อัพโหลดไปแล้ว" ไม่อัปโหลดอะไรเลย', async () => {
    const { svc, storage } = build(undefined, [contentHashOf(jpeg.buffer)]);
    await expect(svc.create(dto, { receipt: [jpeg], report: [pdf] })).rejects.toMatchObject({
      status: 409,
      response: { error: 'ไฟล์ใบเสร็จนี้อัพโหลดไปแล้ว' },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('ใบเสร็จกับ Report เป็นไฟล์เดียวกัน = ปฏิเสธ', async () => {
    const { svc, storage } = build();
    await expect(svc.create(dto, { receipt: [pdf], report: [pdf] })).rejects.toMatchObject({
      response: { error: 'ไฟล์ใบเสร็จกับไฟล์ Report เป็นไฟล์เดียวกัน' },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('วันที่ที่ไม่มีจริง (31 ก.พ.) = ปฏิเสธ', async () => {
    const { svc, storage } = build();
    await expect(svc.create({ ...dto, date: '2026-02-31' }, { receipt: [jpeg], report: [pdf] })).rejects.toMatchObject({
      response: { error: expect.stringContaining('วันที่') },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });
});

// ผู้ใช้ 2026-09-27: แก้/ยกเลิกรายการที่บันทึกผิดได้ ต้องมีเหตุผล + ประวัติ ยกเลิกไม่ลบแถว และไฟล์เดิมแนบใหม่ได้
describe('YamahaRelocationService - แก้ / ยกเลิกรายการ', () => {
  // จำลอง Prisma.Decimal (มี toFixed/isFinite ให้ audit-log แปลงเป็นข้อความ)
  const dec = (n: number) => ({ toString: () => String(n), toFixed: () => n.toFixed(2), isFinite: () => true });
  const entryRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'e1',
    date: new Date('2026-09-22T00:00:00.000Z'),
    size: 'SMALL',
    count: 30,
    billFee: dec(150),
    noBillFee: dec(300),
    createdAt: new Date('2026-09-22T01:00:00.000Z'),
    cancelledAt: null,
    attachments: [
      { id: 'a1', kind: 'RECEIPT', mimeType: 'image/jpeg', sizeBytes: 5, originalName: 'r.jpg', createdAt: new Date(0) },
      { id: 'a2', kind: 'REPORT', mimeType: 'application/pdf', sizeBytes: 15, originalName: 'rep.pdf', createdAt: new Date(0) },
    ],
    ...overrides,
  });

  function setup(entry: unknown = entryRow(), matched = 1) {
    let current = entry as Record<string, unknown> | null;
    const prisma = {
      $transaction: vi.fn(),
      yamahaRelocationEntry: {
        findUnique: vi.fn(async () => current),
        findUniqueOrThrow: vi.fn(async () => current),
        findMany: vi.fn(async () => []),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (matched) current = { ...current, ...data };
          return { count: matched };
        }),
      },
      yamahaRelocationAttachment: { updateMany: vi.fn(async () => ({ count: 2 })) },
      auditLog: { create: vi.fn(async () => ({ id: 'audit1' })) },
    };
    prisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(prisma));
    const storage = { put: vi.fn(), get: vi.fn(), delete: vi.fn() };
    return { svc: new YamahaRelocationService(prisma as unknown as PrismaService, storage as unknown as ReceiptStorage), prisma };
  }

  it('แก้จำนวนคันต้องมีเหตุผล', async () => {
    const { svc, prisma } = setup();
    await expect(svc.update('e1', { count: '3' })).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่แก้รายการแจ้งย้าย' } });
    expect(prisma.yamahaRelocationEntry.updateMany).not.toHaveBeenCalled();
  });

  it('แก้จำนวนคัน 30 -> 3: คิดค่าธรรมเนียมใหม่ และบันทึกเฉพาะช่องที่เปลี่ยนลงประวัติ', async () => {
    const { svc, prisma } = setup();
    const res = await svc.update('e1', { count: '3', remark: 'พิมพ์เกิน 0' });
    const { where, data } = prisma.yamahaRelocationEntry.updateMany.mock.calls[0][0] as unknown as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(where).toMatchObject({ id: 'e1', cancelledAt: null, count: 30 });
    expect(data).toMatchObject({ count: 3, billFee: 15, noBillFee: 30 });
    const audit = (prisma.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(audit).toMatchObject({
      entity: 'YamahaRelocation',
      entityId: 'e1',
      action: 'update',
      remark: 'พิมพ์เกิน 0',
      changes: { count: { from: 30, to: 3 }, billFee: { from: '150', to: 15 }, noBillFee: { from: '300', to: 30 } },
    });
    expect(Object.keys(audit.changes as object)).not.toContain('date');
    expect(res.entry.count).toBe(3);
  });

  it('ย้ายไปหน้ารถใหญ่: ค่า No bill คิดตามอัตรารถใหญ่', async () => {
    const { svc, prisma } = setup(entryRow({ count: 3, billFee: dec(15), noBillFee: dec(30) }));
    await svc.update('e1', { size: 'LARGE', remark: 'บันทึกผิดหน้า' });
    const { data } = prisma.yamahaRelocationEntry.updateMany.mock.calls[0][0] as unknown as { data: Record<string, unknown> };
    expect(data).toMatchObject({ size: 'LARGE', billFee: 15, noBillFee: 60 });
  });

  it('ไม่มีอะไรเปลี่ยน / ค่าผิด = 400', async () => {
    const { svc } = setup();
    await expect(svc.update('e1', { count: '30', remark: 'x' })).rejects.toMatchObject({ response: { error: 'ไม่มีข้อมูลที่เปลี่ยน' } });
    await expect(svc.update('e1', { count: '0', remark: 'x' })).rejects.toMatchObject({ response: { error: expect.stringContaining('จำนวนคัน') } });
    await expect(svc.update('e1', { date: '2026-13-01', remark: 'x' })).rejects.toMatchObject({ response: { error: expect.stringContaining('วันที่') } });
    await expect(svc.update('e1', { size: 'HUGE', remark: 'x' })).rejects.toMatchObject({ response: { error: expect.stringContaining('ขนาดรถ') } });
  });

  it('มีคนแก้/ยกเลิกไปก่อน = 409 ไม่เขียนประวัติ', async () => {
    const { svc, prisma } = setup(entryRow(), 0);
    await expect(svc.update('e1', { count: '3', remark: 'x' })).rejects.toMatchObject({ status: 409 });
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: ฟอร์มส่งวันที่/ขนาด/จำนวนทุกช่องจากตอนเปิด เดิมเงื่อนไขใช้ค่าที่อ่านในคำขอเดียวกัน ฟอร์มที่เปิดค้างไว้
  // จึงเอาค่าเก่าไปทับการแก้ของอีกคนได้โดยไม่มี 409 - ตอนนี้ฟอร์มส่ง expectedDate/Size/Count (ค่าที่โหลดมา)
  it('ฟอร์มเปิดจากข้อมูลเก่า (ค่าที่โหลดมาไม่ตรงกับในระบบ) = 409 ไม่บันทึก ไม่เขียนประวัติ', async () => {
    const { svc, prisma } = setup(entryRow({ count: 25 })); // อีกคนแก้ 30 -> 25 ไปก่อน
    await expect(
      svc.update('e1', { count: '3', remark: 'x', expectedDate: '2026-09-22', expectedSize: 'SMALL', expectedCount: 30 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.yamahaRelocationEntry.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
    const moved = setup(entryRow({ date: new Date('2026-09-23T00:00:00.000Z') }));
    await expect(moved.svc.update('e1', { count: '3', remark: 'x', expectedDate: '2026-09-22' })).rejects.toMatchObject({ status: 409 });
  });

  it('ค่าที่โหลดมาตรง = ใช้เป็นเงื่อนไขของการบันทึก', async () => {
    const { svc, prisma } = setup();
    await svc.update('e1', { count: '3', remark: 'x', expectedDate: '2026-09-22', expectedSize: 'SMALL', expectedCount: 30 });
    const { where } = prisma.yamahaRelocationEntry.updateMany.mock.calls[0][0] as unknown as { where: Record<string, unknown> };
    expect(where).toEqual({ id: 'e1', cancelledAt: null, date: new Date('2026-09-22T00:00:00.000Z'), size: 'SMALL', count: 30 });
  });

  it('ค่าที่โหลดมาผิดรูปแบบ = 400', async () => {
    const { svc, prisma } = setup();
    await expect(svc.update('e1', { count: '3', remark: 'x', expectedCount: 'สามสิบ' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.update('e1', { count: '3', remark: 'x', expectedSize: 'HUGE' })).rejects.toMatchObject({ status: 400 });
    await expect(svc.update('e1', { count: '3', remark: 'x', expectedDate: '22/09/2026' })).rejects.toMatchObject({ status: 400 });
    expect(prisma.yamahaRelocationEntry.updateMany).not.toHaveBeenCalled();
  });

  it('ยกเลิก: ต้องมีเหตุผล ไม่ลบแถว และล้าง hash ไฟล์แนบให้แนบไฟล์เดิมใหม่ได้', async () => {
    const { svc, prisma } = setup();
    await expect(svc.cancel('e1', '  ')).rejects.toMatchObject({ response: { error: 'กรุณาระบุเหตุผลที่ยกเลิกรายการแจ้งย้าย' } });
    await svc.cancel('e1', 'บันทึกซ้ำ');
    const { data } = prisma.yamahaRelocationEntry.updateMany.mock.calls[0][0] as unknown as { data: Record<string, unknown> };
    expect(data).toMatchObject({ cancelReason: 'บันทึกซ้ำ', cancelledById: null });
    expect(data.cancelledAt).toBeInstanceOf(Date);
    expect(prisma.yamahaRelocationAttachment.updateMany).toHaveBeenCalledWith({ where: { entryId: 'e1' }, data: { contentHash: null } });
    const audit = (prisma.auditLog.create.mock.calls[0] as unknown as [{ data: Record<string, unknown> }])[0].data;
    expect(audit).toMatchObject({ action: 'cancel', changes: { date: '2026-09-22', count: 30, billFee: '150' } });
  });

  it('รายการที่ยกเลิกแล้วแก้/ยกเลิกซ้ำไม่ได้ (409)', async () => {
    const { svc } = setup(entryRow({ cancelledAt: new Date() }));
    await expect(svc.cancel('e1', 'x')).rejects.toMatchObject({ status: 409 });
    await expect(svc.update('e1', { count: '3', remark: 'x' })).rejects.toMatchObject({ status: 409 });
  });

  it('รายการของเดือนไม่รวมรายการที่ยกเลิกแล้ว', async () => {
    const { svc, prisma } = setup();
    await svc.findForMonth('SMALL', '2026-09');
    const { where } = (prisma.yamahaRelocationEntry.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0];
    expect(where).toMatchObject({ size: 'SMALL', cancelledAt: null });
  });
});
