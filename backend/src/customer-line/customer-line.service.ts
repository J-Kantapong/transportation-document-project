import { readFile } from 'node:fs/promises';
import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { bangkokToday } from '../overview/overview-calculator.js';
import { LineConfigError, replyLine, type LineMessage } from '../secretary/line-client.js';
import type { LineEvent } from '../secretary/line-webhook.js';
import type { VehicleTaxRuleSet } from '../tax-renewal/vehicle-tax-calculator.js';
import { TaxService } from '../tax/tax.service.js';
import { cardMessage, fallbackOf, findMenuCard, WELCOME_CARD, type MenuCard } from './customer-menu.js';
import { syncRichMenu } from './rich-menu.js';
import { answerTax, isCancel, isTaxDatePostback, isTaxQuestion, parseTaxKind, startTax, TAX_KIND_CARD, type TaxSession } from './tax-check.js';
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

// การ์ดเมนูที่ตรงกับเหตุการณ์ - เพิ่มเพื่อน = การ์ดทักทาย · ข้อความที่บอทไม่รู้จัก = การ์ดทักทายเช่นกัน (แทนข้อความตอบกลับ
// อัตโนมัติ "ขอบคุณที่ติดต่อเรา" ของ LINE Manager ซึ่งต้องปิดไว้ ไม่งั้นลูกค้าได้คำตอบซ้อนสองข้อความ)
export function menuCardFor(event: LineEvent): MenuCard | null {
  if (event.type === 'follow') return WELCOME_CARD;
  if (event.type !== 'message' || event.message?.type !== 'text') return null;
  return findMenuCard(event.message.text) ?? WELCOME_CARD;
}

// คำตอบของบอทต่อหนึ่งเหตุการณ์ - null = ไม่ตอบ (รูป สติกเกอร์ ฯลฯ) · เรื่อง ตรอ. มาก่อนเมนูเสมอ
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
  const card = menuCardFor(event);
  return card ? cardMessage(card) : null;
}

export interface Routed {
  message: LineMessage | null;
  session: TaxSession | null; // การเช็กค่าภาษีที่ยังถามไม่จบของลูกค้าคนนี้ หลังเหตุการณ์นี้
}

// ทางเดินของหนึ่งเหตุการณ์ เมื่อรู้ว่าลูกค้าค้างการเช็กค่าภาษีอยู่หรือไม่ (session) - rules = อัตราภาษี (null = โหลดไม่ได้)
// ระหว่างเช็กค่าภาษี ข้อความที่พิมพ์คือคำตอบของคำถามปัจจุบัน เว้นแต่เป็นคำสั่งชัดๆ: ยกเลิก, เรื่อง ตรอ., คำของเมนู (กดแถบเมนู)
// หรือเริ่มเช็กค่าภาษีใหม่ - พวกนี้ออกจากการเช็กที่ค้างอยู่
export function routeEvent(event: LineEvent, today: string, session: TaxSession | null, rules: VehicleTaxRuleSet | null): Routed {
  const noRates: Routed = { message: { type: 'text', text: 'ขออภัยครับ ตอนนี้เช็กค่าภาษีไม่ได้ชั่วคราว กรุณาลองใหม่อีกครั้ง หรือพิมพ์ ติดต่อเจ้าหน้าที่' }, session: null };

  if (event.type === 'postback' && isTaxDatePostback(event.postback?.data)) {
    if (!session) return { message: { type: 'text', text: 'หมดเวลาของการเช็กครั้งก่อนแล้ว พิมพ์ เช็กภาษี เพื่อเริ่มใหม่' }, session: null };
    return rules ? answerTax(session, { pickedDate: event.postback?.params?.date }, today, rules) : noRates;
  }

  if (event.type === 'message' && event.message?.type === 'text') {
    const typed = event.message.text;
    if (session && isCancel(typed)) return { message: { type: 'text', text: 'ยกเลิกการเช็กค่าภาษีแล้วครับ' }, session: null };
    if (!isTroQuestion(typed) && !findMenuCard(typed, true)) {
      if (isTaxQuestion(typed)) {
        const kind = parseTaxKind(typed);
        return kind ? startTax(kind, today, rules) : { message: cardMessage(TAX_KIND_CARD), session: null };
      }
      if (session) return rules ? answerTax(session, { typed }, today, rules) : noRates;
    }
    return { message: replyFor(event, today), session: null };
  }

  // รูป สติกเกอร์ ฯลฯ ไม่ล้างการเช็กที่ค้างอยู่
  return { message: replyFor(event, today), session };
}

const SESSION_TTL_MS = 20 * 60_000;
const MAX_SESSIONS = 2000;
const RULES_TTL_MS = 10 * 60_000;

