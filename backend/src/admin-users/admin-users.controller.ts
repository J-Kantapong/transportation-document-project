import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { AdminUsersService } from './admin-users.service.js';

// สิทธิ์: ADMIN เท่านั้น (ดู auth/access-policy.ts)
@Controller('api/admin/users')
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  list(@Query('status') status?: string) {
    return this.adminUsersService.list(status);
  }

  @Patch(':id')
  update(@CurrentUser() admin: RequestUser, @Param('id') id: string, @Body() body: unknown) {
    return this.adminUsersService.update(admin.id, id, body);
  }
}
