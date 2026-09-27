import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import type { CreateCustomerDto } from './dto/create-customer.dto.js';
import type { UpdateCustomerDto } from './dto/update-customer.dto.js';
import { CustomersService } from './customers.service.js';

// สิทธิ์: GET พนักงานทุกฝ่าย / เพิ่มและแก้ไข ADMIN เท่านั้น (ดู auth/access-policy.ts)
@Controller('api/customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Get()
  async findAll() {
    return { customers: await this.customersService.findAll() };
  }

  @Post()
  create(@Body() body: CreateCustomerDto) {
    return this.customersService.create(body);
  }

  // { customer } - แก้ 7 ช่อง (+ เงื่อนไขวางบิลถ้าส่ง terms) ต้องมี remark (ผู้ใช้ 2026-09-27)
  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateCustomerDto) {
    return this.customersService.update(id, body);
  }

  // { entries } ประวัติการแก้ไข ใหม่สุดก่อน - GET ที่ไม่ใช่รายการทั้งหมดเป็นของ ADMIN (access-policy.ts)
  @Get(':id/history')
  history(@Param('id') id: string) {
    return this.customersService.history(id);
  }
}
