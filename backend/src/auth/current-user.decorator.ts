import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { RequestUser } from './auth.types.js';

// @CurrentUser() user: RequestUser - อ่านผู้ใช้ที่ AuthGuard ตรวจแล้ว
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestUser => {
  return ctx.switchToHttp().getRequest<{ user: RequestUser }>().user;
});
