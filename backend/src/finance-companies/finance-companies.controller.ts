import { Body, Controller, Get, Post } from '@nestjs/common';
import { FinanceCompaniesService } from './finance-companies.service.js';
import type { CreateFinanceCompanyDto } from './dto/create-finance-company.dto.js';

@Controller('api/finance-companies')
export class FinanceCompaniesController {
  constructor(private readonly financeCompaniesService: FinanceCompaniesService) {}

  @Get()
  async findAll() {
    return { financeCompanies: await this.financeCompaniesService.findAll() };
  }

  @Post()
  create(@Body() body: CreateFinanceCompanyDto) {
    return this.financeCompaniesService.create(body);
  }
}
