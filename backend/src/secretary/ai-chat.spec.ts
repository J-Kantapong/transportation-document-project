import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OverviewService } from '../overview/overview.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { AI_TOOLS, forcedAiQuestion, looksLikeQuestion, messagesToText, splitReply } from './ai-chat.js';
import type { AiChatService } from './ai-chat.service.js';
import type { LineMessage } from './line-client.js';
import type { LookupService } from './lookup.service.js';
import type { NotesService } from './notes.service.js';
import { SecretaryService } from './secretary.service.js';
import type { StatementService } from './statement.service.js';

describe('forcedAiQuestion', () => {
  it('"ถาม …" = ส่งให้ AI พร้อมตัดคำว่าถามออก', () => {
    expect(forcedAiQuestion('ถาม ยอด SPI เดือนนี้')).toBe('ยอด SPI เดือนนี้');
    expect(forcedAiQuestion('ถามยอด SPI')).toBe('ยอด SPI');
    expect(forcedAiQuestion('ถาม')).toBeNull();
    expect(forcedAiQuestion('ยอด SPI')).toBeNull();
  });
});

describe('looksLikeQuestion', () => {
  it('คำสั่งสั้นเดิมไม่ใช่คำถาม ประโยคยาวเป็นคำถาม', () => {
    expect(looksLikeQuestion('สรุปเย็นวันนี้ใช้')).toBe(false);
    expect(looksLikeQuestion('การเงินค้าง')).toBe(false);
    expect(looksLikeQuestion('รถของ SPI ที่ค้างรับป้ายมีกี่คันครับ')).toBe(true);
  });
});

describe('messagesToText', () => {
  it('การ์ด flex แปลงเป็นข้อความ แถวแนวนอนอยู่บรรทัดเดียว ลิงก์ปุ่มติดไปด้วย', () => {
    const card: LineMessage = {
      type: 'flex',
      altText: 'การเงินค้าง',
      contents: {
        type: 'bubble',
        header: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'การเงินค้าง' }] },
        body: {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: 'รอรับเงิน' }, { type: 'text', text: '฿1,000' }] },
            { type: 'separator' },
          ],
        },
        footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', action: { type: 'uri', label: 'เปิด', uri: 'https://x/billing' } }] },
      },
    };
    expect(messagesToText([{ type: 'text', text: 'หัวข้อ' }, card])).toBe('หัวข้อ\n\nการเงินค้าง\nรอรับเงิน ฿1,000\nเปิด: https://x/billing');
  });

  it('การ์ดที่อ่านข้อความไม่ได้ ใช้ altText', () => {
    expect(messagesToText([{ type: 'flex', altText: 'เมนู', contents: { type: 'bubble' } }])).toBe('เมนู');
  });
});

describe('splitReply', () => {
  it('ตัดตามบรรทัดไม่เกินความยาวต่อข้อความ และไม่เกินจำนวนข้อความ', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `บรรทัด ${i} ${'x'.repeat(20)}`).join('\n');
    const parts = splitReply(lines, 200, 3);
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => p.length <= 200)).toBe(true);
    expect(parts[2]).toContain('คำตอบยาวเกิน');
  });

  it('คำตอบว่าง = ข้อความแจ้ง ไม่ส่งข้อความว่างให้ LINE', () => {
    expect(splitReply('  ')).toEqual(['ขออภัย ไม่มีคำตอบ ลองถามใหม่อีกครั้ง']);
  });
});

describe('AI_TOOLS', () => {
  it('มีแค่เครื่องมืออ่านข้อมูล', () => {
    expect(AI_TOOLS.map((t) => t.name).sort()).toEqual(['run_command', 'search_vehicles']);
  });
});

