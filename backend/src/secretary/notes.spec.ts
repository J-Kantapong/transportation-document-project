import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { NotesService } from './notes.service.js';
import { MAX_NOTES, noteKey, parseNoteCommand } from './notes.js';

describe('parseNoteCommand', () => {
  it('จำ ชื่อ = ข้อความ (แยกที่ = หรือ : ตัวแรก เก็บข้อความหลายบรรทัดครบ)', () => {
    expect(parseNoteCommand('จำ ที่อยู่บริษัท = 123 ถ.สุขุมวิท')).toEqual({ type: 'save', title: 'ที่อยู่บริษัท', value: '123 ถ.สุขุมวิท' });
    expect(parseNoteCommand('จำที่อยู่บริษัท:บรรทัด 1\nบรรทัด 2 = ต่อ')).toEqual({ type: 'save', title: 'ที่อยู่บริษัท', value: 'บรรทัด 1\nบรรทัด 2 = ต่อ' });
  });

  it('จำ แต่ไม่มีข้อความ = พิมพ์ผิดรูปแบบ', () => {
    expect(parseNoteCommand('จำ ที่อยู่บริษัท')).toEqual({ type: 'invalid-save' });
    expect(parseNoteCommand('จำ')).toEqual({ type: 'invalid-save' });
    expect(parseNoteCommand('จำ ชื่อ =')).toEqual({ type: 'invalid-save' });
  });

  it('ขอ / ลืม / ตู้เอกสาร', () => {
    expect(parseNoteCommand('ขอ ที่อยู่')).toEqual({ type: 'get', query: 'ที่อยู่' });
    expect(parseNoteCommand('ขอที่อยู่บริษัท')).toEqual({ type: 'get', query: 'ที่อยู่บริษัท' });
    expect(parseNoteCommand('ลืม ที่อยู่บริษัท')).toEqual({ type: 'forget', query: 'ที่อยู่บริษัท' });
    expect(parseNoteCommand('ตู้เอกสาร')).toEqual({ type: 'list' });
    expect(parseNoteCommand(' ตู้ ')).toEqual({ type: 'list' });
  });

  it('ข้อความอื่นไม่ใช่คำสั่งตู้ (ปล่อยให้ไปจับเป็นคำสั่งสรุป)', () => {
    expect(parseNoteCommand('สรุปเช้า')).toBeNull();
    expect(parseNoteCommand('ค้างจ่าย')).toBeNull();
    expect(parseNoteCommand('ขอ')).toBeNull();
    expect(parseNoteCommand('ลืม')).toBeNull();
  });

  it('key เทียบชื่อโดยไม่สนช่องว่างและตัวพิมพ์', () => {
    expect(noteKey(' ที่อยู่  บริษัท ')).toBe('ที่อยู่บริษัท');
    expect(noteKey('Tax ID')).toBe('taxid');
  });
});

// ตารางจำลองในหน่วยความจำ - ทำเฉพาะเมธอดที่ NotesService ใช้
function fakePrisma() {
  const rows = new Map<string, { key: string; title: string; value: string }>();
  const note = {
    findUnique: vi.fn(({ where }: { where: { key: string } }) => Promise.resolve(rows.get(where.key) ?? null)),
    count: vi.fn(() => Promise.resolve(rows.size)),
    upsert: vi.fn(({ where, create, update }: { where: { key: string }; create: { key: string; title: string; value: string }; update: { title: string; value: string } }) => {
      rows.set(where.key, rows.has(where.key) ? { ...rows.get(where.key)!, ...update } : create);
      return Promise.resolve();
    }),
    delete: vi.fn(({ where }: { where: { key: string } }) => {
      rows.delete(where.key);
      return Promise.resolve();
    }),
    findMany: vi.fn(({ where }: { where?: { key: { contains: string } } } = {}) =>
      Promise.resolve([...rows.values()].filter((r) => !where || r.key.includes(where.key.contains)).sort((a, b) => a.title.localeCompare(b.title, 'th'))),
    ),
  };
  return { rows, service: new NotesService({ secretaryNote: note } as unknown as PrismaService), note };
}

const texts = (messages: Array<{ type: string; text?: string }>) => messages.map((m) => m.text);

