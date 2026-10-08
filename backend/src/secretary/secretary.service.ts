import { Injectable } from '@nestjs/common';
import { bangkokToday } from '../overview/overview-calculator.js';
import { OverviewService } from '../overview/overview.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseCommand, type Command } from './commands.js';
import { buildEveningMessage, type EveningInput } from './evening-message.js';
import { lineConfigFromEnv, pushLine, replyLine, type LineMessage } from './line-client.js';
import type { LineEvent } from './line-webhook.js';
import { NotesService } from './notes.service.js';
import { parseNoteCommand } from './notes.js';
import { buildMorningMessage } from './morning-message.js';
import type { Slot } from './run-key.js';
import { helpText, overdueText, spendText, stuckText, textMessage, withQuickReply } from './replies.js';

// เลขาส่วนตัว (ผู้ใช้ 2026-10-07): ดึงตัวเลขจากภาพรวมผู้บริหารแล้วส่งการ์ดเข้าไลน์ส่วนตัวของเจ้าของ
// ไม่ผ่านผู้ใช้/สิทธิ์ของคำขอ HTTP (ทำงานนอก request = ไม่จำกัดประเภทรถ) - ผู้เรียกต้องเป็นระบบเองเท่านั้น
@Injectable()
export class SecretaryService {
  constructor(
    private readonly overviewService: OverviewService,
    private readonly prisma: PrismaService,
    private readonly notes: NotesService,
  ) {}

  // ที่อยู่เว็บสำหรับลิงก์ในการ์ด (ใช้ FRONTEND_ORIGIN ถ้าตั้งไว้เป็น URL จริง - ไม่ตั้ง = การ์ดไม่มีลิงก์)
  private baseUrl(): string | undefined {
    const origin = process.env.FRONTEND_ORIGIN?.trim();
    return origin && /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : undefined;
  }

  private async morningMessage(): Promise<LineMessage[]> {
    return buildMorningMessage(await this.overviewService.overview(), this.baseUrl());
  }

  private async eveningMessage(): Promise<LineMessage[]> {
    const overview = await this.overviewService.overview();
    const staff = await this.staffActivity(overview.today);
    return buildEveningMessage({ ...overview, staff }, this.baseUrl());
  }

  // ส่งตามเวลาโดยตัวตั้งเวลา (GitHub Actions) - รอบเดียวกันของวันเดียวกัน (เวลาไทย) ส่งครั้งเดียว: ถ้า retry หลังส่งสำเร็จแล้วจะข้าม
  // จำในหน่วยความจำ (เซิร์ฟเวอร์รีสตาร์ท = ลืม) พอสำหรับกัน retry ติดกัน
  private readonly sentSlots = new Set<string>();

  async runScheduled(slot: Slot): Promise<{ sent: boolean; skipped?: 'already-sent' }> {
    const id = `${bangkokToday()}:${slot}`;
    if (this.sentSlots.has(id)) return { sent: false, skipped: 'already-sent' };
    if (slot === 'morning') await this.sendMorning();
    else await this.sendEvening();
    this.sentSlots.clear(); // เก็บเฉพาะวันนี้ ไม่ให้โตไม่สิ้นสุด
    this.sentSlots.add(id);
    return { sent: true };
  }

  async sendMorning(): Promise<void> {
    await pushLine(await this.morningMessage());
  }

  async sendEvening(): Promise<void> {
    await pushLine(await this.eveningMessage());
  }

  // คำตอบของคำสั่งในไลน์ (แบบ A: ไม่ใช้ AI)
  async answer(command: Command): Promise<LineMessage[]> {
    switch (command) {
      case 'morning':
        return this.morningMessage();
      case 'evening':
        return this.eveningMessage();
      case 'overdue':
        return [textMessage(overdueText(await this.overviewService.overview()))];
      case 'stuck':
        return [textMessage(stuckText(await this.overviewService.overview()))];
      case 'spend':
        return [textMessage(spendText(await this.overviewService.overview()))];
      default:
        return [textMessage(helpText())];
    }
  }

