import Anthropic from '@anthropic-ai/sdk';
import { Injectable, Logger } from '@nestjs/common';
import { bangkokToday } from '../overview/overview-calculator.js';
import { VehicleSearchService } from '../vehicle-search/vehicle-search.service.js';
import {
  AI_CHAT_MODEL,
  AI_SYSTEM_PROMPT,
  AI_TOOLS,
  CONVERSATION_IDLE_MS,
  MAX_CONVERSATION_MESSAGES,
  MAX_TOOL_ROUNDS,
  clip,
  questionContent,
} from './ai-chat.js';

const SEARCH_SHOWN = 30;

// คำสั่งอ่านอย่างเดียวของเลขา (SecretaryService.readOnlyCommand) - ส่งเข้ามาเป็นฟังก์ชัน ไม่ inject กันวนพึ่งกัน
export type CommandRunner = (command: string) => Promise<string>;

export interface AiAnswer {
  text: string;
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number; rounds: number };
}

// ถามเลขาด้วย AI (ผู้ใช้ 2026-11-20 รอบ 1: อ่านอย่างเดียว) - ใช้เฉพาะไลน์ของเจ้าของ (SecretaryService ตรวจผู้ส่งก่อนเรียก)
// เครื่องมือมีแค่อ่าน: คำสั่งค้นข้อมูลเดิม + ค้นรถ/งาน ไม่มีทางเขียนข้อมูล
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private client: Anthropic | null = null;
  // บทสนทนาเดียว (มีผู้ใช้คนเดียว) เก็บในหน่วยความจำ - ต่อท้ายอย่างเดียว ไม่ตัดกลาง (thinking / cache ใช้ต่อได้) ยาวหรือเงียบนาน = เริ่มใหม่
  private history: Anthropic.MessageParam[] = [];
  private lastAt = 0;
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly vehicleSearch: VehicleSearchService) {}

  private api(): Anthropic {
    this.client ??= new Anthropic();
    return this.client;
  }

  // ทีละคำถาม: ถ้าถามติดกันสองข้อ ข้อสองรอข้อแรกจบก่อน ไม่ให้ประวัติบทสนทนาปนกัน
  ask(question: string, runCommand: CommandRunner): Promise<AiAnswer> {
    const run = this.busy.then(() => this.askNow(question, runCommand));
    this.busy = run.catch(() => undefined);
    return run;
  }

  reset(): void {
    this.history = [];
  }

  private async askNow(question: string, runCommand: CommandRunner): Promise<AiAnswer> {
    const now = Date.now();
    if (now - this.lastAt > CONVERSATION_IDLE_MS || this.history.length > MAX_CONVERSATION_MESSAGES) this.history = [];
    this.lastAt = now;

    // ทำงานกับสำเนา: ถ้าล้มกลางทาง ประวัติเดิมไม่เสีย (ไม่ค้างคำถามที่ไม่มีคำตอบ)
    const messages: Anthropic.MessageParam[] = [...this.history, { role: 'user', content: questionContent(question, bangkokToday()) }];
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, rounds: 0 };

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const response = await this.api().messages.create({
        model: AI_CHAT_MODEL,
        max_tokens: 8000,
        // คุยถามตอบ = effort low (ถูกและเร็ว) ตามคำแนะนำของรุ่นนี้สำหรับแชต ตัวเลขทั้งหมดมาจากเครื่องมืออยู่แล้ว
        output_config: { effort: 'low' },
        // cache อัตโนมัติ: system + tools + ประวัติคุยซ้ำทุกรอบ อ่านจาก cache คิด 10% ของราคาปกติ
        cache_control: { type: 'ephemeral' },
        system: AI_SYSTEM_PROMPT,
        tools: AI_TOOLS,
        messages,
      });
      usage.rounds += 1;
      usage.inputTokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
      usage.cachedTokens += response.usage.cache_read_input_tokens ?? 0;
      usage.outputTokens += response.usage.output_tokens;
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') return this.finish(messages, 'ขออภัย คำถามนี้ตอบไม่ได้ ลองถามแบบอื่น', usage, false);
      const calls = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || calls.length === 0) {
        const text = response.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        return this.finish(messages, text, usage, true);
      }

      // ทุกผลลัพธ์ของรอบเดียวกันอยู่ในข้อความเดียว · เครื่องมือล้ม = บอก AI ว่าล้ม (is_error) ไม่ทิ้งเงียบ
      const results = await Promise.all(
        calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
          try {
            return { type: 'tool_result', tool_use_id: call.id, content: clip(await this.runTool(call, runCommand)) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { type: 'tool_result', tool_use_id: call.id, content: `ดึงข้อมูลไม่สำเร็จ: ${message}`, is_error: true };
          }
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    // วนครบรอบแล้วยังไม่จบ - ไม่เก็บบทสนทนานี้ (ค้างอยู่ที่ผลเครื่องมือ ถามต่อไม่ได้)
    this.logUsage(usage);
    return { text: 'คำถามนี้ต้องค้นหลายรอบเกินไป ลองถามให้แคบลง เช่น ระบุลูกค้าหรือช่วงวันที่', usage };
  }

  private finish(messages: Anthropic.MessageParam[], text: string, usage: AiAnswer['usage'], keep: boolean): AiAnswer {
    this.history = keep ? messages : [];
    this.logUsage(usage);
    return { text, usage };
  }

  // จดจำนวน token ไว้ดูค่าใช้จ่าย (ไม่จดคำถาม/คำตอบ เพราะมียอดเงินลูกค้า)
  private logUsage(u: AiAnswer['usage']): void {
    this.logger.log(`AI เลขา: ${u.rounds} รอบ input ${u.inputTokens} cached ${u.cachedTokens} output ${u.outputTokens} token`);
  }

  private async runTool(call: Anthropic.ToolUseBlock, runCommand: CommandRunner): Promise<string> {
    const input = (call.input ?? {}) as Record<string, string | undefined>;
    if (call.name === 'run_command') return runCommand(String(input.command ?? ''));
    if (call.name === 'search_vehicles') return this.searchVehicles(input);
    throw new Error(`ไม่รู้จักเครื่องมือ ${call.name}`);
  }

  // ค้นรถ + งานอื่นๆ ด้วยตัวค้นเดียวกับหน้า /vehicles - ทำงานนอก request = เห็นทุกประเภทรถ (เจ้าของระบบ)
  private async searchVehicles(input: Record<string, string | undefined>): Promise<string> {
    const pick = (v: string | undefined) => (v && v !== 'any' ? v.trim() : undefined);
    const params = { q: input.query?.trim() || undefined, status: pick(input.status), kind: pick(input.kind), from: pick(input.from), to: pick(input.to) };
    const [found, jobs] = await Promise.all([
      this.vehicleSearch.search(params),
      // งานอื่นๆ ไม่มีตัวกรองขั้นตอน - ค้นเฉพาะตอนมีคำค้น และไม่ได้กรองสถานะของรถจดใหม่
      params.q && !params.status ? this.vehicleSearch.searchOtherJobs(params) : Promise.resolve(null),
    ]);
    const vehicles = found.vehicles.slice(0, SEARCH_SHOWN).map((v) => ({
      รับงาน: v.date,
      ประเภท: v.kind === 'moto' ? 'จักรยานยนต์' : 'รถยนต์',
      ลูกค้า: v.customerName,
      เจ้าของ: v.ownerName,
      ยี่ห้อ: v.brandName,
      เลขถัง: v.chassis,
      ทะเบียน: v.plate,
      สถานะ: v.statuses.length
        ? v.statuses.map((s) => `${s.label} ${s.days} วัน${s.late ? ' (เกินกำหนด)' : ''}${s.reason ? ` - ${s.reason}` : ''}`).join(' / ')
        : 'จบงานแล้ว',
    }));
    const otherJobs = (jobs?.jobs ?? []).slice(0, SEARCH_SHOWN).map((j) => ({
      งาน: j.typeLabel,
      ยื่น: j.date,
      ลูกค้า: j.customerName,
      เจ้าของ: j.ownerName,
      เลขถัง: j.chassis,
      ทะเบียน: j.plate,
      สถานะ: j.cancelled ? 'ยกเลิกแล้ว' : j.status,
    }));
    return JSON.stringify({
      รถจดใหม่: { total: found.total, แสดง: vehicles.length, รายการ: vehicles },
      จำนวนตามสถานะ: found.counts,
      ...(jobs ? { งานอื่นๆ: { แสดง: otherJobs.length, มีมากกว่านี้: jobs.truncated, รายการ: otherJobs } } : {}),
    });
  }
}
