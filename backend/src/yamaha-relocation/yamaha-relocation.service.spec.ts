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
});
