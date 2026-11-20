import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import type { VehicleSearchService } from '../vehicle-search/vehicle-search.service.js';
import { MAX_TOOL_ROUNDS } from './ai-chat.js';
import { AiChatService } from './ai-chat.service.js';

// จำลอง AI: ตอบตามลำดับที่กำหนด แล้วเก็บคำขอที่ได้รับไว้ตรวจ
type Reply = { stop_reason: string; content: Array<Record<string, unknown>> };
const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 };

function setup(replies: Reply[], searchResult?: Partial<Awaited<ReturnType<VehicleSearchService['search']>>>) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create = vi.fn((params: Anthropic.MessageCreateParamsNonStreaming) => {
    // เก็บสำเนา (messages ถูกต่อท้ายต่อหลังจากนี้)
    requests.push({ ...params, messages: [...params.messages] });
    const next = replies.shift();
    if (!next) throw new Error('ไม่มีคำตอบจำลองเหลือ');
    return Promise.resolve({ ...next, usage });
  });
  const search = vi.fn().mockResolvedValue({ vehicles: [], total: 0, all: 0, hasMore: false, counts: {}, ...searchResult });
  const searchOtherJobs = vi.fn().mockResolvedValue({ jobs: [], truncated: false, allowed: true });
  const svc = new AiChatService({ search, searchOtherJobs } as unknown as VehicleSearchService);
  (svc as unknown as { client: unknown }).client = { messages: { create } };
  vi.spyOn((svc as unknown as { logger: { log: () => void } }).logger, 'log').mockImplementation(() => undefined);
  return { svc, create, requests, search, searchOtherJobs };
}

const text = (t: string): Reply => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: t }] });
const toolUse = (...calls: Array<{ id: string; name: string; input: Record<string, string> }>): Reply => ({
  stop_reason: 'tool_use',
  content: calls.map((c) => ({ type: 'tool_use', ...c })),
});