  // ข้อความที่ผู้ใช้พิมพ์ในแชตกับบอท (LINE ส่งมาที่ webhook) - ตอบเฉพาะเจ้าของ คนอื่นเงียบ ไม่ตอบอะไรเลย
  // ไม่ throw: webhook ตอบ LINE ไปแล้ว งานนี้ทำต่อเบื้องหลัง
  async handleEvents(events: LineEvent[]): Promise<void> {
    const owner = lineConfigFromEnv().userId;
    for (const event of events) {
      if (event.type !== 'message' || event.message?.type !== 'text' || !event.replyToken) continue;
      if (event.source?.userId !== owner) continue;
      if (event.deliveryContext?.isRedelivery) continue; // LINE ส่งซ้ำเมื่อไม่ได้รับตอบ - กันตอบสองรอบ

      let messages: LineMessage[];
      try {
        const typed = event.message.text ?? '';
        const note = parseNoteCommand(typed); // จำ/ขอ/ลืม/ตู้เอกสาร มาก่อนคำสั่งสรุป
        messages = note ? await this.notes.run(note) : await this.answer(parseCommand(typed));
      } catch (error) {
        console.error('เลขาตอบคำสั่งไม่สำเร็จ:', error instanceof Error ? error.message : error);
        messages = [textMessage('ขออภัย ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง')];
      }
      const reply = withQuickReply(messages);
      try {
        await replyLine(event.replyToken, reply);
      } catch {
        // replyToken หมดอายุ (เช่น เซิร์ฟเวอร์เพิ่งตื่นจากหลับ) - ส่งแบบ push แทน
        await pushLine(reply).catch((error: unknown) => console.error('เลขาส่งคำตอบไม่สำเร็จ:', error instanceof Error ? error.message : error));
      }
    }
  }

  // ใครทำอะไรวันนี้ (ตามวันเวลาไทย) เท่าที่ระบบจดชื่อคนทำไว้: แก้ไข/ยกเลิก (VehicleEditLog + AuditLog) และใบส่งงานที่ไม่ได้ยกเลิก
  // การใส่รถ/ยื่นเอกสาร/รับใบเสร็จยังไม่มีคอลัมน์ผู้ทำ จึงยังบอกรายคนไม่ได้
  async staffActivity(today: string): Promise<EveningInput['staff']> {
    const start = new Date(`${today}T00:00:00+07:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const [vehicleEdits, audits, slips] = await Promise.all([
      this.prisma.vehicleEditLog.groupBy({ by: ['editedById'], where: { editedAt: { gte: start, lt: end }, editedById: { not: null } }, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['editedById'], where: { createdAt: { gte: start, lt: end }, editedById: { not: null } }, _count: { _all: true } }),
      this.prisma.deliverySlip.groupBy({ by: ['createdById'], where: { createdAt: { gte: start, lt: end }, createdById: { not: null }, cancelledAt: null }, _count: { _all: true } }),
    ]);

    const byUser = new Map<string, { edits: number; slips: number }>();
    const add = (id: string | null, field: 'edits' | 'slips', n: number) => {
      if (!id) return;
      const row = byUser.get(id) ?? { edits: 0, slips: 0 };
      row[field] += n;
      byUser.set(id, row);
    };
    for (const r of vehicleEdits) add(r.editedById, 'edits', r._count._all);
    for (const r of audits) add(r.editedById, 'edits', r._count._all);
    for (const r of slips) add(r.createdById, 'slips', r._count._all);
    if (byUser.size === 0) return [];

    const users = await this.prisma.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: { id: true, name: true, displayName: true } });
    return users
      .map((u) => ({ name: u.displayName?.trim() || u.name, ...byUser.get(u.id)! }))
      .sort((a, b) => b.edits + b.slips - (a.edits + a.slips));
  }
}
