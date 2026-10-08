import { Injectable } from '@nestjs/common';
import { bangkokToday } from '../overview/overview-calculator.js';
import { LineConfigError, replyLine, type LineMessage } from '../secretary/line-client.js';
import type { LineEvent } from '../secretary/line-webhook.js';
import {
  checkTro,
  isTroQuestion,
  parseTroPostback,
  parseTypedTro,
  troBothResultMessage,
  troInvalidDateMessage,
  troQuestionMessage,
  troResultMessage,
  type TroKind,
  type TroResult,
} from './tro-check.js';

// คำตอบของบอทต่อหนึ่งเหตุการณ์ - null = ไม่ตอบ (ปล่อยให้ข้อความตอบกลับอัตโนมัติของ LINE และเจ้าหน้าที่ตอบเอง)
export function replyFor(event: LineEvent, today: string): LineMessage | null {
  if (event.type === 'message' && event.message?.type === 'text' && isTroQuestion(event.message.text)) {
    // พิมพ์วันที่มาด้วย (พ.ศ. ได้) = ตอบผลเลย ไม่มีวันที่ = ถามด้วยปุ่ม
    const typed = parseTypedTro(event.message.text ?? '');
    if (typed.date === null) return troQuestionMessage(today);
    const date = typed.date;
    const kinds: TroKind[] = typed.kind ? [typed.kind] : ['car', 'moto'];
    const results = kinds.map((kind) => checkTro(kind, date, today)).filter((result): result is TroResult => result !== null);
    if (results.length !== kinds.length) return troInvalidDateMessage();
    return typed.kind ? troResultMessage(results[0], date) : troBothResultMessage(results, date);
  }
  if (event.type === 'postback') {
    const kind = parseTroPostback(event.postback?.data);
    if (!kind) return null;
    const date = event.postback?.params?.date ?? '';
    const result = checkTro(kind, date, today);
    return result ? troResultMessage(result, date) : troInvalidDateMessage();
  }
  return null;
}

// บอทของบัญชีไลน์ลูกค้า (ผู้ใช้ 2026-10-09) - คนละบัญชีกับเลขาส่วนตัว ใช้กุญแจคนละชุด:
//   LINE_CUSTOMER_CHANNEL_SECRET (ตรวจลายเซ็น webhook) และ LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN (ตอบกลับ)
// ตอบทุกคนที่ทักเข้ามา จึงห้ามอ่าน/เขียนข้อมูลของระบบและห้ามมีราคา - ตอนนี้มีแค่เช็ก ตรอ.
@Injectable()
export class CustomerLineService {
  async handleEvents(events: LineEvent[]): Promise<void> {
    const token = process.env.LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN?.trim();
    if (!token) throw new LineConfigError('ยังไม่ได้ตั้งค่า LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN ใน env');
    const today = bangkokToday();

    for (const event of events) {
      // ส่งซ้ำจาก LINE = replyToken เดิมหมดอายุแล้ว ตอบไม่ได้
      if (!event.replyToken || event.deliveryContext?.isRedelivery) continue;
      const message = replyFor(event, today);
      if (!message) continue;
      await replyLine(event.replyToken, [message], { token, userId: '' }).catch((error: unknown) =>
        console.error('บอทไลน์ลูกค้าตอบไม่สำเร็จ:', error instanceof Error ? error.message : error),
      );
    }
  }
}
