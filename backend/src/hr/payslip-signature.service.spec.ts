import { vi } from 'vitest';
import { requestContext } from '../auth/request-context.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PayslipSignatureService } from './payslip-signature.service.js';

const as = <T>(fn: () => T) => requestContext.run({ user: { id: 'admin1', roles: ['ADMIN'], customerId: null, name: 'ผู้ดูแล' } } as never, fn);

// PNG ขั้นต่ำที่มี IHDR กว้าง x สูง ตามที่ขอ (ตัวตรวจอ่านแค่ magic + IHDR + ขนาดไฟล์)
function png(width: number, height: number, extra = 0): string {
  const b = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return `data:image/png;base64,${b.toString('base64')}`;
}

function setup(existing: unknown = null) {
  const upsert = vi.fn().mockResolvedValue({});
  const deleteMany = vi.fn().mockResolvedValue({ count: existing ? 1 : 0 });
  const auditCreate = vi.fn().mockResolvedValue({ id: 'a1' });
  const row = existing ?? { id: 'payer', signerName: 'ผู้จ่าย', image: new Uint8Array([1, 2, 3]), mimeType: 'image/png', updatedAt: new Date('2026-10-06T00:00:00.000Z'), updatedByName: 'ผู้ดูแล' };
  const prisma = {
    payslipSignature: { findUnique: vi.fn().mockResolvedValue(existing), count: vi.fn().mockResolvedValue(existing ? 1 : 0), upsert, deleteMany },
    auditLog: { create: auditCreate },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(prisma)),
  } as unknown as PrismaService;
  // หลัง set() service อ่านกลับ - ให้ findUnique คืนแถวที่เพิ่งบันทึก
  (prisma.payslipSignature.findUnique as ReturnType<typeof vi.fn>).mockImplementation(async () => (upsert.mock.calls.length || existing ? row : null));
  return { svc: new PayslipSignatureService(prisma), upsert, deleteMany, auditCreate };
}

describe('PayslipSignatureService.set', () => {
  it('stores a valid PNG, trims the name and writes an audit row without the image', async () => {
    const { svc, upsert, auditCreate } = setup();
    const result = await as(() => svc.set({ imageDataUrl: png(400, 160), signerName: '  นาย ผู้จ่าย  ' }));
    expect(upsert.mock.calls[0][0].create).toMatchObject({ id: 'payer', signerName: 'นาย ผู้จ่าย', updatedByName: 'ผู้ดูแล' });
    expect(result.exists).toBe(true);
    const audit = auditCreate.mock.calls[0][0].data;
    expect(audit).toMatchObject({ entity: 'PayslipSignature', action: 'set' });
    expect(JSON.stringify(audit.changes)).not.toContain('base64');
  });

  it('logs a replace when a signature already exists', async () => {
    const { svc, auditCreate } = setup({ id: 'payer', signerName: null, image: new Uint8Array([1]), mimeType: 'image/png', updatedAt: new Date(), updatedByName: null });
    await as(() => svc.set({ imageDataUrl: png(300, 100) }));
    expect(auditCreate.mock.calls[0][0].data.action).toBe('replace');
  });

  it('rejects anything that is not a real PNG of a sensible size', async () => {
    const { svc, upsert } = setup();
    await expect(as(() => svc.set({ imageDataUrl: 'data:image/jpeg;base64,AAAA' }))).rejects.toMatchObject({ response: { error: expect.stringContaining('PNG') } });
    await expect(as(() => svc.set({ imageDataUrl: `data:image/png;base64,${Buffer.from('not a png at all, just text........').toString('base64')}` }))).rejects.toMatchObject({ response: { error: expect.stringContaining('PNG') } });
    await expect(as(() => svc.set({ imageDataUrl: png(5000, 2000) }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ขนาดรูป') } });
    await expect(as(() => svc.set({ imageDataUrl: png(400, 160, 400_000) }))).rejects.toMatchObject({ response: { error: expect.stringContaining('ใหญ่เกินไป') } });
    await expect(as(() => svc.set({}))).rejects.toMatchObject({ response: { error: expect.stringContaining('PNG') } });
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('PayslipSignatureService.remove', () => {
  it('deletes and audits only when there was a signature', async () => {
    const withOne = setup({ id: 'payer', signerName: null, image: new Uint8Array([1]), mimeType: 'image/png', updatedAt: new Date(), updatedByName: null });
    await as(() => withOne.svc.remove());
    expect(withOne.auditCreate.mock.calls[0][0].data.action).toBe('remove');
    const none = setup();
    await as(() => none.svc.remove());
    expect(none.auditCreate).not.toHaveBeenCalled();
  });
});