// บอทของบัญชีไลน์ลูกค้า (ผู้ใช้ 2026-10-09) - คนละบัญชีกับเลขาส่วนตัว ใช้กุญแจคนละชุด:
//   LINE_CUSTOMER_CHANNEL_SECRET (ตรวจลายเซ็น webhook) และ LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN (ตอบกลับ)
// ตอบทุกคนที่ทักเข้ามา จึงห้ามอ่าน/เขียนข้อมูลรถและลูกค้าของระบบ และห้ามมีราคาของสำนักงาน
// มีเช็ก ตรอ. (tro-check.ts) เมนูเอกสาร (customer-menu.ts) และเช็กค่าภาษีของกรมการขนส่ง (tax-check.ts - อ่านแค่ตารางอัตราภาษี)
@Injectable()
export class CustomerLineService implements OnApplicationBootstrap {
  // การเช็กค่าภาษีที่ยังถามไม่จบ ต่อผู้ใช้ไลน์ - อยู่ในหน่วยความจำ เซิร์ฟเวอร์เริ่มใหม่ = ลูกค้าเริ่มถามใหม่
  private readonly sessions = new Map<string, { session: TaxSession; expires: number }>();
  private rulesCache: { rules: VehicleTaxRuleSet; expires: number } | null = null;

  constructor(private readonly tax: TaxService) {}

  private sessionOf(userId: string | undefined): TaxSession | null {
    if (!userId) return null;
    const entry = this.sessions.get(userId);
    if (!entry) return null;
    if (entry.expires > Date.now()) return entry.session;
    this.sessions.delete(userId);
    return null;
  }

  private saveSession(userId: string | undefined, session: TaxSession | null): void {
    if (!userId) return;
    this.sessions.delete(userId);
    if (!session) return;
    // เต็ม = ทิ้งรายการเก่าสุด (Map เรียงตามลำดับที่ใส่)
    if (this.sessions.size >= MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value as string);
    this.sessions.set(userId, { session, expires: Date.now() + SESSION_TTL_MS });
  }

  // อัตราภาษีเปลี่ยนนานๆ ครั้ง - จำไว้ช่วงสั้นๆ ไม่ให้ทุกข้อความของคนนอกยิงฐานข้อมูล
  private async taxRules(): Promise<VehicleTaxRuleSet | null> {
    if (this.rulesCache && this.rulesCache.expires > Date.now()) return this.rulesCache.rules;
    try {
      const rules = await this.tax.loadRuleSet();
      this.rulesCache = { rules, expires: Date.now() + RULES_TTL_MS };
      return rules;
    } catch (error) {
      console.error('บอทไลน์ลูกค้าโหลดอัตราภาษีไม่สำเร็จ:', error instanceof Error ? error.message : error);
      return null;
    }
  }

  // ตั้งแถบเมนูด้านล่างแชตตอนเซิร์ฟเวอร์เริ่ม (ไม่รอ ไม่ทำให้เซิร์ฟเวอร์ล้ม) - ไม่มีกุญแจ = ข้าม (เครื่อง dev)
  onApplicationBootstrap(): void {
    const token = process.env.LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN?.trim();
    if (!token) return;
    void readFile(new URL('./rich-menu.png', import.meta.url))
      .then((image) => syncRichMenu(token, image))
      .then((result) => console.log(`แถบเมนูไลน์ลูกค้า: ${result}`))
      .catch((error: unknown) => console.error('ตั้งแถบเมนูไลน์ลูกค้าไม่สำเร็จ:', error instanceof Error ? error.message : error));
  }

  async handleEvents(events: LineEvent[]): Promise<void> {
    const token = process.env.LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN?.trim();
    if (!token) throw new LineConfigError('ยังไม่ได้ตั้งค่า LINE_CUSTOMER_CHANNEL_ACCESS_TOKEN ใน env');
    const today = bangkokToday();

    for (const event of events) {
      // ส่งซ้ำจาก LINE = replyToken เดิมหมดอายุแล้ว ตอบไม่ได้
      if (!event.replyToken || event.deliveryContext?.isRedelivery) continue;
      const userId = event.source?.userId;
      const session = this.sessionOf(userId);
      const needsRates = session !== null || (event.type === 'message' && isTaxQuestion(event.message?.text));
      const routed = routeEvent(event, today, session, needsRates ? await this.taxRules() : null);
      this.saveSession(userId, routed.session);
      const message = routed.message;
      if (!message) continue;
      const config = { token, userId: '' };
      const replyToken = event.replyToken;
      await replyLine(replyToken, [message], config)
        .catch((error: unknown) => {
          // LINE ไม่รับการ์ด = ตอบเป็นข้อความล้วนของการ์ดเดียวกันแทน ลูกค้าจะได้ไม่เงียบ
          const fallback = fallbackOf(message);
          if (!fallback) throw error;
          console.error('บอทไลน์ลูกค้าส่งการ์ดไม่สำเร็จ ตอบเป็นข้อความแทน:', error instanceof Error ? error.message : error);
          return replyLine(replyToken, [fallback], config);
        })
        .catch((error: unknown) => console.error('บอทไลน์ลูกค้าตอบไม่สำเร็จ:', error instanceof Error ? error.message : error));
    }
  }
}
