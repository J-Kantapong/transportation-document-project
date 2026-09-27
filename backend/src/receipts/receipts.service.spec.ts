import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import type { UserRole } from '../generated/prisma/enums.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NoAiReceiptExtractor, type ReceiptExtractor } from './receipt-extractor.js';
import { checkReading, isNearChassis, normalizeReceiptDate, type ReceiptReading } from './receipt-extraction.js';
import type { ReceiptStorage } from './receipt-storage.js';
import { ReceiptsService, detectImageType } from './receipts.service.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const file = (buffer = JPEG) => ({ buffer, size: buffer.length, originalname: 'receipt.jpg' });

function setup(submission: unknown = { id: 's1', status: 'PENDING', vehicle: { chassis: 'LS6CME0P7TC914754' } }, receipt: unknown = null, extractor: ReceiptExtractor = new NoAiReceiptExtractor(), pendingByChassis: unknown = null, dups: { saved?: unknown; image?: unknown; byChassis?: unknown } = {}, nearCandidates: unknown[] = []) {
  const storage = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn(), delete: vi.fn().mockResolvedValue(undefined) } satisfies ReceiptStorage;
  const create = vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data }));
  const locked: Record<string, string> = {};
  const prisma = {
    documentSubmission: {
      findUnique: vi.fn().mockResolvedValue(submission),
      // findDuplicate ค้นด้วย receiptNo / OR (รถมีใบเสร็จแล้ว) - matchByChassis ค้นรถที่รอใบเสร็จ
      findFirst: vi.fn().mockImplementation(async ({ where }) =>
        where.receiptNo ? (dups.saved ?? null) : where.OR ? (dups.byChassis ?? null) : pendingByChassis,
      ),
      findMany: vi.fn().mockResolvedValue(nearCandidates),
    },
    receiptImage: {
      create,
      findFirst: vi.fn().mockResolvedValue(dups.image ?? null),
      findUnique: vi.fn().mockResolvedValue(receipt),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      update: vi.fn().mockImplementation(async ({ data }) => ({ id: 'r1', ...data })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    // ล็อกแถวรายการ (SELECT ... FOR UPDATE) คืนสถานะล่าสุด - เทสต์ตั้ง locked[id] เพื่อจำลองสถานะที่เปลี่ยนระหว่างนั้น (ไม่ตั้ง = PENDING)
    $queryRaw: vi.fn(async (_sql: TemplateStringsArray, ids: string[]) => ids.filter((id) => locked[id] !== 'GONE').map((id) => ({ id, status: locked[id] ?? 'PENDING' }))),
  } as unknown as PrismaService;
  Object.assign(prisma, { $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)) });
  const images = (prisma as unknown as { receiptImage: Record<string, ReturnType<typeof vi.fn>> }).receiptImage;
  const submissions = (prisma as unknown as { documentSubmission: Record<string, ReturnType<typeof vi.fn>> }).documentSubmission;
  const lockRows = (prisma as unknown as { $queryRaw: ReturnType<typeof vi.fn> }).$queryRaw;
  return { svc: new ReceiptsService(prisma, storage, extractor), storage, create, images, submissions, locked, lockRows };
}

const CAR = 'รย.1-เก๋ง 4 ประตู';
const MOTO = 'รย.12-รถจักรยานยนต์ส่วนบุคคล';
const as = <T>(roles: UserRole[], fn: () => T): T => requestContext.run({ user: { id: 'u1', roles, customerId: null, name: 'ทดสอบ' } }, fn);

describe('normalizeReceiptDate', () => {
  it('ใบเสร็จเป็น พ.ศ.: ค.ศ. คงเดิม · พ.ศ. ที่ AI ไม่ได้แปลงลบ 543 · วันที่ไม่มีจริงเป็น null', () => {
    expect(normalizeReceiptDate('2026-09-23')).toBe('2026-09-23');
    expect(normalizeReceiptDate('2569-09-23')).toBe('2026-09-23');
    expect(normalizeReceiptDate('2569-02-30')).toBeNull();
    expect(normalizeReceiptDate('23/09/2569')).toBeNull();
    expect(normalizeReceiptDate(null)).toBeNull();
  });
});

