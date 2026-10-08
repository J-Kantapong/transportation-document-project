// ส่งข้อความเข้าไลน์ส่วนตัวของเจ้าของระบบผ่าน LINE Messaging API - เลขาส่วนตัว (ผู้ใช้ 2026-10-07)
// ค่าลับอยู่ใน env เท่านั้น (ห้ามใส่ในโค้ด/แชต/log):
//   LINE_CHANNEL_ACCESS_TOKEN = กุญแจส่งข้อความของบอท (Channel access token แบบ long-lived)
//   LINE_USER_ID              = ปลายทาง = ไลน์ส่วนตัวของเจ้าของ (ขึ้นต้น U ตามด้วย hex 32 ตัว)
//   LINE_CHANNEL_SECRET       = ใช้ตรวจลายเซ็นข้อความที่ LINE ส่งมาที่ webhook (ดู line-webhook.ts)

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';
const TIMEOUT_MS = 15_000;
const MAX_MESSAGES_PER_PUSH = 5; // ข้อจำกัดของ LINE ต่อหนึ่งคำขอ
const MAX_TEXT_LENGTH = 5000;

// ปุ่มลัดใต้ข้อความ: message = กดแล้วส่งข้อความนั้นเข้าแชตเหมือนพิมพ์เอง · datetimepicker = กดแล้วเปิดปฏิทิน
// วันที่ที่เลือกกลับมาเป็น postback พร้อม data (ใช้ในบอทไลน์ลูกค้า)
export type QuickReplyAction =
  | { type: 'message'; label: string; text: string }
  | { type: 'datetimepicker'; label: string; data: string; mode: 'date'; max?: string };

export interface QuickReply {
  items: Array<{ type: 'action'; action: QuickReplyAction }>;
}

export type LineMessage =
  | { type: 'text'; text: string; quickReply?: QuickReply }
  | { type: 'flex'; altText: string; contents: Record<string, unknown>; quickReply?: QuickReply };

export interface LineConfig {
  token: string;
  userId: string;
}

// ตั้งค่าไม่ครบ/ผิดรูปแบบ - แยกชนิดไว้ให้ผู้เรียกบอกผู้ใช้ตรงๆ ว่าต้องไปแก้ env
export class LineConfigError extends Error {}

export function lineConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LineConfig {
  const token = env.LINE_CHANNEL_ACCESS_TOKEN?.trim() ?? '';
  const userId = env.LINE_USER_ID?.trim() ?? '';
  const missing = [
    token ? null : 'LINE_CHANNEL_ACCESS_TOKEN',
    userId ? null : 'LINE_USER_ID',
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) throw new LineConfigError(`ยังไม่ได้ตั้งค่า ${missing.join(' และ ')} ใน env`);
  if (!/^U[0-9a-f]{32}$/i.test(userId)) {
    throw new LineConfigError('LINE_USER_ID ต้องขึ้นต้นด้วย U ตามด้วยตัวอักษร/เลข 32 ตัว (คัดลอกจาก Your user ID ใน LINE Developers Console)');
  }
  return { token, userId };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function assertSendable(messages: LineMessage[]): void {
  if (messages.length === 0 || messages.length > MAX_MESSAGES_PER_PUSH) {
    throw new Error(`ส่งไลน์ได้ครั้งละ 1-${MAX_MESSAGES_PER_PUSH} ข้อความ`);
  }
  for (const message of messages) {
    if (message.type === 'text' && message.text.length > MAX_TEXT_LENGTH) {
      throw new Error(`ข้อความไลน์ยาวเกิน ${MAX_TEXT_LENGTH} ตัวอักษร`);
    }
  }
}

async function postLine(url: string, body: unknown, token: string, fetchImpl: FetchLike): Promise<void> {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return;

  // เก็บเฉพาะข้อความอธิบายของ LINE - ไม่ใส่ token/ปลายทางลงใน error เพราะมักถูก log
  const detail = await response
    .json()
    .then((payload: { message?: string }) => payload.message ?? '')
    .catch(() => '');
  throw new Error(`LINE ตอบกลับ ${response.status}${detail ? `: ${detail}` : ''}`);
}

export async function pushLine(
  messages: LineMessage[],
  config: LineConfig = lineConfigFromEnv(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  assertSendable(messages);
  await postLine(PUSH_URL, { to: config.userId, messages }, config.token, fetchImpl);
}

export function pushLineText(text: string, config?: LineConfig, fetchImpl?: FetchLike): Promise<void> {
  return pushLine([{ type: 'text', text }], config, fetchImpl);
}

// ตอบกลับข้อความที่ผู้ใช้เพิ่งพิมพ์ (ใช้ replyToken ที่ LINE ส่งมากับ webhook - หมดอายุเร็ว ใช้ได้ครั้งเดียว)
export async function replyLine(
  replyToken: string,
  messages: LineMessage[],
  config: LineConfig = lineConfigFromEnv(),
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  assertSendable(messages);
  await postLine(REPLY_URL, { replyToken, messages }, config.token, fetchImpl);
}
