import { Body, Controller, Headers, HttpCode, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { verifyLineSignature, type LineWebhookBody } from './line-webhook.js';
import { SecretaryService } from './secretary.service.js';

@Controller('api/secretary')
export class SecretaryController {
  constructor(private readonly secretary: SecretaryService) {}

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
}
