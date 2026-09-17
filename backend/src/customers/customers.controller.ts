import { Body, Controller, Get, Post } from '@nestjs/common';
import type { CreateCustomerDto } from './dto/create-customer.dto.js';
import { CustomersService } from './customers.service.js';

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

  // test for auto deploy
}
