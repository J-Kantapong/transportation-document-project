import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { RequestUser } from './auth.types.js';
import { CurrentUser } from './current-user.decorator.js';

// สิทธิ์: register/login เปิดสาธารณะ ที่เหลือต้องล็อกอิน (ดู access-policy.ts)
@Controller('api/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() body: unknown) {
    return this.authService.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: unknown) {
    return this.authService.login(body);
  }

  @Get('me')
  me(@CurrentUser() user: RequestUser) {
    return this.authService.me(user.id);
  }

  @Post('change-password')
  @HttpCode(200)
  changePassword(@CurrentUser() user: RequestUser, @Body() body: unknown) {
    return this.authService.changePassword(user.id, body);
  }
}
