// ถามเลขาไลน์เป็นภาษาพูดด้วย AI (แผน B, ผู้ใช้ 2026-11-20 "เริ่มรอบ 1") - รอบ 1 อ่านอย่างเดียว:
// AI เรียกได้แค่คำสั่งค้นข้อมูลที่มีอยู่แล้ว (อ่านอย่างเดียว) + ค้นรถ/งาน ไม่มีเครื่องมือเขียนข้อมูลเลย
// ไฟล์นี้เป็นฟังก์ชันล้วน (prompt / เครื่องมือ / เลือกว่าข้อความไหนส่งให้ AI / แปลงการ์ดเป็นข้อความ) - งานที่เรียก API อยู่ใน ai-chat.service.ts
import type Anthropic from '@anthropic-ai/sdk';
import type { LineMessage } from './line-client.js';

// Sonnet 5.5 (ผู้ใช้ 2026-11-20 เลือกตามคำแนะนำ): รุ่นเดียวกับตัวอ่านใบเสร็จ เข้าใจภาษาไทยและตัวเลขเงินได้แม่น
export const AI_CHAT_MODEL = 'claude-sonnet-5-5';
export const MAX_TOOL_ROUNDS = 6; // กัน AI วนเรียกเครื่องมือไม่จบ (และกันค่าใช้จ่ายบานปลาย)
export const MAX_TOOL_RESULT_CHARS = 8000;
export const MAX_REPLY_MESSAGES = 4; // LINE รับไม่เกิน 5 ข้อความต่อครั้ง เหลือที่ไว้หนึ่ง
export const LINE_TEXT_LIMIT = 4800; // LINE จำกัด 5,000 ตัวอักษรต่อข้อความ
export const CONVERSATION_IDLE_MS = 30 * 60 * 1000; // เงียบเกิน 30 นาที = เริ่มบทสนทนาใหม่
export const MAX_CONVERSATION_MESSAGES = 40; // ยาวเกิน = เริ่มใหม่ทั้งก้อน (ไม่ตัดกลางบทสนทนา เพื่อให้ cache และ thinking ใช้ต่อได้)

export function aiChatEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!env.ANTHROPIC_API_KEY?.trim();
}

const compact = (s: string) => s.replace(/\s+/g, '');

// "ถาม …" = ส่งให้ AI เสมอ แม้ข้อความจะไปตรงคำสั่งเดิม (เช่น "ถาม ยอด SPI เดือนนี้เทียบเดือนก่อน")
export function forcedAiQuestion(input: string): string | null {
  const m = /^ถาม\s*([\s\S]+)$/.exec(input.trim());
  return m && m[1].trim() ? m[1].trim() : null;
}

// คำสั่งเดิมจับด้วยคำสำคัญ ("ค้าง" "ติด" "ใช้" "ยอด") ซึ่งเจอได้ในประโยคคำถามทั่วไป - คำสั่งจริงสั้น (ยาวสุด "สรุปเย็นวันนี้ใช้" 16 ตัว)
// ข้อความที่ยาวกว่านี้และตรงแค่คำสำคัญของ parseCommand ถือเป็นคำถาม ส่งให้ AI
export const KEYWORD_COMMAND_MAX_CHARS = 20;
export function looksLikeQuestion(input: string): boolean {
  return compact(input).length > KEYWORD_COMMAND_MAX_CHARS;
}

// --- แปลงคำตอบของคำสั่งเดิม (ข้อความ / การ์ด flex) เป็นข้อความล้วนให้ AI อ่าน ------------------------
function flexText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as Record<string, unknown>;
  if (n.type === 'text' && typeof n.text === 'string') return n.text;
  if (n.type === 'span' && typeof n.text === 'string') return n.text;
  if (n.type === 'button') {
    const action = n.action as Record<string, unknown> | undefined;
    if (action && typeof action.label === 'string') return typeof action.uri === 'string' ? `${action.label}: ${action.uri}` : '';
  }
  if (n.type === 'bubble') return ['header', 'hero', 'body', 'footer'].map((k) => flexText(n[k])).filter(Boolean).join('\n');
  if (Array.isArray(n.contents)) {
    const parts = n.contents.map(flexText).filter(Boolean);
    return parts.join(n.layout === 'horizontal' || n.layout === 'baseline' ? ' ' : '\n');
  }
  return '';
}

export function messagesToText(messages: LineMessage[]): string {
  return messages
    .map((m) => (m.type === 'text' ? m.text : flexText(m.contents) || m.altText))
    .filter(Boolean)
    .join('\n\n');
}

