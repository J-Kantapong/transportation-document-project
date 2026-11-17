import { Injectable } from '@nestjs/common';
import { bangkokToday } from '../overview/overview-calculator.js';
import { OverviewService } from '../overview/overview.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseCommand, type Command } from './commands.js';
import { buildEveningMessage, type EveningInput } from './evening-message.js';
import { buildFinanceMessage } from './finance-message.js';
import { loadFinancePending } from './finance-pending.js';
import { parseInvoiceLinkCommand } from './invoice-link.js';
import { lineConfigFromEnv, pushLine, replyLine, type LineMessage } from './line-client.js';
import type { LineEvent } from './line-webhook.js';
import { NotesService } from './notes.service.js';
import { parseNoteCommand } from './notes.js';
import { buildMorningMessage } from './morning-message.js';
import {
  ambiguousProvinceText,
  parseProvinceRateCommand,
  provinceRateTableTexts,
  provinceRateText,
  type ProvinceRateCommand,
  type SupplierCostRow,
} from './province-rates.js';
import { dueReminders, reminderMessage, remindersText } from './reminders.js';
import type { Slot } from './run-key.js';
import { helpText, overdueText, spendText, stuckText, textMessage, withQuickReply } from './replies.js';
import { parseStatementPostback } from './statement-message.js';
import { StatementService } from './statement.service.js';

const total = (s: Omit<EveningInput['staff'][number], 'name'>) => s.entered + s.submitted + s.received + s.edits + s.slips;

// เลขาส่วนตัว (ผู้ใช้ 2026-10-07): ดึงตัวเลขจากภาพรวมผู้บริหารแล้วส่งการ์ดเข้าไลน์ส่วนตัวของเจ้าของ
// ไม่ผ่านผู้ใช้/สิทธิ์ของคำขอ HTTP (ทำงานนอก request = ไม่จำกัดประเภทรถ) - ผู้เรียกต้องเป็นระบบเองเท่านั้น
@Injectable()
export class SecretaryService {
  constructor(
    private readonly overviewService: OverviewService,
    private readonly prisma: PrismaService,
    private readonly notes: NotesService,
    private readonly statements: StatementService,
  ) {}

  // ที่อยู่เว็บสำหรับลิงก์ในการ์ด (ใช้ FRONTEND_ORIGIN ถ้าตั้งไว้เป็น URL จริง - ไม่ตั้ง = การ์ดไม่มีลิงก์)
  private baseUrl(): string | undefined {
    const origin = process.env.FRONTEND_ORIGIN?.trim();
    return origin && /^https?:\/\//i.test(origin) ? origin.replace(/\/+$/, '') : undefined;
  }

  private async morningMessage(): Promise<LineMessage[]> {
    return buildMorningMessage(await this.overviewService.overview(), this.baseUrl());
  }

  // การ์ดการเงินค้าง (ผู้ใช้ 2026-10-31) - ส่งต่อจากสรุปเช้าทุกวัน และคำสั่ง "การเงิน"
  private async financeMessage(): Promise<LineMessage[]> {
    return buildFinanceMessage(await loadFinancePending(this.prisma, bangkokToday()), this.baseUrl());
  }

  private async eveningMessage(): Promise<LineMessage[]> {
    const overview = await this.overviewService.overview();
    const staff = await this.staffActivity(overview.today);
    return buildEveningMessage({ ...overview, staff }, this.baseUrl());
  }

  // ส่งตามเวลาโดยตัวตั้งเวลา (GitHub Actions) - รอบเดียวกันของวันเดียวกัน (เวลาไทย) ส่งครั้งเดียว: ถ้า retry หลังส่งสำเร็จแล้วจะข้าม
  // จำในหน่วยความจำ (เซิร์ฟเวอร์รีสตาร์ท = ลืม) พอสำหรับกัน retry ติดกัน
  private readonly sentSlots = new Set<string>();

  async runScheduled(slot: Slot): Promise<{ sent: boolean; skipped?: 'already-sent'; reminders?: string[] }> {
    const today = bangkokToday();
    if (!this.sentSlots.has(`${today}:`)) this.sentSlots.clear(); // วันใหม่ = เริ่มจำใหม่ ไม่ให้โตไม่สิ้นสุด
    this.sentSlots.add(`${today}:`);
    if (slot === 'reminder') return this.runReminders(today);
    const id = `${today}:${slot}`;
    if (this.sentSlots.has(id)) return { sent: false, skipped: 'already-sent' };
    if (slot === 'morning') await this.sendMorning();
    else await this.sendEvening();
    this.sentSlots.add(id);
    return { sent: true };
  }