describe('AiChatService (จำลอง AI)', () => {
  it('เรียกเครื่องมือแล้วส่งผลกลับ ได้คำตอบสุดท้าย', async () => {
    const { svc, requests } = setup([toolUse({ id: 't1', name: 'run_command', input: { command: 'การเงินค้าง' } }), text('รอรับเงิน 18 ใบ')]);
    const runCommand = vi.fn().mockResolvedValue('รอรับเงิน 18 ใบ ฿1,333,197.53');
    const answer = await svc.ask('ลูกค้าไหนค้างจ่าย', runCommand);
    expect(answer.text).toBe('รอรับเงิน 18 ใบ');
    expect(runCommand).toHaveBeenCalledWith('การเงินค้าง');
    expect(answer.usage).toEqual({ rounds: 2, inputTokens: 200, cachedTokens: 100, outputTokens: 40 });
    // รอบสอง: ส่งคำตอบของ AI (tool_use) + ผลเครื่องมือกลับไปครบ
    const second = requests[1].messages;
    expect(second).toHaveLength(3);
    expect(second[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'รอรับเงิน 18 ใบ ฿1,333,197.53' }] });
    // วันที่ไปกับคำถาม ไม่อยู่ใน system (cache ใช้ได้ทุกวัน)
    expect(String(second[0].content)).toMatch(/^\(วันนี้ \d{4}-\d{2}-\d{2}\)\nลูกค้าไหนค้างจ่าย$/);
    expect(requests[0].model).toBe('claude-sonnet-5-5');
    expect(requests[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('เรียกหลายเครื่องมือในรอบเดียว ผลทั้งหมดอยู่ในข้อความเดียว · เครื่องมือล้ม = is_error ไม่ล้มทั้งคำถาม', async () => {
    const { svc, requests, search } = setup(
      [
        toolUse(
          { id: 'a', name: 'search_vehicles', input: { query: '', status: 'plate', kind: 'any', from: '', to: '' } },
          { id: 'b', name: 'run_command', input: { command: 'งานค้าง' } },
        ),
        text('ตอบ'),
      ],
      { total: 279 },
    );
    const answer = await svc.ask('ค้างป้ายกี่คัน', () => Promise.reject(new Error('ฐานข้อมูลล่ม')));
    expect(answer.text).toBe('ตอบ');
    expect(search).toHaveBeenCalledWith({ q: undefined, status: 'plate', kind: undefined, from: undefined, to: undefined });
    const results = requests[1].messages[2].content as Anthropic.ToolResultBlockParam[];
    expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
    expect(JSON.parse(String(results[0].content)).รถจดใหม่.total).toBe(279);
    expect(results[1]).toMatchObject({ is_error: true, content: 'ดึงข้อมูลไม่สำเร็จ: ฐานข้อมูลล่ม' });
  });

  it('ค้นด้วยคำค้น (ไม่กรองสถานะ) = ค้นงานอื่นๆ ด้วย', async () => {
    const { svc, searchOtherJobs } = setup([toolUse({ id: 'a', name: 'search_vehicles', input: { query: '4813', status: 'any', kind: 'car', from: '', to: '' } }), text('ok')]);
    await svc.ask('รถ 4813', vi.fn());
    expect(searchOtherJobs).toHaveBeenCalledWith(expect.objectContaining({ q: '4813', kind: 'car' }));
  });

  it('ถามต่อเนื่องได้ (จำบทสนทนา) และ reset แล้วเริ่มใหม่', async () => {
    const { svc, requests } = setup([text('ข้อแรก'), text('ข้อสอง'), text('ข้อสาม')]);
    await svc.ask('ถามหนึ่ง', vi.fn());
    await svc.ask('ถามสอง', vi.fn());
    expect(requests[1].messages).toHaveLength(3); // ถามหนึ่ง / ตอบหนึ่ง / ถามสอง
    svc.reset();
    await svc.ask('ถามสาม', vi.fn());
    expect(requests[2].messages).toHaveLength(1);
  });

  it('ถามติดกันสองข้อ ข้อสองรอข้อแรกจบ ไม่ปนกัน', async () => {
    const { svc, requests } = setup([text('หนึ่ง'), text('สอง')]);
    const [a, b] = await Promise.all([svc.ask('ก', vi.fn()), svc.ask('ข', vi.fn())]);
    expect([a.text, b.text]).toEqual(['หนึ่ง', 'สอง']);
    expect(requests[1].messages).toHaveLength(3);
  });

  it('วนเรียกเครื่องมือไม่จบ = หยุดที่จำนวนรอบสูงสุด และไม่เก็บบทสนทนาที่ค้าง', async () => {
    const loop = Array.from({ length: MAX_TOOL_ROUNDS }, (_, i) => toolUse({ id: `t${i}`, name: 'run_command', input: { command: 'งานค้าง' } }));
    const { svc, create, requests } = setup([...loop, text('ใหม่')]);
    const answer = await svc.ask('วน', vi.fn().mockResolvedValue('x'));
    expect(create).toHaveBeenCalledTimes(MAX_TOOL_ROUNDS);
    expect(answer.text).toContain('ค้นหลายรอบเกินไป');
    await svc.ask('ถามใหม่', vi.fn());
    expect(requests[MAX_TOOL_ROUNDS].messages).toHaveLength(1);
  });

  it('AI ปฏิเสธ = ข้อความแจ้ง และเริ่มบทสนทนาใหม่', async () => {
    const { svc, requests } = setup([{ stop_reason: 'refusal', content: [] }, text('ok')]);
    expect((await svc.ask('x', vi.fn())).text).toContain('ตอบไม่ได้');
    await svc.ask('y', vi.fn());
    expect(requests[1].messages).toHaveLength(1);
  });

  it('API ล้ม = โยน error ให้ผู้เรียกแจ้งผู้ใช้ และประวัติเดิมไม่เสีย', async () => {
    const { svc, create, requests } = setup([text('ข้อแรก'), text('ข้อสาม')]);
    await svc.ask('ถามหนึ่ง', vi.fn());
    create.mockImplementationOnce(() => Promise.reject(new Error('529 overloaded')));
    await expect(svc.ask('ถามสอง', vi.fn())).rejects.toThrow('529');
    await svc.ask('ถามสาม', vi.fn());
    expect(requests.at(-1)!.messages).toHaveLength(3); // ถามหนึ่ง / ตอบหนึ่ง / ถามสาม (ข้อที่ล้มไม่ค้าง)
  });

  it('เครื่องมือที่ไม่รู้จัก = is_error', async () => {
    const { svc, requests } = setup([toolUse({ id: 'z', name: 'delete_vehicle', input: {} }), text('ok')]);
    await svc.ask('ลบรถ', vi.fn());
    expect((requests[1].messages[2].content as Anthropic.ToolResultBlockParam[])[0]).toMatchObject({ is_error: true });
  });
});