describe('NotesService', () => {
  it('จำ แล้วขอคืนได้ (ชื่อบับเบิลหนึ่ง ค่าอีกบับเบิลเพื่อกดคัดลอกเฉพาะค่า)', async () => {
    const { service } = fakePrisma();
    expect(texts(await service.run({ type: 'save', title: 'ที่อยู่บริษัท', value: '123 ถ.สุขุมวิท' }))).toEqual(['จำ "ที่อยู่บริษัท" แล้ว']);
    expect(texts(await service.run({ type: 'get', query: 'ที่อยู่ บริษัท' }))).toEqual(['ที่อยู่บริษัท', '123 ถ.สุขุมวิท']);
  });

  it('จำซ้ำชื่อเดิม = ทับ และส่งค่าเดิมกลับให้', async () => {
    const { service, rows } = fakePrisma();
    await service.run({ type: 'save', title: 'เลขภาษี', value: 'AAA' });
    const out = await service.run({ type: 'save', title: 'เลขภาษี', value: 'BBB' });
    expect(texts(out)).toEqual(['อัปเดต "เลขภาษี" แล้ว\nค่าเดิม:', 'AAA']);
    expect(rows.get('เลขภาษี')?.value).toBe('BBB');
  });

  it('ขอแบบพิมพ์บางคำ: เจอเดียวส่งเลย หลายอันให้เลือก ไม่เจอบอกตรงๆ', async () => {
    const { service } = fakePrisma();
    await service.run({ type: 'save', title: 'ที่อยู่บริษัท', value: 'A' });
    await service.run({ type: 'save', title: 'ที่อยู่โกดัง', value: 'B' });
    await service.run({ type: 'save', title: 'เลขภาษี', value: 'C' });
    expect(texts(await service.run({ type: 'get', query: 'ภาษี' }))).toEqual(['เลขภาษี', 'C']);
    const many = texts(await service.run({ type: 'get', query: 'ที่อยู่' }))[0];
    expect(many).toContain('เจอหลายรายการ');
    expect(many).toContain('• ที่อยู่บริษัท');
    expect(many).toContain('• ที่อยู่โกดัง');
    expect(texts(await service.run({ type: 'get', query: 'ไม่มีแน่' }))[0]).toContain('ไม่พบ');
  });

  it('ลืม: ลบได้เฉพาะชื่อที่ตรงตัว และส่งค่าที่ลบกลับให้', async () => {
    const { service, rows } = fakePrisma();
    await service.run({ type: 'save', title: 'ที่อยู่บริษัท', value: 'A' });
    expect(texts(await service.run({ type: 'forget', query: 'ที่อยู่' }))[0]).toContain('ไม่พบ');
    expect(rows.size).toBe(1);
    expect(texts(await service.run({ type: 'forget', query: 'ที่อยู่บริษัท' }))).toEqual(['ลืม "ที่อยู่บริษัท" แล้ว ค่าที่ลบ:', 'A']);
    expect(rows.size).toBe(0);
  });

  it('ตู้เต็มแล้วไม่รับรายการใหม่ แต่ยังทับของเดิมได้ · ข้อความยาวเกินถูกปฏิเสธ', async () => {
    const { service, rows, note } = fakePrisma();
    note.count.mockResolvedValue(MAX_NOTES);
    expect(texts(await service.run({ type: 'save', title: 'ใหม่', value: 'x' }))[0]).toContain('ตู้เต็ม');
    expect(rows.size).toBe(0);
    rows.set('เก่า', { key: 'เก่า', title: 'เก่า', value: 'old' });
    expect(texts(await service.run({ type: 'save', title: 'เก่า', value: 'new' }))[0]).toContain('อัปเดต');
    expect(texts(await service.run({ type: 'save', title: 'ยาว', value: 'ก'.repeat(2001) }))[0]).toContain('ยาวเกิน');
  });

  it('ตู้ว่างแสดงวิธีใช้ ตู้มีของแสดงรายการ', async () => {
    const { service } = fakePrisma();
    expect(texts(await service.run({ type: 'list' }))[0]).toContain('จำ ที่อยู่บริษัท');
    await service.run({ type: 'save', title: 'เลขภาษี', value: 'C' });
    expect(texts(await service.run({ type: 'list' }))[0]).toContain('• เลขภาษี');
  });
});