  // เตือนประจำสัปดาห์ (ผู้ใช้ 2026-10-31): ส่งทุกรายการของวันนี้ที่ถึงเวลาแล้วและยังไม่ได้ส่ง (แต่ละรายการจำแยก
  // จึงเรียกซ้ำกี่ครั้งในวันเดียวก็ส่งรายการละครั้ง) - ไม่มีรายการ = sent false
  private async runReminders(today: string): Promise<{ sent: boolean; skipped?: 'already-sent'; reminders: string[] }> {
    const due = dueReminders().filter((r) => !this.sentSlots.has(`${today}:reminder:${r.id}`));
    if (due.length === 0) return { sent: false, skipped: 'already-sent', reminders: [] };
    await pushLine(due.map((r) => reminderMessage(r, this.baseUrl())));
    for (const r of due) this.sentSlots.add(`${today}:reminder:${r.id}`);
    return { sent: true, reminders: due.map((r) => r.id) };
  }

  async sendMorning(): Promise<void> {
    await pushLine(await this.morningMessage());
    // แยกส่ง: LINE รับไม่เกิน 5 ข้อความต่อครั้ง สรุปเช้าที่ยาวมีข้อความต่อท้ายได้
    await pushLine(await this.financeMessage());
  }

  async sendEvening(): Promise<void> {
    await pushLine(await this.eveningMessage());
  }

  // คำตอบของคำสั่งในไลน์ (แบบ A: ไม่ใช้ AI)
  async answer(command: Command): Promise<LineMessage[]> {
    switch (command) {
      case 'morning':
        return this.morningMessage();
      case 'finance':
        return this.financeMessage();
      case 'evening':
        return this.eveningMessage();
      case 'overdue':
        return [textMessage(overdueText(await this.overviewService.overview()))];
      case 'stuck':
        return [textMessage(stuckText(await this.overviewService.overview()))];
      case 'spend':
        return [textMessage(spendText(await this.overviewService.overview()))];
      case 'reminders':
        return [textMessage(remindersText())];
      default:
        return [textMessage(helpText())];
    }
  }

  // เรทจดต่างจังหวัด (ผู้ใช้ 2026-11-17): เรทเสนอ + ต้องนำรถไปตรวจไหม จาก province-rates.ts · ต้นทุนซับอ่านจากตารางราคาซับสด
  async provinceRates(command: ProvinceRateCommand): Promise<LineMessage[]> {
    if (command.kind === 'ambiguous') return [textMessage(ambiguousProvinceText(command.candidates))];
    const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    const found = await this.prisma.supplierProvinceRate.findMany(command.kind === 'province' ? { where: { province: command.province } } : undefined);
    const rows: SupplierCostRow[] = found.map((r) => ({
      province: r.province,
      accepts: r.accepts,
      serviceFee: num(r.serviceFee),
      channelFee: num(r.channelFee),
      inspectionFee: num(r.inspectionFee),
      plateSwapFee: num(r.plateSwapFee),
      plateSwapNote: r.plateSwapNote,
    }));
    if (command.kind === 'province') return [textMessage(provinceRateText(command.province, rows[0]))];
    return provinceRateTableTexts(rows).map(textMessage);
  }

