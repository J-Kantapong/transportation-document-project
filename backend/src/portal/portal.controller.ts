import { Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import type { RequestUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import { PortalService } from './portal.service.js';

// สิทธิ์: CUSTOMER เท่านั้น (ดู auth/access-policy.ts) - ทุก query กรองด้วย user.customerId
@Controller('api/portal')
export class PortalController {
  constructor(private readonly portalService: PortalService) {}

  @Get('company')
  company(@CurrentUser() user: RequestUser) {
    return this.portalService.company(user.customerId);
  }

  @Get('vehicles')
  vehicles(@CurrentUser() user: RequestUser) {
    return this.portalService.vehicles(user.customerId);
  }

  @Post('vehicles/:id/confirm-delivery')
  @HttpCode(200)
  confirmDelivery(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.portalService.confirmDelivery(user.customerId, id);
  }
}