describe('SecretaryService.answerText กับ AI', () => {
  const ask = vi.fn();
  const reset = vi.fn();
  const lookupRun = vi.fn();
  const notesRun = vi.fn();
  const hasMatch = vi.fn();
  let s: SecretaryService;
  const env = { ...process.env };

  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN; // showLoading ล้มเงียบ ไม่ยิง LINE จริง
    ask.mockReset().mockResolvedValue({ text: 'คำตอบจาก AI', usage: {} });
    lookupRun.mockReset().mockResolvedValue([{ type: 'text', text: 'ผลค้นข้อมูล' }]);
    notesRun.mockReset().mockResolvedValue([{ type: 'text', text: 'ข้อความในตู้' }]);
    hasMatch.mockReset().mockResolvedValue(false);
    s = new SecretaryService(
      {} as OverviewService,
      {} as PrismaService,
      { run: notesRun, hasMatch } as unknown as NotesService,
      {} as StatementService,
      { run: lookupRun } as unknown as LookupService,
      { ask, reset } as unknown as AiChatService,
    );
    vi.spyOn(s, 'answer').mockImplementation((c) => Promise.resolve([{ type: 'text', text: `คำสั่ง ${c}` }]));
  });
  afterEach(() => {
    process.env = { ...env };
  });

  const texts = (m: LineMessage[]) => m.map((x) => (x.type === 'text' ? x.text : x.altText));

  it('ข้อความที่ไม่ตรงคำสั่งไหน = ถาม AI', async () => {
    expect(texts(await s.answerText('สวัสดี วันนี้มีอะไรต้องตามบ้าง'))).toEqual(['คำตอบจาก AI']);
    expect(ask).toHaveBeenCalledWith('สวัสดี วันนี้มีอะไรต้องตามบ้าง', expect.any(Function));
  });

  it('คำสั่งเดิมยังตอบเหมือนเดิม ไม่เสีย token', async () => {
    expect(texts(await s.answerText('งานค้าง'))).toEqual(['ผลค้นข้อมูล']);
    expect(texts(await s.answerText('การเงินค้าง'))).toEqual(['คำสั่ง finance']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('ประโยคยาวที่บังเอิญมีคำสำคัญ ("ค้าง") = ถาม AI', async () => {
    await s.answerText('ลูกค้าไหนค้างจ่ายนานที่สุดและเท่าไหร่');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('"ถาม …" ไป AI เสมอ แม้จะตรงคำสั่งเดิม', async () => {
    await s.answerText('ถาม งานค้าง');
    expect(ask).toHaveBeenCalledWith('งานค้าง', expect.any(Function));
    expect(lookupRun).not.toHaveBeenCalled();
  });

  it('"ขอ …" ที่มีในตู้ = ตู้ข้อความ · ไม่มีในตู้ = ถาม AI', async () => {
    hasMatch.mockResolvedValueOnce(true);
    expect(texts(await s.answerText('ขอ ที่อยู่บริษัท'))).toEqual(['ข้อความในตู้']);
    await s.answerText('ขอดูรถ SPI ที่ยังไม่ได้ป้าย');
    expect(ask).toHaveBeenCalledOnce();
  });

  it('"เริ่มใหม่" ล้างบทสนทนา', async () => {
    await s.answerText('เริ่มใหม่');
    expect(reset).toHaveBeenCalledOnce();
    expect(ask).not.toHaveBeenCalled();
  });

  it('ไม่มี ANTHROPIC_API_KEY = การ์ดเมนูเหมือนเดิม', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    expect(texts(await s.answerText('สวัสดี'))).toEqual(['คำสั่ง menu']);
    expect(ask).not.toHaveBeenCalled();
  });

  it('AI ล้ม = ข้อความแจ้ง ไม่เงียบ', async () => {
    ask.mockRejectedValueOnce(new Error('timeout'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(texts(await s.answerText('สวัสดี'))[0]).toContain('AI ตอบไม่สำเร็จ');
  });

  it('เครื่องมือของ AI: คำสั่งที่แก้ข้อมูล (จำ / ลืม) ถูกบล็อก', async () => {
    expect(await s.readOnlyCommand('จำ ที่อยู่ = 1 ถ.สุขุมวิท')).toContain('แก้ข้อมูล');
    expect(await s.readOnlyCommand('ลืม ที่อยู่')).toContain('แก้ข้อมูล');
    expect(notesRun).not.toHaveBeenCalled();
    expect(await s.readOnlyCommand('เมนู')).toContain('ไม่รู้จักคำสั่ง');
  });
});
