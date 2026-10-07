import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { LineMessage } from './line-client.js';
import { MAX_NOTES, MAX_TITLE_LENGTH, MAX_VALUE_LENGTH, NOTES_HELP, noteKey, type NoteCommand } from './notes.js';
import { textMessage } from './replies.js';

const MAX_LIST = 40;

// ตู้ข้อความของเจ้าของ (ผู้ใช้ 2026-10-07) - เรียกจาก SecretaryService เฉพาะข้อความที่มาจาก LINE_USER_ID เท่านั้น
@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  async run(command: NoteCommand): Promise<LineMessage[]> {
    switch (command.type) {
      case 'invalid-save':
        return [textMessage(`พิมพ์แบบนี้ครับ: จำ ชื่อ = ข้อความ\nเช่น จำ ที่อยู่บริษัท = 123 ถ.สุขุมวิท`)];
      case 'save':
        return this.save(command.title, command.value);
      case 'get':
        return this.get(command.query);
      case 'forget':
        return this.forget(command.query);
      case 'list':
        return this.list();
    }
  }

  private async save(title: string, value: string): Promise<LineMessage[]> {
    const key = noteKey(title);
    if (!key || !value) return [textMessage('ต้องมีทั้งชื่อและข้อความ เช่น จำ ที่อยู่บริษัท = 123 ถ.สุขุมวิท')];
    if (title.length > MAX_TITLE_LENGTH) return [textMessage(`ชื่อยาวเกิน ${MAX_TITLE_LENGTH} ตัวอักษร`)];
    if (value.length > MAX_VALUE_LENGTH) return [textMessage(`ข้อความยาวเกิน ${MAX_VALUE_LENGTH} ตัวอักษร`)];

    const existing = await this.prisma.secretaryNote.findUnique({ where: { key } });
    if (!existing && (await this.prisma.secretaryNote.count()) >= MAX_NOTES) {
      return [textMessage(`ตู้เต็ม (${MAX_NOTES} รายการ) ลืมรายการเก่าก่อนด้วยคำสั่ง ลืม ชื่อ`)];
    }
    await this.prisma.secretaryNote.upsert({ where: { key }, create: { key, title, value }, update: { title, value } });
    // ทับของเดิม: ส่งค่าเดิมกลับให้ด้วย เผื่อพิมพ์ผิด จะได้เอากลับมาได้
    return existing ? [textMessage(`อัปเดต "${title}" แล้ว\nค่าเดิม:`), textMessage(existing.value)] : [textMessage(`จำ "${title}" แล้ว`)];
  }

  // หาแบบตรงตัวก่อน ไม่เจอค่อยหาที่ชื่อมีคำนั้น: เจอเดียว = ส่งข้อความ (แยกอีกบับเบิลเพื่อให้กดคัดลอกเฉพาะค่า) หลายอัน = ให้เลือก
  private async get(query: string): Promise<LineMessage[]> {
    const key = noteKey(query);
    const exact = await this.prisma.secretaryNote.findUnique({ where: { key } });
    if (exact) return [textMessage(exact.title), textMessage(exact.value)];

    const matches = await this.prisma.secretaryNote.findMany({ where: { key: { contains: key } }, orderBy: { title: 'asc' }, take: 11 });
    if (matches.length === 0) return [textMessage(`ไม่พบ "${query}" ในตู้ พิมพ์ ตู้เอกสาร เพื่อดูรายการ`)];
    if (matches.length === 1) return [textMessage(matches[0].title), textMessage(matches[0].value)];
    const shown = matches.slice(0, 10).map((n) => `• ${n.title}`);
    return [textMessage(['เจอหลายรายการ พิมพ์ "ขอ ชื่อ" ให้ตรงขึ้น:', ...shown, ...(matches.length > 10 ? ['…และอีกหลายรายการ'] : [])].join('\n'))];
  }

  // ลบเฉพาะชื่อที่ตรงตัว (กันลบผิดอัน) และส่งค่าที่ลบกลับให้ เผื่อเปลี่ยนใจ
  private async forget(query: string): Promise<LineMessage[]> {
    const key = noteKey(query);
    const existing = await this.prisma.secretaryNote.findUnique({ where: { key } });
    if (!existing) return [textMessage(`ไม่พบ "${query}" (ลืมได้เฉพาะชื่อที่ตรงตัว ดูชื่อจาก ตู้เอกสาร)`)];
    await this.prisma.secretaryNote.delete({ where: { key } });
    return [textMessage(`ลืม "${existing.title}" แล้ว ค่าที่ลบ:`), textMessage(existing.value)];
  }

  private async list(): Promise<LineMessage[]> {
    const notes = await this.prisma.secretaryNote.findMany({ orderBy: { title: 'asc' }, take: MAX_LIST + 1, select: { title: true } });
    if (notes.length === 0) return [textMessage(NOTES_HELP)];
    const shown = notes.slice(0, MAX_LIST).map((n) => `• ${n.title}`);
    return [textMessage(['ในตู้มี:', ...shown, ...(notes.length > MAX_LIST ? ['…และอีกหลายรายการ'] : []), '', 'พิมพ์ "ขอ ชื่อ" เพื่อเอาข้อความ'].join('\n'))];
  }
}
