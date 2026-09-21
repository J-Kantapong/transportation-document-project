import * as process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Injectable, Logger } from '@nestjs/common';
import { RECEIPT_MODEL } from '../receipts/receipt-extractor.js';
import { PLATE_READING_PROMPT, PlateReadingSchema, type ReadPlate } from './plate-reading.js';

// ตัวอ่านเลขทะเบียนจากรูปป้าย (AI) - ผลเก็บใน PlatePhoto.extraction ให้พนักงานยืนยันก่อนบันทึกเสมอ
export const PLATE_READER = Symbol('PLATE_READER');

export type PlateExtraction =
  | { plates: ReadPlate[]; usage: { inputTokens: number; outputTokens: number; cachedTokens: number } }
  | { error: string };

export interface PlateReader {
  readonly source: string; // NONE หรือ model id
  read(image: Buffer, mimeType: string): Promise<PlateExtraction | null>; // null = ไม่มี AI
}

// ไม่มี ANTHROPIC_API_KEY: เก็บรูปอย่างเดียว พนักงานจับคู่เอง
@Injectable()
export class NoAiPlateReader implements PlateReader {
  readonly source = 'NONE';

  read(): Promise<null> {
    return Promise.resolve(null);
  }
}

// ใช้ Sonnet 5 ตัวเดียวกับใบเสร็จ - ผลทดสอบใบเสร็จ: Haiku อ่านพยัญชนะทะเบียนผิดเกือบทุกใบ (ข -> ย ฯลฯ)
@Injectable()
export class ClaudePlateReader implements PlateReader {
  readonly source = RECEIPT_MODEL;
  private readonly logger = new Logger(ClaudePlateReader.name);
  private readonly client = new Anthropic();

  async read(image: Buffer, mimeType: string): Promise<PlateExtraction> {
    try {
      const response = await this.client.messages.parse({
        model: RECEIPT_MODEL,
        max_tokens: 8000,
        output_config: { effort: 'medium', format: zodOutputFormat(PlateReadingSchema) },
        // prompt ซ้ำทุกรูป -> cache ไว้ใน system; รูปต้องอยู่หลัง cache breakpoint
        system: [{ type: 'text', text: PLATE_READING_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: image.toString('base64') },
              },
              { type: 'text', text: 'อ่านป้ายทะเบียนทุกแผ่นในรูปนี้' },
            ],
          },
        ],
      });
      if (response.stop_reason === 'refusal') return { error: 'AI ปฏิเสธการอ่านรูปนี้' };
      if (response.stop_reason === 'max_tokens') return { error: 'AI อ่านไม่จบ' };
      const parsed = response.parsed_output;
      if (!parsed) return { error: 'AI ตอบกลับในรูปแบบที่อ่านไม่ได้' };
      return {
        plates: parsed.plates,
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
        this.logger.warn(`อ่านป้ายทะเบียนไม่สำเร็จ: ${err.status} ${err.message}`);
        return { error: `AI อ่านไม่สำเร็จ (${err.status ?? 'เชื่อมต่อไม่ได้'})` };
      }
      throw err;
    }
  }
}

export const plateReaderProvider = {
  provide: PLATE_READER,
  useFactory: (): PlateReader => (process.env.ANTHROPIC_API_KEY ? new ClaudePlateReader() : new NoAiPlateReader()),
};