export function clip(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(ตัดเหลือ ${max} ตัวอักษร ข้อมูลยังมีอีก ให้บอกผู้ใช้ว่าข้อมูลยาวเกิน)`;
}

// แบ่งคำตอบยาวเป็นหลายข้อความตามบรรทัด (LINE จำกัดต่อข้อความ และต่อครั้ง)
export function splitReply(text: string, limit = LINE_TEXT_LIMIT, maxMessages = MAX_REPLY_MESSAGES): string[] {
  const clean = text.trim() || 'ขออภัย ไม่มีคำตอบ ลองถามใหม่อีกครั้ง';
  const out: string[] = [];
  let current = '';
  for (const line of clean.split('\n')) {
    const piece = line.length > limit ? line.slice(0, limit) : line;
    if (current && current.length + 1 + piece.length > limit) {
      out.push(current);
      current = piece;
    } else current = current ? `${current}\n${piece}` : piece;
  }
  if (current) out.push(current);
  if (out.length <= maxMessages) return out;
  const kept = out.slice(0, maxMessages);
  kept[maxMessages - 1] = `${kept[maxMessages - 1].slice(0, limit - 60)}\n…(คำตอบยาวเกิน ถามให้แคบลงได้)`;
  return kept;
}

// --- prompt และเครื่องมือ (คงที่ทุกคำขอ = cache ได้: ห้ามใส่วันที่/เวลาตรงนี้ วันที่ส่งไปกับคำถามแทน) ------------------
export const AI_SYSTEM_PROMPT = `คุณคือเลขาส่วนตัวในไลน์ของเจ้าของบริษัทรับจดทะเบียนรถ (จดรถใหม่ งานรถเก่า โอน สลับเลข ต่อภาษี ฯลฯ)
ตอบคำถามเกี่ยวกับข้อมูลในระบบของบริษัท โดยดึงข้อมูลจริงด้วยเครื่องมือเท่านั้น

กฎ
- ตอบภาษาไทย สั้น ตรงคำถาม เหมือนเลขาคุยกับเจ้านาย
- ตัวเลข ยอดเงิน วันที่ เลขถัง ทะเบียน ต้องมาจากผลของเครื่องมือเท่านั้น ห้ามเดา ห้ามคำนวณยอดเงินใหม่ถ้าเครื่องมือให้ยอดมาแล้ว ยอดเงินเขียนเต็มไม่ปัด
- ถ้าเครื่องมือไม่มีข้อมูลที่ถาม ให้บอกตรงๆ ว่าในไลน์ยังดูไม่ได้ และแนะนำหน้าเว็บที่เกี่ยวข้องถ้ารู้
- คุณแก้ไข บันทึก ลบ ออกเอกสาร หรือส่งข้อความหาใครไม่ได้ (รอบนี้อ่านอย่างเดียว) ถ้าถูกขอให้ทำ บอกว่าต้องทำบนเว็บ
- ข้อความแสดงในไลน์: ห้ามใช้ markdown (ไม่มี ** # ตาราง) ใช้บรรทัดสั้นๆ และ • นำหน้ารายการ
- วันที่ตอบเป็น วว/ดด/ปปปป (ค.ศ.) ตามระบบ
- ถ้าคำถามกำกวม (เช่น ชื่อลูกค้าตรงหลายราย) ให้ถามกลับสั้นๆ
- ลิงก์ดาวน์โหลดเอกสารที่เครื่องมือให้มา ส่งต่อได้ตามเดิม

ความรู้พื้นฐานของระบบ
- ขั้นตอนรถจดใหม่: แจ้งย้าย > ส่งตรวจ > ผลตรวจ > ยื่นเอกสาร > รับใบเสร็จ > รับป้าย > รับเล่ม > ส่งงาน (Delivery) > ส่งป้าย > วางบิล
- ใบวางบิล = IV, ใบกำกับภาษี = TV, ใบเสนอราคา = QT, ใบส่งงาน = DL
- Yamaha (YM) ค้างจ่ายภายใน 45 วันนับจากวันออกบิลถือว่าปกติ ไม่ใช่เกินกำหนด
- ค่าอากรแยกจากยอดรวมเสมอ`;

const COMMAND_LIST = `คำสั่งที่ใช้ได้ (พิมพ์แบบนี้ทุกตัวอักษร ชื่อลูกค้าพิมพ์บางส่วนได้):
• งานค้าง = จำนวนที่ค้างแต่ละขั้นตอน นานสุดกี่วัน + รอวางบิล/รอรับเงิน
• สรุปงาน = แยกทุกประเภทงาน: ยื่นเดือนนี้ / ค้าง / ต้นทุน / ค่าบริการเฉลี่ย
• สรุปเช้า / สรุปเย็น = การ์ดสรุปประจำวัน (เย็นมีงานที่พนักงานแต่ละคนทำวันนี้)
• การเงินค้าง = เงินเดือน / รอวางบิลรายลูกค้า / บิลรอรับเงิน / 50 ทวิ ค้าง / ใบเสนอราคาค้าง
• ค้างจ่าย = บิลเกินกำหนดชำระ รายลูกค้า
• รถติดขัด = รถที่ค้างเกินกำหนดแต่ละขั้น
• ยอดใช้จ่าย = ใช้เงินวันนี้ / เมื่อวาน / 7 วัน / เดือนนี้
• ตารางเตือน = เตือนประจำสัปดาห์
• ยอด <ลูกค้า> = บิลรอรับเงิน / วางบิล-รับเงินเดือนนี้ / รถรอวางบิล / ใบเสนอราคาค้าง ของลูกค้ารายนั้น
• บิล <ลูกค้า> / ใบกำกับ <ลูกค้า> / ใบเสนอราคา <ลูกค้า> = 5 ใบล่าสุดของลูกค้า พร้อมลิงก์ PDF
• บิลล่าสุด / ใบกำกับล่าสุด / ใบเสนอราคาล่าสุด (ต่อท้ายจำนวนได้ เช่น บิลล่าสุด 5)
• บิล IV2026-155 / ใบกำกับ TV2026-146 / QT2026-012 = ตามเลขเอกสาร
• ราคา = รายชื่อลูกค้าที่ตั้งราคา · ราคา <ลูกค้า> = ตารางราคาค่าบริการของลูกค้า
• ต้นทุน = เลือกงาน · ต้นทุน เฉลี่ย · ต้นทุน สลับเลข · ต้นทุน จดรถยนต์ · ต้นทุน จดจักรยานยนต์ · ต้นทุน <จังหวัด> (ราคาซับ)
• เรทจังหวัด = ตารางทุกจังหวัด · เรท <จังหวัด> = เรทเสนอ / ต้องนำรถไปตรวจไหม / ต้นทุนซับ
• ขอ <ชื่อ> = ข้อความที่จดไว้ในตู้ (เช่น ที่อยู่บริษัท) · ตู้เอกสาร = รายชื่อข้อความในตู้`;

export const AI_TOOLS: Anthropic.Tool[] = [
  {
    name: 'run_command',
    description: `เรียกคำสั่งค้นข้อมูลของเลขา (อ่านอย่างเดียว) แล้วได้คำตอบเป็นข้อความ เรียกหลายคำสั่งพร้อมกันได้\n${COMMAND_LIST}`,
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string', description: 'คำสั่งหนึ่งคำสั่ง เช่น "ยอด SPI" หรือ "งานค้าง"' } },
      required: ['command'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'search_vehicles',
    description:
      'ค้นรถและงานอื่นๆ (สลับเลข ยกเลิกการใช้รถ ย้ายออก คัดป้าย งานโอน ต่อภาษี) ด้วยเลขถัง เลขเครื่อง ทะเบียน ชื่อลูกค้า หรือชื่อเจ้าของ ' +
      'ได้สถานะปัจจุบันของแต่ละคัน (ค้างขั้นไหน กี่วัน เกินกำหนดไหม) · ใส่ status เพื่อกรองเฉพาะรถที่ค้างขั้นนั้น · ' +
      'ค้นแบบไม่ใส่ query ได้ (เช่น นับรถทั้งหมดที่ค้างรับป้าย) · ผลแสดงไม่เกิน 30 คัน แต่ total คือจำนวนจริงทั้งหมด',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'คำค้น เช่น เลขถังบางส่วน ทะเบียน "1กข 1234" ชื่อลูกค้า (ว่าง = ทุกคัน)' },
        status: {
          type: 'string',
          enum: ['any', 'transfer', 'inspectSend', 'inspectResult', 'submit', 'receipt', 'plate', 'book', 'delivery', 'plateDelivery', 'billing', 'done', 'problem'],
          description:
            'any = ไม่กรอง · transfer แจ้งย้าย · inspectSend ส่งตรวจ · inspectResult รอผลตรวจ · submit รอยื่น · receipt รอใบเสร็จ · plate รอป้าย · book รอเล่ม · delivery รอส่งงาน · plateDelivery รอส่งป้าย · billing รอวางบิล · done จบแล้ว · problem มีปัญหา/เกินกำหนด',
        },
        kind: { type: 'string', enum: ['any', 'car', 'moto'], description: 'car รถยนต์ · moto จักรยานยนต์ · any ทั้งหมด' },
        from: { type: 'string', description: 'วันที่รับงานตั้งแต่ YYYY-MM-DD (ค.ศ.) หรือว่าง' },
        to: { type: 'string', description: 'วันที่รับงานถึง YYYY-MM-DD (ค.ศ.) หรือว่าง' },
      },
      required: ['query', 'status', 'kind', 'from', 'to'],
      additionalProperties: false,
    },
    strict: true,
  },
];

// คำถามของผู้ใช้ + วันที่วันนี้ (วันที่อยู่ในข้อความผู้ใช้ ไม่อยู่ใน system เพื่อให้ cache ของ system/tools ใช้ได้ทุกวัน)
export function questionContent(question: string, today: string): string {
  return `(วันนี้ ${today})\n${question}`;
}
