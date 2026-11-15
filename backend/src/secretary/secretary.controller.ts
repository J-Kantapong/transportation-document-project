import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Post, Query, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { TaxInvoiceService } from '../billing/tax-invoice.service.js';
import { verifyLineSignature, type LineWebhookBody } from './line-webhook.js';
import { verifyPrintToken } from './print-link.js';
import { isSlot, MIN_KEY_LENGTH, verifyRunKey } from './run-key.js';
import { SecretaryService } from './secretary.service.js';

@Controller('api/secretary')
export class SecretaryController {
  constructor(
    private readonly secretary: SecretaryService,
    private readonly taxInvoices: TaxInvoiceService,
  ) {}

  // webhook ของ LINE (เปิดสาธารณะใน access-policy.ts เพราะ LINE ไม่มี token ของระบบ) - ความปลอดภัยอยู่ที่ลายเซ็น:
  // ไม่ผ่านลายเซ็น = ตอบ 401 ก่อนอ่านข้อมูล/ฐานข้อมูลใดๆ · ตอบ LINE ทันที แล้วค่อยหาคำตอบเบื้องหลัง
  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() req: { rawBody?: Buffer }, @Headers('x-line-signature') signature: string | undefined, @Body() body: LineWebhookBody) {
    const secret = process.env.LINE_CHANNEL_SECRET?.trim();
    if (!secret) throw new ServiceUnavailableException('ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET');
    if (!req.rawBody || !verifyLineSignature(req.rawBody, signature, secret)) throw new UnauthorizedException();

    const events = Array.isArray(body?.events) ? body.events : [];
    void this.secretary.handleEvents(events).catch((error: unknown) => console.error('เลขารับข้อความไม่สำเร็จ:', error instanceof Error ? error.message : error));
    return {};
  }

  // ใบกำกับภาษีสำหรับหน้า /tv ของเว็บ (ลิงก์ที่เลขาส่งในไลน์หลังกดออกใบกำกับ, ผู้ใช้ 2026-11-16) - เปิดสาธารณะใน access-policy.ts
  // ความปลอดภัยอยู่ที่ token (HMAC ด้วย AUTH_SECRET หมดอายุใน 7 วัน, print-link.ts): token ไม่ผ่าน = 401 ก่อนแตะฐานข้อมูล
  @Get('tax-invoice')
  async taxInvoice(@Query('token') token: string | undefined) {
    const id = verifyPrintToken(token, process.env.AUTH_SECRET?.trim() ?? '');
    if (!id) throw new UnauthorizedException({ error: 'ลิงก์ไม่ถูกต้องหรือหมดอายุแล้ว' });
    return { taxInvoice: await this.taxInvoices.get(id) };
  }

  // ตั้งเวลาส่งสรุป (GitHub Actions เรียกตามเวลา 09:00 / 16:00 เวลาไทย): POST /api/secretary/run?slot=morning|evening|reminder (reminder = เตือนประจำสัปดาห์ที่ถึงเวลาแล้ว reminders.ts)
  // เปิดสาธารณะใน access-policy.ts เพราะ GitHub ไม่มี token ของระบบ - ความปลอดภัยอยู่ที่กุญแจ SECRETARY_RUN_KEY ใน header x-secretary-key
  // (ไม่ตั้ง/สั้นเกินไป = ตอบ 503 · กุญแจผิด = 401 ก่อนแตะข้อมูล) · slot เดียวกันในวันเดียวกันส่งครั้งเดียว กัน retry ส่งซ้ำ
  @Post('run')
  @HttpCode(200)
  async run(@Headers('x-secretary-key') key: string | undefined, @Query('slot') slot: string | undefined) {
    const expected = process.env.SECRETARY_RUN_KEY?.trim();
    if (!expected || expected.length < MIN_KEY_LENGTH) throw new ServiceUnavailableException('ยังไม่ได้ตั้งค่า SECRETARY_RUN_KEY');
    if (!verifyRunKey(key, expected)) throw new UnauthorizedException();
    if (!isSlot(slot)) throw new BadRequestException('slot ต้องเป็น morning, evening หรือ reminder');
    return this.secretary.runScheduled(slot);
  }
}