describe('detectImageType', () => {
  it('ดูชนิดจาก byte แรก ไม่ใช่นามสกุล', () => {
    expect(detectImageType(JPEG)?.mimeType).toBe('image/jpeg');
    expect(detectImageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))?.mimeType).toBe('image/webp');
    expect(detectImageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });
});

describe('ReceiptsService.upload', () => {
  it('ไม่รับไฟล์ที่ไม่ใช่รูป', async () => {
    const { svc, storage } = setup();
    await expect(svc.upload(file(Buffer.from('%PDF-1.7')), 's1')).rejects.toMatchObject({
      response: { error: expect.stringContaining('JPEG, PNG หรือ WebP') },
    });
    expect(storage.put).not.toHaveBeenCalled();
  });

  it('แนบกับรายการที่รอใบเสร็จ - เก็บไฟล์แล้วบันทึก key โดยยังไม่ใช้ AI', async () => {
    const { svc, storage, create } = setup();
    await svc.upload(file(), 's1');
    const data = create.mock.calls[0][0].data;
    expect(data).toMatchObject({ submissionId: 's1', mimeType: 'image/jpeg', extractionSource: 'NONE' });
    expect(data.storageKey).toMatch(/^receipts\/\d{4}\/\d{2}\/[0-9a-f-]+\.jpg$/);
    expect(storage.put).toHaveBeenCalledWith(data.storageKey, JPEG, 'image/jpeg');
  });

  it('ไม่ส่ง submissionId = อัปโหลดหลายใบ รอจับคู่', async () => {
    const { svc, create } = setup();
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.submissionId).toBeNull();
  });

  it('แนบกับรายการที่ยื่นไม่สำเร็จไม่ได้', async () => {
    const { svc } = setup({ id: 's1', status: 'FAILED', vehicle: { chassis: 'X', body: null } });
    await expect(svc.upload(file(), 's1')).rejects.toMatchObject({ response: { error: expect.stringContaining('ยื่นไม่สำเร็จ') } });
  });

  it('บันทึกฐานข้อมูลไม่สำเร็จ - ลบไฟล์ที่เก็บไปแล้วทิ้ง', async () => {
    const { svc, storage, create } = setup();
    create.mockRejectedValueOnce(new Error('db down'));
    await expect(svc.upload(file(), 's1')).rejects.toThrow('db down');
    expect(storage.delete).toHaveBeenCalledWith(vi.mocked(storage.put).mock.calls[0][0]);
  });

  it('บันทึก hash ของไฟล์ไว้กันอัปโหลดซ้ำ', async () => {
    const { svc, create } = setup();
    await svc.upload(file(), 's1');
    expect(create.mock.calls[0][0].data.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('รูปเดิมอยู่ในระบบแล้ว = ปฏิเสธ "อัพโหลดไปแล้ว" ก่อนเก็บไฟล์และก่อนใช้ AI', async () => {
    const extractor = { source: 'test', extract: vi.fn() } as unknown as ReceiptExtractor;
    const { svc, storage, create } = setup(undefined, { id: 'r0' }, extractor);
    await expect(svc.upload(file(), 's1')).rejects.toMatchObject({ status: 409, response: { error: 'รูปนี้อัพโหลดไปแล้ว' } });
    expect(extractor.extract).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: ตรวจสถานะก่อน AI อ่าน (หลายวินาที) แล้วค่อยเขียน - ระหว่างนั้นอีกคนบันทึกยื่นไม่สำเร็จได้
  it('แนบในแถว: ล็อกแถวรายการก่อนบันทึก ระหว่างนั้นถูกบันทึกยื่นไม่สำเร็จ -> ไม่แนบ และลบไฟล์ที่เก็บไปแล้ว', async () => {
    const { svc, storage, create, locked, lockRows } = setup();
    locked.s1 = 'FAILED';
    await expect(svc.upload(file(), 's1')).rejects.toMatchObject({ status: 400, response: { error: expect.stringContaining('ยื่นไม่สำเร็จ') } });
    expect(lockRows.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(create).not.toHaveBeenCalled();
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });

  it('อัปโหลดรูปเดียวกันพร้อมกัน (unique index ชน) = "อัพโหลดไปแล้ว" และลบไฟล์ที่เก็บไปแล้ว', async () => {
    const { svc, storage, create } = setup();
    create.mockRejectedValueOnce(Object.assign(new Error('unique'), { code: 'P2002', meta: { target: ['contentHash'] } }));
    await expect(svc.upload(file(), 's1')).rejects.toMatchObject({ status: 409, response: { error: 'รูปนี้อัพโหลดไปแล้ว' } });
    expect(storage.delete).toHaveBeenCalledTimes(1);
  });
});

describe('ReceiptsService.remove', () => {
  const attached = (status: string, body = CAR) => ({
    id: 'r1',
    storageKey: 'k',
    submissionId: 's1',
    plateSwapId: null,
    submission: { status, vehicle: { body } },
  });
  const unassigned = { id: 'r1', storageKey: 'k', submissionId: null, plateSwapId: null, submission: null };

  it('ลบรูปของรายการที่รับใบเสร็จแล้วไม่ได้ (หลักฐานวางบิล)', async () => {
    const { svc, storage, images } = setup(undefined, attached('RECEIPT_RECEIVED'));
    await expect(svc.remove('r1')).rejects.toMatchObject({ response: { error: expect.stringContaining('ลบรูปใบเสร็จไม่ได้') } });
    expect(images.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('ลบรูปที่ยังไม่จับคู่ได้ ทั้งแถวและไฟล์ (ลบแบบมีเงื่อนไข - ต้องยังไม่ได้จับคู่)', async () => {
    const { svc, storage, images } = setup(undefined, unassigned);
    await svc.remove('r1');
    expect(images.deleteMany).toHaveBeenCalledWith({ where: { id: 'r1', plateSwapId: null, submissionId: null } });
    expect(storage.delete).toHaveBeenCalledWith('k');
  });

  // พบ 2026-09-27: เดิมไม่ตรวจประเภทรถของรายการที่รูปแนบอยู่
  it('STAFF_MOTO ลบรูปที่แนบกับรถยนต์ไม่ได้', async () => {
    const { svc, storage, images } = setup(undefined, attached('PENDING', CAR));
    await expect(as(['STAFF_MOTO'], () => svc.remove('r1'))).rejects.toMatchObject({ status: 403 });
    expect(images.deleteMany).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  // ข้อความต้องใช้ได้ทั้งถาดและหน้าถ่ายบนมือถือ ("ลบแล้วถ่ายใหม่" - หน้านั้นไม่มีถาด) (พบ 2026-09-27)
  it('ลบจากถาด/หน้าถ่าย (unassignedOnly) แต่อีกเครื่องจับคู่กับรถไปแล้ว -> 409 ไม่ลบ บอกให้ลบจากแถวของรถ', async () => {
    const { svc, images } = setup(undefined, attached('PENDING'));
    await expect(svc.remove('r1', '1')).rejects.toMatchObject({
      status: 409,
      response: { error: 'รูปนี้ถูกจับคู่กับรถไปแล้ว ลบไม่ได้ - ลบได้จากแถวของรถคันนั้นในหน้ารับใบเสร็จ' },
    });
    expect(images.deleteMany).not.toHaveBeenCalled();
  });

  it('ระหว่างกดลบ รูปถูกย้าย/รายการได้ใบเสร็จไปแล้ว (ลบไม่โดนแถวไหน) -> 409 ไม่ลบไฟล์', async () => {
    const { svc, storage, images } = setup(undefined, attached('PENDING'));
    images.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(svc.remove('r1')).rejects.toMatchObject({ status: 409 });
    expect(images.deleteMany.mock.calls[0][0].where).toMatchObject({ submissionId: 's1', submission: { status: { not: 'RECEIPT_RECEIVED' } } });
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('รูปของรายการ: ล็อกแถวรายการก่อนลบ (การบันทึก "ได้ใบเสร็จ" ที่ทำพร้อมกันต้องรอ) · รูปในถาดไม่ต้องล็อก', async () => {
    const { svc, lockRows } = setup(undefined, attached('PENDING'));
    await svc.remove('r1');
    expect(lockRows.mock.calls[0][1]).toEqual(['s1']);
    const tray = setup(undefined, unassigned);
    await tray.svc.remove('r1', '1');
    expect(tray.lockRows).not.toHaveBeenCalled();
  });
});

describe('ReceiptsService.assign - จับคู่เอง', () => {
  const photo = (extra: Record<string, unknown> = {}) => ({ id: 'r1', extraction: null, submissionId: null, plateSwapId: null, submission: null, ...extra });

  it('รูปที่ยังไม่จับคู่ -> จับคู่แบบมีเงื่อนไข (ต้องยังอยู่ที่เดิม)', async () => {
    const { svc, images } = setup(undefined, photo());
    await svc.assign('r1', 's1', true);
    expect(images.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'r1', plateSwapId: null, submissionId: null }, data: { submissionId: 's1' } });
  });

  // พบ 2026-09-27: เดิมย้ายหลักฐานวางบิลออกจากรายการที่รับใบเสร็จแล้วได้ หรือรูปเป็นของงานสลับเลขและรถใหม่พร้อมกัน
  it.each([
    [{ submissionId: 's0', submission: { status: 'RECEIPT_RECEIVED', vehicle: { body: CAR } } }, 'รับใบเสร็จแล้ว'],
    [{ plateSwapId: 'ps1' }, 'งานสลับเลข'],
  ])('ย้ายรูปที่เป็นหลักฐานของรายการอื่นไม่ได้ %j', async (extra, message) => {
    const { svc, images } = setup(undefined, photo(extra));
    await expect(svc.assign('r1', 's1')).rejects.toMatchObject({ response: { error: expect.stringContaining(message) } });
    expect(images.updateMany).not.toHaveBeenCalled();
  });

  it('รูปที่แนบกับรถประเภทอื่นอยู่ ย้ายไม่ได้ (ตรวจขอบเขตรายการเดิม)', async () => {
    const { svc, images } = setup({ id: 's1', status: 'PENDING', vehicle: { chassis: 'X', body: MOTO } }, photo({ submissionId: 's0', submission: { status: 'PENDING', vehicle: { body: CAR } } }));
    await expect(as(['STAFF_MOTO'], () => svc.assign('r1', 's1'))).rejects.toMatchObject({ status: 403 });
    expect(images.updateMany).not.toHaveBeenCalled();
  });

  it('จับคู่จากถาดที่เก่า: อีกเครื่องจับคู่รูปนี้กับรถคันอื่นไปแล้ว -> 409', async () => {
    const { svc, images } = setup(undefined, photo({ submissionId: 's0', submission: { status: 'PENDING', vehicle: { body: CAR } } }));
    await expect(svc.assign('r1', 's1', true)).rejects.toMatchObject({ status: 409 });
    expect(images.updateMany).not.toHaveBeenCalled();
  });

  // พบ 2026-09-27: ตรวจสถานะแล้วค่อยเขียน - ระหว่างนั้นอีกคนบันทึกใบยื่นได้ ล็อกแถวรายการทั้งสองก่อนแล้วดูสถานะล่าสุด
  it('ย้ายรูประหว่างรายการ: ล็อกรายการเดิมและรายการใหม่ (เรียงตาม id) แล้วเขียนเฉพาะที่รายการเดิมยังไม่ได้ใบเสร็จ', async () => {
    const { svc, images, lockRows } = setup(undefined, photo({ submissionId: 's9', submission: { status: 'PENDING', vehicle: { body: CAR } } }));
    await svc.assign('r1', 's1');
    expect(lockRows.mock.calls[0][0].join('?')).toContain('FOR UPDATE');
    expect(lockRows.mock.calls[0][1]).toEqual(['s1', 's9']);
    expect(images.updateMany.mock.calls[0][0].where).toEqual({ id: 'r1', plateSwapId: null, submissionId: 's9', submission: { status: { not: 'RECEIPT_RECEIVED' } } });
  });

  it('ระหว่างนั้นรายการใหม่ถูกบันทึกยื่นไม่สำเร็จ -> ไม่แนบ (รูปจะค้างกับรายการที่ไม่มีหน้าไหนเข้าถึง)', async () => {
    const { svc, images, locked } = setup(undefined, photo());
    locked.s1 = 'FAILED';
    await expect(svc.assign('r1', 's1', true)).rejects.toMatchObject({ status: 400, response: { error: expect.stringContaining('ยื่นไม่สำเร็จ') } });
    expect(images.updateMany).not.toHaveBeenCalled();
  });

  it('ระหว่างนั้นรายการเดิมเพิ่งได้ใบเสร็จ -> ไม่ย้ายหลักฐานวางบิลออก', async () => {
    const { svc, images, locked } = setup(undefined, photo({ submissionId: 's9', submission: { status: 'PENDING', vehicle: { body: CAR } } }));
    locked.s9 = 'RECEIPT_RECEIVED';
    await expect(svc.assign('r1', 's1')).rejects.toMatchObject({ response: { error: expect.stringContaining('รับใบเสร็จแล้ว') } });
    expect(images.updateMany).not.toHaveBeenCalled();
  });

  it('ระหว่างนั้นรายการใหม่ถูกยกเลิก -> ไม่พบ / รูปถูกย้ายหรือลบไปแล้ว (เขียนไม่โดนแถวไหน) -> 409', async () => {
    const gone = setup(undefined, photo());
    gone.locked.s1 = 'GONE';
    await expect(gone.svc.assign('r1', 's1', true)).rejects.toMatchObject({ status: 404 });
    const moved = setup(undefined, photo());
    moved.images.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(moved.svc.assign('r1', 's1', true)).rejects.toMatchObject({ status: 409 });
  });
});

describe('ReceiptsService - ขอบเขตการดูรูป / ถาดรอจับคู่', () => {
  it('ถามผลรูปหลายรูป: เห็นเฉพาะรูปที่ยังไม่จับคู่ หรือของรถในขอบเขตการอ่าน', async () => {
    const { svc, images } = setup();
    await as(['STAFF_MOTO'], () => svc.findByIds('a,b'));
    expect(images.findMany.mock.calls[0][0].where).toEqual({
      id: { in: ['a', 'b'] },
      OR: [{ submissionId: null }, { submission: { vehicle: { AND: [{ body: { startsWith: 'รย.12-' } }] } } }],
    });
  });

  it('ดูรูปของรถนอกขอบเขต -> ไม่พบ', async () => {
    const { svc, images } = setup();
    images.findFirst.mockResolvedValueOnce(null);
    await expect(as(['STAFF_CAR'], () => svc.getImage('r1'))).rejects.toMatchObject({ status: 404 });
    expect(images.findFirst.mock.calls[0][0].where.OR).toHaveLength(2);
  });

  it('ถาดรอจับคู่: บอกจำนวนทั้งหมด และโหลดเพิ่มด้วย offset', async () => {
    const { svc, images } = setup();
    images.findMany.mockResolvedValueOnce([{ id: 'r201' }]);
    images.count.mockResolvedValueOnce(201);
    const res = await svc.listUnassigned('200');
    expect(images.findMany.mock.calls[0][0]).toMatchObject({ where: { submissionId: null, plateSwapId: null }, skip: 200, take: 200 });
    expect(res).toEqual({ receipts: [{ id: 'r201' }], total: 201, hasMore: false });
    await expect(svc.listUnassigned('-1')).rejects.toMatchObject({ status: 400 });
  });
});

const READING: ReceiptReading = {
  receiptNo: '69/0035358',
  date: '2026-09-07',
  plateCategory: '8ขก',
  plateNumber: '3484',
  chassis: 'LS6CME0P7TC914754',
  weightKg: 1850,
  items: [5, 50, 200, 100, 1600].map((amount) => ({ label: 'x', amount })),
  total: 1955,
  uncertainFields: [],
};
const aiReading = (reading: ReceiptReading): ReceiptExtractor => ({
  source: 'claude-sonnet-5',
  extract: () => Promise.resolve({ reading, checks: checkReading(reading), usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 0 } }),
});

describe('ReceiptsService.upload - จับคู่ด้วยเลขตัวถังที่ AI อ่าน', () => {
  it('อัปโหลดหลายใบ: เลขตัวถังตรงกับรถที่รอใบเสร็จ -> แนบให้เลย', async () => {
    const { svc, create, submissions } = setup(undefined, null, aiReading(READING), { id: 's9' });
    await svc.upload(file());
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBe('s9');
    expect(data.extraction.match).toBe('chassis');
    // เลขตัวถังที่คีย์ไว้เป็นตัวเล็กก็ต้องเจอ (พบ 2026-09-27)
    expect(submissions.findFirst.mock.calls.at(-1)![0].where.vehicle.chassis).toEqual({ equals: 'LS6CME0P7TC914754', mode: 'insensitive' });
  });

  it('อัปโหลดหลายใบ: รถที่จับคู่ได้ไม่ได้รอใบเสร็จแล้วตอนบันทึก (ล็อกแล้วดูสถานะ) -> รอในถาดแทน ไม่ error', async () => {
    const { svc, create, locked } = setup(undefined, null, aiReading(READING), { id: 's9' });
    locked.s9 = 'FAILED';
    await svc.upload(file());
    expect(create.mock.calls[0][0].data).toMatchObject({ submissionId: null, extraction: { match: null } });
  });

  it('อัปโหลดหลายใบ: ไม่เจอรถ -> รอจับคู่', async () => {
    const { svc, create } = setup(undefined, null, aiReading(READING), null);
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.submissionId).toBeNull();
  });

  it('แนบในแถวแต่เลขตัวถังในใบเสร็จเป็นของรถคันอื่น -> เตือน', async () => {
    const { svc, create } = setup(undefined, null, aiReading({ ...READING, chassis: 'LS6CME0P2TC915746' }));
    await svc.upload(file(), 's1');
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBe('s1');
    expect(data.extraction.match).toBe('chassis-mismatch');
  });

  // เคสจริง 2026-09-24: AI อ่าน MLTZT1509TX007960 เป็น METZT1509TX007960
  const MOTO_READ = { ...READING, chassis: 'METZT1509TX007960' };
  const moto = (id: string, chassis: string) => ({ id, vehicle: { chassis } });

  it('อัปโหลดหลายใบ: ไม่ตรงเป๊ะแต่ใกล้เคียงคันเดียว -> แนบให้ พร้อมให้เช็ก', async () => {
    const { svc, create } = setup(undefined, null, aiReading(MOTO_READ), null, {}, [moto('s7', 'MLTZT1509TX007960')]);
    await svc.upload(file());
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBe('s7');
    expect(data.extraction.match).toBe('chassis-near');
  });

  it('อัปโหลดหลายใบ: ใกล้เคียงหลายคัน -> ไม่เดา รอจับคู่', async () => {
    const { svc, create } = setup(undefined, null, aiReading(MOTO_READ), null, {}, [moto('s7', 'MLTZT1509TX007960'), moto('s8', 'MXTZT1509TX007960')]);
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.submissionId).toBeNull();
  });

  it('แนบในแถว: เลขตัวถังใกล้เคียงกับรถคันนั้น -> ไม่นับเป็นรถคันอื่น', async () => {
    const { svc, create } = setup({ id: 's1', status: 'PENDING', vehicle: { chassis: 'MLTZT1509TX007960' } }, null, aiReading(MOTO_READ));
    await svc.upload(file(), 's1');
    expect(create.mock.calls[0][0].data.extraction.match).toBe('chassis-near');
  });
});

describe('ReceiptsService.upload - อ่านเบื้องหลัง (background)', () => {
  // findUnique: เช็ก hash ซ้ำ -> readOne โหลดรูป -> ก่อนบันทึกผล (ดูว่าพนักงานจับคู่เองไปแล้วหรือยัง)
  function backgroundSetup(extractor: ReceiptExtractor, submissionIdWhileReading: string | null = null) {
    const ctx = setup(undefined, null, extractor, { id: 's9' });
    const prisma = (ctx.svc as unknown as { prisma: { receiptImage: Record<string, ReturnType<typeof vi.fn>> } }).prisma;
    prisma.receiptImage.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ storageKey: 'k', mimeType: 'image/jpeg', readPending: true })
      .mockResolvedValueOnce({ submissionId: submissionIdWhileReading });
    vi.mocked(ctx.storage.get).mockResolvedValue(JPEG);
    return { ...ctx, update: prisma.receiptImage.update };
  }

  it('ตอบทันทีโดยยังไม่อ่าน แล้ว AI อ่านและจับคู่ให้ทีหลัง', async () => {
    const extract = vi.fn(aiReading(READING).extract);
    const { svc, create, update } = backgroundSetup({ source: 'claude-sonnet-5', extract });
    const { receipt } = await svc.upload(file(), undefined, '1');
    expect(create.mock.calls[0][0].data).toMatchObject({ readPending: true, submissionId: null });
    expect(create.mock.calls[0][0].data.extraction).toBeUndefined();
    expect(receipt).toMatchObject({ readPending: true });
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(extract).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toMatchObject({ readPending: false, submissionId: 's9', extraction: { match: 'chassis' } });
  });

  it('พนักงานจับคู่เองระหว่างรออ่าน -> คงรถที่เลือกไว้', async () => {
    const { svc, update } = backgroundSetup(aiReading(READING), 's1');
    await svc.upload(file(), undefined, '1');
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].data.submissionId).toBe('s1');
  });

  it('รถที่ AI จับคู่ได้ถูกบันทึกยื่นไม่สำเร็จระหว่างนั้น (ล็อกแล้วดูสถานะ) -> ไม่แนบ รอในถาดพร้อมผลอ่าน', async () => {
    const { svc, update, locked } = backgroundSetup(aiReading(READING));
    locked.s9 = 'FAILED';
    await svc.upload(file(), undefined, '1');
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    expect(update.mock.calls[0][0].data).toMatchObject({ readPending: false, submissionId: null, extraction: { match: null } });
  });

  // พบ 2026-09-27: เดิมบันทึกผลพังแล้วรูปค้าง "กำลังอ่าน" จนรีสตาร์ท (แล้วจ่าย AI ซ้ำ)
  it('บันทึกผลอ่านไม่สำเร็จ (รายการที่จับคู่ถูกยกเลิกระหว่างนั้น) -> เลิกสถานะรออ่าน เก็บผลอ่านไว้แต่ไม่จับคู่', async () => {
    const { svc, update, images } = backgroundSetup(aiReading(READING));
    update.mockRejectedValueOnce(Object.assign(new Error('fk'), { code: 'P2003' }));
    await svc.upload(file(), undefined, '1');
    await vi.waitFor(() => expect(images.updateMany).toHaveBeenCalled());
    expect(images.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'r1', readPending: true },
      data: { readPending: false, extraction: { reading: { chassis: 'LS6CME0P7TC914754' }, match: null, duplicate: null } },
    });
  });

  it('ไม่มี AI หรือแนบในแถวรถ -> ไม่ใช้แบบเบื้องหลัง', async () => {
    const { svc, create } = setup();
    await svc.upload(file(), undefined, '1');
    expect(create.mock.calls[0][0].data.readPending).toBe(false);
    const withAi = setup(undefined, null, aiReading(READING));
    await withAi.svc.upload(file(), 's1', '1');
    expect(withAi.create.mock.calls[0][0].data).toMatchObject({ readPending: false, submissionId: 's1' });
  });
});

describe('isNearChassis', () => {
  it('11 ตัวแรกต่างได้ไม่เกิน 2 ตัว เลขท้าย 6 ตัวต้องตรง', () => {
    expect(isNearChassis('METZT1509TX007960', 'MLTZT1509TX007960')).toBe(true);
    expect(isNearChassis('MEXZT1509TX007960', 'MLTZT1509TX007960')).toBe(true);
    expect(isNearChassis('MEXYT1509TX007960', 'MLTZT1509TX007960')).toBe(false);
    // รถล็อตเดียวกันเลขเรียงกัน - อ่านเลขท้ายผิดตัวเดียวก็เป็นคนละคัน
    expect(isNearChassis('MLTZT1509TX007966', 'MLTZT1509TX007960')).toBe(false);
    expect(isNearChassis('MLTZT1509TX007960', 'MLTZT1509TX007960')).toBe(false);
    expect(isNearChassis('MLTZT1509TX00796', 'MLTZT1509TX007960')).toBe(false);
  });
});

describe('ReceiptsService.upload - เตือนใบเสร็จซ้ำจากข้อมูลที่ AI อ่าน', () => {
  it('ไม่ซ้ำ = duplicate เป็น null', async () => {
    const { svc, create } = setup(undefined, null, aiReading(READING), { id: 's9' });
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.extraction.duplicate).toBeNull();
  });

  it('เลขที่ใบเสร็จตรงกับที่ยืนยันไว้แล้ว -> เตือน และไม่แนบให้อัตโนมัติ (รอในถาด)', async () => {
    const saved = { receiptReceivedDate: new Date('2026-09-10T00:00:00Z'), vehicle: { chassis: 'LS6CME0P7TC914754' } };
    const { svc, create } = setup(undefined, null, aiReading(READING), { id: 's9' }, { saved });
    await svc.upload(file());
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBeNull();
    expect(data.extraction.duplicate).toEqual({ by: 'receiptNo', receiptNo: '69/0035358', chassis: 'LS6CME0P7TC914754', receivedDate: '2026-09-10' });
  });

  it('เลขที่ใบเสร็จตรงกับรูปอื่นที่อัปโหลดไว้ (ยังไม่จับคู่) -> เตือน ใช้เลขตัวถังจากผลอ่านของรูปนั้น', async () => {
    const image = { extraction: { reading: { chassis: 'LS6CME0P7TC914754' } }, submission: null };
    const { svc, create } = setup(undefined, null, aiReading(READING), null, { image });
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.extraction.duplicate).toMatchObject({ by: 'receiptNo', chassis: 'LS6CME0P7TC914754', receivedDate: null });
  });

  it('รถคันนี้มีใบเสร็จแล้ว (เลขตัวถัง) -> เตือน', async () => {
    const byChassis = { receiptNo: '69/0000001', receiptReceivedDate: null };
    const { svc, create } = setup(undefined, null, aiReading(READING), null, { byChassis });
    await svc.upload(file());
    expect(create.mock.calls[0][0].data.extraction.duplicate).toEqual({ by: 'chassis', receiptNo: '69/0000001', chassis: 'LS6CME0P7TC914754', receivedDate: null });
  });

  it('แนบในแถวรถแล้วซ้ำ -> ยังแนบตามที่พนักงานเลือก แต่เตือน', async () => {
    const byChassis = { receiptNo: null, receiptReceivedDate: null };
    const { svc, create } = setup(undefined, null, aiReading(READING), null, { byChassis });
    await svc.upload(file(), 's1');
    const data = create.mock.calls[0][0].data;
    expect(data.submissionId).toBe('s1');
    expect(data.extraction.duplicate).toMatchObject({ by: 'chassis' });
  });
});

describe('checkReading - ตรวจอัตโนมัติ', () => {
  it('ใบที่อ่านถูกผ่านทุกข้อ', () => {
    expect(checkReading(READING)).toEqual({ chassisValid: true, receiptNoValid: true, plateValid: true, itemsSumMatchesTotal: true });
  });

  it('จับเลขตัวถังขาดหลัก / มีตัว O / รายการรวมไม่เท่ายอด / ทะเบียนผิดรูป', () => {
    expect(checkReading({ ...READING, chassis: 'LS6CMEP7TC914754' }).chassisValid).toBe(false);
    expect(checkReading({ ...READING, chassis: 'LS6CMEOP4TC915148' }).chassisValid).toBe(false);
    expect(checkReading({ ...READING, total: 1980 }).itemsSumMatchesTotal).toBe(false);
    expect(checkReading({ ...READING, plateCategory: '8ยถก' }).plateValid).toBe(false);
  });

  it('เลขที่ใบเสร็จไม่ล็อกว่าต้องขึ้นต้น 69', () => {
    expect(checkReading({ ...READING, receiptNo: '70/0000001' }).receiptNoValid).toBe(true);
  });
});
