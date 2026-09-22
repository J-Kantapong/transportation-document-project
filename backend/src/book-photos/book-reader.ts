import * as process from 'node:process';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Injectable, Logger } from '@nestjs/common';
import { RECEIPT_MODEL } from '../receipts/receipt-extractor.js';
import { BOOK_READING_PROMPT, BookReadingSchema, type ReadBook } from './book-reading.js';

// ตัวอ่านเลขตัวรถ/ทะเบียนจากรูปเล่มทะเบียน (AI) - ผลเก็บใน BookPhoto.extraction ให้พนักงานยืนยันก่อนบันทึกเสมอ
export const BOOK_READER = Symbol('BOOK_READER');

export type BookExtraction =
  | { books: ReadBook[]; usage: { inputTokens: number; outputTokens: number; cachedTokens: number } }
  | { error: string };

export interface BookReader {
  readonly source: string; // NONE หรือ model id
  read(image: Buffer, mimeType: string): Promise<BookExtraction | null>; // null = ไม่มี AI
}

@Injectable()
export class NoAiBookReader implements BookReader {
  readonly source = 'NONE';

  read(): Promise<null> {
    return Promise.resolve(null);
  }
}

// Sonnet 5 ตัวเดียวกับใบเสร็จ/ป้ายทะเบียน
@Injectable()
export class ClaudeBookReader implements BookReader {
  readonly source = RECEIPT_MODEL;
  private readonly logger = new Logger(ClaudeBookReader.name);
  private readonly client = new Anthropic();

  async read(image: Buffer, mimeType: string): Promise<BookExtraction> {
    try {
      const response = await this.client.messages.parse({
        model: RECEIPT_MODEL,
        max_tokens: 8000,
        output_config: { effort: 'medium', format: zodOutputFormat(BookReadingSchema) },
        // prompt ซ้ำทุกรูป -> cache ไว้ใน system; รูปต้องอยู่หลัง cache breakpoint
        system: [{ type: 'text', text: BOOK_READING_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mimeType as 'image/jpeg' | 'image/png' | 'image/webp', data: image.toString('base64') },
              },
              { type: 'text', text: 'อ่านเลขตัวรถและทะเบียนของเล่มทะเบียนทุกเล่มในรูปนี้' },
            ],
          },
        ],
      });
      if (response.stop_reason === 'refusal') return { error: 'AI ปฏิเสธการอ่านรูปนี้' };
      if (response.stop_reason === 'max_tokens') return { error: 'AI อ่านไม่จบ' };
      const parsed = response.parsed_output;
      if (!parsed) return { error: 'AI ตอบกลับในรูปแบบที่อ่านไม่ได้' };
      return {
        books: parsed.books,
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
        this.logger.warn(`อ่านเล่มทะเบียนไม่สำเร็จ: ${err.status} ${err.message}`);
        return { error: `AI อ่านไม่สำเร็จ (${err.status ?? 'เชื่อมต่อไม่ได้'})` };
      }
      throw err;
    }
  }
}

export const bookReaderProvider = {
  provide: BOOK_READER,
  useFactory: (): BookReader => (process.env.ANTHROPIC_API_KEY ? new ClaudeBookReader() : new NoAiBookReader()),
};
