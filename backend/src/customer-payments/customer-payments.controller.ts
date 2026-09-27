import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { CustomerPaymentsService, type CreatePaymentDto } from './customer-payments.service.js';

// สิทธิ์: ADMIN / ACCOUNTANT / STAFF_CAR - ดู access-policy.ts
@Controller('api/customer-payments')
export class CustomerPaymentsController {
  constructor(private readonly service: CustomerPaymentsService) {}

  @Get()
  list(@Query('customerId') customerId?: string, @Query('offset') offset?: string) {
    return this.service.list({ customerId, offset });
  }

  // ตารางล้อ: รถที่ส่งงานแล้วพร้อมยอดที่ลูกค้าจ่ายมารายคัน
  @Get('vehicles')
  vehicles(@Query('customerId') customerId?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('status') status?: string) {
    return this.service.vehicles({ customerId, from, to, status });
  }

  @Post('match')
  match(@Body() body: { customerId?: unknown; chassis?: unknown }) {
    return this.service.match(body ?? {});
  }

  @Post()
  async create(@Body() body: CreatePaymentDto) {
    return { payment: await this.service.create(body ?? {}) };
  }

  @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body() body: { remark?: unknown }) {
    return { payment: await this.service.cancel(id, body ?? {}) };
  }
}
