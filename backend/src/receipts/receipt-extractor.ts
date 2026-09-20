import * as process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Injectable, Logger } from '@nestjs/common';
import {
  RECEIPT_READING_PROMPT,
  ReceiptReadingSchema,
  checkReading,
  normalizeUncertainFields,
  type ReceiptChecks,
  type ReceiptReading,
} from './receipt-extraction.js';

// ตัวอ่านข้อมูลจากรูปใบเสร็จ (AI) - ผลที่ได้เก็บใน ReceiptImage.extraction ให้พนักงานตรวจทานก่อนบันทึกเสมอ
export const RECEIPT_EXTRACTOR = Symbol('RECEIPT_EXTRACTOR');

// ผลใน ReceiptImage.extraction: อ่านสำเร็จ = reading + checks, อ่านไม่สำเร็จ = error (ยังเก็บรูปไว้ พนักงานกรอกเอง)
export type ReceiptExtraction =
  | {
      reading: ReceiptReading;
      checks: ReceiptChecks;
      // cachedTokens = prompt ที่อ่านจาก cache (คิด 10% ของราคาปกติ) - ถ้าเป็น 0 ตลอดแปลว่า cache ไม่ทำงาน
      usage: { inputTokens: number; outputTokens: number; cachedTokens: number };
    }
  | { error: string };

export interface ReceiptExtractor {
  // ค่าที่บันทึกใน ReceiptImage.extractionSource: NONE หรือ model id ของ AI
  readonly source: string;
  // null = ไม่ได้อ่าน (โหมดไม่มี AI)
  extract(image: Buffer, mimeType: string): Promise<ReceiptExtraction | null>;
}

// ไม่มี ANTHROPIC_API_KEY: เก็บรูปอย่างเดียว พนักงานกรอกยอด/ทะเบียนเอง (ไม่มีค่าใช้จ่าย)
@Injectable()
export class NoAiReceiptExtractor implements ReceiptExtractor {
  readonly source = 'NONE';

  extract(): Promise<null> {
    return Promise.resolve(null);
  }
}

// Claude Sonnet 5 - ผู้ใช้เลือกหลังทดสอบกับใบเสร็จจริง 22 ใบ (ถูกทุกช่อง; Haiku 4.5 อ่านทะเบียน/เลขตัวถังผิดบ่อย)
export const RECEIPT_MODEL = 'claude-sonnet-5';

@Injectable()
export class ClaudeReceiptExtractor implements ReceiptExtractor {
  readonly source = RECEIPT_MODEL;
  private readonly logger = new Logger(ClaudeReceiptExtractor.name);
  private readonly client = new Anthropic();

  async extract(image: Buffer, mimeType: string): Promise<ReceiptExtraction> {
    try {
      const response = await this.client.messages.parse({
        model: RECEIPT_MODEL,
        max_tokens: 8000,
        // วัดกับใบเสร็จจริง 34 ใบแล้ว: effort low/medium ใช้ token เท่ากัน (output แค่ ~290) เลยคง medium ไว้
        output_config: { effort: 'medium', format: zodOutputFormat(ReceiptReadingSchema) },
        // prompt = ส่วนที่ซ้ำทุกใบ (~1,380 token) อยู่ใน system แล้ว cache ไว้ อ่านซ้ำคิดแค่ 10% ของราคาปกติ
        // รูปซึ่งเปลี่ยนทุกใบต้องอยู่หลัง cache breakpoint เสมอ ไม่งั้น cache ใช้ไม่ได้เลยสักใบ
        system: [{ type: 'text', text: RECEIPT_READING_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: image.toString('base64') },
              },
              { type: 'text', text: 'อ่านใบเสร็จใบนี้' },
            ],
          },
        ],
      });
      if (response.stop_reason === 'refusal') return { error: 'AI ปฏิเสธการอ่านรูปนี้' };
      if (response.stop_reason === 'max_tokens') return { error: 'AI อ่านไม่จบ (ข้อความยาวเกิน)' };
      const parsed = response.parsed_output;
      if (!parsed) return { error: 'AI ตอบกลับในรูปแบบที่อ่านไม่ได้' };
      // AI เรียกชื่อช่องไม่ตรงลิสต์ได้ - กรองทิ้งตรงนี้ ไม่ให้กระทบช่องอื่นที่อ่านถูกแล้ว
      const reading: ReceiptReading = { ...parsed, uncertainFields: normalizeUncertainFields(parsed.uncertainFields) };
      return {
        reading,
        checks: checkReading(reading),
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cachedTokens: response.usage.cache_read_input_tokens ?? 0,
        },
      };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return { error: 'API key ไม่ถูกต้อง' };
      if (err instanceof Anthropic.RateLimitError) return { error: 'AI ใช้งานเกินโควต้าชั่วคราว ลองอัปโหลดใหม่อีกครั้ง' };
      if (err instanceof Anthropic.APIError) {
        this.logger.warn(`อ่านใบเสร็จไม่สำเร็จ: ${err.status} ${err.message}`);
        return { error: `AI อ่านไม่สำเร็จ (${err.status ?? 'เชื่อมต่อไม่ได้'})` };
      }
      throw err;
    }
  }
}

// เลือกตัวอ่านตอนเปิดเซิร์ฟเวอร์: มี ANTHROPIC_API_KEY = ใช้ AI (ใส่คีย์แล้วต้อง restart backend)
export const receiptExtractorProvider = {
  provide: RECEIPT_EXTRACTOR,
  useFactory: (): ReceiptExtractor => (process.env.ANTHROPIC_API_KEY ? new ClaudeReceiptExtractor() : new NoAiReceiptExtractor()),
};
