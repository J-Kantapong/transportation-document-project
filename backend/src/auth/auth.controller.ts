import { Body, Controller, Get, HttpCode, Logger, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { clientIp, describeIpHeaders } from './attempt-limiter.js';
import { AuthService } from './auth.service.js';
import type { RequestUser } from './auth.types.js';
import { CurrentUser } from './current-user.decorator.js';

// สิทธิ์: register/login เปิดสาธารณะ ที่เหลือต้องล็อกอิน (ดู access-policy.ts)
@Controller('api/auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);
  private ipHeadersLogged = false;

  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() body: unknown, @Req() req: Request) {
    return this.authService.register(body, this.ip(req));
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown, @Req() req: Request) {
    return this.authService.login(body, this.ip(req));
  }

  // IP ที่ใช้จำกัดจำนวนครั้ง - log รูปแบบ header ของ proxy ครั้งแรกหลังเปิดเครื่อง (ไม่มีตัว IP) ไว้ตรวจว่า clientIp เลือกถูกชั้น
  private ip(req: Request) {
    if (!this.ipHeadersLogged) {
      this.ipHeadersLogged = true;
      this.logger.log(`header IP ของคำขอแรก: ${describeIpHeaders(req)}`);
    }
    return clientIp(req);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.authService.me(user.id, user.tokenExp);
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    return this.authService.changePassword(user.id, body);
  }
}
