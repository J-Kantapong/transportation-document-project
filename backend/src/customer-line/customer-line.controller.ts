import { Body, Controller, Headers, HttpCode, Post, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { verifyLineSignature, type LineWebhookBody } from '../secretary/line-webhook.js';
import { CustomerLineService } from './customer-line.service.js';

@Controller('api/customer-line')
export class CustomerLineController {
  constructor(private readonly customerLine: CustomerLineService) {}

  // webhook ของบัญชีไลน์ลูกค้า (เปิดสาธารณะใน access-policy.ts เพราะ LINE ไม่มี token ของระบบ) - ความปลอดภัยอยู่ที่ลายเซ็น:
  // ไม่ผ่านลายเซ็น = ตอบ 401 ก่อนทำอะไร · ตอบ LINE ทันที แล้วค่อยตอบลูกค้าเบื้องหลัง
  @Post('webhook')
  @HttpCode(200)
  webhook(@Req() req: { rawBody?: Buffer }, @Headers('x-line-signature') signature: string | undefined, @Body() body: LineWebhookBody) {
    const secret = process.env.LINE_CUSTOMER_CHANNEL_SECRET?.trim();
    if (!secret) throw new ServiceUnavailableException('ยังไม่ได้ตั้งค่า LINE_CUSTOMER_CHANNEL_SECRET');
    if (!req.rawBody || !verifyLineSignature(req.rawBody, signature, secret)) throw new UnauthorizedException();

    const events = Array.isArray(body?.events) ? body.events : [];
    void this.customerLine.handleEvents(events).catch((error: unknown) => console.error('บอทไลน์ลูกค้ารับข้อความไม่สำเร็จ:', error instanceof Error ? error.message : error));
    return {};
  }
}