  // ข้อความที่ผู้ใช้พิมพ์ในแชตกับบอท (LINE ส่งมาที่ webhook) - ตอบเฉพาะเจ้าของ คนอื่นเงียบ ไม่ตอบอะไรเลย
  // ไม่ throw: webhook ตอบ LINE ไปแล้ว งานนี้ทำต่อเบื้องหลัง
  async handleEvents(events: LineEvent[]): Promise<void> {
    const owner = lineConfigFromEnv().userId;
    for (const event of events) {
      if (!event.replyToken || event.source?.userId !== owner) continue;
      if (event.deliveryContext?.isRedelivery) continue; // LINE ส่งซ้ำเมื่อไม่ได้รับตอบ - กันตอบสองรอบ (และกันออกใบกำกับซ้ำ)
      // ไฟล์ statement จาก K BIZ และปุ่มในการ์ดจับคู่ยอดเงินเข้า (ผู้ใช้ 2026-11-16)
      const isText = event.type === 'message' && event.message?.type === 'text';
      const isFile = event.type === 'message' && event.message?.type === 'file' && !!event.message.id;
      const postback = event.type === 'postback' ? parseStatementPostback(event.postback?.data) : null;
      if (!isText && !isFile && !postback) continue;

      let messages: LineMessage[];
      try {
        if (postback) messages = await this.statements.handlePostback(postback);
        else if (isFile) messages = await this.statements.handleFile(event.message!.id!, event.message!.fileName ?? '');
        else {
          const typed = event.message?.text ?? '';
          // "บิลล่าสุด" / "บิล IV…" = ลิงก์ดาวน์โหลดใบวางบิล (ผู้ใช้ 2026-11-16) - รูปแบบเฉพาะ (ทั้งข้อความต้องตรง) จึงมาก่อนตู้ข้อความ
          // ไม่งั้น "ขอบิลล่าสุด" จะไปตกคำสั่ง "ขอ" ของตู้ข้อความ
          const invoiceLink = parseInvoiceLinkCommand(typed);
          // "เรทจังหวัด" / "เรท ภูเก็ต" (ผู้ใช้ 2026-11-17) - ก่อนตู้ข้อความ ไม่งั้น "ขอนแก่น" จะไปตกคำสั่ง "ขอ"
          const provinceRate = invoiceLink ? null : parseProvinceRateCommand(typed);
          const note = invoiceLink || provinceRate ? null : parseNoteCommand(typed); // จำ/ขอ/ลืม/ตู้เอกสาร มาก่อนคำสั่งสรุป
          if (invoiceLink) messages = await this.statements.invoiceLinks(invoiceLink);
          else if (provinceRate) messages = await this.provinceRates(provinceRate);
          else if (note) messages = await this.notes.run(note);
          else messages = await this.answer(parseCommand(typed));
        }
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

  // ใครทำอะไรวันนี้ (ตามวันเวลาไทย) เท่าที่ระบบจดชื่อคนทำไว้: ใส่รถ / ยื่นเอกสาร / บันทึกรับใบเสร็จ (Vehicle.createdById,
  // DocumentSubmission.createdById / receivedById ตั้งแต่ 2026-10-08) แก้ไข/ยกเลิก (VehicleEditLog + AuditLog) และใบส่งงานที่ไม่ได้ยกเลิก
  // รับป้าย/รับเล่ม/งานอื่นๆ ยังไม่มีคอลัมน์ผู้ทำ
  async staffActivity(today: string): Promise<EveningInput['staff']> {
    const start = new Date(`${today}T00:00:00+07:00`);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const [vehicleEdits, audits, slips, entered, submitted, received] = await Promise.all([
      this.prisma.vehicleEditLog.groupBy({ by: ['editedById'], where: { editedAt: { gte: start, lt: end }, editedById: { not: null } }, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['editedById'], where: { createdAt: { gte: start, lt: end }, editedById: { not: null } }, _count: { _all: true } }),
      this.prisma.deliverySlip.groupBy({ by: ['createdById'], where: { createdAt: { gte: start, lt: end }, createdById: { not: null }, cancelledAt: null }, _count: { _all: true } }),
      // ผู้ทำ (ผู้ใช้ 2026-10-08): ใส่รถ / ยื่นเอกสาร (นับยื่นไม่สำเร็จด้วย เพราะเป็นงานที่ทำ) / บันทึกรับใบเสร็จ (นับตามวันที่แก้ล่าสุด)
      this.prisma.vehicle.groupBy({ by: ['createdById'], where: { createdAt: { gte: start, lt: end }, createdById: { not: null }, deletedAt: null }, _count: { _all: true } }),
      this.prisma.documentSubmission.groupBy({ by: ['createdById'], where: { createdAt: { gte: start, lt: end }, createdById: { not: null } }, _count: { _all: true } }),
      this.prisma.documentSubmission.groupBy({ by: ['receivedById'], where: { updatedAt: { gte: start, lt: end }, status: 'RECEIPT_RECEIVED', receivedById: { not: null } }, _count: { _all: true } }),
    ]);

    const byUser = new Map<string, Omit<EveningInput['staff'][number], 'name'>>();
    const add = (id: string | null, field: keyof Omit<EveningInput['staff'][number], 'name'>, n: number) => {
      if (!id) return;
      const row = byUser.get(id) ?? { entered: 0, submitted: 0, received: 0, edits: 0, slips: 0 };
      row[field] += n;
      byUser.set(id, row);
    };
    for (const r of entered) add(r.createdById, 'entered', r._count._all);
    for (const r of submitted) add(r.createdById, 'submitted', r._count._all);
    for (const r of received) add(r.receivedById, 'received', r._count._all);
    for (const r of vehicleEdits) add(r.editedById, 'edits', r._count._all);
    for (const r of audits) add(r.editedById, 'edits', r._count._all);
    for (const r of slips) add(r.createdById, 'slips', r._count._all);
    if (byUser.size === 0) return [];

    const users = await this.prisma.user.findMany({ where: { id: { in: [...byUser.keys()] } }, select: { id: true, name: true, displayName: true } });
    return users
      .map((u) => ({ name: u.displayName?.trim() || u.name, ...byUser.get(u.id)! }))
      .sort((a, b) => total(b) - total(a));
  }
}
