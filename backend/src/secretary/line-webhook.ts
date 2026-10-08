// webhook ของ LINE: ข้อความที่ผู้ใช้พิมพ์ในแชตกับบอทจะถูกส่งมาที่ POST /api/secretary/webhook (ผู้ใช้ 2026-10-07)
// ทุกคำขอต้องมีลายเซ็น X-Line-Signature = base64(HMAC-SHA256(raw body, Channel secret)) - ไม่ผ่านต้องไม่แตะข้อมูลใดๆ
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface LineEvent {
  type: string;
  replyToken?: string;
  source?: { type?: string; userId?: string };
  message?: { type?: string; text?: string };
  postback?: { data?: string; params?: { date?: string } };
  deliveryContext?: { isRedelivery?: boolean };
}

export interface LineWebhookBody {
  events?: LineEvent[];
}

export function verifyLineSignature(rawBody: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(signature, 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
